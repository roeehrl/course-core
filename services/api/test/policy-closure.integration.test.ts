import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { closeEnrollment, previewClosure, type PolicyState } from "@course-core/policy";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { rubricCourse, rubricExplanation } from "./rubric-fixture.js";

const origin = "http://localhost:4393",
  schema = "policyclose_" + randomUUID().replaceAll("-", "");
const DAY = 86_400_000;
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, instructor: Session, learner: Session, enrollment: string, catalog: string, version = 0;
interface Session { userId: string; cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "close:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(action: string, body: Record<string, unknown>) {
  const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
  return call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
const ask = () => send("companion", { episodeId: "min", content: "Why does keeping the smaller value work?" });
async function snapshot(): Promise<PolicyState> { return (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0].snapshot; }
async function save(state: PolicyState) {
  await db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollment, JSON.stringify(state), state.policyRevision, state.ledgerRevision]);
}
/** Moves the course window so it ended `endedDaysAgo` days ago (an elapsed cap, as after an outage). */
async function windowEnded(endedDaysAgo: number) {
  const state = await snapshot(), window = state.scopes[0]!.window!;
  window.anchorInstant = new Date(Date.now() - (endedDaysAgo + window.calendarDays) * DAY).toISOString();
  window.resolvedDeadline = new Date(Date.now() - endedDaysAgo * DAY).toISOString();
  await save(state);
}
/** Closes the enrollment at its reached cap, as the deadline wakeup does. */
async function closeAtCap(access: "read_only" | "closed" = "read_only") {
  const state = await snapshot();
  for (const scope of state.scopes) scope.existingMaterialAccess = access;
  const now = new Date().toISOString(), command = { now, reason: "cap" as const, coveredObjectiveIds: [], demonstratedConceptIds: [] };
  const preview = previewClosure(state, command);
  const closed = closeEnrollment(state, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
    idempotencyKey: "cap:" + enrollment, authorityReceipt: { receiptId: randomUUID(), actorId: "system:reached-course-cap", enrollmentId: enrollment, scopeId: "course",
      permission: "close_enrollment", termsDigest: preview.previewDigest, authorizedAt: now } });
  await save(closed.state);
  await db.query("UPDATE enrollments SET status='closed',policy_revision=$2,closed_at=now(),revision=revision+1 WHERE id=$1", [enrollment, closed.state.policyRevision]);
}
async function submitted() {
  const issued = await send("challenges", { episodeId: "min", assessmentId: "min-explain", mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  const answered = await send("answers", { challengeId: issued.json().challengeId, answer: rubricExplanation });
  expect(answered.statusCode, answered.body).toBe(200);
  return (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending[0].attemptId as string;
}
const review = (attemptId: string) => call(instructor, "POST", `/api/admin/rubric-reviews/${attemptId}`, { decision: "met", idempotencyKey: "k-" + randomUUID(), criteria: [
  { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
  { criterionId: "every-element", met: true, quote: "compare every next element with it" },
  { criterionId: "edge", met: false, note: "Empty list not discussed." },
] });

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "close-" + workspace, "Closure"]);
  owner = await session("owner");
  instructor = await session("instructor");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse(`4.0.${version++}`))).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  catalog = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [workspace])).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});
async function enroll(budget?: number) {
  if (budget !== undefined) {
    const current = (await call(owner, "GET", `/api/admin/courses/${catalog}/policy-settings`)).json();
    const saved = await call(owner, "PUT", `/api/admin/courses/${catalog}/policy-settings`, { expectedRevision: current.revision, settings: { ...current.settings, closedQuestionBudget: budget }, reason: "Closed-course help" });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  const release = (await db.query("SELECT id FROM course_releases WHERE workspace_id=$1", [workspace])).rows[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
}

describe("questions after a capped course closes (G15, P20)", () => {
  it("allows read-only questions for a closed course within its configured budget, without reopening work", async () => {
    await enroll(2);
    const allowance = async (who = learner) => (await call(who, "GET", `/api/enrollments/${enrollment}/policy`)).json().closedQuestions;
    // Only a closed course has a question allowance.
    expect(await allowance()).toBeUndefined();
    await windowEnded(1);
    await closeAtCap();
    expect(await allowance()).toEqual({ budget: 2, used: 0, remaining: 2 });
    for (let i = 0; i < 2; i += 1) {
      const asked = await ask();
      expect(asked.statusCode, asked.body).toBe(200);
      expect(asked.json().state).toBe("queued");
      expect(await allowance()).toEqual({ budget: 2, used: i + 1, remaining: 1 - i });
    }
    const spent = await ask();
    expect(spent.statusCode).toBe(409);
    expect(spent.json()).toEqual({ error: "HELP_BUDGET_EXHAUSTED", details: { budget: 2, used: 2, remaining: 0 } });
    // The learner view and the refusal agree at the boundary; staff views never include it.
    expect(await allowance()).toEqual(spent.json().details);
    const staff = await call(instructor, "GET", `/api/enrollments/${enrollment}/policy`);
    if (staff.statusCode === 200) expect(staff.json().closedQuestions).toBeUndefined();
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" })).statusCode).toBe(409);
    expect((await db.query("SELECT status FROM enrollments WHERE id=$1", [enrollment])).rows[0].status).toBe("closed");
    expect((await snapshot()).status).toBe("closed");
  });
  it("refuses questions when the closed course also closed existing material", async () => {
    await enroll();
    await windowEnded(1);
    await closeAtCap("closed");
    expect((await ask()).json().error).toBe("ACCESS_CLOSED");
  });
});

describe("grading after the cutoff (G14, P08)", () => {
  it("records evidence for an on-time submission reviewed after the deadline and closure, without reopening", async () => {
    await enroll();
    const attemptId = await submitted();
    // The submission was on time; the course window then ended and the enrollment closed at its cap.
    await db.query("UPDATE attempts SET submitted_at=now()-interval '2 days' WHERE id=$1", [attemptId]);
    await windowEnded(1);
    await closeAtCap();
    const reviewed = await review(attemptId);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM evidence WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(1);
    expect((await db.query("SELECT status FROM enrollments WHERE id=$1", [enrollment])).rows[0].status).toBe("closed");
    expect((await snapshot()).closure?.reason).toBe("cap");
  });
  it("refuses to grade a submission recorded after the cutoff", async () => {
    await enroll();
    const attemptId = await submitted();
    await windowEnded(1);
    const refused = await review(attemptId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("SUBMITTED_AFTER_CUTOFF");
    expect((await db.query("SELECT count(*)::int AS n FROM evidence WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM rubric_reviews WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(0);
  });
});
