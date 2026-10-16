import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { closeEnrollment, previewClosure } from "@course-core/policy";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";

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
async function complete(access: "read_only" | "closed", reason: "completed" | "cap" = "completed") {
  const row = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0];
  for (const scope of row.snapshot.scopes) scope.existingMaterialAccess = access;
  // A cap closure is evaluated after the fixture's 30-day window, so the policy accepts it as reached.
  const policy = row.snapshot, now = new Date(Date.now() + (reason === "cap" ? 31 * 86_400_000 : 0)).toISOString();
  const command = { now, reason, coveredObjectiveIds: reason === "cap" ? [] : policy.coreObjectiveIds, demonstratedConceptIds: [] };
  const preview = previewClosure(policy, command);
  const closed = closeEnrollment(policy, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: policy.policyRevision, expectedLedgerRevision: policy.ledgerRevision,
    idempotencyKey: reason + ":" + enrollment, authorityReceipt: { receiptId: randomUUID(), actorId: "system:test", enrollmentId: enrollment, scopeId: "course", permission: "close_enrollment", termsDigest: preview.previewDigest, authorizedAt: now } });
  await db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollment, JSON.stringify(closed.state), closed.state.policyRevision, closed.state.ledgerRevision]);
  await db.query("UPDATE enrollments SET status=$3,policy_revision=$2,closed_at=now(),revision=revision+1 WHERE id=$1", [enrollment, closed.state.policyRevision, reason === "cap" ? "closed" : "completed"]);
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
  /** Earn one piece of independent evidence, then close the enrollment the given way. */
  async function earnThenClose(reason: "completed" | "cap") {
    const issued = await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await send("answers", { challengeId: issued.json().challengeId, answer: "two" })).statusCode).toBe(200);
    const evidenceId = (await db.query("SELECT id FROM evidence WHERE enrollment_id=$1 AND invalidated_at IS NULL", [enrollment])).rows[0].id as string;
    // Before closure the learner has no notices.
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().closedRecordNotices).toEqual([]);
    await complete("read_only", reason);
    return { evidenceId, before: (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json() };
  }
  async function reject(evidenceId: string, enrollmentRevision: number, note: string) {
    const catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
    const course = (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json();
    return app.inject({ method: "POST", url: `/api/admin/courses/${catalog}/enrollments/${enrollment}/evidence/${evidenceId}/review`,
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.csrf, "if-match": String(course.revision), "idempotency-key": randomUUID() },
      payload: { decision: "reject", note, enrollmentRevision } });
  }
  const amendments = async () => (await db.query("SELECT actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed_record_amended'", [enrollment])).rows;

  it("does not reopen the course, keeps the closure report, tells the learner why and audits the amendment", async () => {
    const { evidenceId, before } = await earnThenClose("completed");
    expect(before.status).toBe("completed");
    const reason = "The key accepted a wrong ordering; this item was defective.";
    const rejected = await reject(evidenceId, before.revision, reason);
    expect(rejected.statusCode, rejected.body).toBe(200);
    const after = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    // Not reopened, and not downgraded: completion is the outcome recorded at closure. A later
    // rejection amends the record; it does not turn a completion into a cap/deadline closure.
    expect(after.status).toBe("completed");
    expect((await db.query("SELECT status FROM enrollments WHERE id=$1", [enrollment])).rows[0].status).toBe("completed");
    expect(after.closureReport).toEqual(before.closureReport);
    expect(after.closureReport.reason).toBe("completed");
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" })).statusCode).toBe(409);
    expect(after.closedRecordNotices).toEqual([expect.objectContaining({ evidenceId, assessmentId: "min-a", objectiveId: "minimum", reason })]);
    expect(await amendments()).toEqual([{ actor_kind: "system", payload: expect.objectContaining({ source: "evidence_rejected", assessmentId: "min-a", evidence: 1,
      statusBefore: "completed", statusAfter: "completed", reopened: false, closureReportKept: true }) }]);
    // The workspace audit log shows that system payload.
    const log = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=enrollment.closed_record_amended`)).json();
    expect(log.events).toEqual([expect.objectContaining({ actorKind: "system", payloadWithheld: false, payload: expect.objectContaining({ reopened: false, statusAfter: "completed" }) })]);
  });

  it("keeps completed-course questions and their answers after a rejection", async () => {
    const { evidenceId, before } = await earnThenClose("completed");
    expect((await reject(evidenceId, before.revision, "Defective key.")).statusCode).toBe(200);
    // The learner can still ask under the closed-course question budget...
    const asked = await send("companion", { episodeId: "min", content: "Why does keeping the smaller value work?" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json().state).toBe("queued");
    // ...and the supervisor still admits the completed-course companion answer. Before this fix the
    // rejection set the status to `closed`, so the question was queued but refused as 'inactive'.
    const bridge = createPostgresSupervisorBridge(db, { serviceToken: "synthetic-test-service-token-not-a-credential", workspaceIds: [workspace],
      jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
    await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10_000, tokens: 10_000 });
    await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 10_000, tokens: 10_000 });
    const lease = (await bridge.claimOutbox(randomUUID(), 100, 30_000)).find((row) => row.eventId === asked.json().eventId)!;
    expect(lease).toBeDefined();
    const refs = await bridge.prepareOutbox(lease);
    await bridge.ackOutbox(lease);
    const prepared = (await db.query("SELECT disposition FROM supervisor_preparations WHERE event_id=$1", [asked.json().eventId])).rows[0];
    expect(prepared.disposition).toBe("prepared");
    expect(refs).toHaveLength(1);
    expect((await db.query("SELECT role FROM supervisor_jobs WHERE id=$1", [refs[0]!.jobId])).rows[0].role).toBe("companion");
  });

  it("keeps a cap closure as closed: a rejection never upgrades or otherwise rewrites the outcome", async () => {
    const { evidenceId, before } = await earnThenClose("cap");
    expect(before.status).toBe("closed");
    expect(before.closureReport.reason).toBe("cap");
    const rejected = await reject(evidenceId, before.revision, "Defective key.");
    expect(rejected.statusCode, rejected.body).toBe(200);
    const after = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    expect(after.status).toBe("closed");
    expect(after.closureReport).toEqual(before.closureReport);
    expect(after.closedRecordNotices).toEqual([expect.objectContaining({ evidenceId, reason: "Defective key." })]);
    expect(await amendments()).toEqual([{ actor_kind: "system", payload: expect.objectContaining({ source: "evidence_rejected", statusBefore: "closed", statusAfter: "closed", reopened: false }) }]);
  });

  it("writes no closed-record amendment and changes no status for an active enrollment", async () => {
    const issued = await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
    expect((await send("answers", { challengeId: issued.json().challengeId, answer: "two" })).statusCode).toBe(200);
    const evidenceId = (await db.query("SELECT id FROM evidence WHERE enrollment_id=$1 AND invalidated_at IS NULL", [enrollment])).rows[0].id as string;
    const before = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    expect((await reject(evidenceId, before.revision, "Defective key.")).statusCode).toBe(200);
    const after = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    expect(after.status).toBe("active");
    expect(after.revision).toBe(before.revision + 1);
    expect(after.closedRecordNotices).toEqual([]);
    expect(await amendments()).toEqual([]);
  });
});
