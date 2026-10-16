import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError, type ProviderAdapter, type UsageReceipt } from "@course-core/providers";
import type { Outcome, ProviderRequest, RunRef } from "@course-core/supervisor";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { composeProviders } from "../src/provider-composition.js";
import { fixture } from "./fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

// Real PostgreSQL, HTTP routes, the real bridge, gateway and verifiers; only the model is scripted.
// A model answer that Core's own checks refuse is a definite outcome: the job ends failed
// (verification_rejected), the refused output is never stored, the usage is charged, and the
// learner or staff see an ended state. A response Core cannot know the fate of still waits.
const origin = "http://localhost:4396",
  schema = "strategy_refusals_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  token = randomUUID(),
  jobPolicy = { allowance: { microUsd: 100000, tokens: 200000 } };
interface Session { id: string; cookie: string; csrf: string }
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, testDatabase: TestDatabase | undefined;
let owner: Session, releaseId: string, catalog: string;
const HUGE_REPLY = "REFUSED_REPLY_CANARY " + "x".repeat(33000);
let reply: () => string = () => "Compare each value with the smallest so far.";
let proposal: () => unknown = () => ({ summary: "Offer one more example.", needs: [{ objectiveId: "minimum", reason: "Asked twice.", proposedAction: "clarification" }] });
const usage = (operation: "tutor" | "assess"): UsageReceipt => ({
  accounting: { accountingKey: "synthetic" }, providerId: "test", modelId: "scripted-model", operation,
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
});
const adapter: ProviderAdapter = {
  providerId: "test",
  validateModel() {},
  ports: {
    tutoring: { async tutor() { return { usage: usage("tutor"), output: { text: reply() } }; } },
    structured_assessment: { async assess() { return { usage: usage("assess"), output: proposal() as never }; } },
  },
};
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "refusal:" + id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const transition = (command: unknown) =>
  app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token }, payload: { method: "transition", command } });
async function learner() {
  const who = await session("learner");
  const enrollment = (await call(who, "POST", "/api/enrollments", { releaseId })).json().id as string;
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 1000000, tokens: 2000000 });
  const revision = async () => (await call(who, "GET", `/api/enrollments/${enrollment}`)).json().revision as number;
  return { who, enrollment, revision };
}
type Learner = Awaited<ReturnType<typeof learner>>;
/** Drives one queued job exactly as the durable worker would: claim, gateway call, settle. */
async function run(eventId: string, role: ProviderRequest["role"]) {
  const outbox = (await bridge.claimOutboxEvent(eventId, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  expect(claim.effect).toBe("invoke");
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role,
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  const r = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": operation.id }, payload: request });
  expect(r.statusCode, r.body).toBe(200);
  const settled = await bridge.transition({ type: "settle", ref: ref!, operationId: operation.id, ownerId: operation.ownerId, outcome: r.json() });
  return { ref: ref! as RunRef, outcome: r.json() as Outcome, settled };
}
async function ask(l: Learner, content = "How do I find the minimum?") {
  const asked = await call(l.who, "POST", `/api/enrollments/${l.enrollment}/companion`,
    { expectedRevision: await l.revision(), idempotencyKey: randomUUID(), episodeId: "min", content });
  expect(asked.statusCode, asked.body).toBe(200);
  return asked.json() as { messageId: string; eventId: string };
}
const messages = async (l: Learner) => {
  const r = await call(l.who, "GET", `/api/enrollments/${l.enrollment}/companion`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().messages as { id: string; role: string; content: string; job_state: string | null; job_reason: string | null; refusal_reason?: string | null }[];
};
const artifacts = async (jobId: string) => JSON.stringify((await db.query("SELECT content FROM supervisor_artifacts WHERE job_id=$1", [jobId])).rows);
const spend = async (jobId: string) => (await db.query("SELECT micro_usd::int AS micro_usd,tokens::int AS tokens FROM supervisor_job_spend WHERE job_id=$1", [jobId])).rows[0];

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders({
    registry: { revision: "refusal-test", models: [{ id: "scripted-model", providerId: "test", remoteModel: "scripted", providerConfig: {}, enabled: true,
      capabilities: ["tutoring", "structured_assessment"], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: { companion: { modelId: "scripted-model", maxInputCharacters: 20000, maxOutputTokens: 1000 },
      supervisor: { modelId: "scripted-model", maxInputCharacters: 20000, maxOutputTokens: 1000 } },
  }, () => "synthetic", { test: () => adapter });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, providers, supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "refusals", "Refusals"]);
  await allowUnpricedPaidWork(db, workspace);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
  owner = await session("owner");
  releaseId = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(owner, "POST", `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("a model answer Core refuses ends the job instead of waiting as uncertain", () => {
  it("a companion reply over the size bound: charged, never stored or shown, and the learner is told it couldn't be answered", async () => {
    const l = await learner();
    reply = () => HUGE_REPLY;
    const question = await ask(l);
    const { ref, outcome, settled } = await run(question.eventId, "companion");
    expect(outcome).toMatchObject({ status: "succeeded", usage: { tokens: 30 }, usageBasis: { tokens: "reported" } });
    expect(settled.snapshot.state).not.toBe("waiting");
    expect(await spend(ref.jobId)).toMatchObject({ tokens: 30 });
    const verified = (await transition({ type: "verify", ref })).json();
    expect(verified.snapshot).toMatchObject({ state: "failed", reason: "verification_rejected" });
    expect((await transition({ type: "apply", ref })).json().snapshot?.state).not.toBe("applied");
    // Only the reason is kept: the refused reply is not stored, and no answer appears.
    expect(await artifacts(ref.jobId)).toContain('"reason":"output_too_large"');
    expect(await artifacts(ref.jobId)).not.toContain("REFUSED_REPLY_CANARY");
    const shown = await messages(l);
    expect(shown.filter((m) => m.role === "assistant")).toEqual([]);
    expect(shown.find((m) => m.id === question.messageId)).toMatchObject({ job_state: "failed", job_reason: "verification_rejected", refusal_reason: "output_too_large" });
    expect(JSON.stringify(shown)).not.toContain("REFUSED_REPLY_CANARY");
    // Asking again is a new question with its own job, which can be answered.
    reply = () => "Compare each value with the smallest so far.";
    const again = await ask(l);
    const second = await run(again.eventId, "companion");
    expect((await transition({ type: "verify", ref: second.ref })).json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref: second.ref })).json().snapshot.state).toBe("applied");
    const after = await messages(l);
    expect(after.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["Compare each value with the smallest so far."]);
    expect(after.find((m) => m.id === again.messageId)).toMatchObject({ job_state: "applied", refusal_reason: null });
  }, 30000);

  it("an uncertain companion outcome still waits as provider_uncertain and is not marked as refused", async () => {
    const l = await learner();
    reply = () => { throw new ProviderError("TIMEOUT", { submission: "unknown" }); };
    const question = await ask(l);
    const { ref, outcome, settled } = await run(question.eventId, "companion");
    expect(outcome).toEqual({ status: "uncertain" });
    expect(settled.snapshot).toMatchObject({ state: "waiting", reason: "provider_uncertain" });
    expect(await artifacts(ref.jobId)).toBe("[]");
    expect((await messages(l)).find((m) => m.id === question.messageId)).toMatchObject({ job_state: "waiting", refusal_reason: null });
    reply = () => "Compare each value with the smallest so far.";
  }, 30000);

  it("a teaching proposal naming an objective outside the lesson ends the supervisor job; staff see the refusal and its reason", async () => {
    const l = await learner();
    const consent = await call(l.who, "POST", `/api/enrollments/${l.enrollment}/supervision`,
      { expectedRevision: await l.revision(), idempotencyKey: randomUUID(), adaptiveTeaching: true });
    expect(consent.statusCode, consent.body).toBe(200);
    proposal = () => ({ summary: "INVENTED_OBJECTIVE_CANARY", needs: [{ objectiveId: "invented-objective", reason: "Model inference.", proposedAction: "practice" }] });
    const event = await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: l.enrollment, actorId: l.who.id, actorKind: "learner",
      type: "learning.review_requested", payload: { episodeId: "min" }, idempotencyKey: randomUUID(), supervise: true }));
    const { ref, outcome } = await run(event.id, "supervisor");
    expect(outcome).toMatchObject({ status: "succeeded", usage: { tokens: 30 } });
    expect((await transition({ type: "verify", ref })).json().snapshot).toMatchObject({ state: "failed", reason: "verification_rejected" });
    expect(await artifacts(ref.jobId)).not.toContain("INVENTED_OBJECTIVE_CANARY");
    expect((await db.query("SELECT count(*)::int AS n FROM supervisor_adaptations WHERE job_id=$1", [ref.jobId])).rows[0].n).toBe(0);
    const view = await call(owner, "GET", `/api/admin/courses/${catalog}/runs/${ref.jobId}`);
    expect(view.statusCode, view.body).toBe(200);
    const refused = view.json().artifacts;
    expect(refused).toEqual([expect.objectContaining({ name: expect.stringMatching(/^Refused model output/), status: "rejected" })]);
    expect(JSON.parse(refused[0].preview)).toMatchObject({ verification: "rejected", refusedByCoreChecks: true, refusalReason: "objective_out_of_scope", outputStored: false });
    expect(view.body).not.toContain("INVENTED_OBJECTIVE_CANARY");
  }, 30000);
});
