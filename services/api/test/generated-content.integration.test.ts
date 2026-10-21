import { randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import type { ProviderRequest } from "@course-core/supervisor";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { composeProviders } from "../src/provider-composition.js";
import { svgRenderer } from "../src/svg-renderer.js";
import { withInstalledExtensions, checkAdaptationConfiguration, createAdaptationRuntime } from "../src/adaptation-store.js";
import type { RuntimeExtension } from "../src/publication.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";
import { generatedContentFixture, lineScene, syntheticCodeEvaluator } from "./generated-content-fixture.js";

/**
 * Supervisor-generated simulations, check questions and code exercises through the real pipeline
 * (requirements E01, E03, E04, E05, E06): scripted model tool calls, the separate verification
 * phase and the atomic application, on real Postgres and HTTP. Model output is synthetic.
 */
const schema = "generated_content_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  token = randomUUID();
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, testDatabase: TestDatabase | undefined,
  owner: Session, releaseId: string, renderer: RuntimeExtension, fixture: ReturnType<typeof generatedContentFixture>;
const codeRuns: string[] = [];
type Session = { id: string; cookie: string; csrf: string };
const usage: UsageReceipt = { accounting: { accountingKey: "synthetic" }, providerId: "test", modelId: "planner", operation: "assess",
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
const scripts = new Map<string, (round: number, prompt: any) => any>();
const adapter: ProviderAdapter = { providerId: "test", validateModel() {}, ports: { structured_assessment: {
  async assess(req) {
    const [key, round] = req.accounting.accountingKey.split(":round-");
    return { usage, output: scripts.get(key!)!(Number(round), JSON.parse(req.messages[0]!.text)) };
  } } } };
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
async function login(role = "learner"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, "Generated content learner"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const transition = (command: unknown) => app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token },
  payload: { method: "transition", command } });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  renderer = await svgRenderer();
  fixture = generatedContentFixture(renderer);
  const providers = composeProviders({
    registry: { revision: "generated-content", models: [{ id: "planner", providerId: "test", remoteModel: "planner", providerConfig: {}, enabled: true,
      capabilities: ["structured_assessment"], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: { supervisor: { modelId: "planner", maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 } },
  }, () => "synthetic", { test: () => adapter });
  const jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: fixture.runtime, providers,
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy }, installedExtensions: [renderer, syntheticCodeEvaluator(codeRuns)] });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "generated-content", "Generated content"]);
  await allowUnpricedPaidWork(db, workspace);
  owner = await login("owner");
  const imported = await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers: headers(owner), payload: fixture.course });
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${releaseId}/publish`, headers: headers(owner) });
  expect(published.statusCode, published.body).toBe(200);
  const approved = await app.inject({ method: "POST", url: `/api/admin/releases/${releaseId}/adaptation-registry`, headers: headers(owner),
    payload: { expectedRegistryRevision: 0, configuration: fixture.config } });
  expect(approved.statusCode, approved.body).toBe(200);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

/** A learner with adaptive teaching on, and a ready supervisor job about the "min" lesson. */
async function enroll(consent = true) {
  const learner = await login();
  const enrolled = await app.inject({ method: "POST", url: "/api/enrollments", headers: headers(learner), payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id as string;
  const snapshot = async () => (await app.inject({ url: `/api/enrollments/${id}`, headers: headers(learner) })).json();
  const command = async (path: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/enrollments/${id}/${path}`, headers: headers(learner),
      payload: { expectedRevision: (await snapshot()).revision, idempotencyKey: randomUUID(), ...body } });
  expect((await command("supervision", { adaptiveTeaching: consent })).statusCode).toBe(200);
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: id }, { microUsd: 1000000, tokens: 2000000 });
  return { learner, id, snapshot, command };
}
type Learner = Awaited<ReturnType<typeof enroll>>;
async function job(learner: Learner) {
  const event = await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: learner.id, actorId: learner.learner.id, actorKind: "learner",
    type: "learning.review_requested", payload: { episodeId: "min" }, idempotencyKey: randomUUID(), supervise: true }));
  const outbox = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  expect(claim.effect).toBe("invoke");
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role: "supervisor",
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  return { ref: ref!, request, operation };
}
type Job = Awaited<ReturnType<typeof job>>;
/** The model lists profiles, stages one candidate, checks it and finishes. */
function script(j: Job, candidate: (prompt: any) => Record<string, unknown>) {
  scripts.set(createHash("sha256").update(j.request.operationId).digest("hex"), (round, prompt) =>
    round === 0 ? { decision: "tool", tool: "list_generation_profiles", argumentsJson: "{}", summary: "" }
    : round === 1 ? { decision: "tool", tool: "create_teaching", summary: "", argumentsJson: JSON.stringify(candidate(prompt)) }
    : round === 2 && prompt.toolResults.at(-1).result.artifactDigest
      ? { decision: "tool", tool: "check_teaching", summary: "", argumentsJson: JSON.stringify({ artifactDigest: prompt.toolResults.at(-1).result.artifactDigest }) }
    : { decision: "finish", tool: "none", argumentsJson: "{}", summary: "Generated practice for the minimum lesson, after its checks." });
}
async function invoke(j: Job) {
  const r = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": j.request.operationId }, payload: j.request });
  expect(r.statusCode, r.body).toBe(200);
  await bridge.transition({ type: "settle", ref: j.ref, operationId: j.operation.id, ownerId: j.operation.ownerId, outcome: r.json() });
  return r.json();
}
const outcome = async (j: Job, tool: string) => (await db.query("SELECT outcome FROM supervisor_tool_calls WHERE job_id=$1 AND tool=$2", [j.ref.jobId, tool])).rows[0]?.outcome;
const base = { objectiveIds: ["minimum"], sourceRefs: ["ordering-author-reference"] };
const simulation = (scene = lineScene("model-chosen-id")) => () => ({ profileId: "simulation-profile", kind: "simulation", scene, ...base });
const question = (over: Record<string, unknown> = {}) => (prompt: any) => ({ profileId: "check-profile", kind: "check_item",
  prompt: "A line has slope 3 and intercept 1. What is y at x = 4?",
  model: { visualId: prompt.toolResults[0].result.profiles.find((p: any) => p.id === "check-profile").models[0].visualId, state: { slope: 3, x: 4 },
    read: { value: { pane: "rule", symbol: "y" } } },
  explanation: "Multiply the slope by x, then add the intercept: 3 × 4 + 1 = 13.", ...base, ...over });
const exercise = (over: Record<string, unknown> = {}) => () => ({ profileId: "code-profile", kind: "code_exercise",
  prompt: "Write solve(values) that returns the smallest number in the list.", starterCode: "def solve(values):\n    return values[0]\n",
  tests: [{ id: "mixed", input: [3, 1, 2], expected: 1 }, { id: "negative", input: [-4, 0], expected: -4 }, { id: "single", input: [7], expected: 7 }],
  referenceSolution: "def solve(values):\n    return min(values)\n", wrongSolutions: ["def solve(values):\n    return max(values)\n"], ...base, ...over });
/** Generate, verify and apply one candidate. */
async function deliver(learner: Learner, candidate: (prompt: any) => Record<string, unknown>) {
  const j = await job(learner);
  script(j, candidate);
  await invoke(j);
  const verified = await transition({ type: "verify", ref: j.ref });
  expect(verified.statusCode, verified.body).toBe(200);
  return { j, verified: verified.json().snapshot.state as string, apply: async () => {
    const applied = await transition({ type: "apply", ref: j.ref });
    expect(applied.statusCode, applied.body).toBe(200);
    return applied.json().snapshot.state as string;
  } };
}
const lesson = async (learner: Learner) => (await learner.snapshot()).course.chapters[0].episodes.find((e: any) => e.id === "min");
const changes = async (learner: Learner) => (await app.inject({ url: `/api/enrollments/${learner.id}/personal-changes`, headers: headers(learner.learner) })).json().changes;
const evidence = async (learner: Learner) => Number((await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [learner.id])).rows[0].count);

describe("generated simulations (E01, E05)", () => {
  it("a scene the supervisor writes passes the host's model check and the renderer, joins the lesson labelled, grants nothing and can be undone", async () => {
    const learner = await enroll();
    const before = await lesson(learner);
    const run = await deliver(learner, simulation());
    expect((await outcome(run.j, "list_generation_profiles")).result.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "simulation-profile", creates: "simulation" }), expect.objectContaining({ id: "check-profile", creates: "check_item" }),
      expect.objectContaining({ id: "code-profile", creates: "code_exercise", language: "python" })]));
    expect((await outcome(run.j, "check_teaching")).result).toMatchObject({ verification: "passed", failedCheckIds: [], doesNotGrantMastery: true });
    expect(run.verified).toBe("ready");
    expect(await run.apply()).toBe("applied");
    const after = await lesson(learner);
    // Appended after every existing block: the learner's place and earlier parts stay as they were.
    expect(after.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
    const added = after.blocks.at(-1);
    expect(added).toMatchObject({ type: "visual" });
    const delivered = (await learner.snapshot()).course.visuals.find((v: any) => v.id === added.visualId);
    // The host names the scene and the installed renderer draws it; nothing executable was delivered.
    expect(delivered).toMatchObject({ rendererId: "course-core-svg-v1", id: expect.stringMatching(/^artifact-.*--scene$/) });
    expect(await evidence(learner)).toBe(0);
    const listed = await changes(learner);
    expect(listed).toEqual([expect.objectContaining({ kind: "attach_visual", provenance: "generated", unverified: true, revertable: true, blockId: added.id })]);
    const undone = await learner.command("personal-changes/revert", { proposalId: listed[0].proposalId, expectedPlanRevision: (await learner.snapshot()).planRevision ?? 1 });
    expect(undone.statusCode, undone.body).toBe(200);
    expect((await lesson(learner)).blocks).toEqual(before.blocks);
  }, 60000);
  it("a scene whose formula contradicts its trace is check feedback, never ready and never in the lesson", async () => {
    const learner = await enroll();
    const contradictory = lineScene();
    (contradictory.panes[0] as any).values[0].value = { op: "add", args: [(contradictory.panes[0] as any).values[0].value, 1] };
    const run = await deliver(learner, simulation(contradictory));
    expect((await outcome(run.j, "check_teaching")).result).toMatchObject({ verification: "rejected", failedCheckIds: ["host-model-agreement"],
      contentProblems: ["model_invariant_failed"] });
    expect(run.verified).not.toBe("ready");
    expect((await learner.snapshot()).planRevision ?? 0).toBe(0);
  }, 60000);
  it("an invalid scene stages nothing and tells the supervisor why", async () => {
    const learner = await enroll();
    const run = await deliver(learner, () => ({ ...simulation()(), scene: { ...lineScene(), script: "alert(1)" } }));
    expect((await outcome(run.j, "create_teaching")).result).toEqual({ selected: false, reason: "content_invalid", problems: ["scene_invalid"], doesNotGrantMastery: true });
    expect((await outcome(run.j, "create_teaching")).generatedTeaching).toBeUndefined();
  }, 60000);
});

describe("generated check questions keyed by the course's model (E01, E04)", () => {
  it("the host derives the key from the scene, the question joins the lesson's check and is graded on that key", async () => {
    const learner = await enroll();
    const run = await deliver(learner, question());
    expect((await outcome(run.j, "list_generation_profiles")).result.profiles.find((p: any) => p.id === "check-profile").models[0])
      .toMatchObject({ visualId: fixture.authoredVisualId, formulas: [{ pane: "rule", symbols: ["y", "m"] }] });
    // The tool result never carries a key; the staged candidate holds the derived one.
    expect(JSON.stringify((await outcome(run.j, "create_teaching")).result)).not.toContain("13");
    expect((await outcome(run.j, "create_teaching")).generatedTeaching.artifact.assessment.grading.expected).toBe(13);
    expect(run.verified).toBe("ready");
    expect(await run.apply()).toBe("applied");
    const [change] = await changes(learner);
    expect(change).toMatchObject({ kind: "add_assessment_variant", unverified: true, revertable: false, assessmentId: expect.stringMatching(/--item$/) });
    // The learner bundle never carries the key or the model binding.
    const snapshot = await learner.snapshot();
    expect(JSON.stringify(snapshot.course)).not.toContain("scene-model-v1");
    for (const [answer, passed] of [[12, false], [13, true]] as const) {
      const challenge = await learner.command("challenges", { episodeId: "min", assessmentId: change.assessmentId, mode: "practice" });
      expect(challenge.statusCode, challenge.body).toBe(200);
      const answered = await learner.command("answers", { challengeId: challenge.json().challengeId, answer });
      expect(answered.statusCode, answered.body).toBe(200);
      expect(answered.json().result.passed).toBe(passed);
    }
  }, 60000);
  it("a question about a personal simulation is keyed by that simulation", async () => {
    const learner = await enroll();
    expect(await (await deliver(learner, simulation(lineScene()))).apply()).toBe("applied");
    const personal = (await lesson(learner)).blocks.at(-1).visualId;
    const run = await deliver(learner, question({ model: { visualId: personal, state: { slope: -2, x: 5, intercept: 3 }, read: { cell: { pane: "trace", row: 0, column: 1 } } },
      prompt: "With slope -2, intercept 3 and x = 5, what is y?" }));
    expect((await outcome(run.j, "create_teaching")).generatedTeaching.artifact.assessment.grading.expected).toBe(-7);
    expect(await run.apply()).toBe("applied");
  }, 60000);
  it("a wrong claimed key, or a prompt without the numbers it depends on, is refused before anything is staged", async () => {
    const learner = await enroll();
    for (const over of [{ answer: 12 }, { prompt: "What is y here?" }]) {
      const run = await deliver(learner, question(over));
      expect((await outcome(run.j, "create_teaching")).result).toMatchObject({ selected: false, reason: "content_invalid" });
      expect((await outcome(run.j, "create_teaching")).generatedTeaching).toBeUndefined();
      // The run can still finish, with nothing generated to deliver.
      if (run.verified === "ready") await run.apply();
    }
    expect((await learner.snapshot()).planRevision ?? 0).toBe(0);
  }, 60000);
});

describe("generated code exercises (E01, E05)", () => {
  it("hidden tests are proven against the reference and wrong solutions in the grader, then grade the learner's answer", async () => {
    const learner = await enroll();
    codeRuns.length = 0;
    const run = await deliver(learner, exercise());
    expect((await outcome(run.j, "check_teaching")).result).toMatchObject({ verification: "passed" });
    // Reference, starter and the wrong solution ran in the installed grader; none ran in the API.
    expect(codeRuns).toEqual(expect.arrayContaining([expect.stringContaining("min(values)"), expect.stringContaining("values[0]"), expect.stringContaining("max(values)")]));
    expect(run.verified).toBe("ready");
    expect(await run.apply()).toBe("applied");
    const [change] = await changes(learner);
    const snapshot = await learner.snapshot();
    expect(JSON.stringify(snapshot.course)).not.toContain("max(values)");
    expect(JSON.stringify(snapshot.course)).not.toContain("negative");
    for (const [answer, passed] of [["def solve(values):\n    return values[-1]\n", false], ["def solve(values):\n    return min(values)\n", true]] as const) {
      const challenge = await learner.command("challenges", { episodeId: "min", assessmentId: change.assessmentId, mode: "practice" });
      expect(challenge.statusCode, challenge.body).toBe(200);
      const answered = await learner.command("answers", { challengeId: challenge.json().challengeId, answer });
      expect(answered.statusCode, answered.body).toBe(200);
      expect(answered.json().result).toMatchObject({ passed, execution: { totalCases: 3 } });
    }
  }, 60000);
  it("tests that a wrong program passes, or a reference that fails them, never become ready", async () => {
    const learner = await enroll();
    for (const over of [{ referenceSolution: "def solve(values):\n    return sorted(values)[-1]\n" }, { wrongSolutions: ["def solve(values):\n    return min(values) + 0\n"] }]) {
      const run = await deliver(learner, exercise(over));
      expect((await outcome(run.j, "check_teaching")).result).toMatchObject({ verification: "rejected", failedCheckIds: ["host-code-reference"] });
      expect(run.verified).not.toBe("ready");
    }
    expect((await learner.snapshot()).planRevision ?? 0).toBe(0);
  }, 60000);
});

describe("changes land only at a safe boundary (E03)", () => {
  it("an addition while the learner is mid-question waits, can be added after the attempt, and keeps their place", async () => {
    const learner = await enroll();
    expect((await learner.command("read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
    const open = await learner.command("challenges", { episodeId: "min", assessmentId: "min-a", mode: "practice" });
    expect(open.statusCode, open.body).toBe(200);
    const before = await lesson(learner);
    const run = await deliver(learner, simulation());
    expect(run.verified).toBe("ready");
    expect(await run.apply()).toBe("applied");
    // Nothing changed in the lesson; the change waits for the learner.
    expect(await lesson(learner)).toEqual(before);
    const listed = async () => (await app.inject({ url: `/api/enrollments/${learner.id}/personal-changes/pending`, headers: headers(learner.learner) })).json().pending;
    const [pending] = await listed();
    expect(pending).toMatchObject({ kind: "attach_visual", episodeId: "min", reason: "attempt_in_progress", addableNow: false, waitingFor: "attempt_in_progress" });
    expect(JSON.stringify(pending)).not.toContain("scene");
    const early = await learner.command("personal-changes/pending/apply", { pendingId: pending.pendingId });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("ADAPTATION_NOT_AT_SAFE_BOUNDARY");
    // Another learner cannot see or add it.
    const other = await login();
    expect((await app.inject({ url: `/api/enrollments/${learner.id}/personal-changes/pending`, headers: headers(other) })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await learner.command("answers", { challengeId: open.json().challengeId, answer: "two" })).statusCode).toBe(200);
    expect((await listed())[0]).toMatchObject({ addableNow: true });
    const added = await learner.command("personal-changes/pending/apply", { pendingId: pending.pendingId });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ status: "applied", planRevision: 1 });
    const after = await learner.snapshot();
    const episode = after.course.chapters[0].episodes.find((e: any) => e.id === "min");
    expect(episode.blocks.slice(0, before.blocks.length)).toEqual(before.blocks);
    expect(episode.blocks.at(-1)).toMatchObject({ type: "visual" });
    // The part the learner had read is still read.
    expect(after.lessons.find((l: any) => l.id === "min").completedBlockIds).toEqual(["min-text"]);
    expect(await listed()).toEqual([]);
    expect((await learner.command("personal-changes/pending/apply", { pendingId: pending.pendingId })).json().error).toBe("PENDING_CHANGE_RESOLVED");
  }, 60000);
  it("a waiting change lapses when consent is withdrawn, and can be turned down", async () => {
    for (const ending of ["lapse", "decline"] as const) {
      const learner = await enroll();
      const open = await learner.command("challenges", { episodeId: "min", assessmentId: "min-a", mode: "practice" });
      const run = await deliver(learner, simulation());
      expect(await run.apply()).toBe("applied");
      const [pending] = (await app.inject({ url: `/api/enrollments/${learner.id}/personal-changes/pending`, headers: headers(learner.learner) })).json().pending;
      await learner.command("answers", { challengeId: open.json().challengeId, answer: "two" });
      if (ending === "lapse") {
        expect((await learner.command("supervision", { adaptiveTeaching: false })).statusCode).toBe(200);
        const lapsed = await learner.command("personal-changes/pending/apply", { pendingId: pending.pendingId });
        expect(lapsed.json()).toMatchObject({ status: "lapsed", code: "SUPERVISION_CONSENT_CHANGED" });
      } else {
        const declined = await learner.command("personal-changes/pending/decline", { pendingId: pending.pendingId });
        expect(declined.json()).toMatchObject({ status: "declined" });
      }
      expect((await learner.snapshot()).planRevision ?? 0).toBe(0);
      expect((await db.query("SELECT status FROM adaptation_pending_changes WHERE id=$1", [pending.pendingId])).rows[0].status).toBe(ending === "lapse" ? "lapsed" : "declined");
    }
  }, 90000);
});

describe("registry approval of generated content", () => {
  it("needs the installed scene renderer for simulations and a generated-test evaluator for code exercises", () => {
    const bare = createAdaptationRuntime([fixture.adapter]);
    expect(checkAdaptationConfiguration(fixture.course, fixture.config, bare)).toEqual({ valid: false, code: "GENERATED_SIMULATION_RENDERER_UNAVAILABLE" });
    const noCode = { ...fixture.config, profiles: fixture.config.profiles.filter((p) => p.id !== "simulation-profile") };
    expect(checkAdaptationConfiguration(fixture.course, noCode, withInstalledExtensions(bare, [renderer]))).toEqual({ valid: false, code: "GENERATED_CODE_EVALUATOR_UNAVAILABLE" });
    expect(checkAdaptationConfiguration(fixture.course, fixture.config, withInstalledExtensions(bare, [renderer, syntheticCodeEvaluator()]))).toEqual({ valid: true, profiles: 3 });
    const keyless = { ...fixture.config, profiles: [{ ...fixture.config.profiles[1]!, canonicalAssessmentId: undefined }] };
    expect(checkAdaptationConfiguration(fixture.course, JSON.parse(JSON.stringify(keyless)), withInstalledExtensions(bare, [renderer, syntheticCodeEvaluator()])))
      .toEqual({ valid: false, code: "GENERATED_TEACHING_PROFILE_INVALID" });
    const choice = { ...fixture.config, profiles: [{ ...fixture.config.profiles[1]!, canonicalAssessmentId: "min-a" }] };
    expect(checkAdaptationConfiguration(fixture.course, choice, withInstalledExtensions(bare, [renderer, syntheticCodeEvaluator()])).valid).toBe(false);
  });
});
