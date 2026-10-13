import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import type { HostBridge, ProviderRequest } from "@course-core/supervisor";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { composeProviders } from "../src/provider-composition.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { rubricCourse, rubricExplanation } from "./rubric-fixture.js";

// Real PostgreSQL, the real bridge and provider gateway; only the model is scripted.
// Passing here shows the host path and its checks, not the quality of any real model.
const origin = "http://localhost:4392",
  schema = "rubric_assist_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  token = randomUUID(),
  jobPolicy = { allowance: { microUsd: 100000, tokens: 200000 } };
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>, bare: Awaited<ReturnType<typeof createServer>>, bridge: HostBridge;
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
  const claimed = await bridge.claimOutbox(randomUUID(), 100, 30000), outbox = claimed.find((e) => e.eventId === event)!;
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
    registry: { revision: "assist-test", models: [{ id: "reviewer-model", providerId: "test", remoteModel: "reviewer", providerConfig: {}, enabled: true,
      capabilities: ["structured_assessment"], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: { reviewer: { modelId: "reviewer-model", maxInputCharacters: 20000, maxOutputTokens: 1000 } },
  }, () => "synthetic", { test: () => adapter });
  app = await createServer(db, { origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()], providers, supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bare = await createServer(db, { origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "assist", "Assist"]);
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
  if (root) {
    await root.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await root.end();
  }
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
  }, 30000);

  it("a draft quoting words the learner never wrote is rejected before any reviewer sees it", async () => {
    const pending = await submitAnswer();
    await send(learner, "review-assist", { granted: true });
    const asked = await call(instructor, "POST", `/api/admin/rubric-reviews/${pending.attemptId}/assist`, { idempotencyKey: "assist-" + randomUUID() });
    draft = () => ({ ...honest(), criteria: honest().criteria.map((c) => (c.criterionId === "edge" ? { ...c, met: true, quote: "an empty list has no minimum at all" } : c)) });
    const { ref, outcome } = await runJob(asked.json().requestId);
    expect(outcome.status).not.toBe("succeeded");
    const verified = await transition({ type: "verify", ref });
    expect(verified.json().snapshot?.state ?? verified.json().error).not.toBe("ready");
    expect((await queue()).assist).toMatchObject({ draft: null });
    expect((await db.query("SELECT count(*) FROM rubric_suggestions WHERE enrollment_id=$1", [enrollment])).rows[0].count).toBe("0");
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
});
