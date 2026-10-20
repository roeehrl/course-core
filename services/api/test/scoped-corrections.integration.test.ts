import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { rubricCourse, rubricExplanation } from "./rubric-fixture.js";
import { recordSyntheticRun } from "./run-fixture.js";

// Real HTTP and PostgreSQL 17: the debug inspector reachable from the learner app (U01) and the
// scoped retry and regrade controls (U07): role matrix, audit receipts, idempotency, refusals for
// an erased or closed enrollment, and the link between a regrade and the decision it supersedes.
const origin = "http://localhost:4393",
  schema = "scoped_corrections_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bare: Awaited<ReturnType<typeof createServer>>, adminDirectory: string;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, admin: Session, instructor: Session, reviewer: Session, observer: Session, learner: Session;
let catalog: string, release: string, enrollment: string, versions = 0;

async function person(role: string, workspaceId = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "sc:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown, server = app) =>
  server.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(who: Session, id: string, action: string, body: Record<string, unknown>) {
  const revision = (await call(who, "GET", "/api/enrollments/" + id)).json().revision;
  const r = await call(who, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
/** The learner answers one item; returns the attempt id. */
async function answer(assessmentId: string, response: unknown, who = learner, id = enrollment) {
  const issued = await send(who, id, "challenges", { episodeId: "min", assessmentId, mode: "independent" });
  await send(who, id, "answers", { challengeId: issued.challengeId, answer: response });
  return (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 ORDER BY submitted_at DESC LIMIT 1", [id])).rows[0].id as string;
}
const findings = (over: Record<string, unknown> = {}) => [
  { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
  { criterionId: "every-element", met: true, quote: "compare every next element with it" },
  { criterionId: "edge", met: false, note: "Empty list not discussed." },
].map((f) => (over[f.criterionId] ? { ...f, ...(over[f.criterionId] as object) } : f));
const notMet = () => findings({ invariant: { met: false, quote: undefined } }).map(({ quote, ...f }) => (quote === undefined ? f : { ...f, quote }));
const regradePath = (attemptId: string, e = enrollment) => `/api/admin/enrollments/${e}/attempts/${attemptId}/regrade`;
const regrade = (who: Session, attemptId: string, body: Record<string, unknown> = {}, e = enrollment) =>
  call(who, "POST", regradePath(attemptId, e), { idempotencyKey: "rg-" + randomUUID(), reason: "The evaluator was fixed; grading this answer again.", ...body });
const runPath = (runId: string) => `/api/admin/courses/${catalog}/runs/${runId}`;
const retry = (who: Session, runId: string, body: Record<string, unknown> = {}) =>
  call(who, "POST", `${runPath(runId)}/retry`, { idempotencyKey: "rt-" + randomUUID(), reason: "Provider outage ended; running this again.", ...body });
async function endedRun(state: "failed" | "cancelled" | "applied" | "running", options: { uncertain?: boolean; role?: "supervisor" | "companion" } = {}) {
  const { jobId } = await recordSyntheticRun(db, { workspaceId: workspace, enrollmentId: enrollment, releaseId: release, learnerId: learner.userId, ...(options.role ? { role: options.role } : {}) });
  const op = options.uncertain ? `, '{operations,0,status}', '"uncertain"'` : "";
  await db.query(`UPDATE supervisor_jobs SET state=$2,runtime_snapshot=jsonb_set(jsonb_set(runtime_snapshot,'{state}',to_jsonb($2::text)),'{reason}',$3::jsonb) WHERE id=$1`,
    [jobId, state, state === "failed" ? '"attempts_exhausted"' : state === "cancelled" ? '"cancel_requested"' : "null"]);
  if (op) await db.query(`UPDATE supervisor_jobs SET runtime_snapshot=jsonb_set(jsonb_set(runtime_snapshot,'{operations,0,status}','"uncertain"'),'{operations,0,outcome}','{"status":"uncertain"}') WHERE id=$1`, [jobId]);
  return jobId;
}
const count = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].n as number;
const erase = async (id = enrollment, who = learner) => {
  const r = await call(who, "POST", `/api/enrollments/${id}/erase`, { confirmation: `ERASE ${id.slice(0, 8)}`, reason: "Synthetic learner asked for erasure." });
  expect(r.statusCode, r.body).toBe(200);
};
const close = (id = enrollment) => db.query("UPDATE enrollments SET status='closed',closed_at=now() WHERE id=$1", [id]);

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  adminDirectory = mkdtempSync(join(tmpdir(), "inspector-admin-"));
  writeFileSync(join(adminDirectory, "index.html"), "<!doctype html><title>Admin</title>");
  const options = { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] };
  app = await createServer(db, { ...options, adminDirectory });
  bare = await createServer(db, options);
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "sc-" + workspace, "Scoped corrections"]);
  owner = await person("owner");
  admin = await person("admin");
  instructor = await person("instructor");
  reviewer = await person("reviewer");
  observer = await person("observer");
  learner = await person("learner");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse(`2.1.${versions++}`))).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 10_000, tokens: 10_000 });
});
afterAll(async () => {
  await app?.close();
  await bare?.close();
  await db?.end();
  await testDatabase?.drop();
  if (adminDirectory) rmSync(adminDirectory, { recursive: true, force: true });
});

describe("debug inspector from the learner app (U01)", () => {
  it("is offered only to an account with the learner-view permission on that enrollment; a learner never gets it", async () => {
    const access = (who: Session, id = enrollment, server = app) => call(who, "GET", `/api/enrollments/${id}/debug-inspector`, undefined, server);
    const own = await access(learner);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.headers["cache-control"]).toBe("no-store");
    expect(own.json()).toEqual({ available: false, permissions: [] });
    // A workspace owner who is also enrolled in the course.
    const ownerEnrollment = (await call(owner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const staff = (await access(owner, ownerEnrollment)).json();
    expect(staff).toMatchObject({ available: true, role: "owner", path: "/admin/inspector", receipt: "learner.viewed_by_staff" });
    expect(staff.permissions).toEqual(expect.arrayContaining(["learner.view", "run.inspect", "run.payload", "run.retry", "evidence.regrade"]));
    // Admins see it on someone else's enrollment; other staff do not, and outsiders learn nothing.
    expect((await access(admin)).json()).toMatchObject({ available: true, role: "admin" });
    expect((await access(instructor)).json()).toEqual({ available: false, permissions: [] });
    expect((await access(reviewer)).statusCode).toBe(404);
    expect((await access(observer)).statusCode).toBe(404);
    const elsewhere = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [elsewhere, "sc-" + elsewhere, "Elsewhere"]);
    expect((await access(await person("owner", elsewhere))).statusCode).toBe(404);
    // Without the admin export there is no inspector page to open.
    expect((await access(owner, ownerEnrollment, bare)).json()).toEqual({ available: false, permissions: [] });
    await erase(ownerEnrollment, owner);
    expect((await access(owner, ownerEnrollment)).statusCode).toBe(410);
  });

  it("is enforced by the server: each open is an audited learner-view read, which a learner is refused", async () => {
    const ownerEnrollment = (await call(owner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    expect((await call(learner, "GET", `/api/admin/enrollments/${enrollment}/learner-view`)).statusCode).toBe(403);
    expect((await call(learner, "GET", `/api/admin/enrollments/${enrollment}/runs`)).statusCode).toBe(403);
    expect(await count("SELECT count(*)::int AS n FROM staff_learner_views WHERE workspace_id=$1", [workspace])).toBe(0);
    for (let open = 0; open < 2; open++) {
      const view = await call(owner, "GET", `/api/admin/enrollments/${ownerEnrollment}/learner-view`);
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json()).toMatchObject({ readOnly: true, view: { viewer: { id: owner.userId, role: "owner" }, visibleToLearner: true } });
    }
    // The same receipt the staff path writes: a recorded view and a workspace audit event, per open.
    expect((await db.query("SELECT viewer_id,viewer_role FROM staff_learner_views WHERE enrollment_id=$1", [ownerEnrollment])).rows)
      .toEqual([{ viewer_id: owner.userId, viewer_role: "owner" }, { viewer_id: owner.userId, viewer_role: "owner" }]);
    expect(await count("SELECT count(*)::int AS n FROM learning_events WHERE event_type='learner.viewed_by_staff' AND payload->>'enrollmentId'=$1", [ownerEnrollment])).toBe(2);
    expect((await call(owner, "GET", `/api/enrollments/${ownerEnrollment}/staff-views`)).json().views).toHaveLength(2);
  });

  it("serves the inspector page frameable by this origin only, and every other page keeps frame-ancestors 'none'", async () => {
    const page = await app.inject({ url: "/admin/inspector" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    const admin = await app.inject({ url: "/admin/" });
    expect(admin.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await app.inject({ url: "/api/health" })).headers["content-security-policy"] ?? "frame-ancestors 'none'").toContain("frame-ancestors 'none'");
    expect((await bare.inject({ url: "/admin/inspector" })).statusCode).toBe(404);
  });
});

describe("retrying one supervisor run (U07)", () => {
  it("only owners and admins may retry; other staff and the learner are refused and nothing is written", async () => {
    const runId = await endedRun("failed");
    for (const who of [instructor, reviewer, observer, learner]) expect((await retry(who, runId)).statusCode).toBe(403);
    expect(await count("SELECT count(*)::int AS n FROM supervisor_job_retries WHERE workspace_id=$1", [workspace])).toBe(0);
    expect((await retry(admin, runId)).statusCode).toBe(200);
    expect((await retry(owner, await endedRun("failed"))).statusCode).toBe(200);
    expect((await retry(owner, randomUUID())).statusCode).toBe(404);
    expect((await call(owner, "POST", `${runPath(runId)}/retry`, { idempotencyKey: "rt-" + randomUUID(), reason: "short" })).statusCode).toBe(400);
  });

  it("runs a failed run again as a new run through the dispatcher, linked both ways, idempotently and once", async () => {
    const runId = await endedRun("failed");
    const before = (await db.query("SELECT state,runtime_snapshot FROM supervisor_jobs WHERE id=$1", [runId])).rows[0];
    const key = "rt-" + randomUUID(), reason = "Provider outage RT-CANARY ended; running this again.";
    const first = await retry(owner, runId, { idempotencyKey: key, reason });
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json();
    expect(body).toEqual({ runId, retryEventId: expect.any(String), outcome: "failed", previousState: "failed", previousReason: "attempts_exhausted", state: "queued", replayed: false });
    // Same key and request: the stored answer. Same key, other request: a conflict. New key: once only.
    expect((await retry(owner, runId, { idempotencyKey: key, reason })).json()).toEqual({ ...body, replayed: true });
    expect((await retry(owner, runId, { idempotencyKey: key, reason: "A different reason for the same key." })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    const again = await retry(admin, runId);
    expect([again.statusCode, again.json().error]).toEqual([409, "RUN_ALREADY_RETRIED"]);
    // Audit: a staff event on the learner's record (no reason), the retry row (with it).
    const events = (await db.query("SELECT actor_id,actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='supervisor.run_retry_requested'", [enrollment])).rows;
    expect(events).toEqual([{ actor_id: owner.userId, actor_kind: "staff",
      payload: { runId, role: "supervisor", outcome: "failed", previousState: "failed", previousReason: "attempts_exhausted" } }]);
    expect((await db.query("SELECT actor_id,reason,outcome FROM supervisor_job_retries WHERE job_id=$1", [runId])).rows).toEqual([{ actor_id: owner.userId, reason, outcome: "failed" }]);
    const audit = await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=supervisor.run_retry_requested`);
    expect(audit.json().events).toEqual([expect.objectContaining({ actor: "owner person", payloadWithheld: false, payload: expect.objectContaining({ runId }) })]);
    expect(audit.body).not.toContain("RT-CANARY");
    // The dispatcher prepares it into its own new run (never coalesced); the old run is untouched.
    const bridge = createPostgresSupervisorBridge(db, { serviceToken: "synthetic-test-service-token-not-a-credential", workspaceIds: [workspace],
      jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
    const lease = await bridge.claimOutboxEvent(body.retryEventId, randomUUID(), 30_000);
    expect(lease).not.toBeNull();
    const prepared = await bridge.prepareOutbox(lease!);
    expect(prepared).toHaveLength(1);
    const next = prepared[0]!.jobId;
    expect(next).not.toBe(runId);
    expect((await db.query("SELECT role,state,input_event_id FROM supervisor_jobs WHERE id=$1", [next])).rows[0]).toEqual({ role: "supervisor", state: "queued", input_event_id: body.retryEventId });
    expect((await db.query("SELECT state,runtime_snapshot FROM supervisor_jobs WHERE id=$1", [runId])).rows[0]).toEqual(before);
    const old = (await call(instructor, "GET", runPath(runId))).json();
    expect(old.retry).toEqual({ retryOf: null, retriedBy: { eventId: body.retryEventId, runId: next, outcome: "failed", at: expect.any(String) } });
    expect((await call(instructor, "GET", runPath(next))).json().retry).toEqual({ retryOf: runId, retriedBy: null });
  });

  it("retries a run that ended with an uncertain call, and refuses live, applied and request-bound runs", async () => {
    const uncertain = await retry(owner, await endedRun("cancelled", { uncertain: true }));
    expect(uncertain.statusCode, uncertain.body).toBe(200);
    expect(uncertain.json()).toMatchObject({ outcome: "uncertain", previousState: "cancelled" });
    const refusal = async (runId: string) => { const r = await retry(owner, runId); return [r.statusCode, r.json().error]; };
    expect(await refusal(await endedRun("running"))).toEqual([409, "RUN_NOT_ENDED"]);
    expect(await refusal(await endedRun("applied"))).toEqual([409, "RUN_NOT_RETRYABLE"]);
    expect(await refusal(await endedRun("cancelled"))).toEqual([409, "RUN_NOT_RETRYABLE"]);
    expect(await refusal(await endedRun("failed", { role: "companion" }))).toEqual([409, "RUN_RETRY_UNSUPPORTED"]);
    await db.query("INSERT INTO supervisor_controls(enrollment_id,workspace_id,state,revision) VALUES($1,$2,'stopped',1)", [enrollment, workspace]);
    expect(await refusal(await endedRun("failed"))).toEqual([409, "SUPERVISION_STOPPED"]);
    expect(await count("SELECT count(*)::int AS n FROM supervisor_job_retries WHERE workspace_id=$1", [workspace])).toBe(1);
  });

  it("refuses a closed enrollment (409) and an erased one (410), and erasure redacts an earlier reason", async () => {
    const done = await endedRun("failed"), pending = await endedRun("failed");
    expect((await retry(owner, done, { reason: "Ticket RT-ERASE-CANARY: retrying." })).statusCode).toBe(200);
    await close();
    const closed = await retry(owner, pending);
    expect([closed.statusCode, closed.json().error]).toEqual([409, "ENROLLMENT_CLOSED"]);
    await db.query("UPDATE enrollments SET status='active',closed_at=NULL WHERE id=$1", [enrollment]);
    await erase();
    const erased = await retry(owner, pending);
    expect([erased.statusCode, erased.json().error]).toEqual([410, "ENROLLMENT_ERASED"]);
    expect((await db.query("SELECT reason FROM supervisor_job_retries WHERE job_id=$1", [done])).rows).toEqual([{ reason: "[erased]" }]);
    expect(await count("SELECT count(*)::int AS n FROM supervisor_job_retries t WHERE t::text LIKE '%RT-ERASE-CANARY%'", [])).toBe(0);
  });
});

describe("regrading one attempt (U07)", () => {
  /** A choice answer recorded wrong by a faulty evaluator: the stored grade disagrees with the key. */
  async function misgraded() {
    const attemptId = await answer("min-a", "two");
    await db.query("UPDATE attempts SET result=jsonb_set(result,'{passed}','false') WHERE id=$1", [attemptId]);
    await db.query("UPDATE evidence SET result='{\"passed\":false}' WHERE attempt_id=$1", [attemptId]);
    return attemptId;
  }

  it("follows the role matrix: owners, admins and instructors; never reviewers, observers, the learner or their own answer", async () => {
    const attemptId = await misgraded();
    for (const who of [reviewer, observer, learner]) expect((await regrade(who, attemptId)).statusCode).toBe(403);
    expect((await call(reviewer, "GET", regradePath(attemptId))).statusCode).toBe(403);
    expect(await count("SELECT count(*)::int AS n FROM attempt_regrades WHERE workspace_id=$1", [workspace])).toBe(0);
    expect((await regrade(instructor, attemptId)).statusCode).toBe(200);
    expect((await regrade(admin, attemptId)).statusCode).toBe(200);
    expect((await regrade(owner, attemptId)).statusCode).toBe(200);
    // An owner who is also enrolled cannot regrade their own answer.
    const ownEnrollment = (await call(owner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const own = await answer("min-a", "five", owner, ownEnrollment);
    const self = await regrade(owner, own, {}, ownEnrollment);
    expect([self.statusCode, self.json().error]).toEqual([403, "SELF_REVIEW_FORBIDDEN"]);
  });

  it("grades an automated attempt again with the course's evaluator: a new decision linked to the old, new evidence, gate path recomputed", async () => {
    const attemptId = await misgraded();
    const stored = (await db.query("SELECT result,response FROM attempts WHERE id=$1", [attemptId])).rows[0];
    const oldEvidence = (await db.query("SELECT id FROM evidence WHERE attempt_id=$1", [attemptId])).rows.map((r) => r.id);
    const decisionsBefore = await count("SELECT count(*)::int AS n FROM gate_decisions WHERE enrollment_id=$1", [enrollment]);
    const key = "rg-" + randomUUID(), reason = "Choice key fixed RG-CANARY; grading again.";
    const r = await regrade(instructor, attemptId, { idempotencyKey: key, reason });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body).toEqual({ regradeId: expect.any(String), attemptId, kind: "automated", outcome: "changed", passed: true, previousPassed: false,
      supersedes: { kind: "attempt", id: attemptId }, eventId: expect.any(String), evidence: { invalidated: 1, created: 1 }, replayed: false });
    // Past evidence is never rewritten: the attempt keeps its result; old evidence is invalidated with a reason.
    expect((await db.query("SELECT result,response FROM attempts WHERE id=$1", [attemptId])).rows[0]).toEqual(stored);
    expect((await db.query("SELECT id,invalidation_reason FROM evidence WHERE attempt_id=$1 AND invalidated_at IS NOT NULL", [attemptId])).rows)
      .toEqual(oldEvidence.map((id) => ({ id, invalidation_reason: "Superseded by a regrade" })));
    const fresh = (await db.query("SELECT result,independent,evaluator_ref FROM evidence WHERE attempt_id=$1 AND invalidated_at IS NULL", [attemptId])).rows;
    expect(fresh).toEqual([{ result: { passed: true, regraded: true, regradeId: body.regradeId }, independent: true, evaluator_ref: expect.stringMatching(/choice/) }]);
    expect(await count("SELECT count(*)::int AS n FROM gate_decisions WHERE enrollment_id=$1", [enrollment])).toBeGreaterThan(decisionsBefore);
    // Idempotent under its key; a different request under the same key is a conflict.
    expect((await regrade(instructor, attemptId, { idempotencyKey: key, reason })).json()).toEqual({ ...body, replayed: true });
    expect((await regrade(instructor, attemptId, { idempotencyKey: key, reason: "Some other reason for this key." })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    // Audit: staff event without the reason; the regrade row keeps it.
    const audit = await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=assessment.regraded`);
    expect(audit.json().events).toEqual([expect.objectContaining({ actor: "instructor person", payload: expect.objectContaining({ regradeId: body.regradeId, outcome: "changed" }) })]);
    expect(audit.body).not.toContain("RG-CANARY");
    // A second regrade supersedes the first: an upheld decision changes no evidence.
    const second = (await regrade(admin, attemptId)).json();
    expect(second).toMatchObject({ outcome: "upheld", passed: true, previousPassed: true, supersedes: { kind: "regrade", id: body.regradeId }, evidence: { invalidated: 0, created: 0 } });
    const view = (await call(owner, "GET", regradePath(attemptId))).json();
    expect(view).toMatchObject({ kind: "automated", current: { kind: "regrade", id: second.regradeId, passed: true } });
    expect(view.history.map((h: { regradeId: string; supersedes: unknown; actor: string }) => [h.regradeId, h.supersedes, h.actor])).toEqual([
      [body.regradeId, { kind: "attempt", id: attemptId }, "instructor person"], [second.regradeId, { kind: "regrade", id: body.regradeId }, "admin person"]]);
  });

  it("takes a rubric attempt's second decision from a different person under the quoting rules, and the learner sees it", async () => {
    const attemptId = await answer("min-explain", rubricExplanation);
    const reviewed = await call(instructor, "POST", `/api/admin/rubric-reviews/${attemptId}`, { decision: "met", criteria: findings(), idempotencyKey: "rv-" + randomUUID() });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const reviewId = (await db.query("SELECT id FROM rubric_reviews WHERE attempt_id=$1", [attemptId])).rows[0].id;
    // Findings are required, the original reviewer is refused, a quote must be the learner's words.
    expect((await regrade(owner, attemptId)).json().error).toBe("RUBRIC_FINDINGS_REQUIRED");
    expect((await regrade(instructor, attemptId, { decision: "not_met", criteria: notMet() })).json().error).toBe("SECOND_REVIEWER_REQUIRED");
    expect((await regrade(owner, attemptId, { decision: "met", criteria: findings({ invariant: { quote: "words the learner never wrote at all" } }) })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    const view = (await call(owner, "GET", regradePath(attemptId))).json();
    expect(view).toMatchObject({ kind: "rubric", current: { kind: "review", id: reviewId, passed: true, decision: "met" }, rubric: { answers: [rubricExplanation] } });
    const r = await regrade(owner, attemptId, { decision: "not_met", criteria: notMet() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ kind: "rubric", outcome: "changed", passed: false, previousPassed: true, supersedes: { kind: "review", id: reviewId } });
    // The review row is unchanged; the learner's view shows the new decision and can no longer appeal.
    expect((await db.query("SELECT decision FROM rubric_reviews WHERE id=$1", [reviewId])).rows).toEqual([{ decision: "met" }]);
    const mine = (await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews.find((x: { attemptId: string }) => x.attemptId === attemptId);
    expect(mine).toMatchObject({ status: "not_met", canAppeal: false, regrade: { outcome: "changed", at: expect.any(String) } });
    expect(mine.criteria.find((c: { id: string }) => c.id === "invariant").met).toBe(false);
    const revision = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().revision;
    const appeal = await call(learner, "POST", `/api/enrollments/${enrollment}/reviews/${attemptId}/appeal`, { expectedRevision: revision, idempotencyKey: randomUUID(), reason: "Please look again at my answer." });
    expect([appeal.statusCode, appeal.json().error]).toEqual([409, "ALREADY_REGRADED"]);
  });

  it("leaves an open appeal to the appeal queue and an unreviewed answer to the review queue", async () => {
    const pending = await answer("min-explain", rubricExplanation);
    expect((await regrade(owner, pending, { decision: "met", criteria: findings() })).json().error).toBe("NOT_YET_REVIEWED");
    expect((await call(instructor, "POST", `/api/admin/rubric-reviews/${pending}`, { decision: "not_met", criteria: notMet(), idempotencyKey: "rv-" + randomUUID() })).statusCode).toBe(200);
    await send(learner, enrollment, `reviews/${pending}/appeal`, { reason: "Please look again at my answer." });
    expect((await regrade(owner, pending, { decision: "met", criteria: findings() })).json().error).toBe("APPEAL_OPEN");
  });

  it("refuses a closed enrollment (409) and an erased one (410); erasure redacts reasons and quoted findings", async () => {
    const attemptId = await misgraded();
    expect((await regrade(owner, attemptId, { reason: "Ticket RG-ERASE-CANARY: grading again." })).statusCode).toBe(200);
    await close();
    const closed = await regrade(admin, attemptId);
    expect([closed.statusCode, closed.json().error]).toEqual([409, "ENROLLMENT_CLOSED"]);
    await db.query("UPDATE enrollments SET status='active',closed_at=NULL WHERE id=$1", [enrollment]);
    await erase();
    const erased = await regrade(admin, attemptId);
    expect([erased.statusCode, erased.json().error]).toEqual([410, "ENROLLMENT_ERASED"]);
    expect((await call(admin, "GET", regradePath(attemptId))).statusCode).toBe(410);
    expect((await db.query("SELECT reason,result FROM attempt_regrades WHERE attempt_id=$1", [attemptId])).rows).toEqual([{ reason: "[erased]", result: { passed: true } }]);
  });

  it("refuses evidence staff already withdrew, and answers outside the gate path", async () => {
    const attemptId = await misgraded();
    await db.query("UPDATE evidence SET invalidated_at=now(),invalidation_reason='Defective item' WHERE attempt_id=$1", [attemptId]);
    expect((await regrade(owner, attemptId)).json().error).toBe("EVIDENCE_INVALIDATED");
    const issued = await send(learner, enrollment, "challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
    await send(learner, enrollment, "answers", { challengeId: issued.challengeId, abstain: true });
    const abstained = (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 ORDER BY submitted_at DESC LIMIT 1", [enrollment])).rows[0].id;
    expect((await regrade(owner, abstained)).json().error).toBe("NOTHING_TO_REGRADE");
    expect((await regrade(owner, randomUUID())).statusCode).toBe(404);
  });
});
