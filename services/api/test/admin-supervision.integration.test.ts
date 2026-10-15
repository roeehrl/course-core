import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: the staff routes over the supervision pause/stop/resume control.
const origin = "http://localhost:4394",
  schema = "admin_supervision_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, instructor: Session, reviewer: Session, observer: Session, learner: Session, enrollment: string;

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "sv:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const base = () => `/api/admin/enrollments/${enrollment}/supervision`;
const act = (action: string, who = instructor, body: Record<string, unknown> = {}) => call(who, "POST", `${base()}/${action}`, { idempotencyKey: "sv-" + randomUUID(), ...body });
const overview = async (who = instructor) => {
  const r = await call(who, "GET", base());
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
/** A live supervisor job for the enrollment, made through the real bridge from a supervised event. */
async function liveJob() {
  const options = { serviceToken: "synthetic-test-service-token-not-a-credential", workspaceIds: [workspace],
    jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } };
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 10_000, tokens: 10_000 });
  const bridge = createPostgresSupervisorBridge(db, options);
  const id = await transaction(db, async (client) => (await appendEvent(client, { workspaceId: workspace, enrollmentId: enrollment, actorId: learner.userId,
    actorKind: "learner", type: "learning.updated", payload: {}, idempotencyKey: randomUUID(), supervise: true })).id);
  const lease = (await bridge.claimOutbox(randomUUID(), 100, 30_000)).find((row) => row.eventId === id)!;
  const refs = await bridge.prepareOutbox(lease);
  await bridge.ackOutbox(lease);
  return refs[0]!;
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "sv-" + workspace, "Supervision"]);
  owner = await person("owner");
  instructor = await person("instructor");
  reviewer = await person("reviewer");
  observer = await person("observer");
  learner = await person("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("supervision controls", () => {
  it("only roles with supervision.control change it; run inspectors read it; others see nothing", async () => {
    expect(await overview()).toMatchObject({ control: { state: "active", revision: 0 }, jobs: [], pendingSignals: 0, canControl: true });
    expect((await overview(reviewer)).canControl).toBe(false);
    expect((await call(observer, "GET", base())).statusCode).toBe(403);
    expect((await call(learner, "GET", base())).statusCode).toBe(403);
    for (const who of [reviewer, observer, learner]) expect((await act("pause", who)).statusCode).toBe(403);
    expect((await act("pause", owner)).json()).toMatchObject({ state: "paused", previousState: "active", revision: 1, changed: true });
  });

  it("a course-scoped instructor grant controls supervision on that course; no grant, no access", async () => {
    const scoped = await person("course_scoped"), none = await person("course_scoped");
    const catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
    const granted = await call(owner, "POST", `/api/admin/workspaces/${workspace}/course-grants`, { userId: scoped.userId, catalogId: catalog, role: "instructor",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reasonCode: "support_case", idempotencyKey: "g-" + randomUUID() });
    expect(granted.statusCode, granted.body).toBe(200);
    expect((await overview(scoped)).canControl).toBe(true);
    expect((await act("pause", scoped)).json()).toMatchObject({ state: "paused" });
    expect((await call(none, "GET", base())).statusCode).toBe(403);
    expect((await act("resume", none)).statusCode).toBe(403);
  });

  it("pause, idempotent replay, stale revision, invalid transition, stop and resume", async () => {
    const key = "sv-" + randomUUID();
    const paused = await act("pause", instructor, { idempotencyKey: key, reasonCode: "learner_request", expectedRevision: 0 });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ state: "paused", revision: 1, changed: true, replayed: false });
    expect((await act("pause", instructor, { idempotencyKey: key })).json()).toMatchObject({ state: "paused", revision: 1, replayed: true });
    expect((await act("resume", instructor, { idempotencyKey: key })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    expect((await act("resume", instructor, { expectedRevision: 0 })).json().error).toBe("SUPERVISION_CONTROL_STALE");
    expect((await act("pause")).json()).toMatchObject({ changed: false, revision: 1 });
    expect((await act("stop", instructor, { reasonCode: "safety_review" })).json()).toMatchObject({ state: "stopped", revision: 2 });
    expect((await act("pause")).json().error).toBe("SUPERVISION_CONTROL_INVALID");
    expect((await act("resume")).json()).toMatchObject({ state: "active", previousState: "stopped", revision: 3 });
    expect(await overview()).toMatchObject({ control: { state: "active", revision: 3, changedBy: instructor.userId } });
    // Each real change is a staff event; no-ops are not.
    const events = (await db.query("SELECT actor_id,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='supervision.control_changed' ORDER BY sequence", [enrollment])).rows;
    expect(events.map((e) => e.payload.state)).toEqual(["paused", "stopped", "active"]);
    expect(events.every((e) => e.actor_id === instructor.userId)).toBe(true);
    // Input validation.
    expect((await act("pause", instructor, { reasonCode: "Free text is not a code" })).statusCode).toBe(400);
    expect((await call(instructor, "POST", `${base()}/pause`, { idempotencyKey: "short" })).statusCode).toBe(400);
    expect((await call(instructor, "POST", `/api/admin/enrollments/${randomUUID()}/supervision/pause`, { idempotencyKey: "sv-" + randomUUID() })).statusCode).toBe(404);
  });

  it("shows a live job as held while paused, and stop requests its cancellation", async () => {
    const ref = await liveJob();
    expect((await overview()).jobs).toEqual([expect.objectContaining({ id: ref.jobId, held: false, cancellationRequested: false })]);
    expect((await act("pause")).json()).toMatchObject({ signalledJobs: 1 });
    const paused = await overview();
    expect(paused.jobs[0]).toMatchObject({ held: true });
    expect(paused.pendingSignals).toBe(1);
    expect((await act("stop")).json()).toMatchObject({ state: "stopped", cancelledJobs: 1 });
    expect((await overview()).jobs[0]).toMatchObject({ held: false, cancellationRequested: true });
  });
});
