import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import type { HostBridge, ProviderRequest } from "@course-core/supervisor";
import { checkGateDecision, type CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { composeProviders } from "../src/provider-composition.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { gatedCourse, repairEvaluatorStub } from "./gated-fixture.js";

// Conversational (rubric-backed) gate evidence on real PostgreSQL, the real bridge and provider
// gateway. Only the model is scripted: passing shows the host's checks, not any model's quality.
const origin = "http://localhost:4397",
  schema = "conversation_gate_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  token = randomUUID(),
  jobPolicy = { allowance: { microUsd: 100000, tokens: 200000 } };
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: HostBridge;
let owner: Session, instructor: Session, learner: Session, enrollment: string, catalog: string, course: CourseManifest, versions = 0;
interface Session { id: string; cookie: string; csrf: string }
const firstTurn = "I keep the smallest value seen so far and compare every next value with it. The kept value is never greater than any value already seen.";
const reply = "For example with 8, 2 and 5 my kept value goes 8, then 2, and it stays 2 because 5 is larger.";
let draft: (input: { answer: string }) => unknown;
const usage: UsageReceipt = {
  accounting: { accountingKey: "synthetic" }, providerId: "test", modelId: "reviewer-model", operation: "assess",
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
};
const adapter: ProviderAdapter = { providerId: "test", validateModel() {}, ports: { structured_assessment: { async assess(req) { return { usage, output: draft(JSON.parse(req.messages[0]!.text)) as never }; } } } };
/** A scripted model "impression": it claims both criteria with a quote for one only. */
const impression = () => ({ summary: "The learner understands the running minimum.", criteria: [
  { criterionId: "invariant", met: true, quote: "The kept value is never greater than any value already seen", note: "States the invariant." },
  { criterionId: "own-example", met: false, quote: "", note: "No example yet." },
] });

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "conv:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(action: string, body: Record<string, unknown>) {
  const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
  return call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
const decision = async () => (await call(learner, "GET", `/api/enrollments/${enrollment}/gates/min-gate/decision`)).json().decision;
const queue = async () => (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending.filter((p: { enrollmentId: string }) => p.enrollmentId === enrollment);
const evidenceCount = async () => (await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1 AND result ? 'reviewed'", [enrollment])).rows[0].n;
const transition = (command: unknown) => app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token }, payload: { method: "transition", command } });
async function runJob(requestId: string) {
  const event = (await db.query("SELECT activation_event_id FROM rubric_assist_requests WHERE id=$1", [requestId])).rows[0].activation_event_id;
  const claimed = await bridge.claimOutbox(randomUUID(), 100, 30000), outbox = claimed.find((e) => e.eventId === event)!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role: "reviewer",
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  const r = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": operation.id }, payload: request });
  await bridge.transition({ type: "settle", ref: ref!, operationId: operation.id, ownerId: operation.ownerId, outcome: r.json() });
  return { ref: ref!, outcome: r.json() };
}
async function explain(text = firstTurn) {
  const issued = await send("challenges", { episodeId: "min", assessmentId: "gate-conversation:min-gate", mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  const answered = await send("answers", { challengeId: issued.json().challengeId, answer: text });
  expect(answered.statusCode, answered.body).toBe(200);
  return { question: issued.json().question, result: answered.json().result };
}
const review = (attemptId: string, body: Record<string, unknown>) =>
  call(instructor, "POST", `/api/admin/rubric-reviews/${attemptId}`, { idempotencyKey: "review-" + randomUUID(), ...body });

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(url.href);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  const providers = composeProviders({
    registry: { revision: "conversation-test", models: [{ id: "reviewer-model", providerId: "test", remoteModel: "reviewer", providerConfig: {}, enabled: true,
      capabilities: ["structured_assessment"], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: { reviewer: { modelId: "reviewer-model", maxInputCharacters: 20000, maxOutputTokens: 1000 } },
  }, () => "synthetic", { test: () => adapter });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator(), repairEvaluatorStub()], providers, supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "conversation", "Conversation"]);
  owner = await session("owner");
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 30000);
beforeEach(async () => {
  draft = impression;
  instructor = await session("instructor");
  learner = await session("learner");
  course = gatedCourse(`6.0.${versions++}`, { conversation: true });
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course)).json().id;
  const published = await call(owner, "POST", `/api/releases/${release}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 1000000, tokens: 2000000 });
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  expect((await send("read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await root.end();
  }
});

describe("conversational (rubric-backed) gate evidence", () => {
  it("counts a conversation only after a human confirms every criterion with the learner's own quoted words", async () => {
    const one = await send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
    expect((await send("answers", { challengeId: one.json().challengeId, answer: 4 })).json().result.passed).toBe(true);
    const { question, result } = await explain();
    expect(question).toMatchObject({ id: "gate-conversation:min-gate", type: "rubric", allowAbstain: true });
    expect(question.prompt).toMatch(/^Explain in your own words, with an example of your own: Find a minimum\./);
    expect(question.criteria.map((c: { id: string }) => c.id)).toEqual(["invariant", "own-example"]);
    expect(result).toMatchObject({ pendingReview: true, passed: false });
    expect((await decision()).status).toBe("under_review");

    // The scripted model drafts quoted findings for the reviewer. A draft is not a grade.
    const [first] = await queue();
    expect(first).toMatchObject({ assessmentId: "gate-conversation:min-gate", conversationGateId: "min-gate" });
    expect((await send("review-assist", { granted: true })).json()).toMatchObject({ granted: true });
    const asked = await call(instructor, "POST", `/api/admin/rubric-reviews/${first.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    expect(asked.statusCode, asked.body).toBe(200);
    const { ref } = await runJob(asked.json().requestId);
    expect((await transition({ type: "verify", ref })).json().snapshot.state).toBe("ready");
    expect((await transition({ type: "apply", ref })).json().snapshot.state).toBe("applied");
    expect((await queue())[0].assist).toMatchObject({ state: "suggested", draft: { notAGrade: true } });
    // Model output alone grants nothing.
    expect(await evidenceCount()).toBe(0);
    expect((await decision()).status).toBe("under_review");

    // The reviewer asks a neutral follow-up; the learner replies in the same conversation.
    const probe = await review(first.attemptId, { decision: "needs_clarification", probeOnly: true, learnerNote: "Can you walk through an example of your own?",
      criteria: [{ criterionId: "invariant", met: true, quote: "The kept value is never greater than any value already seen" }, { criterionId: "own-example", met: false }] });
    expect(probe.statusCode, probe.body).toBe(200);
    const waiting = await decision();
    expect(waiting.status).toBe("under_review");
    expect(waiting.nextActions[0]).toMatchObject({ kind: "attempt_check", targetId: "gate-conversation:min-gate" });
    expect(waiting.nextActions[0].label).toMatch(/Reply to the reviewer's follow-up question/);
    const replied = await send(`reviews/${first.attemptId}/reply`, { answer: reply });
    expect(replied.json()).toMatchObject({ pendingReview: true, independent: true });
    const [second] = await queue();
    expect(second.thread.map((t: { attemptId: string }) => t.attemptId)).toEqual([first.attemptId]);

    // Impressions, missing quotes and words the learner never wrote are refused.
    expect((await review(second.attemptId, { decision: "met", criteria: [{ criterionId: "invariant", met: true }, { criterionId: "own-example", met: true, quote: "my kept value goes 8, then 2" }] })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    expect((await review(second.attemptId, { decision: "met", criteria: [{ criterionId: "invariant", met: true, quote: "The learner understands the running minimum." }, { criterionId: "own-example", met: true, quote: "my kept value goes 8, then 2" }] })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    expect(await evidenceCount()).toBe(0);
    const confirmed = await review(second.attemptId, { decision: "met", criteria: [
      { criterionId: "invariant", met: true, quote: "The kept value is never greater than any value already seen" },
      { criterionId: "own-example", met: true, quote: "my kept value goes 8, then 2" }] });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const evidence = (await db.query("SELECT result,independent FROM evidence WHERE attempt_id=$1", [second.attemptId])).rows[0];
    expect(evidence).toMatchObject({ independent: true, result: { passed: true, reviewed: true,
      conversation: { gateId: "min-gate", rubricId: "explain-minimum", rubricVersion: "1.0.0" },
      citedSpans: [{ turnId: first.attemptId, quote: "The kept value is never greater than any value already seen" }, { turnId: second.attemptId, quote: "my kept value goes 8, then 2" }] } });

    // The quoted conversation is transfer evidence: with one more family the gate is ready, no extra quiz needed.
    const ready = await decision();
    expect(ready.status).toBe("ready");
    expect(ready.criterionResults.find((c: { criterionId: string }) => c.criterionId === "transfer").met).toBe(true);
    expect(checkGateDecision(course, JSON.parse(JSON.stringify(ready).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, '"core-$1"'))).valid).toBe(true);
    expect((await send("complete", { episodeId: "min", gateDecisionId: ready.decisionId })).statusCode).toBe(200);
  }, 30000);

  it("a model judgment without learner quotes never reaches a reviewer and leaves the gate under review", async () => {
    await explain();
    const [pending] = await queue();
    await send("review-assist", { granted: true });
    draft = () => ({ summary: "Clearly understands.", criteria: [{ criterionId: "invariant", met: true, quote: "", note: "Seems right." }, { criterionId: "own-example", met: true, quote: "", note: "Seems right." }] });
    const asked = await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    const { ref, outcome } = await runJob(asked.json().requestId);
    expect(outcome.status).not.toBe("succeeded");
    const verified = await transition({ type: "verify", ref });
    expect(verified.json().snapshot?.state ?? verified.json().error).not.toBe("ready");
    expect((await queue())[0].assist).toMatchObject({ draft: null });
    expect(await evidenceCount()).toBe(0);
    expect((await decision()).status).toBe("under_review");
  }, 30000);

  it("a not-met conversation is honest evidence of a gap, not a pass", async () => {
    await explain();
    const [pending] = await queue();
    expect((await review(pending.attemptId, { decision: "not_met", criteria: [{ criterionId: "invariant", met: true, quote: "The kept value is never greater than any value already seen" }, { criterionId: "own-example", met: false }] })).statusCode).toBe(200);
    const record = await decision();
    expect(record.status).toBe("needs_evidence");
    expect(record.criterionResults.find((c: { criterionId: string }) => c.criterionId === "transfer").met).toBe(false);
  });
});
