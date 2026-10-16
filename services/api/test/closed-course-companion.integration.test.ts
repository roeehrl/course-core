import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { closeEnrollment, previewClosure, type PolicyState } from "@course-core/policy";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge, recordSupervisorVerification, storeSupervisorArtifact } from "../src/supervisor-bridge.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { rubricCourse } from "./rubric-fixture.js";

// G15 / P20: a course closed at its cap (or completed) answers bounded read-only questions
// through the real learner route and the real Postgres supervisor bridge; a question is
// charged against the closed-course budget only while it can still be answered.
const origin = "http://localhost:4394",
  schema = "closedcompanion_" + randomUUID().replaceAll("-", "");
const DAY = 86_400_000;
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, enrollment: string, catalog: string, version = 0;
interface Session { userId: string; cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "closedq:" + id, role + " person"]);
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
const allowance = async () => (await call(learner, "GET", `/api/enrollments/${enrollment}/policy`)).json().closedQuestions;
const messages = async () => (await call(learner, "GET", `/api/enrollments/${enrollment}/companion`)).json().messages as { id: string; role: string; content: string; job_state: string | null }[];
async function snapshot(): Promise<PolicyState> { return (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0].snapshot; }
async function save(state: PolicyState) {
  await db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollment, JSON.stringify(state), state.policyRevision, state.ledgerRevision]);
}
async function setAccess(access: "read_only" | "closed") {
  const state = await snapshot();
  for (const scope of state.scopes) scope.existingMaterialAccess = access;
  await save(state);
}
/** Ends the course window a day ago: the cap is a deadline that has already passed. */
async function windowEnded() {
  const state = await snapshot(), window = state.scopes[0]!.window!;
  window.anchorInstant = new Date(Date.now() - (1 + window.calendarDays) * DAY).toISOString();
  window.resolvedDeadline = new Date(Date.now() - DAY).toISOString();
  await save(state);
}
/** The policy engine's real closure transition, as the deadline wakeup (cap) or completion does. */
async function close(reason: "cap" | "completed") {
  const state = await snapshot(), now = new Date().toISOString();
  const command = { now, reason, coveredObjectiveIds: reason === "completed" ? state.coreObjectiveIds : [], demonstratedConceptIds: [] };
  const preview = previewClosure(state, command);
  const closed = closeEnrollment(state, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
    idempotencyKey: `${reason === "cap" ? "cap" : "completion"}:${enrollment}`, authorityReceipt: { receiptId: randomUUID(), actorId: reason === "cap" ? "system:reached-course-cap" : "system:verified-course-coverage",
      enrollmentId: enrollment, scopeId: "course", permission: "close_enrollment", termsDigest: preview.previewDigest, authorizedAt: now } });
  await save(closed.state);
  await db.query("UPDATE enrollments SET status=$3,policy_revision=$2,closed_at=now(),revision=revision+1 WHERE id=$1", [enrollment, closed.state.policyRevision, reason === "cap" ? "closed" : "completed"]);
}
async function closeAtCap() { await windowEnded(); await close("cap"); }

const bridge = () => createPostgresSupervisorBridge(db, { serviceToken: "synthetic-test-service-token-not-a-credential", workspaceIds: [workspace],
  jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
/** Delivers one event to the supervisor bridge as the worker does; returns its admission. */
async function deliver(eventId: string) {
  const b = bridge(), lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find((row) => row.eventId === eventId);
  expect(lease).toBeDefined();
  const refs = await b.prepareOutbox(lease!); await b.ackOutbox(lease!);
  const disposition = (await db.query("SELECT disposition FROM supervisor_preparations WHERE event_id=$1", [eventId])).rows[0].disposition as string;
  return { b, refs, disposition };
}
/** Runs an admitted companion job through a scripted (synthetic) provider result, verification and application. */
async function answer(eventId: string, text = "Synthetic verified explanation.") {
  const d = await deliver(eventId);
  expect(d.disposition).toBe("prepared");
  expect(d.refs).toHaveLength(1);
  const ref = d.refs[0]!;
  const job = (await db.query("SELECT role,specification FROM supervisor_jobs WHERE id=$1", [ref.jobId])).rows[0];
  expect(job.role).toBe("companion");
  // A capped course's deadline has passed; a read-only answer is bounded by the job duration instead.
  expect(job.specification.deadlineAtMs).toBeGreaterThan(Date.now());
  const claimed = await d.b.transition({ type: "claim", ref, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  expect(claimed.effect).toBe("invoke");
  const op = claimed.snapshot.operations[0]!;
  const output = await storeSupervisorArtifact(db, ref, op.id, op.ownerId, { kind: "companion_message", text });
  await d.b.transition({ type: "settle", ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: "succeeded", artifact: output, usage: { microUsd: 25, tokens: 40 } } });
  const verifierId = randomUUID();
  await db.query("INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,'Synthetic verifier',true,false)", [verifierId, workspace]);
  await recordSupervisorVerification(db, ref, verifierId, "verified");
  expect((await d.b.transition({ type: "verify", ref })).snapshot.state).toBe("ready");
  expect((await d.b.transition({ type: "apply", ref })).snapshot.state).toBe("applied");
  return ref;
}
async function learnerRecord() {
  const count = async (table: string) => Number((await db.query(`SELECT count(*) FROM ${table} WHERE enrollment_id=$1`, [enrollment])).rows[0].count);
  const row = (await db.query("SELECT status,policy_revision FROM enrollments WHERE id=$1", [enrollment])).rows[0];
  return { evidence: await count("evidence"), attempts: await count("attempts"), progress: await count("episode_progress"), grants: await count("extension_grants"),
    status: row.status, policyRevision: row.policy_revision, policyStatus: (await snapshot()).status, closure: (await snapshot()).closure };
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "closedq-" + workspace, "Closed questions"]);
  owner = await session("owner");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse(`5.0.${version++}`))).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  catalog = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [workspace])).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});
async function enroll(budget: number) {
  const current = (await call(owner, "GET", `/api/admin/courses/${catalog}/policy-settings`)).json();
  const saved = await call(owner, "PUT", `/api/admin/courses/${catalog}/policy-settings`, { expectedRevision: current.revision, settings: { ...current.settings, closedQuestionBudget: budget }, reason: "Closed-course help" });
  expect(saved.statusCode, saved.body).toBe(200);
  const release = (await db.query("SELECT id FROM course_releases WHERE workspace_id=$1", [workspace])).rows[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 10_000, tokens: 10_000 });
}

describe("closed-course questions are answered read-only within the budget (G15, P20)", () => {
  it("answers a question on a course closed at its cap, charges it once and changes nothing else", async () => {
    await enroll(2);
    await closeAtCap();
    const before = await learnerRecord();
    expect(before).toMatchObject({ status: "closed", policyStatus: "closed" });
    const asked = await ask();
    expect(asked.statusCode, asked.body).toBe(200);
    expect(await allowance()).toEqual({ budget: 2, used: 1, remaining: 1 });
    const ref = await answer(asked.json().eventId);
    const shown = await messages();
    expect(shown.map((m) => [m.role, m.job_state])).toEqual([["learner", "applied"], ["assistant", "applied"]]);
    expect(shown[1]!.content).toBe("Synthetic verified explanation.");
    // The answer is charged exactly once, and grants no evidence, progression or reopening.
    expect(await allowance()).toEqual({ budget: 2, used: 1, remaining: 1 });
    expect(await learnerRecord()).toEqual(before);
    expect((await db.query("SELECT count(*)::int AS n FROM supervisor_applications WHERE job_id=$1", [ref.jobId])).rows[0].n).toBe(1);
    // Only the companion may run on a closed enrollment: planning stays inactive.
    const planning = await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: enrollment, actorId: learner.userId, actorKind: "learner",
      type: "learning.updated", payload: {}, idempotencyKey: randomUUID(), supervise: true }));
    expect((await deliver(planning.id)).disposition).toBe("inactive");
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" })).statusCode).toBe(409);
  });
  it("refuses a question once the budget is spent, without charging or saving it", async () => {
    await enroll(1);
    await closeAtCap();
    await answer((await ask()).json().eventId);
    const spent = await ask();
    expect(spent.statusCode).toBe(409);
    expect(spent.json()).toEqual({ error: "HELP_BUDGET_EXHAUSTED", details: { budget: 1, used: 1, remaining: 0 } });
    expect(await allowance()).toEqual({ budget: 1, used: 1, remaining: 0 });
    expect((await messages()).filter((m) => m.role === "learner")).toHaveLength(1);
  });
  it("does not charge a question the access policy refuses, at the route or at admission", async () => {
    await enroll(1);
    await closeAtCap();
    const asked = await ask();
    expect(asked.statusCode, asked.body).toBe(200);
    expect(await allowance()).toEqual({ budget: 1, used: 1, remaining: 0 });
    // Material access closes after the question was accepted: the supervisor refuses it and the charge is returned.
    await setAccess("closed");
    const refused = await deliver(asked.json().eventId);
    expect(refused).toMatchObject({ refs: [], disposition: "policy_denied" });
    expect(await allowance()).toEqual({ budget: 1, used: 0, remaining: 1 });
    expect((await messages()).map((m) => [m.role, m.job_state])).toEqual([["learner", "refused"]]);
    // While access stays closed the route refuses up front and saves nothing.
    expect((await ask()).json().error).toBe("ACCESS_CLOSED");
    expect(await messages()).toHaveLength(1);
    expect(await allowance()).toEqual({ budget: 1, used: 0, remaining: 1 });
    // The returned allowance is usable once the material is readable again.
    await setAccess("read_only");
    const again = await ask();
    expect(again.statusCode, again.body).toBe(200);
    await answer(again.json().eventId);
    expect(await allowance()).toEqual({ budget: 1, used: 1, remaining: 0 });
  });
  it("returns the charge when an admitted question ends without an answer", async () => {
    await enroll(1);
    await closeAtCap();
    const asked = await ask();
    const d = await deliver(asked.json().eventId);
    expect(d.disposition).toBe("prepared");
    expect(await allowance()).toEqual({ budget: 1, used: 1, remaining: 0 });
    expect((await d.b.transition({ type: "halt", ref: d.refs[0]!, reason: "cancel_requested" })).snapshot.state).toBe("cancelled");
    expect(await allowance()).toEqual({ budget: 1, used: 0, remaining: 1 });
    expect((await messages()).map((m) => m.job_state)).toEqual(["cancelled"]);
    expect((await ask()).statusCode).toBe(200);
  });
  it("keeps completed-course questions working the same way", async () => {
    await enroll(1);
    await close("completed");
    const before = await learnerRecord();
    expect(before.status).toBe("completed");
    await answer((await ask()).json().eventId, "Synthetic completed-course explanation.");
    expect((await messages()).map((m) => [m.role, m.job_state])).toEqual([["learner", "applied"], ["assistant", "applied"]]);
    expect(await allowance()).toEqual({ budget: 1, used: 1, remaining: 0 });
    expect(await learnerRecord()).toEqual(before);
    expect((await ask()).json().error).toBe("HELP_BUDGET_EXHAUSTED");
  });
});
