import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { ProviderError, type ProviderAdapter, type UsageReceipt } from "@course-core/providers";
import { dispatchOnce, HttpHostBridge, type ProviderRequest, type RunRef } from "@course-core/supervisor";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { composeProviders } from "../src/provider-composition.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { rubricCourse, rubricExplanation } from "./rubric-fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

// Real PostgreSQL, the real bridge and provider gateway; only the model is scripted.
// Passing here shows the host path and its checks, not the quality of any real model.
const origin = "http://localhost:4392",
  schema = "rubric_assist_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  token = randomUUID(),
  jobPolicy = { allowance: { microUsd: 100000, tokens: 200000 } };
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bare: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge;
let owner: Session, instructor: Session, learner: Session, enrollment: string, catalog: string, versions = 0;
interface Session { id: string; cookie: string; csrf: string }
const seen: string[] = [];
let draft: (input: { answer: string; criteria: { id: string }[] }) => unknown;
const usage: UsageReceipt = {
  accounting: { accountingKey: "synthetic" }, providerId: "test", modelId: "reviewer-model", operation: "assess",
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
};
const adapter: ProviderAdapter = {
  providerId: "test",
  validateModel() {},
  ports: {
    structured_assessment: {
      async assess(req) {
        seen.push(JSON.stringify(req));
        return { usage, output: draft(JSON.parse(req.messages[0]!.text)) as never };
      },
    },
  },
};
const honest = () => ({
  summary: "Both required ideas are present; the empty list is not discussed.",
  criteria: [
    { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element", note: "States the invariant." },
    { criterionId: "every-element", met: true, quote: "compare every next element with it", note: "Covers each element." },
    { criterionId: "edge", met: false, quote: "", note: "No empty-list case." },
  ],
});

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "assist:" + id, role === "learner" ? "Distinctive Learner Name" : role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown, server = app) =>
  server.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(who: Session, action: string, body: Record<string, unknown>) {
  const revision = (await call(who, "GET", "/api/enrollments/" + enrollment)).json().revision;
  return call(who, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
async function submitAnswer(text = rubricExplanation) {
  const issued = await send(learner, "challenges", { episodeId: "min", assessmentId: "min-explain", mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  expect((await send(learner, "answers", { challengeId: issued.json().challengeId, answer: text })).statusCode).toBe(200);
  return queue();
}
// Every test course shares one catalogue; select this test's enrollment.
const queue = async () => (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending.find((p: { enrollmentId: string }) => p.enrollmentId === enrollment);
const transition = (command: unknown) =>
  app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token }, payload: { method: "transition", command } });
/** Drives the queued job exactly as the durable worker would. */
async function runJob(requestId: string) {
  const event = (await db.query("SELECT activation_event_id FROM rubric_assist_requests WHERE id=$1", [requestId])).rows[0].activation_event_id;
  const outbox = (await bridge.claimOutboxEvent(event, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  expect(claim.effect).toBe("invoke");
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role: "reviewer",
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  const r = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": operation.id }, payload: request });
  expect(r.statusCode, r.body).toBe(200);
  await bridge.transition({ type: "settle", ref: ref!, operationId: operation.id, ownerId: operation.ownerId, outcome: r.json() });
  return { ref: ref!, outcome: r.json() };
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders({
    registry: { revision: "assist-test", models: [{ id: "reviewer-model", providerId: "test", remoteModel: "reviewer", providerConfig: {}, enabled: true,
      capabilities: ["structured_assessment"], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: { reviewer: { modelId: "reviewer-model", maxInputCharacters: 20000, maxOutputTokens: 1000 } },
  }, () => "synthetic", { test: () => adapter });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()], providers, supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bare = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "assist", "Assist"]);
  await allowUnpricedPaidWork(db, workspace);
  owner = await session("owner");
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 30000);
beforeEach(async () => {
  draft = honest;
  instructor = await session("instructor");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse(`3.0.${versions++}`))).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 1000000, tokens: 2000000 });
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
});
afterAll(async () => {
  await app?.close();
  await bare?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("AI drafts for written-answer reviewers", () => {
  it("needs the learner's opt-in, sends only the question, rubric and answer, and shows a verified draft that is not a grade", async () => {
    const pending = await submitAnswer();
    expect(pending.assist).toMatchObject({ learnerConsented: false, state: "not_consented", draft: null });
    const ask = () => call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    expect((await ask()).json().error).toBe("RUBRIC_ASSIST_CONSENT_REQUIRED");
    expect((await call(learner, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() })).statusCode).toBe(403);
    const consent = await call(learner, "GET", `/api/enrollments/${enrollment}/review-assist`);
    expect(consent.json()).toMatchObject({ granted: false, notShared: expect.arrayContaining(["your name"]) });
    expect((await send(learner, "review-assist", { granted: true })).json()).toMatchObject({ granted: true, consentRevision: 1 });
    expect((await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-1" }, bare)).json().error).toBe("RUBRIC_ASSIST_UNAVAILABLE");
    const asked = await ask();
    expect(asked.statusCode, asked.body).toBe(200);
    expect((await ask()).json()).toMatchObject({ requestId: asked.json().requestId, replayed: true });
    expect((await queue()).assist.state).toBe("requested");
    const before = seen.length;
    const { ref } = await runJob(asked.json().requestId);
    const sent = seen.slice(before).join("\n");
    expect(sent).toContain("never greater than any element");
    expect(sent).toContain("States the invariant");
    expect(sent).not.toContain("Distinctive Learner Name");
    expect(sent).not.toContain(learner.id);
    expect((await transition({ type: "verify", ref })).json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref })).json().snapshot.state).toBe("applied");
    const shown = (await queue()).assist;
    expect(shown).toMatchObject({ state: "suggested", draft: { notAGrade: true, criteria: honest().criteria } });
    // A draft creates no evidence and no learner-visible review.
    expect((await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [enrollment])).rows[0].count).toBe("0");
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews[0].status).toBe("pending_review");
    // The learner's export lists the draft but withholds its findings while the answer awaits judgement.
    const exportDrafts = async () => { const r = await call(learner, "GET", `/api/enrollments/${enrollment}/export`); expect(r.statusCode, r.body).toBe(200); return r.json().writtenAnswerAssistance.drafts; };
    expect(await exportDrafts()).toEqual([expect.objectContaining({ attempt_id: pending.attemptId, request_id: asked.json().requestId, summary: null, criteria: null, withheld: true })]);
    // The human reviewer records their own review; agreement is measured, not assumed.
    const reviewed = await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}`, {
      decision: "met", suggestionId: shown.draft.suggestionId, idempotencyKey: "review-" + randomUUID(),
      criteria: [
        { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
        { criterionId: "every-element", met: true, quote: "compare every next element with it" },
        { criterionId: "edge", met: true, quote: "I keep the smallest value seen so far" },
      ] });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect((await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-assist/agreement`)).json()).toMatchObject({ reviewsWithDraft: 1, criteriaCompared: 3, criteriaAgreed: 2 });
    // Once judged, the export carries what the model drafted about the learner's answer.
    expect(await exportDrafts()).toEqual([expect.objectContaining({ attempt_id: pending.attemptId, notAGrade: true, summary: honest().summary, criteria: honest().criteria })]);
  }, 30000);

  it("a draft quoting words the learner never wrote ends as rejected with its reason, and asking again starts a fresh request", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const ask = () => call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const first = await ask();
    draft = () => ({ ...honest(), criteria: honest().criteria.map((c) => (c.criterionId === "edge" ? { ...c, met: true, quote: "an empty list has no minimum at all" } : c)) });
    const { ref, outcome } = await runJob(first.json().requestId);
    // The model answered and Core refused its draft: a definite outcome with the reported usage, not an uncertain submission.
    expect(outcome).toMatchObject({ status: "succeeded", usage: { tokens: 30 }, usageBasis: { tokens: "reported" } });
    expect((await db.query("SELECT state,runtime_snapshot->>'reason' AS reason FROM supervisor_jobs WHERE id=$1", [ref.jobId])).rows[0]).toEqual({ state: "running", reason: null });
    const verified = await transition({ type: "verify", ref });
    expect(verified.json().snapshot).toMatchObject({ state: "failed", reason: "verification_rejected" });
    expect((await transition({ type: "apply", ref })).json().snapshot?.state).not.toBe("applied");
    expect((await queue()).assist).toMatchObject({ state: "rejected", rejectionReason: "quote_not_in_answer", draft: null });
    expect((await db.query("SELECT count(*) FROM rubric_suggestions WHERE enrollment_id=$1", [enrollment])).rows[0].count).toBe("0");
    // Only the reason is kept; the refused draft's words are not stored or shown.
    const stored = JSON.stringify((await db.query("SELECT content FROM supervisor_artifacts WHERE job_id=$1", [ref.jobId])).rows);
    expect(stored).toContain("rubric_refusal");
    expect(stored).not.toMatch(/an empty list has no minimum|States the invariant/);
    // "Ask again" supersedes the rejected request instead of replaying it.
    draft = honest;
    const second = await ask();
    expect(second.json()).toMatchObject({ state: "requested", replayed: false });
    expect(second.json().requestId).not.toBe(first.json().requestId);
    expect((await queue()).assist).toMatchObject({ state: "requested", rejectionReason: null });
    const again = await runJob(second.json().requestId);
    expect((await transition({ type: "verify", ref: again.ref })).json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref: again.ref })).json().snapshot.state).toBe("applied");
    expect((await queue()).assist).toMatchObject({ state: "suggested", draft: { criteria: honest().criteria } });
    expect((await db.query("SELECT id,state,rejection_reason FROM rubric_assist_requests WHERE attempt_id=$1 ORDER BY created_at", [pending.attemptId])).rows).toEqual([
      { id: first.json().requestId, state: "superseded", rejection_reason: "quote_not_in_answer" },
      { id: second.json().requestId, state: "suggested", rejection_reason: null }]);
  }, 30000);

  it("a draft that marks a criterion met without quoting the answer is rejected as no_quotes, and a replay keeps the same request", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const ask = () => call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const first = await ask();
    draft = () => ({ ...honest(), criteria: honest().criteria.map((c) => ({ ...c, met: true, quote: "" })) });
    const { ref } = await runJob(first.json().requestId);
    // Before verification the request still answers "requested" and a repeat is the same request.
    expect((await ask()).json()).toMatchObject({ requestId: first.json().requestId, replayed: true });
    expect((await transition({ type: "verify", ref })).json().snapshot).toMatchObject({ state: "failed", reason: "verification_rejected" });
    // A repeated verification neither conflicts nor changes the recorded reason.
    expect((await transition({ type: "verify", ref })).json().snapshot).toMatchObject({ state: "failed" });
    expect((await queue()).assist).toMatchObject({ state: "rejected", rejectionReason: "no_quotes", draft: null });
    // The learner's export names why their request ended.
    const exported = (await call(learner, "GET", `/api/enrollments/${enrollment}/export`)).json().writtenAnswerAssistance.requests;
    expect(exported).toEqual([expect.objectContaining({ attempt_id: pending.attemptId, state: "rejected", rejection_reason: "no_quotes" })]);
  }, 30000);

  it("an uncertain provider outcome still waits as provider_uncertain, and asking again replays the live request", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const ask = () => call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const first = await ask();
    draft = () => { throw new ProviderError("TIMEOUT", { submission: "unknown" }); };
    const { ref, outcome } = await runJob(first.json().requestId);
    expect(outcome).toEqual({ status: "uncertain" });
    expect((await db.query("SELECT state,runtime_snapshot->>'reason' AS reason FROM supervisor_jobs WHERE id=$1", [ref.jobId])).rows[0]).toEqual({ state: "waiting", reason: "provider_uncertain" });
    expect((await queue()).assist).toMatchObject({ state: "requested", rejectionReason: null });
    expect((await db.query("SELECT state,rejection_reason FROM rubric_assist_requests WHERE id=$1", [first.json().requestId])).rows[0]).toEqual({ state: "requested", rejection_reason: null });
    expect((await ask()).json()).toMatchObject({ requestId: first.json().requestId, replayed: true });
  }, 30000);

  it("revoking consent after the draft was generated stops it from being shown", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const asked = await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const { ref } = await runJob(asked.json().requestId);
    expect((await send(learner, "review-assist", { granted: false })).json()).toMatchObject({ granted: false, consentRevision: 2 });
    const verified = await transition({ type: "verify", ref });
    expect(verified.json().snapshot?.state ?? verified.json().error).not.toBe("ready");
    expect((await transition({ type: "apply", ref })).json().snapshot?.state).not.toBe("applied");
    expect((await queue()).assist).toMatchObject({ learnerConsented: false, draft: null });
  }, 30000);

  it("a request whose job was cancelled can be asked again, and a live request is still replayed", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const ask = () => call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const first = await ask();
    draft = () => { throw new ProviderError("TIMEOUT", { submission: "unknown" }); };
    const { ref } = await runJob(first.json().requestId);
    // An uncertain provider outcome leaves the job waiting; an operator then cancels it (as a provider change or erasure does).
    await db.query("UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1", [ref.jobId]);
    await bridge.transition({ type: "claim", ref, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
    expect((await db.query("SELECT state FROM supervisor_jobs WHERE id=$1", [ref.jobId])).rows[0].state).toBe("cancelled");
    expect((await queue()).assist).toMatchObject({ state: "failed", draft: null });
    draft = honest;
    const second = await ask();
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ state: "requested", replayed: false });
    expect(second.json().requestId).not.toBe(first.json().requestId);
    expect((await ask()).json()).toMatchObject({ requestId: second.json().requestId, replayed: true });
    expect((await queue()).assist.state).toBe("requested");
    const again = await runJob(second.json().requestId);
    expect((await transition({ type: "verify", ref: again.ref })).json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref: again.ref })).json().snapshot.state).toBe("applied");
    expect((await queue()).assist).toMatchObject({ state: "suggested", draft: { criteria: honest().criteria } });
    const states = (await db.query("SELECT id,state FROM rubric_assist_requests WHERE attempt_id=$1 ORDER BY created_at", [pending.attemptId])).rows;
    expect(states).toEqual([{ id: first.json().requestId, state: "superseded" }, { id: second.json().requestId, state: "suggested" }]);
  }, 30000);

  it("a request whose event was never admitted, or made under an ended consent grant, can be asked again", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const ask = () => call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const first = await ask();
    // The enrollment is paused when the worker prepares the event: it is disposed of without a job.
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [enrollment]);
    const event = (await db.query("SELECT activation_event_id FROM rubric_assist_requests WHERE id=$1", [first.json().requestId])).rows[0].activation_event_id;
    const outbox = (await bridge.claimOutboxEvent(event, randomUUID(), 30000))!;
    expect(await bridge.prepareOutbox(outbox)).toEqual([]);
    await bridge.ackOutbox(outbox);
    await db.query("UPDATE enrollments SET status='active' WHERE id=$1", [enrollment]);
    expect((await queue()).assist).toMatchObject({ state: "failed", draft: null });
    const second = await ask();
    expect(second.json()).toMatchObject({ replayed: false });
    // Revoked and granted again: the earlier request is void and a new one may be made.
    await send(learner, "review-assist", { granted: false });
    await send(learner, "review-assist", { granted: true });
    expect((await queue()).assist).toMatchObject({ state: "available", draft: null });
    const third = await ask();
    expect(third.json()).toMatchObject({ replayed: false });
    expect(third.json().requestId).not.toBe(second.json().requestId);
    const { ref } = await runJob(third.json().requestId);
    expect((await transition({ type: "verify", ref })).json().snapshot.state).toBe("ready");
  }, 30000);

  it("consent withdrawn after the request was dispatched is refused once, for good, with a recorded reason, over the real bridge RPC", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const asked = await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    expect(asked.statusCode, asked.body).toBe(200);
    // The learner withdraws consent before the dispatcher reaches the event: a permanent conflict.
    expect((await send(learner, "review-assist", { granted: false })).json()).toMatchObject({ granted: false });
    const event = (await db.query("SELECT activation_event_id FROM rubric_assist_requests WHERE id=$1", [asked.json().requestId])).rows[0].activation_event_id as string;
    // Every other pending event of this workspace is someone else's; deliver them out of the way first.
    await db.query("UPDATE outbox SET available_at=clock_timestamp()+interval '1 hour' WHERE event_id<>$1 AND delivered_at IS NULL AND quarantined_at IS NULL", [event]);
    // The real dispatcher and HTTP host bridge, sent through this server's bridge route.
    const viaServer: typeof fetch = async (input, init) => {
      const r = await app.inject({ method: "POST", url: new URL(String(input)).pathname, headers: init!.headers as Record<string, string>, payload: String(init!.body) });
      return new Response(r.body, { status: r.statusCode, headers: { "content-type": "application/json" } });
    };
    const host = new HttpHostBridge(origin, token, 10_000, viaServer), started: RunRef[] = [];
    const starter = { start: async (ref: RunRef) => { started.push(ref); } };
    expect(await dispatchOnce(host, starter, { leaseMs: 30_000 })).toEqual({ claimed: 1, delivered: 1, deferred: 0, quarantined: 0, leaseLost: 0, failed: 0 });
    expect(started).toEqual([]);
    // Consumed in one attempt: delivered, never quarantined, nothing left to retry.
    expect((await db.query("SELECT attempts,delivered_at IS NOT NULL AS delivered,quarantined_at,last_error_code FROM outbox WHERE event_id=$1", [event])).rows[0])
      .toEqual({ attempts: 1, delivered: true, quarantined_at: null, last_error_code: null });
    expect(await dispatchOnce(host, starter, { leaseMs: 30_000 })).toMatchObject({ claimed: 0 });
    const reason = (await db.query("SELECT disposition,reason_code FROM supervisor_preparations WHERE event_id=$1", [event])).rows[0];
    expect(reason.disposition).toBe("refused");
    expect(["RUBRIC_ASSIST_CONSENT_CHANGED", "RUBRIC_ASSIST_NOT_PENDING"]).toContain(reason.reason_code);
    expect((await db.query("SELECT count(*)::int AS n FROM supervisor_jobs WHERE input_event_id=$1", [event])).rows[0].n).toBe(0);
    // The reviewer sees the request ended; staff see why, in the audit log and the supervision view.
    expect((await queue()).assist).toMatchObject({ draft: null });
    expect((await queue()).assist.state).not.toBe("requested");
    const audit = await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=supervisor.event_refused`);
    expect(audit.statusCode, audit.body).toBe(200);
    expect(audit.json().events.filter((e: { payload: { eventId: string } }) => e.payload.eventId === event)).toEqual([
      expect.objectContaining({ actorKind: "system", enrollmentId: enrollment, payload: { eventId: event, eventType: "rubric.assist_requested", reasonCode: reason.reason_code } })]);
    const overview = await call(instructor, "GET", `/api/admin/enrollments/${enrollment}/supervision`);
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().undeliveredEvents).toEqual([{ eventId: event, eventType: "rubric.assist_requested", outcome: "refused", reason: reason.reason_code, at: expect.any(String), requeued: false, requeueable: false }]);
    await db.query("UPDATE outbox SET available_at=clock_timestamp() WHERE delivered_at IS NULL AND quarantined_at IS NULL");
  }, 30000);

  it("revoking consent after a draft was shown hides it, and granting again does not revive it", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const asked = await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const { ref } = await runJob(asked.json().requestId);
    expect((await transition({ type: "verify", ref })).json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref })).json().snapshot.state).toBe("applied");
    const shown = (await queue()).assist;
    expect(shown).toMatchObject({ state: "suggested", draft: { notAGrade: true } });
    expect((await send(learner, "review-assist", { granted: false })).json()).toMatchObject({ granted: false });
    expect((await queue()).assist).toMatchObject({ learnerConsented: false, state: "not_consented", draft: null });
    const findings = { decision: "met", suggestionId: shown.draft.suggestionId, idempotencyKey: "review-" + randomUUID(),
      criteria: [
        { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
        { criterionId: "every-element", met: true, quote: "compare every next element with it" },
        { criterionId: "edge", met: false },
      ] };
    // The withdrawn draft cannot be recorded as the one the reviewer had open.
    expect((await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}`, findings)).json().error).toBe("RUBRIC_SUGGESTION_MISMATCH");
    expect((await send(learner, "review-assist", { granted: true })).json()).toMatchObject({ granted: true, consentRevision: 3 });
    expect((await queue()).assist).toMatchObject({ learnerConsented: true, draft: null });
    expect((await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}`, { ...findings, idempotencyKey: "review-" + randomUUID() })).json().error).toBe("RUBRIC_SUGGESTION_MISMATCH");
    const { suggestionId: _omit, ...withoutDraft } = findings;
    expect((await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}`, { ...withoutDraft, idempotencyKey: "review-" + randomUUID() })).statusCode).toBe(200);
  }, 30000);
});
