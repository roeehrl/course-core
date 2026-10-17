import { createHash, randomUUID } from "node:crypto";
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
import { supervisorGeneratedTeachingFixture } from "./generated-teaching-fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

// Real PostgreSQL, HTTP routes, the real bridge, gateway, scoped tools and plan verifier; only the
// model is scripted. When the tool loop's own round checks refuse what the model decided, the run
// ends: failed/verification_rejected with a tool_loop_* reason, every paid round charged, tool
// receipts kept, nothing applied, and nothing re-run on retry or replay. An outcome Core cannot
// know (a timeout after sending) still waits as provider_uncertain.
const origin = "http://localhost:4397",
  schema = "tool_loop_refusals_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  token = randomUUID(),
  jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } },
  fixture = supervisorGeneratedTeachingFixture();
fixture.course.research = {
  publicTopics: [1, 2, 3].map((n) => ({ id: "ordering-research-" + n, objectiveIds: ["minimum"], queryText: "Public ordering explanation " + n, allowedDomains: ["docs.python.org"] })),
};
interface Session { id: string; cookie: string; csrf: string }
type Decision = { decision: string; tool: string; argumentsJson: string; summary: string };
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, testDatabase: TestDatabase | undefined;
let owner: Session, releaseId: string, catalog: string;
const scripts = new Map<string, (round: number) => Decision | Promise<Decision>>(), modelCalls = new Map<string, number>();
const usage: UsageReceipt = {
  accounting: { accountingKey: "synthetic" }, providerId: "test", modelId: "planner", operation: "assess",
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
};
let researchCalls = 0;
const adapter: ProviderAdapter = {
  providerId: "test",
  validateModel() {},
  ports: {
    research: { async research() { researchCalls++; throw new ProviderError("INVALID_RESPONSE", { submission: "unknown" }); } },
    structured_assessment: {
      async assess(request) {
        const [key, round] = request.accounting.accountingKey.split(":round-");
        modelCalls.set(key!, (modelCalls.get(key!) ?? 0) + 1);
        return { usage, output: (await scripts.get(key!)!(Number(round))) as never };
      },
    },
  },
};
const tool = (name: string, args: unknown = {}): Decision => ({ decision: "tool", tool: name, argumentsJson: JSON.stringify(args), summary: "" });
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "loop:" + id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const transition = (command: unknown) =>
  app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token }, payload: { method: "transition", command } });

/** A consenting learner's supervisor job, claimed as the durable worker would, with its model script. */
async function job(script: (round: number) => Decision | Promise<Decision>) {
  const learner = await session("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId })).json().id as string;
  const revision = async () => (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().revision as number;
  const consent = await call(learner, "POST", `/api/enrollments/${enrollment}/supervision`, { expectedRevision: await revision(), idempotencyKey: randomUUID(), adaptiveTeaching: true });
  expect(consent.statusCode, consent.body).toBe(200);
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 1000000, tokens: 2000000 });
  const event = await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: enrollment, actorId: learner.id, actorKind: "learner",
    type: "learning.review_requested", payload: { episodeId: "min" }, idempotencyKey: randomUUID(), supervise: true }));
  const outbox = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  expect(claim.effect).toBe("invoke");
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role: "supervisor",
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  const key = createHash("sha256").update(operation.id).digest("hex");
  scripts.set(key, script);
  const gateway = async () => {
    const r = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": operation.id }, payload: request });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Outcome;
  };
  const settle = async (outcome: Outcome) => (await bridge.transition({ type: "settle", ref: ref!, operationId: operation.id, ownerId: operation.ownerId, outcome })).snapshot;
  return { learner, enrollment, ref: ref! as RunRef, gateway, settle, models: () => modelCalls.get(key) ?? 0 };
}
type Job = Awaited<ReturnType<typeof job>>;
const rows = async (sql: string, jobId: string) => (await db.query(sql, [jobId])).rows;
const receipts = (jobId: string) => rows("SELECT tool,step FROM supervisor_tool_calls WHERE job_id=$1 ORDER BY step", jobId);
const artifacts = (jobId: string) => rows("SELECT content FROM supervisor_artifacts WHERE job_id=$1", jobId);
const spend = async (jobId: string) => (await rows("SELECT tokens::int AS tokens FROM supervisor_job_spend WHERE job_id=$1", jobId))[0];
const nothingApplied = async (jobId: string) => {
  for (const table of ["supervisor_applications", "supervisor_plan_effects", "supervisor_model_effects", "supervisor_adaptations"])
    expect((await rows(`SELECT 1 FROM ${table} WHERE job_id=$1`, jobId)).length, table).toBe(0);
};
/** Runs the job to its end and checks the definite refusal: charged, rejected, never applied. */
async function refused(j: Job, reason: string, rounds: number, called = rounds) {
  const outcome = await j.gateway();
  expect(outcome).toMatchObject({ status: "succeeded", usage: { tokens: 30 * rounds }, usageBasis: { tokens: "reported" } });
  expect(j.models()).toBe(called);
  const settled = await j.settle(outcome);
  expect(settled.state).not.toBe("waiting");
  expect(await spend(j.ref.jobId)).toEqual({ tokens: 30 * rounds });
  // Only the reason is stored: no plan, selection or summary from the refused run.
  expect(await artifacts(j.ref.jobId)).toEqual([{ content: { kind: "output_refusal", role: "supervisor", reason } }]);
  const verified = await transition({ type: "verify", ref: j.ref });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(verified.json().snapshot).toMatchObject({ state: "failed", reason: "verification_rejected" });
  expect((await transition({ type: "apply", ref: j.ref })).json().snapshot?.state).toBe("failed");
  await nothingApplied(j.ref.jobId);
  // A retried gateway request is answered from its receipt: no model round runs again.
  expect(await j.gateway()).toEqual(outcome);
  expect(j.models()).toBe(called);
  expect(await spend(j.ref.jobId)).toEqual({ tokens: 30 * rounds });
  return outcome;
}
const learnerTools = async (j: Job) => {
  const r = await call(j.learner, "GET", `/api/enrollments/${j.enrollment}/supervision/tools`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().calls as { tool: string; jobState: string; outcome: { delivery: string | null; selected: boolean; researchState: string | null } }[];
};
const runView = async (jobId: string) => {
  const r = await call(owner, "GET", `/api/admin/courses/${catalog}/runs/${jobId}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders({
    registry: { revision: "loop-refusals", models: [{ id: "planner", providerId: "test", remoteModel: "planner", providerConfig: {}, enabled: true,
      capabilities: ["structured_assessment", "research"], tools: ["web_search"], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: {
      research: { modelId: "planner", maxInputCharacters: 12000, maxOutputTokens: 1000 },
      supervisor: { modelId: "planner", maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 },
    },
  }, () => "synthetic", { test: () => adapter });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: fixture.runtime, providers,
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "loop-refusals", "Loop refusals"]);
  await allowUnpricedPaidWork(db, workspace);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
  owner = await session("owner");
  const imported = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture.course);
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  expect((await call(owner, "POST", `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  const approved = await call(owner, "POST", `/api/admin/releases/${releaseId}/adaptation-registry`, { expectedRegistryRevision: 0, configuration: fixture.config });
  expect(approved.statusCode, approved.body).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("the tool loop's own round checks end the run instead of waiting as uncertain", () => {
  it("an invalid decision after a selection: charged, receipts kept, no partial plan, and every surface shows the run ended", async () => {
    const j = await job((round) => round === 0 ? tool("list_support")
      : round === 1 ? tool("choose_support", { profileId: "ordering-support-profile", entryId: "number-line-support" })
        : { decision: "finish", tool: "none", argumentsJson: '{"applied":true}', summary: "PARTIAL_PLAN_CANARY" });
    await refused(j, "tool_loop_invalid_decision", 3);
    expect(await receipts(j.ref.jobId)).toEqual([{ tool: "list_support", step: 0 }, { tool: "choose_support", step: 1 }]);
    expect(JSON.stringify(await artifacts(j.ref.jobId))).not.toContain("PARTIAL_PLAN_CANARY");
    // Learner timeline: the selection belongs to a failed run and was not delivered.
    const chosen = (await learnerTools(j)).find((c) => c.tool === "choose_support")!;
    expect(chosen).toMatchObject({ jobState: "failed", outcome: { selected: true } });
    expect(chosen.outcome.delivery).not.toBe("applied");
    // Staff run inspector: the refusal and its reason; the selected receipt reads as not delivered, not pending.
    const view = await runView(j.ref.jobId);
    expect(view.status).toBe("failed");
    expect(view.summary).toContain("Runtime reason: verification_rejected.");
    expect(view.summary).toContain("Core refused the model output: tool_loop_invalid_decision.");
    expect(view.artifacts).toEqual([expect.objectContaining({ name: expect.stringMatching(/^Refused model output/), status: "rejected" })]);
    expect(JSON.parse(view.artifacts[0].preview)).toMatchObject({ refusedByCoreChecks: true, refusalReason: "tool_loop_invalid_decision", outputStored: false });
    const toolDecisions = view.decisions.filter((d: { tool: string }) => ["list_support", "choose_support"].includes(d.tool));
    expect(toolDecisions.map((d: { outcome: string }) => d.outcome)).toEqual(["allowed", "denied"]);
    expect(JSON.stringify(view.decisions)).not.toContain("pending_review");
    expect(JSON.stringify(view.decisions)).not.toContain("is pending until");
    expect(view.workflow.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "verification", status: "rejected" }),
      expect.objectContaining({ kind: "artifact", label: expect.stringMatching(/^output_refusal /) })]));
    expect(JSON.stringify(view)).not.toContain("PARTIAL_PLAN_CANARY");
    // A sandboxed replay has nothing to compare and never calls a provider.
    const replay = await call(owner, "POST", `/api/admin/courses/${catalog}/runs/${j.ref.jobId}/replay`);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ outcome: "not_replayable", reason: "refused_output", providerCalls: 0 });
    expect(j.models()).toBe(3);
  }, 30000);

  it("tool arguments that fail the tool's contract are an invalid decision, with nothing recorded for that call", async () => {
    const j = await job((round) => round === 0 ? tool("get_profile") : tool("get_code_results", { assessmentId: "forged" }));
    await refused(j, "tool_loop_invalid_decision", 2);
    expect(await receipts(j.ref.jobId)).toEqual([{ tool: "get_profile", step: 0 }]);
  }, 30000);

  it("a third research request is a candidate limit: staged requests are never dispatched or collected", async () => {
    const j = await job((round) => round === 0 ? tool("list_research_topics") : tool("request_research", { topicId: "ordering-research-" + round }));
    await refused(j, "tool_loop_candidate_limit", 4);
    expect(await receipts(j.ref.jobId)).toEqual([{ tool: "list_research_topics", step: 0 }, { tool: "request_research", step: 1 }, { tool: "request_research", step: 2 }]);
    expect(await rows("SELECT state,activation_event_id FROM research_requests WHERE parent_job_id=$1", j.ref.jobId))
      .toEqual([{ state: "staged", activation_event_id: null }, { state: "staged", activation_event_id: null }]);
    expect(researchCalls).toBe(0);
    const research = (await learnerTools(j)).filter((c) => c.tool === "request_research");
    expect(research.map((c) => [c.jobState, c.outcome.researchState])).toEqual([["failed", "staged"], ["failed", "staged"]]);
    expect(JSON.parse((await runView(j.ref.jobId)).artifacts[0].preview)).toMatchObject({ refusalReason: "tool_loop_candidate_limit" });
  }, 30000);

  it("the round limit ends the run after exactly the bound's paid rounds", async () => {
    const j = await job(() => tool("get_profile"));
    await refused(j, "tool_loop_round_limit", 8);
    expect(await receipts(j.ref.jobId)).toHaveLength(8);
    expect(JSON.parse((await runView(j.ref.jobId)).artifacts[0].preview)).toMatchObject({ refusalReason: "tool_loop_round_limit" });
  }, 30000);

  it("tool refusals decided by the model's own request end the run, with nothing recorded for that call", async () => {
    for (const [decision, code] of [
      [tool("request_research", { topicId: "ordering-research-1" }), "RESEARCH_TOPIC_NOT_OBSERVED"],
      [tool("get_history", { beforeMessageId: randomUUID() }), "SUPERVISOR_HISTORY_SCOPE"],
      [tool("choose_resource", { attachmentId: randomUUID(), objectiveId: "minimum" }), "RESOURCE_NOT_OBSERVED"],
      [tool("check_teaching", { artifactDigest: "c".repeat(64) }), "GENERATED_TEACHING_CANDIDATE_NOT_FOUND"],
    ] as const) {
      const j = await job((round) => round === 0 ? tool("get_profile") : decision);
      await refused(j, "tool_loop_invalid_decision", 2);
      expect(await receipts(j.ref.jobId), code).toEqual([{ tool: "get_profile", step: 0 }]);
    }
  }, 60000);

  it("a later round the provider certainly never received ends the run, charged with the earlier round only", async () => {
    const j = await job((round) => {
      if (round === 0) return tool("get_profile");
      throw new ProviderError("MISSING_CREDENTIAL", { submission: "not_sent" });
    });
    await refused(j, "tool_loop_round_not_started", 1, 2);
    expect(await receipts(j.ref.jobId)).toEqual([{ tool: "get_profile", step: 0 }]);
  }, 30000);

  it("a later round the provider definitely refused ends the run, charged with the earlier round only", async () => {
    const j = await job((round) => {
      if (round === 0) return tool("get_profile");
      const refused = new ProviderError("AUTHENTICATION", { status: 401, submission: "rejected" });
      refused.usage = { ...usage, attempts: [{ attempt: 1, status: 401, outcome: "rejected", tokens: { input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null } }] };
      throw refused;
    });
    await refused(j, "tool_loop_round_rejected", 1, 2);
    const view = await runView(j.ref.jobId);
    expect(view.summary).toContain("not the model's output: tool_loop_round_rejected.");
    expect(view.artifacts).toEqual([expect.objectContaining({ name: expect.stringMatching(/^Run ended without output/), status: "rejected" })]);
    expect(JSON.parse(view.artifacts[0].preview)).toMatchObject({ refusedByCoreChecks: false, refusalReason: "tool_loop_round_rejected" });
  }, 30000);

  it("a generation profile staff withdrew mid-run ends the run as host-side, never waiting", async () => {
    const j = await job(async (round) => {
      if (round === 0) return tool("list_generation_profiles");
      await db.query("UPDATE adaptation_registries SET status='revoked' WHERE course_release_id=$1", [releaseId]);
      return tool("create_teaching", { profileId: "generated-ordering-profile", kind: "explanation", markdown: "Compare each value with the smallest so far.",
        objectiveIds: ["minimum"], sourceRefs: [fixture.source] });
    });
    try {
      await refused(j, "tool_loop_runtime_unavailable", 2);
    } finally {
      await db.query("UPDATE adaptation_registries SET status='active' WHERE course_release_id=$1", [releaseId]);
    }
    expect(await receipts(j.ref.jobId)).toEqual([{ tool: "list_generation_profiles", step: 0 }]);
    expect((await runView(j.ref.jobId)).summary).toContain("not the model's output: tool_loop_runtime_unavailable.");
    const listed = (await learnerTools(j)).find((c) => c.tool === "list_generation_profiles")!;
    expect(listed.jobState).toBe("failed");
  }, 30000);

  it("a refusal caused by the learner changing state mid-run is not blamed on the model: the fence ends the job", async () => {
    let learner: Session | undefined, enrollment = "";
    const j = await job(async (round) => {
      if (round === 0) return tool("list_research_topics");
      // The learner turns personal support off between rounds.
      const revision = (await call(learner!, "GET", `/api/enrollments/${enrollment}`)).json().revision;
      const off = await call(learner!, "POST", `/api/enrollments/${enrollment}/supervision`, { expectedRevision: revision, idempotencyKey: randomUUID(), adaptiveTeaching: false });
      expect(off.statusCode, off.body).toBe(200);
      return tool("request_research", { topicId: "ordering-research-1" });
    });
    learner = j.learner; enrollment = j.enrollment;
    const outcome = await j.gateway();
    expect(outcome).toEqual({ status: "uncertain" });
    expect(await artifacts(j.ref.jobId)).toEqual([]);
    expect(await rows("SELECT 1 FROM research_requests WHERE parent_job_id=$1", j.ref.jobId)).toEqual([]);
    expect(await j.settle(outcome)).toMatchObject({ state: "cancelled", reason: "stale_revision" });
  }, 30000);

  it("an uncertain provider round after a tool round still waits as provider_uncertain and is never resent", async () => {
    const j = await job((round) => {
      if (round === 0) return tool("get_profile");
      throw new ProviderError("TIMEOUT", { submission: "unknown" });
    });
    const outcome = await j.gateway();
    expect(outcome).toEqual({ status: "uncertain" });
    expect(await j.settle(outcome)).toMatchObject({ state: "waiting", reason: "provider_uncertain" });
    expect(await artifacts(j.ref.jobId)).toEqual([]);
    expect(await j.gateway()).toEqual({ status: "uncertain" });
    expect(j.models()).toBe(2);
  }, 30000);
});
