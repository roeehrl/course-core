import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { closeEnrollment, previewClosure } from "@course-core/policy";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4389",
  schema = "completed_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, enrollment: string;
interface Session { cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "completed:" + id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(action: string, body: Record<string, unknown>) {
  const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
  return call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
async function complete(access: "read_only" | "closed") {
  const row = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0];
  for (const scope of row.snapshot.scopes) scope.existingMaterialAccess = access;
  const policy = row.snapshot, now = new Date().toISOString();
  const command = { now, reason: "completed" as const, coveredObjectiveIds: policy.coreObjectiveIds, demonstratedConceptIds: [] };
  const preview = previewClosure(policy, command);
  const closed = closeEnrollment(policy, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: policy.policyRevision, expectedLedgerRevision: policy.ledgerRevision,
    idempotencyKey: "completion:" + enrollment, authorityReceipt: { receiptId: randomUUID(), actorId: "system:test", enrollmentId: enrollment, scopeId: "course", permission: "close_enrollment", termsDigest: preview.previewDigest, authorizedAt: now } });
  await db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollment, JSON.stringify(closed.state), closed.state.policyRevision, closed.state.ledgerRevision]);
  await db.query("UPDATE enrollments SET status='completed',policy_revision=$2,closed_at=now(),revision=revision+1 WHERE id=$1", [enrollment, closed.state.policyRevision]);
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "done-" + workspace, "Completed"]);
  owner = await session("owner");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  await call(owner, "POST", `/api/releases/${release}/publish`);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("questions after a course is completed", () => {
  it("keeps bounded explanatory questions but no new required work", async () => {
    await complete("read_only");
    const asked = await send("companion", { episodeId: "min", content: "Why does keeping the smaller value work?" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json().state).toBe("queued");
    const events = (await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.requested'", [enrollment])).rows;
    expect(events).toHaveLength(1);
    // Completion does not reopen checks or planning.
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" })).statusCode).toBe(409);
  });
  it("refuses questions when the course closed access to existing material", async () => {
    await complete("closed");
    expect((await send("companion", { episodeId: "min", content: "Why does keeping the smaller value work?" })).json().error).toBe("ACCESS_CLOSED");
  });
});

describe("evidence withdrawn after a course is completed", () => {
  it("does not reopen the course, keeps the closure report, tells the learner why and audits the amendment", async () => {
    const issued = await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await send("answers", { challengeId: issued.json().challengeId, answer: "two" })).statusCode).toBe(200);
    const evidenceId = (await db.query("SELECT id FROM evidence WHERE enrollment_id=$1 AND invalidated_at IS NULL", [enrollment])).rows[0].id as string;
    // Before closure the learner has no notices.
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().closedRecordNotices).toEqual([]);
    await complete("read_only");
    const before = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    const catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
    const course = (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json();
    const reason = "The key accepted a wrong ordering; this item was defective.";
    const rejected = await app.inject({ method: "POST", url: `/api/admin/courses/${catalog}/enrollments/${enrollment}/evidence/${evidenceId}/review`,
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.csrf, "if-match": String(course.revision), "idempotency-key": randomUUID() },
      payload: { decision: "reject", note: reason, enrollmentRevision: before.revision } });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const after = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    // Not reopened: still ended, no new required work, and checks stay closed.
    expect(["completed", "closed"]).toContain(after.status);
    expect(after.closureReport).toEqual(before.closureReport);
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" })).statusCode).toBe(409);
    expect(after.closedRecordNotices).toEqual([expect.objectContaining({ evidenceId, assessmentId: "min-a", objectiveId: "minimum", reason })]);
    const audit = (await db.query("SELECT actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed_record_amended'", [enrollment])).rows;
    expect(audit).toEqual([{ actor_kind: "system", payload: expect.objectContaining({ source: "evidence_rejected", assessmentId: "min-a", evidence: 1, statusBefore: "completed", reopened: false, closureReportKept: true }) }]);
    // The workspace audit log shows that system payload.
    const log = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=enrollment.closed_record_amended`)).json();
    expect(log.events).toEqual([expect.objectContaining({ actorKind: "system", payloadWithheld: false, payload: expect.objectContaining({ reopened: false }) })]);
  });
});
