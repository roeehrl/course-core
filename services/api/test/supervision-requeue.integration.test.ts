import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { dispatchOnce, type RunRef } from "@course-core/supervisor";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: an operator re-queues a supervisor request the dispatcher
// quarantined after an outage, once, with a reason, through the staff route.
const origin = "http://localhost:4395",
  schema = "supervision_requeue_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, release: string, owner: Session, admin: Session, instructor: Session, reviewer: Session, learner: Session, enrollment: string;

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "rq:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const base = (e = enrollment) => `/api/admin/enrollments/${e}/supervision`;
const requeue = (eventId: string, who = owner, body: Record<string, unknown> = {}, e = enrollment) =>
  call(who, "POST", `${base(e)}/events/${eventId}/requeue`, { idempotencyKey: "rq-" + randomUUID(), reason: "Provider outage is over; delivering again.", ...body });
const overview = async (who = owner) => {
  const r = await call(who, "GET", base());
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const bridgeOptions = () => ({ serviceToken: "synthetic-test-service-token-not-a-credential", workspaceIds: [workspace],
  jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
const bridge = () => createPostgresSupervisorBridge(db, bridgeOptions());
async function supervised(type = "learning.updated", payload: Record<string, unknown> = {}, actorKind: "learner" | "system" = "learner", e = enrollment) {
  return transaction(db, async (client) => (await appendEvent(client, { workspaceId: workspace, enrollmentId: e, ...(actorKind === "learner" ? { actorId: learner.userId } : {}),
    actorKind, type, payload, idempotencyKey: randomUUID(), supervise: true })).id);
}
/** Delivery fails during an outage until the dispatcher gives up: the real lease and nack. */
async function quarantine(eventId: string, code: "dispatch_unavailable" | "prepare_conflict" | "prepare_refused" = "dispatch_unavailable") {
  const b = bridge(), lease = await b.claimOutboxEvent(eventId, randomUUID(), 30_000);
  expect(lease).not.toBeNull();
  expect(await b.nackOutbox(lease!, code, 0, true)).toBe(true);
}
const outbox = async (eventId: string) => (await db.query(`SELECT attempts,last_error_code,quarantined_at IS NOT NULL AS quarantined,delivered_at IS NOT NULL AS delivered,
  available_at<=clock_timestamp() AS available,lease_token FROM outbox WHERE event_id=$1`, [eventId])).rows[0];
async function consent(adaptiveTeaching: boolean) {
  const snapshot = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
  const r = await call(learner, "POST", `/api/enrollments/${enrollment}/supervision`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), adaptiveTeaching });
  expect(r.statusCode, r.body).toBe(200);
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "rq-" + workspace, "Requeue"]);
  owner = await person("owner");
  admin = await person("admin");
  instructor = await person("instructor");
  reviewer = await person("reviewer");
  learner = await person("learner");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 10_000, tokens: 10_000 });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("re-queueing a quarantined supervisor request", () => {
  it("only owners and admins may re-queue; other staff and the learner are refused and nothing changes", async () => {
    const id = await supervised();
    await quarantine(id);
    expect((await overview(owner)).canRequeue).toBe(true);
    expect((await overview(admin)).canRequeue).toBe(true);
    expect(await overview(instructor)).toMatchObject({ canControl: true, canRequeue: false });
    expect((await overview(reviewer)).canRequeue).toBe(false);
    for (const who of [instructor, reviewer, learner]) expect((await requeue(id, who)).statusCode).toBe(403);
    expect(await outbox(id)).toMatchObject({ quarantined: true, last_error_code: "dispatch_unavailable" });
    expect((await requeue(id, admin)).statusCode).toBe(200);
  });

  it("releases an outage quarantine once with reset attempts, records who and why, and the dispatcher then delivers it", async () => {
    const id = await supervised();
    await quarantine(id);
    await db.query("UPDATE outbox SET attempts=8,last_error_code='attempts_exhausted' WHERE event_id=$1", [id]);
    expect((await overview()).undeliveredEvents).toEqual([
      { eventId: id, eventType: "learning.updated", outcome: "quarantined", reason: "attempts_exhausted", at: expect.any(String), requeued: false, requeueable: true }]);
    const key = "rq-" + randomUUID(), reason = "Provider outage is over; delivering again.";
    const r = await requeue(id, owner, { idempotencyKey: key, reason: `  ${reason}  ` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ eventId: id, eventType: "learning.updated", previousCode: "attempts_exhausted", previousAttempts: 8, replayed: false });
    expect(await outbox(id)).toEqual({ attempts: 0, last_error_code: null, quarantined: false, delivered: false, available: true, lease_token: null });
    // The audit record keeps the reason; the staff learning event carries ids and codes only.
    expect((await db.query("SELECT actor_id,reason,previous_code,previous_attempts FROM supervisor_event_requeues WHERE event_id=$1", [id])).rows)
      .toEqual([{ actor_id: owner.userId, reason, previous_code: "attempts_exhausted", previous_attempts: 8 }]);
    const events = (await db.query("SELECT actor_id,actor_kind,payload,causation_id FROM learning_events WHERE enrollment_id=$1 AND event_type='supervisor.event_requeued'", [enrollment])).rows;
    expect(events).toEqual([{ actor_id: owner.userId, actor_kind: "staff", causation_id: id,
      payload: { eventId: id, eventType: "learning.updated", previousCode: "attempts_exhausted", previousAttempts: 8 } }]);
    expect((await db.query("SELECT 1 FROM outbox WHERE event_id=(SELECT id FROM learning_events WHERE event_type='supervisor.event_requeued' AND enrollment_id=$1)", [enrollment])).rowCount).toBe(0);
    const audit = await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=supervisor.event_requeued`);
    expect(audit.statusCode, audit.body).toBe(200);
    expect(audit.json().events).toEqual([expect.objectContaining({ actorKind: "staff", actor: "owner person", enrollmentId: enrollment,
      payload: { eventId: id, eventType: "learning.updated", previousCode: "attempts_exhausted", previousAttempts: 8 }, payloadWithheld: false })]);
    expect(audit.body).not.toContain(reason);
    // The same request replays; any other is refused: once only.
    expect((await requeue(id, owner, { idempotencyKey: key })).json()).toMatchObject({ replayed: true, previousAttempts: 8 });
    expect((await requeue(id, admin)).json().error).toBe("SUPERVISOR_EVENT_ALREADY_REQUEUED");
    // The real dispatcher delivers it with fresh attempts.
    const started: RunRef[] = [];
    const backlog = (await db.query("SELECT count(*)::int AS n FROM outbox WHERE delivered_at IS NULL AND quarantined_at IS NULL AND payload->>'enrollmentId'=$1", [enrollment])).rows[0].n;
    expect(await dispatchOnce(bridge(), { async start(ref: RunRef) { started.push(ref); } }, { leaseMs: 30_000 })).toMatchObject({ claimed: backlog, delivered: backlog, quarantined: 0 });
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((s) => s.enrollmentId === enrollment)).toBe(true);
    expect(await outbox(id)).toMatchObject({ attempts: 1, delivered: true, quarantined: false });
    expect((await overview()).undeliveredEvents).toEqual([]);
    // Delivered: nothing to release any more, not even with the original key replayed elsewhere.
    expect((await requeue(id, owner)).json().error).toBe("SUPERVISOR_EVENT_ALREADY_REQUEUED");
  });

  it("a request quarantined again after its one re-queue is listed as re-queued and cannot be released twice", async () => {
    const id = await supervised();
    await quarantine(id);
    expect((await requeue(id)).statusCode).toBe(200);
    await quarantine(id);
    expect((await overview()).undeliveredEvents).toEqual([expect.objectContaining({ eventId: id, outcome: "quarantined", requeued: true, requeueable: false })]);
    const again = await requeue(id);
    expect([again.statusCode, again.json().error]).toEqual([409, "SUPERVISOR_EVENT_ALREADY_REQUEUED"]);
    expect(await outbox(id)).toMatchObject({ quarantined: true });
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE event_type='supervisor.event_requeued' AND enrollment_id=$1", [enrollment])).rows[0].n).toBe(1);
  });

  it("refuses refusals, malformed envelopes, withdrawn requests, live events and other learners' events", async () => {
    const conflict = await supervised(), refusedClient = await supervised(), invalid = await supervised(), withdrawn = await supervised(), live = await supervised();
    await quarantine(conflict, "prepare_conflict");
    await quarantine(refusedClient, "prepare_refused");
    await db.query("UPDATE outbox SET quarantined_at=clock_timestamp(),last_error_code='invalid_envelope' WHERE event_id=$1", [invalid]);
    // A withdrawn question is quarantined without a code; it is not a failure and never re-queued.
    await db.query("UPDATE outbox SET quarantined_at=clock_timestamp() WHERE event_id=$1", [withdrawn]);
    for (const id of [conflict, refusedClient, invalid, withdrawn]) {
      const r = await requeue(id);
      expect([r.statusCode, r.json().error], id).toEqual([409, "SUPERVISOR_EVENT_NOT_REQUEUEABLE"]);
    }
    expect((await overview()).undeliveredEvents.every((u: { requeueable: boolean }) => !u.requeueable)).toBe(true);
    expect((await requeue(live)).json().error).toBe("SUPERVISOR_EVENT_NOT_QUARANTINED");
    expect((await requeue(randomUUID())).json().error).toBe("SUPERVISOR_EVENT_NOT_FOUND");
    // Another learner's quarantined event is not reachable through this enrollment.
    const other = await person("learner");
    const otherEnrollment = (await call(other, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const theirs = await supervised("learning.updated", {}, "system", otherEnrollment);
    await quarantine(theirs);
    expect((await requeue(theirs)).json().error).toBe("SUPERVISOR_EVENT_NOT_FOUND");
    expect(await outbox(theirs)).toMatchObject({ quarantined: true });
    // Input validation: a reason is required, ids must be ids.
    expect((await requeue(theirs, owner, { reason: "short" }, otherEnrollment)).statusCode).toBe(400);
    expect((await call(owner, "POST", `${base(otherEnrollment)}/events/${theirs}/requeue`, { idempotencyKey: "rq-" + randomUUID() })).statusCode).toBe(400);
    expect((await requeue("not-an-id")).statusCode).toBe(400);
    expect((await requeue(theirs, owner, {}, randomUUID())).statusCode).toBe(404);
    expect(await db.query("SELECT 1 FROM supervisor_event_requeues WHERE workspace_id=$1", [workspace])).toMatchObject({ rowCount: 0 });
  });

  it("refuses when the learner withdrew consent after the request, for supervision and for a research request", async () => {
    await consent(true);
    const id = await supervised();
    await quarantine(id);
    await consent(false);
    const r = await requeue(id);
    expect([r.statusCode, r.json().error]).toEqual([409, "SUPERVISION_CONSENT_WITHDRAWN"]);
    expect(await outbox(id)).toMatchObject({ quarantined: true, last_error_code: "dispatch_unavailable" });
    // A research request is bound to the permission revision it was made under: withdrawing and
    // granting again is still a withdrawal for that request.
    await consent(true);
    const parent = await supervised();
    const b = bridge(), lease = (await b.claimOutboxEvent(parent, randomUUID(), 30_000))!;
    const [job] = await b.prepareOutbox(lease);
    await b.ackOutbox(lease);
    const requestId = randomUUID(), research = await supervised("research.requested", { requestId }, "system");
    const revision = (await db.query("SELECT revision FROM supervisor_permissions WHERE enrollment_id=$1", [enrollment])).rows[0].revision;
    await db.query(`INSERT INTO research_requests(id,workspace_id,enrollment_id,course_release_id,parent_job_id,topic_id,episode_id,permission_revision,query_digest,state,activation_event_id)
      VALUES($1,$2,$3,$4,$5,'topic','min',$6,$7,'dispatched',$8)`, [requestId, workspace, enrollment, release, job!.jobId, revision, "a".repeat(64), research]);
    await quarantine(research);
    await consent(false);
    await consent(true);
    const refused = await requeue(research);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "SUPERVISION_CONSENT_WITHDRAWN"]);
    // Under the same, unchanged permission it is released.
    await db.query("UPDATE research_requests SET permission_revision=$2 WHERE id=$1", [requestId, revision + 2]);
    expect((await requeue(research)).statusCode).toBe(200);
  });

  it("refuses an erased enrollment, and erasure redacts an earlier re-queue reason", async () => {
    const released = await supervised(), pending = await supervised();
    await quarantine(released);
    const reason = "Outage ticket RQ-CANARY-" + randomUUID();
    expect((await requeue(released, owner, { reason })).statusCode).toBe(200);
    await quarantine(pending);
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Synthetic learner asked for erasure." });
    expect(erased.statusCode, erased.body).toBe(200);
    const r = await requeue(pending);
    expect([r.statusCode, r.json().error]).toEqual([410, "ENROLLMENT_ERASED"]);
    expect(await outbox(pending)).toMatchObject({ quarantined: true });
    expect((await db.query("SELECT reason FROM supervisor_event_requeues WHERE event_id=$1", [released])).rows).toEqual([{ reason: "[erased]" }]);
    expect((await db.query("SELECT count(*)::int AS n FROM supervisor_event_requeues t WHERE t::text LIKE $1", ["%RQ-CANARY%"])).rows[0].n).toBe(0);
  });
});
