import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { claimCancellationDeliveries } from "../src/supervisor-cancellation.js";
import { recordSyntheticRun } from "./run-fixture.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: per-run cancel, retry of a staff-cancelled run, and batch replay of
// a course's finished runs (U07): roles, receipts, idempotency and refusals.
const origin = "http://localhost:4389",
  schema = "run_controls_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, instructor: Session, reviewer: Session, learner: Session, catalog: string, release: string, enrollment: string;

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "rc:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const runPath = (runId: string) => `/api/admin/courses/${catalog}/runs/${runId}`;
const recordRun = () => recordSyntheticRun(db, { workspaceId: workspace, enrollmentId: enrollment, releaseId: release, learnerId: learner.userId });
/** Ends a run as the bridge would: the row and its runtime snapshot agree on the state. */
const end = (ids: string | string[], state: "applied" | "cancelled", flagged = false) =>
  db.query("UPDATE supervisor_jobs SET state=$2,cancellation_requested=cancellation_requested OR $3,runtime_snapshot=jsonb_set(runtime_snapshot,'{state}',to_jsonb($2::text)) WHERE id=ANY($1::uuid[])",
    [[ids].flat(), state, flagged]);
const cancel = (who: Session, runId: string, body: Record<string, unknown> = {}) =>
  call(who, "POST", `${runPath(runId)}/cancel`, { idempotencyKey: "cx-" + randomUUID(), reason: "Wrong learner context; stopping this run.", ...body });

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "rc-" + workspace, "Run controls"]);
  owner = await person("owner");
  instructor = await person("instructor");
  reviewer = await person("reviewer");
  learner = await person("learner");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("per-run cancel", () => {
  it("flags only that run, queues its wake-up, records a staff event and is idempotent", async () => {
    const { jobId } = await recordRun(), other = (await recordRun()).jobId;
    const key = "cx-" + randomUUID();
    const done = await cancel(instructor, jobId, { idempotencyKey: key });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ runId: jobId, previousState: "ready", state: "cancel_requested", signalled: true, replayed: false });
    const flags = (await db.query("SELECT id,cancellation_requested FROM supervisor_jobs WHERE enrollment_id=$1", [enrollment])).rows;
    expect(Object.fromEntries(flags.map((r) => [r.id, r.cancellation_requested]))).toEqual({ [jobId]: true, [other]: false });
    const deliveries = await claimCancellationDeliveries(db, [workspace], randomUUID(), 10, 30_000);
    expect(deliveries).toEqual([expect.objectContaining({ reason: "staff_cancelled", jobs: [expect.objectContaining({ jobId })] })]);
    const events = (await db.query("SELECT actor_id,actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='supervisor.run_cancel_requested'", [enrollment])).rows;
    expect(events).toEqual([{ actor_id: instructor.userId, actor_kind: "staff", payload: { runId: jobId, role: "supervisor", previousState: "ready", signalled: true } }]);
    // The same request replays; a new request on a flagged run is refused.
    expect((await cancel(instructor, jobId, { idempotencyKey: key })).json()).toMatchObject({ replayed: true, runId: jobId });
    expect((await cancel(instructor, jobId, { idempotencyKey: key, reason: "A different reason for the same key." })).statusCode).toBe(409);
    expect((await cancel(owner, jobId)).json().error).toBe("RUN_CANCEL_ALREADY_REQUESTED");
    // The audit log shows the cancellation with its ids, never the staff reason.
    const audit = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?limit=20`)).json().events
      .find((e: { type: string }) => e.type === "supervisor.run_cancel_requested");
    expect(audit).toMatchObject({ actorKind: "staff", payload: { runId: jobId } });
    expect(JSON.stringify(audit)).not.toContain("Wrong learner context");
  });

  it("refuses ended runs, unknown runs, roles without supervision control and erased learners", async () => {
    const { jobId } = await recordRun();
    expect((await cancel(reviewer, jobId)).statusCode).toBe(403);
    expect((await cancel(learner, jobId)).statusCode).toBe(403);
    expect((await cancel(owner, randomUUID())).statusCode).toBe(404);
    expect((await cancel(owner, jobId, { reason: "short" })).statusCode).toBe(400);
    await end(jobId, "applied");
    expect((await cancel(owner, jobId)).json().error).toBe("RUN_ALREADY_ENDED");
    const live = (await recordRun()).jobId;
    // Erasure itself waits for live runs; the stored state is what the route must honour.
    await db.query("UPDATE enrollments SET status='erased' WHERE id=$1", [enrollment]);
    expect((await cancel(owner, live)).statusCode).toBe(410);
  });

  it("lets staff retry a run they cancelled, once; other cancelled runs stay unretryable", async () => {
    const { jobId } = await recordRun();
    expect((await cancel(owner, jobId)).statusCode).toBe(200);
    // The bridge ends the flagged run as cancelled.
    await end(jobId, "cancelled");
    const retry = (runId: string) => call(owner, "POST", `${runPath(runId)}/retry`, { idempotencyKey: "rt-" + randomUUID(), reason: "Context fixed; running this again." });
    const retried = await retry(jobId);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ runId: jobId, outcome: "cancelled", previousState: "cancelled", state: "queued" });
    expect((await retry(jobId)).json().error).toBe("RUN_ALREADY_RETRIED");
    const stopped = (await recordRun()).jobId;
    await end(stopped, "cancelled", true);
    expect((await retry(stopped)).json().error).toBe("RUN_NOT_RETRYABLE");
  });
});

describe("batch replay", () => {
  it("replays the course's finished runs read-only, each under a new id with its own receipt", async () => {
    const a = (await recordRun()).jobId, b = (await recordRun()).jobId, live = (await recordRun()).jobId;
    await end([a, b], "applied");
    const before = (await db.query("SELECT count(*)::int AS n FROM supervisor_jobs")).rows[0].n;
    const replay = await call(instructor, "POST", `/api/admin/courses/${catalog}/runs/replay`, { limit: 5 });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ summary: { matches: 2, diverged: 0, notReplayable: 0 }, providerCalls: 0, progressWrites: "denied" });
    expect(replay.json().runs.map((r: { runId: string }) => r.runId).sort()).toEqual([a, b].sort());
    expect(replay.json().runs.map((r: { runId: string }) => r.runId)).not.toContain(live);
    expect(replay.json().runs.every((r: { runId: string; replayRunId: string }) => r.replayRunId !== r.runId)).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM supervisor_jobs")).rows[0].n).toBe(before);
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE workspace_id=$1 AND event_type='run.replayed'", [workspace])).rows[0].n).toBe(2);
    expect((await call(instructor, "POST", `/api/admin/courses/${catalog}/runs/replay`, { limit: 21 })).statusCode).toBe(400);
    expect((await call(instructor, "POST", `/api/admin/courses/${catalog}/runs/replay`, { limit: 5, enrollmentId: randomUUID() })).json().runs).toEqual([]);
    expect((await call(learner, "POST", `/api/admin/courses/${catalog}/runs/replay`, {})).statusCode).toBe(403);
  });
});
