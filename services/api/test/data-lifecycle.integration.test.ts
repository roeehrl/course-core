import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { tablesContaining } from "./table-scan.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge, parkSupervisorJob } from "../src/supervisor-bridge.js";

const origin = "http://localhost:4385",
  schema = "lifecycle_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, release: string, owner: Session, learner: Session, enrollment: string, canary: string;
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "lifecycle:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
async function command(action: string, body: Record<string, unknown>) {
  const snapshot = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
  const r = await call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, {
    expectedRevision: snapshot.revision,
    idempotencyKey: randomUUID(),
    ...body,
  });
  expect(r.statusCode, action + " " + r.body).toBe(200);
  return r.json();
}
/** Every row of every application table, as text, that still contains the canary. */
const canaryHits = () => tablesContaining(db, canary);
const erase = (who: Session, body: Record<string, unknown> = {}) =>
  call(who, "POST", `/api/enrollments/${enrollment}/erase`, {
    confirmation: `ERASE ${enrollment.slice(0, 8)}`,
    reason: "Learner asked for their course data to be removed.",
    ...body,
  });
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  canary = "CANARY-" + randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "life-" + workspace, "Lifecycle"]);
  owner = await session("owner");
  learner = await session("learner");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  await call(owner, "POST", `/api/releases/${release}/publish`);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await command("profile", { profile: { displayName: "Lifecycle learner", goal: "My private goal " + canary, pace: "steady" } });
  await command("read", { episodeId: "min", blockId: "min-text" });
  const challenge = await command("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
  await command("answers", { challengeId: challenge.challengeId, answer: 4 });
  await command("companion", { episodeId: "min", content: "Why does the minimum work? " + canary });
  await command("learner-model/profile", {
    profile: { preferences: { goal: "Model goal " + canary }, priorKnowledge: [{ objectiveId: "minimum", statement: "I think I know this " + canary }], thoughts: "Thoughts " + canary },
  });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("learner data export and erasure", () => {
  it("exports a learner's own complete record without grading keys, to them or an owner only", async () => {
    const r = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["content-disposition"]).toContain(`enrollment-${enrollment}.json`);
    const doc = r.json();
    expect(doc).toMatchObject({ format: "course-core.enrollment-export", formatVersion: 1 });
    expect(doc.enrollment.profile.goal).toContain(canary);
    expect(doc.companion.items.some((m: { content: string }) => m.content.includes(canary))).toBe(true);
    expect(doc.attempts.items).toHaveLength(1);
    expect(doc.attempts.items[0].response).toBe(4);
    expect(doc.evidence.items.length).toBeGreaterThan(0);
    expect(doc.events.items.map((e: { event_type: string }) => e.event_type)).toContain("assessment.submitted");
    expect(JSON.stringify(doc)).not.toContain('"grading"');
    expect(JSON.stringify(doc)).not.toContain("absoluteTolerance");
    // Staff scope: an owner may export on request; an instructor and another learner may not.
    const byOwner = await call(owner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(byOwner.statusCode).toBe(200);
    // Through either path, a staff copy leaves out the companion conversation and the learner model.
    expect(byOwner.json()).toMatchObject({ audience: "staff", companion: null, learnerModel: null });
    for (const marker of ["Why does the minimum work? ", "Model goal ", "I think I know this ", "Thoughts "]) {
      expect(r.body).toContain(marker + canary);
      expect(byOwner.body).not.toContain(marker + canary);
    }
    expect((await call(await session("instructor"), "GET", `/api/enrollments/${enrollment}/export`)).statusCode).toBe(404);
    expect((await call(await session("learner"), "GET", `/api/enrollments/${enrollment}/export`)).statusCode).toBe(404);
    const exports = await db.query("SELECT actor_kind FROM data_exports WHERE enrollment_id=$1 ORDER BY created_at", [enrollment]);
    expect(exports.rows.map((r) => r.actor_kind)).toEqual(["learner", "staff"]);
  });

  it("erases personal content everywhere, keeps an auditable skeleton and blocks further use", async () => {
    expect((await canaryHits()).length).toBeGreaterThan(0);
    expect((await erase(learner, { confirmation: "ERASE" })).json().error).toBe("ERASURE_CONFIRMATION_REQUIRED");
    expect((await erase(await session("instructor"))).statusCode).toBe(404);
    const erased = await erase(learner);
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json()).toMatchObject({ status: "erased", replayed: false });
    expect(erased.json().counts.companionMessages).toBeGreaterThan(0);
    expect(erased.json().counts.attempts).toBe(1);
    // No table anywhere still holds the learner's private text.
    expect(await canaryHits()).toEqual([]);
    const attempt = (await db.query("SELECT response,result FROM attempts WHERE enrollment_id=$1", [enrollment])).rows[0];
    expect(attempt).toEqual({ response: { erased: true }, result: { erased: true } });
    // Skeleton: identifiers, timestamps and event types remain for audit.
    const events = (await db.query("SELECT event_type,payload FROM learning_events WHERE enrollment_id=$1", [enrollment])).rows;
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((e) => JSON.stringify(e.payload) === '{"erased":true}')).toBe(true);
    // Reads and commands stop; the learner cannot silently re-enroll into the erased record.
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).statusCode).toBe(410);
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}/companion`)).statusCode).toBe(410);
    expect((await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().error).toBe("ENROLLMENT_ERASED");
    expect((await call(learner, "GET", "/api/enrollments")).json()).toEqual([expect.objectContaining({ id: enrollment, status: "erased" })]);
    // Replays are idempotent; staff still see a coherent workspace.
    expect((await erase(learner)).json()).toMatchObject({ replayed: true, counts: erased.json().counts });
    const catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
    const view = await call(owner, "GET", "/api/admin/courses/" + catalog);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().enrollments[0]).toMatchObject({ status: "erased", evidence: [] });
    const audit = (await db.query("SELECT event_type,payload FROM learning_events WHERE workspace_id=$1 AND event_type='data.erased'", [workspace])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].payload)).not.toContain("Learner asked");
    // Immutability is unchanged outside an erasure transaction.
    expect((await db.query("SELECT count(*)::int AS n FROM learner_model_changes WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBeGreaterThan(0);
    await expect(db.query("UPDATE learner_model_changes SET data='{}'::jsonb WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/IMMUTABLE/);
    // The redaction exception is scoped to the named enrollment and its transaction.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('course_core.erasure_enrollment',$1,true)", [randomUUID()]);
      await expect(client.query("UPDATE learner_model_changes SET data='{}'::jsonb WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/IMMUTABLE/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('course_core.erasure_enrollment',$1,true)", [enrollment]);
      await expect(client.query("DELETE FROM learner_model_changes WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/IMMUTABLE/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("signals live supervisor jobs, ends parked ones without a provider call, and then erases", async () => {
    for (const scope of [{ workspaceId: workspace }, { workspaceId: workspace, enrollmentId: enrollment }])
      await configureSupervisorBudget(db, scope, { microUsd: 10_000, tokens: 10_000 });
    const bridge = createPostgresSupervisorBridge(db, {
      workspaceIds: [workspace],
      jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 },
    });
    const refs = [];
    for (const lease of await bridge.claimOutbox(randomUUID(), 100, 30_000)) {
      refs.push(...(await bridge.prepareOutbox(lease)));
      await bridge.ackOutbox(lease);
    }
    expect(refs.length).toBeGreaterThanOrEqual(2);
    const [calling, parked, ...others] = refs;
    const claim = () =>
      bridge.transition({ type: "claim", ref: calling!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
    const claimed = await claim();
    expect(claimed.effect).toBe("invoke");
    await parkSupervisorJob(db, parked!, "needs_input");
    const stateOf = async (jobId: string) =>
      (await db.query("SELECT state,result->>'reason' AS reason,cancellation_requested FROM supervisor_jobs WHERE id=$1", [jobId])).rows[0];

    expect((await erase(learner)).json().error).toBe("ERASURE_WAITING_FOR_SUPERVISION");
    // The cancellation is stored and queued for signalling to every live job's workflow.
    const deliveries = await bridge.claimCancellations(randomUUID(), 10, 30_000);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ reason: "data_erasure", enrollmentId: enrollment });
    expect(deliveries[0]!.jobs.map((r) => r.jobId).sort()).toEqual(refs.map((r) => r.jobId).sort());
    expect(await bridge.ackCancellation(deliveries[0]!, true)).toBe(true);
    // A second request while waiting signals again (an earlier signal may have been lost) without re-marking.
    expect((await erase(learner)).statusCode).toBe(409);
    expect(await bridge.claimCancellations(randomUUID(), 10, 30_000)).toHaveLength(1);

    // Reconciliation ends jobs that no workflow will step: parked and queued ones, without a call.
    await bridge.reconcile(100);
    for (const ref of [parked!, ...others]) expect(await stateOf(ref.jobId)).toEqual({ state: "cancelled", reason: "cancel_requested", cancellation_requested: true });
    // The job with its call out is left to its signalled workflow, which settles the call and stops.
    expect(["running", "analyzing", "building", "evaluating"]).toContain((await stateOf(calling!.jobId)).state);
    const op = claimed.snapshot.operations[0]!;
    const settled = await bridge.transition({ type: "settle", ref: calling!, operationId: op.id, ownerId: op.ownerId, outcome: { status: "not_started", retryable: true } });
    expect(settled).toMatchObject({ effect: "stop", snapshot: { state: "cancelled", reason: "cancel_requested" } });
    expect((await claim()).effect).toBe("stop");

    expect((await erase(learner)).statusCode).toBe(200);
    expect(await canaryHits()).toEqual([]);
  });

  it("stops supervision first and waits for running jobs before erasing", async () => {
    const job = randomUUID();
    await db.query(
      "INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES($1,$2,$3,$4,'companion','running',1,'{}'::jsonb)",
      [job, enrollment, workspace, "wf-" + job],
    );
    const waiting = await erase(learner);
    expect(waiting.json().error).toBe("ERASURE_WAITING_FOR_SUPERVISION");
    expect((await db.query("SELECT cancellation_requested FROM supervisor_jobs WHERE id=$1", [job])).rows[0].cancellation_requested).toBe(true);
    expect((await canaryHits()).length).toBeGreaterThan(0);
    await db.query("UPDATE supervisor_jobs SET state='cancelled' WHERE id=$1", [job]);
    expect((await erase(learner)).statusCode).toBe(200);
    expect(await canaryHits()).toEqual([]);
  });
});
