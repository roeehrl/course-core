import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DockerSandbox, QUALIFIED_IMAGES } from "@course-core/sandbox";
import { compileCourse } from "@course-core/sdk/compiler";
import { createDatabase, transaction } from "../src/database.js";
import { appendEvent } from "../src/events.js";
import { composeProviders } from "../src/provider-composition.js";
import {
  configureSupervisorBudget,
  createPostgresSupervisorBridge,
  recordSupervisorVerification,
  storeSupervisorArtifact,
} from "../src/supervisor-bridge.js";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { hashPassword, storePassword } from "../src/passwords.js";
import { existsSync } from "node:fs";
import { ensureCatalog } from "../src/admin-routes.js";
import { fixture } from "../test/fixture.js";
import { allowUnpricedPaidWork } from "../test/cost-fixture.js";
import { syntheticResearchInspector } from "../test/research-fixture.js";
import { placementWrittenCourse, rubricCourse } from "../test/rubric-fixture.js";
import { enablePlacement } from "../test/placement-admin-fixture.js";
import { gatedCourse, repairEvaluatorStub } from "../test/gated-fixture.js";
import { activityCourse, hintProbeCourse, hintProbeRuntime, sandboxedActivity, sandboxedActivityRuntime, sandboxedDeclaration, syntheticActivityEvaluator } from "../test/activity-fixture.js";
import { declarativeActivityRuntime } from "../src/activity-runtime.js";
import { retentionCourse } from "../test/retention-fixture.js";
import { hypothesisCourse } from "../test/hypothesis-fixture.js";
import { teachingContext } from "../src/provider-context.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { createMediaJobService, workspaceMediaResolver } from "../src/media-jobs.js";
import { MEDIA_CREDENTIAL, SYNTHETIC_CAPTIONS, ScriptedVideo, mediaConfiguration, mediaJobPolicy } from "../test/media-fixture.js";
import { toVisualExperience } from "@course-core/visuals/headless";
import { closeEnrollment, previewClosure } from "@course-core/policy";
import { sortingDemo } from "@course-core/visuals/demos";
import { svgRenderer } from "../src/svg-renderer.js";
import { supervisorGeneratedTeachingFixture } from "../test/generated-teaching-fixture.js";
import { generatedContentFixture, lineScene, LINE_COMPONENT_SOURCE, syntheticCodeEvaluator } from "../test/generated-content-fixture.js";
import { recoveryFixture } from "../test/recovery-fixture.js";
import {
  approveAdaptationRegistry,
  createAdaptationRuntime,
  withInstalledExtensions,
} from "../src/adaptation-store.js";
import { codeEvaluator } from "../src/code-evaluator.js";
import { offsetClock } from "../src/clock.js";
import {
  comparisonFixtures,
  codeRecoveryFixture,
} from "../test/code-recovery-fixture.js";
import {
  DEFAULT_BROWSER_PORT,
  DEFAULT_PASSKEY_PORT,
  parsePort,
} from "./ports.js";

// Test-only loopback host. Not included in the API build or production routes.
if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  throw new Error(
    "Use only TEST_DATABASE_URL for real browser/database acceptance.",
  );
// This file is the disposable test host itself (it refuses anything but a loopback
// test database below), so it declares the test environment for every Playwright
// config that launches it. Only then does createServer accept its test clock.
process.env.NODE_ENV = "test";
// Ports come from the Playwright config (browser/ports.ts): fixed 4317/4318 in CI,
// free loopback ports locally, or COURSE_BROWSER_PORT / COURSE_BROWSER_PASSKEY_PORT.
const port =
    parsePort("COURSE_BROWSER_PORT", process.env.COURSE_BROWSER_PORT) ??
    DEFAULT_BROWSER_PORT,
  passkeyPort =
    parsePort("COURSE_BROWSER_PASSKEY_PORT", process.env.COURSE_BROWSER_PASSKEY_PORT) ??
    DEFAULT_PASSKEY_PORT,
  hostOrigin = `http://127.0.0.1:${port}`;
const testUrl = new URL(process.env.TEST_DATABASE_URL);
if (
  !["postgres:", "postgresql:"].includes(testUrl.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(testUrl.hostname) ||
  !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(testUrl.pathname) ||
  testUrl.search ||
  testUrl.hash
)
  throw new Error("Disposable loopback test database required.");
const storageRoot = fileURLToPath(new URL("../.local/", import.meta.url));
await mkdir(storageRoot, { recursive: true, mode: 0o700 });
const storage = await mkdtemp(path.join(storageRoot, "browser-code-"));
const image =
  process.env.COURSE_SANDBOX_IMAGE ??
  QUALIFIED_IMAGES[process.arch as keyof typeof QUALIFIED_IMAGES];
if (!image) throw new Error("A qualified Python image is required.");
const sandbox = new DockerSandbox({ image, storageDirectory: storage });
if (!(await sandbox.readiness()).ready)
  throw new Error(
    "Real prepared Docker isolation is required for browser code qualification.",
  );
const schema = `course_browser_${randomUUID().replaceAll("-", "")}`;
const admin = createDatabase(process.env.TEST_DATABASE_URL);
await admin.query(`CREATE SCHEMA ${schema}`);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set("options", `-csearch_path=${schema}`);
const db = createDatabase(url.toString());
await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
// Placement is off until staff enable it (migration 048). This disposable browser host's course
// fixtures were written for placement being offered, so every course published here starts with
// placement enabled, as an owner would set it. The default itself is covered by
// test/placement-admin.integration.test.ts; the settings route by enablePlacement() below.
await db.query(`CREATE FUNCTION browser_host_enable_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'published' THEN
    INSERT INTO placement_settings(workspace_id,course_key,enabled,retest_cooldown_hours) VALUES (NEW.workspace_id,NEW.course_key,true,0) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$`);
await db.query("CREATE TRIGGER browser_host_enable_placement AFTER INSERT OR UPDATE OF status ON course_releases FOR EACH ROW EXECUTE FUNCTION browser_host_enable_placement()");
const workspaceId = randomUUID(),
  ownerId = randomUUID(),
  releaseId = randomUUID(),
  supervisorToken = randomUUID();
const generatedFixture = supervisorGeneratedTeachingFixture();
generatedFixture.course.id = "generated-ordering";
generatedFixture.course.title = "Verified teaching examples";
const generatedReleaseId = randomUUID(),
  generatedCourse = compileCourse(generatedFixture.course);
// Same verified generator, but its addition is optional for the learner.
const optionalFixture = supervisorGeneratedTeachingFixture();
optionalFixture.course.id = "generated-optional";
optionalFixture.course.title = "Optional teaching examples";
for (const profile of optionalFixture.config.profiles) if (profile.operation === "append_teaching") profile.classification = "optional";
optionalFixture.course.adaptation!.limits.allowedClassifications = ["required", "optional"];
const optionalReleaseId = randomUUID(),
  optionalCourse = compileCourse(optionalFixture.course);
const generatedMarkdown = "Minimum of [31, -14, 9] is -14.";
// The generated-content course (set below, once the renderer is installed): the supervisor writes a simulation.
let contentCourseDigest = "";
/** Operations whose supervisor writes an interactive component instead of a simulation. */
const componentOperations = new Set<string>();
const lineComponent = { title: "Line explorer", description: "Change the slope, x and intercept, then run the model to see y.", source: LINE_COMPONENT_SOURCE,
  inputs: [{ name: "slope", label: "Slope", min: -5, max: 5, step: 1, initial: 2 }, { name: "x", label: "Input x", min: 0, max: 10, step: 1, initial: 3 },
    { name: "intercept", label: "Intercept", min: -10, max: 10, step: 1, initial: 1 }],
  outputs: [{ name: "y", label: "Output y" }],
  tests: [{ id: "start", input: { slope: 2, x: 3, intercept: 1 }, expected: { y: 7 } }, { id: "steep", input: { slope: 5, x: 10, intercept: -10 }, expected: { y: 40 } },
    { id: "flat", input: { slope: 0, x: 4, intercept: 3 }, expected: { y: 3 } }] };
const contentScript = (round: number, component: boolean) =>
  round === 0
    ? { decision: "tool", tool: "list_generation_profiles", argumentsJson: "{}", summary: "" }
    : round === 1
      ? { decision: "tool", tool: "create_teaching", summary: "", argumentsJson: JSON.stringify(component
          ? { profileId: "component-profile", kind: "component", component: lineComponent, objectiveIds: ["minimum"], sourceRefs: ["ordering-author-reference"] }
          : { profileId: "simulation-profile", kind: "simulation", scene: lineScene("browser-line"), objectiveIds: ["minimum"], sourceRefs: ["ordering-author-reference"] }) }
      : { decision: "finish", tool: "none", argumentsJson: "{}", summary: "Generated practice of a straight line for the minimum lesson." };
const repairOperations = new Set<string>();
const modelAdapter: ProviderAdapter = {
  providerId: "browser-supervisor",
  validateModel() {},
  ports: {
    structured_assessment: {
      async assess(req) {
        const round = Number(req.accounting.accountingKey.split(":round-")[1]),
          prompt = JSON.parse(req.messages[0]!.text);
        const repair = repairOperations.has(
          req.accounting.accountingKey.split(":round-")[0]!,
        );
        const output = repair
          ? round === 0
            ? {
                decision: "tool",
                tool: "list_generation_profiles",
                argumentsJson: "{}",
                summary: "",
              }
            : round === 1 || round === 3
              ? {
                  decision: "tool",
                  tool: "create_teaching",
                  argumentsJson: JSON.stringify({
                    profileId: "generated-ordering-profile",
                    kind: "explanation",
                    markdown:
                      round === 1
                        ? "Minimum of [31, -14, 9] is 9."
                        : generatedMarkdown,
                    objectiveIds: ["minimum"],
                    sourceRefs: [generatedFixture.source],
                  }),
                  summary: "",
                }
              : round === 2
                ? {
                    decision: "tool",
                    tool: "check_teaching",
                    argumentsJson: JSON.stringify({
                      artifactDigest:
                        prompt.toolResults.at(-1).result.artifactDigest,
                    }),
                    summary: "",
                  }
                : {
                    decision: "finish",
                    tool: "none",
                    argumentsJson: "{}",
                    summary: "Use the repaired independently checked example.",
                  }
          : prompt.context.course.digest === contentCourseDigest
            ? contentScript(round, componentOperations.has(req.accounting.accountingKey.split(":round-")[0]!))
          : prompt.context.course.digest === generatedCourse.digest || prompt.context.course.digest === optionalCourse.digest
            ? round === 0
              ? {
                  decision: "tool",
                  tool: "list_generation_profiles",
                  argumentsJson: "{}",
                  summary: "",
                }
              : round === 1
                ? {
                    decision: "tool",
                    tool: "create_teaching",
                    argumentsJson: JSON.stringify({
                      profileId: "generated-ordering-profile",
                      kind: "explanation",
                      markdown: generatedMarkdown,
                      objectiveIds: ["minimum"],
                      sourceRefs: [generatedFixture.source],
                    }),
                    summary: "",
                  }
                : {
                    decision: "finish",
                    tool: "none",
                    argumentsJson: "{}",
                    summary:
                      "New teaching requires independent reference verification.",
                  }
            : round === 0
              ? {
                  decision: "tool",
                  tool: "get_model_sources",
                  argumentsJson: "{}",
                  summary: "",
                }
              : round === 1
                ? {
                    decision: "tool",
                    tool: "suggest_model",
                    argumentsJson: JSON.stringify({
                      suggestion: {
                        kind: "explanation_style",
                        value: "step_by_step",
                      },
                      sourceEventIds: [
                        prompt.toolResults.at(-1).result.sources[0].eventId,
                      ],
                    }),
                    summary: "",
                  }
                : {
                    decision: "finish",
                    tool: "none",
                    argumentsJson: "{}",
                    summary: "Propose a learning preference for review.",
                  };
        const usage: UsageReceipt = {
          accounting: req.accounting,
          providerId: "browser-supervisor",
          modelId: "planner",
          operation: "assess",
          attempts: [
            {
              attempt: 1,
              status: 200,
              outcome: "response",
              tokens: {
                input: 10,
                output: 10,
                total: 20,
                cachedInput: 0,
                thoughts: 0,
                toolInput: 0,
              },
            },
          ],
          inputCharacters: 100,
          requestedMaxOutputTokens: 1000,
          requestedVideoSeconds: null,
          observedImageCount: null,
          observedVideoCount: null,
          cost: null,
        };
        return { output, usage };
      },
    },
  },
};
const providers = composeProviders(
  {
    registry: {
      revision: "browser-supervisor",
      models: [
        {
          id: "planner",
          providerId: modelAdapter.providerId,
          remoteModel: "synthetic-planner",
          providerConfig: {},
          enabled: true,
          capabilities: ["structured_assessment"],
          limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 },
        },
      ],
    },
    adapters: [
      {
        id: modelAdapter.providerId,
        kind: "browser",
        credentialEnv: "COURSE_PROVIDER_BROWSER_API_KEY",
      },
    ],
    roles: {
      supervisor: {
        modelId: "planner",
        maxInputCharacters: 30000,
        maxOutputTokens: 1000,
        maxToolRounds: 8,
      },
    },
  },
  () => "synthetic",
  { browser: () => modelAdapter },
);
const supervisorOptions = {
  serviceToken: supervisorToken,
  workspaceIds: [workspaceId],
  jobPolicy: { allowance: { microUsd: 100000, tokens: 1200000 } },
};
const renderer = await svgRenderer(),
  recovery = recoveryFixture(),
  grader = await codeEvaluator(
    Buffer.from(JSON.stringify(comparisonFixtures)),
    sandbox,
  ),
  codeRecovery = codeRecoveryFixture(grader),
  content = generatedContentFixture(renderer),
  contentReleaseId = randomUUID(),
  contentCourse = compileCourse(content.course);
contentCourseDigest = contentCourse.digest;
// Test-only generated media: a scripted video adapter behind its own provider store.
// Only the media service uses it; the supervisor keeps the fixed test providers.
const mediaVideo = new ScriptedVideo(),
  mediaProviders = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": mediaVideo.factory() }),
  mediaOptions = { pollIntervalMs: 1000 };
// This disposable host's server clock runs 25 hours ahead (accepted only under NODE_ENV=test,
// set at the top of this file). It decides retention due-ness only, so a check demonstrated
// "now" is already due without rewriting any stored timestamp.
const app = await createServer(db, { loginCodes: true, clock: offsetClock(25 * 3_600_000),
  // Browser practice runs: a short wall-clock limit so the runaway-loop journey stays quick.
  pythonRunner: { timeoutMs: 3000 },
  media: { resolver: workspaceMediaResolver(mediaProviders), options: mediaOptions },
  origin: hostOrigin,
  secureCookies: false,
  learnerDirectory: fileURLToPath(
    new URL("../../../apps/learner/dist", import.meta.url),
  ),
  // The admin export is served when built (root `check api` builds it).
  ...(existsSync(fileURLToPath(new URL("../../../apps/admin/dist/index.html", import.meta.url)))
    ? { adminDirectory: fileURLToPath(new URL("../../../apps/admin/dist", import.meta.url)) }
    : {}),
  // The repair stub only serves the versioned-gate fixture's code-repair item (test host only).
  // The synthetic code evaluator tests generated components and exercises here (test host only).
  installedExtensions: [renderer, grader, reviewedRubricEvaluator(), repairEvaluatorStub(), syntheticCodeEvaluator(),
    // Activity runtime: Core's interpreter, a synthetic sandboxed probe and evaluator (test host only).
    declarativeActivityRuntime(), sandboxedActivityRuntime(), syntheticActivityEvaluator(), hintProbeRuntime()],
  adaptation: createAdaptationRuntime([
    ...recovery.runtime.adapters,
    ...codeRecovery.runtime.adapters,
    ...generatedFixture.runtime.adapters.filter(
      (a) => a.kind === "generated-teaching",
    ),
    content.adapter,
  ]),
  providers,
  supervisor: supervisorOptions,
  // Test-only: inspections never touch the network.
  researchInspector: syntheticResearchInspector(),
});
const source = recovery.course,
  visual = toVisualExperience(sortingDemo);
source.extensions.push({
  id: renderer.id,
  version: renderer.version,
  integrity: renderer.integrity,
  execution: "declarative",
  entrypoint: "renderers/svg-v1.js",
  platforms: ["web"],
  capabilities: ["visual.render"],
  accessibility: {
    keyboard: true,
    reducedMotion: true,
    textAlternative: visual.accessibility.description,
  },
});
source.visuals.push(visual);
source.chapters[0]!.episodes[1]!.blocks.unshift({
  id: "max-visual",
  type: "visual",
  visualId: visual.id,
});
const course = compileCourse(source);
await db.query(
  "INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)",
  [ownerId, "test:owner", "Test owner"],
);
await db.query("INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)", [
  workspaceId,
  "browser",
  "Browser acceptance",
]);
await allowUnpricedPaidWork(db, workspaceId);
await db.query(
  "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
  [workspaceId, ownerId],
);
await db.query(
  "INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
  [
    releaseId,
    workspaceId,
    course.server.id,
    course.server.version,
    course.digest,
    JSON.stringify(course.server),
    JSON.stringify(course.learner),
    ownerId,
  ],
);
await approveAdaptationRegistry(
  db,
  { id: ownerId, displayName: "Test owner" },
  { releaseId, expectedRegistryRevision: 0, configuration: recovery.config },
  recovery.runtime,
);
await db.query(
  "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
  [
    generatedReleaseId,
    workspaceId,
    generatedCourse.server.id,
    generatedCourse.server.version,
    generatedCourse.digest,
    JSON.stringify(generatedCourse.server),
    JSON.stringify(generatedCourse.learner),
    ownerId,
  ],
);
await approveAdaptationRegistry(
  db,
  { id: ownerId, displayName: "Test owner" },
  {
    releaseId: generatedReleaseId,
    expectedRegistryRevision: 0,
    configuration: generatedFixture.config,
  },
  generatedFixture.runtime,
);
await db.query(
  "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
  [optionalReleaseId, workspaceId, optionalCourse.server.id, optionalCourse.server.version, optionalCourse.digest, JSON.stringify(optionalCourse.server), JSON.stringify(optionalCourse.learner), ownerId],
);
await approveAdaptationRegistry(
  db,
  { id: ownerId, displayName: "Test owner" },
  { releaseId: optionalReleaseId, expectedRegistryRevision: 0, configuration: optionalFixture.config },
  optionalFixture.runtime,
);
const codeWorkspaceId = randomUUID(),
  codeReleaseId = randomUUID(),
  codeCourse = compileCourse(codeRecovery.course);
await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
  codeWorkspaceId,
  "browser-code",
  "Code recovery acceptance",
]);
await allowUnpricedPaidWork(db, codeWorkspaceId);
await db.query(
  "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
  [codeWorkspaceId, ownerId],
);
await db.query(
  "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
  [
    codeReleaseId,
    codeWorkspaceId,
    codeCourse.server.id,
    codeCourse.server.version,
    codeCourse.digest,
    JSON.stringify(codeCourse.server),
    JSON.stringify(codeCourse.learner),
    ownerId,
  ],
);
await approveAdaptationRegistry(
  db,
  { id: ownerId, displayName: "Test owner" },
  {
    releaseId: codeReleaseId,
    expectedRegistryRevision: 0,
    configuration: codeRecovery.config,
  },
  codeRecovery.runtime,
);
await db.query(
  "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
  [contentReleaseId, workspaceId, contentCourse.server.id, contentCourse.server.version, contentCourse.digest, JSON.stringify(contentCourse.server), JSON.stringify(contentCourse.learner), ownerId],
);
// Approval checks generated content against the installed renderer and a generated-test evaluator.
await approveAdaptationRegistry(
  db,
  { id: ownerId, displayName: "Test owner" },
  { releaseId: contentReleaseId, expectedRegistryRevision: 0, configuration: content.config },
  withInstalledExtensions(content.runtime, [renderer, syntheticCodeEvaluator()]),
);
// Raw fixture inserts must establish the same catalogue records as real import.
for (const id of [releaseId, generatedReleaseId, optionalReleaseId, codeReleaseId, contentReleaseId]) await ensureCatalog(db, id);
app.post("/test/code-session", async () => {
  const userId = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [userId, `test:${userId}`, "Browser code learner"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')",
    [codeWorkspaceId, userId],
  );
  return { token: await issueLoginCode(db, userId) };
});
// Exercises the real staff API (import, publish, source, inspect, review,
// attach) and returns a learner sign-in code for the same workspace.
app.post("/test/research-session", async () => {
  const workspace = randomUUID(),
    origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspace,
    "research-" + workspace,
    "Research browser workspace",
  ]);
  await allowUnpricedPaidWork(db, workspace);
  const ids: Record<string, string> = {};
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [ids[role], "research-browser:" + ids[role], role === "owner" ? "Research owner" : "Research learner"],
    );
    await db.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspace, ids[role], role],
    );
  }
  const login = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, ids.owner!) },
  });
  const headers = {
    origin,
    cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    "x-csrf-token": login.json().csrfToken,
  };
  const call = async (url: string, payload?: unknown) => {
    const r = await app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    if (r.statusCode !== 200) throw Error(`Research fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const manifest = fixture();
  // A wide code block scrolls sideways on phones and must stay keyboard reachable.
  const text = manifest.chapters[0]!.episodes[0]!.blocks[0] as { markdown: string };
  text.markdown += "\n\n```python\nsmallest = values[0]; [smallest := value for value in values[1:] if value < smallest]  # keep the smaller value at each comparison step\n```";
  manifest.research = {
    publicTopics: [
      { id: "minimum-research", objectiveIds: ["minimum"], queryText: "Public explanation of finding the minimum of a list" },
    ],
  };
  const release = (await call(`/api/workspaces/${workspace}/releases`, manifest)).id;
  await call(`/api/releases/${release}/publish`);
  const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
  for (const source of [
    { kind: "web", url: "https://docs.python.org/3/library/functions.html", quote: "Each comparison keeps the smaller value", rights: { use: "link_only", basis: "link_only", reference: "Linked with attribution only." } },
    { kind: "youtube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", fallbackText: "The walkthrough keeps the smaller value after each comparison and then checks it against every element.", quote: "keeps the smaller value after each comparison", rights: { use: "embed", basis: "provider_embed", reference: "Provider embedded player terms." } },
  ]) {
    const added = await call(`/api/admin/releases/${release}/research/sources`, {
      topicId: "minimum-research",
      kind: source.kind,
      url: source.url,
      ...(source.fallbackText ? { fallbackText: source.fallbackText } : {}),
      expiresAt,
      idempotencyKey: "fixture-" + randomUUID(),
    });
    const inspection = await call(`/api/admin/research/sources/${added.sourceId}/inspect`, {});
    const library = (await app.inject({ url: `/api/admin/releases/${release}/research/library`, headers })).json();
    const inspected = library.sources.find((s: { id: string }) => s.id === added.sourceId).inspections[0];
    const review = await call(`/api/admin/research/inspections/${inspection.inspectionId}/review`, {
      decision: "approved",
      contentDigest: inspected.contentDigest,
      rationale: "Reinforces the running-minimum invariant with a second representation.",
      evidence: [{ quote: source.quote, relevance: "States the invariant this episode assesses." }],
      suitability: { topicRelevant: true, accurateEnoughForUse: true, safeForAudience: true },
      rights: source.rights,
      acknowledgesTruncation: false,
      idempotencyKey: "fixture-" + randomUUID(),
    });
    await call(`/api/admin/research/reviews/${review.reviewId}/attachments`, {
      episodeId: "min",
      expiresAt,
      idempotencyKey: "fixture-" + randomUUID(),
    });
  }
  return { token: await issueLoginCode(db, ids.learner!) };
});
// A workspace with a reviewed written-answer course: returns a learner sign-in
// code and an owner session the test uses as the (separate) reviewer.
// A learner whose episode has one generated clip that staff approved and attached,
// and one generated clip still under review (never shown), all through the real API.
app.post("/test/media-session", async () => {
  const workspace = randomUUID(), origin = hostOrigin, ids: Record<string, string> = {};
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "media-" + workspace, "Media browser workspace"]);
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "media-browser:" + ids[role], role === "owner" ? "Media owner" : "Media learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = async (id: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { origin, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ids.owner!), learner = await login(ids.learner!);
  const call = async (url: string, payload: unknown, headers = owner) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw Error(`Media fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const release = (await call(`/api/workspaces/${workspace}/releases`, fixture())).id;
  await call(`/api/releases/${release}/publish`, {});
  const enrollmentId = (await call("/api/enrollments", { releaseId: release }, learner)).id;
  await mediaProviders.save({ id: ids.owner!, displayName: "Media owner" }, workspace, { expectedRevision: 0, idempotencyKey: "media-" + randomUUID(),
    configuration: mediaConfiguration(), jobPolicy: mediaJobPolicy(250_000), credentials: { [MEDIA_CREDENTIAL]: "synthetic-media-credential" } });
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 5_000_000, tokens: 1_000_000 });
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId }, { microUsd: 5_000_000, tokens: 1_000_000 });
  const jobs: string[] = [];
  for (const title of ["Running minimum in motion", "Unreviewed draft clip"])
    jobs.push((await call(`/api/admin/enrollments/${enrollmentId}/media-jobs`, { episodeId: "min", title,
      objective: "Show the running minimum keeping the smaller value at each comparison.",
      script: "Narrated diagram: a highlight moves along a list and stays on the smaller value after each comparison.", idempotencyKey: "media-" + randomUUID() })).id);
  const worker = createMediaJobService(db, workspaceMediaResolver(mediaProviders), mediaOptions);
  for (let i = 0; i < 4; i++) await worker.run({ now: new Date(Date.now() + i * 2000), limit: 10 });
  const approved = (await app.inject({ url: `/api/admin/media-jobs/${jobs[0]}`, headers: owner })).json();
  await call(`/api/admin/media-jobs/${jobs[0]}/review`, { decision: "approved", assetSha256: approved.asset.sha256, captionsVtt: SYNTHETIC_CAPTIONS,
    transcript: "The running minimum keeps the smaller value after each comparison in the list.",
    visualDescription: "A list of five boxes; a highlight moves left to right and stays on the smallest value so far.",
    findings: { factualAccuracy: true, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true },
    rationale: "Matches the reference trace for the minimum episode and the captions follow the narration.", idempotencyKey: "media-" + randomUUID() });
  await call(`/api/admin/media-jobs/${jobs[0]}/attach`, { expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), idempotencyKey: "media-" + randomUUID() });
  return { token: await issueLoginCode(db, ids.learner!) };
});
// The debug inspector reachable from the learner app (U01): a course whose first lesson opens on an
// illustration, published by a workspace owner who is also enrolled, and a plain learner enrolled
// beside them. `role` picks who signs in to the learner app.
app.post("/test/inspector-session", async (request) => {
  const role = (request.body as { role?: string } | null)?.role === "learner" ? "learner" : "owner";
  const workspace = randomUUID(), origin = hostOrigin, ids: Record<string, string> = {};
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "inspector-" + workspace, "Inspector browser workspace"]);
  for (const member of ["owner", "learner"]) {
    ids[member] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[member], "inspector-browser:" + ids[member], member === "owner" ? "Inspector owner" : "Inspector learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[member], member]);
  }
  const login = async (id: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { origin, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": r.json().csrfToken };
  };
  const call = async (url: string, payload: unknown, headers: Record<string, string>) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw Error(`Inspector fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const owner = await login(ids.owner!), learner = await login(ids.learner!);
  const lesson = fixture(), illustration = toVisualExperience(sortingDemo);
  lesson.id = "inspector-ordering";
  lesson.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: "declarative", entrypoint: "renderers/svg-v1.js",
    platforms: ["web"], capabilities: ["visual.render"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: illustration.accessibility.description } });
  lesson.visuals.push(illustration);
  lesson.chapters[0]!.episodes[0]!.blocks.unshift({ id: "min-visual", type: "visual", visualId: illustration.id });
  const release = (await call(`/api/workspaces/${workspace}/releases`, lesson, owner)).id;
  await call(`/api/releases/${release}/publish`, {}, owner);
  const enrollments = { owner: (await call("/api/enrollments", { releaseId: release }, owner)).id, learner: (await call("/api/enrollments", { releaseId: release }, learner)).id };
  return { token: await issueLoginCode(db, ids[role]!), enrollmentId: enrollments[role], otherEnrollmentId: enrollments[role === "owner" ? "learner" : "owner"] };
});
app.post("/test/rubric-session", async () => {
  const workspace = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "rubric-" + workspace, "Rubric browser workspace"]);
  await allowUnpricedPaidWork(db, workspace);
  const ids: Record<string, string> = {};
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "rubric-browser:" + ids[role], role === "owner" ? "Rubric reviewer" : "Rubric learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, ids.owner!) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const release = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers, payload: rubricCourse() })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers });
  if (published.statusCode !== 200) throw Error("Rubric fixture publication failed: " + published.body);
  await enablePlacement(app, { cookie: headers.cookie, csrf: headers["x-csrf-token"] }, origin, workspace);
  return { token: await issueLoginCode(db, ids.learner!), reviewer: headers };
});
// Placement whose second (locked) episode is probed by a reviewed written explanation.
app.post("/test/placement-written-session", async () => {
  const workspace = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "placewritten-" + workspace, "Written placement browser workspace"]);
  const ids: Record<string, string> = {};
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "placewritten-browser:" + ids[role], role === "owner" ? "Placement reviewer" : "Placement learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, ids.owner!) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const release = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers, payload: placementWrittenCourse() })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers });
  if (published.statusCode !== 200) throw Error("Written placement fixture publication failed: " + published.body);
  await enablePlacement(app, { cookie: headers.cookie, csrf: headers["x-csrf-token"] }, origin, workspace);
  return { token: await issueLoginCode(db, ids.learner!), reviewer: headers };
});
// A workspace with an SDK 0.5 versioned gate (transfer, misconception and new item types).
app.post("/test/gates-session", async () => {
  const workspace = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "gates-" + workspace, "Gates browser workspace"]);
  const ids: Record<string, string> = {};
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "gates-browser:" + ids[role], role === "owner" ? "Owner" : "Gate learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, ids.owner!) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const release = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers, payload: gatedCourse() })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers });
  if (published.statusCode !== 200) throw Error("Gate fixture publication failed: " + published.body);
  return { token: await issueLoginCode(db, ids.learner!), reviewer: headers };
});
// A workspace whose first lesson has a declarative activity (judged by a synthetic registered
// evaluator) and a sandboxed web activity that probes its own sandbox.
app.post("/test/activity-session", async () => {
  const workspace = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "activity-" + workspace, "Activity browser workspace"]);
  const ids: Record<string, string> = {};
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "activity-browser:" + ids[role], role === "owner" ? "Owner" : "Activity learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, ids.owner!) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const course = activityCourse();
  course.extensions.push(sandboxedDeclaration());
  course.activities!.push(sandboxedActivity());
  course.chapters[0]!.episodes[0]!.blocks.splice(2, 0, { id: "min-probe", type: "activity", activityId: "sandbox-probe" });
  const release = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers, payload: course })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers });
  if (published.statusCode !== 200) throw Error("Activity fixture publication failed: " + published.body);
  return { token: await issueLoginCode(db, ids.learner!) };
});
// A workspace whose first lesson runs the network-hint probe toward a local port the spec listens on.
app.post("/test/hint-session", async (request) => {
  const { port } = request.body as { port: number };
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("A local listener port is required");
  const workspace = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "hints-" + workspace, "Hint browser workspace"]);
  const ids: Record<string, string> = {};
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "hints-browser:" + ids[role], role === "owner" ? "Owner" : "Hint learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, ids.owner!) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const release = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers, payload: hintProbeCourse(port) })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers });
  if (published.statusCode !== 200) throw Error("Hint fixture publication failed: " + published.body);
  return { token: await issueLoginCode(db, ids.learner!) };
});
// Moves a gates-session enrollment's course deadline into the past (the cap is reached) or back
// into the future (as an accepted extension would), so the browser suite can reach those decisions.
app.post("/test/gates-deadline", async (request) => {
  const { enrollmentId, reached } = request.body as { enrollmentId: string; reached: boolean };
  const row = (await db.query("SELECT p.snapshot FROM policy_states p JOIN enrollments e ON e.id=p.enrollment_id JOIN workspaces w ON w.id=e.workspace_id WHERE p.enrollment_id=$1 AND w.slug LIKE 'gates-%'", [enrollmentId])).rows[0];
  if (!row) throw Error("Not a gates-session enrollment");
  const at = new Date(Date.now() + (reached ? -1000 : 30 * 86_400_000)).toISOString();
  row.snapshot.scopes[0].hardDeadline = { at, timeZone: "UTC", disambiguation: "reject" };
  await db.query("UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1", [enrollmentId, JSON.stringify(row.snapshot)]);
  return { ok: true };
});
// A learner who demonstrated "minimum"; on this host's clock the first delayed check is due.
app.post("/test/retention-session", async () => {
  const workspace = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ret-" + workspace, "Retention browser workspace"]);
  await allowUnpricedPaidWork(db, workspace);
  const ids: Record<string, string> = {};
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "ret-browser:" + ids[role], role === "owner" ? "Owner" : "Retention learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = async (id: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { origin, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ids.owner!), learner = await login(ids.learner!);
  const release = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers: owner, payload: retentionCourse() })).json().id;
  await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers: owner });
  const enrollment = (await app.inject({ method: "POST", url: "/api/enrollments", headers: learner, payload: { releaseId: release } })).json().id;
  const send = async (action: string, body: Record<string, unknown>) => {
    const revision = (await app.inject({ url: `/api/enrollments/${enrollment}`, headers: learner })).json().revision;
    return (await app.inject({ method: "POST", url: `/api/enrollments/${enrollment}/${action}`, headers: learner, payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...body } })).json();
  };
  for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
    const issued = await send("challenges", { episodeId: "min", assessmentId, mode: "independent" });
    await send("answers", { challengeId: issued.challengeId, answer });
  }
  await app.inject({ url: `/api/enrollments/${enrollment}/retention`, headers: learner });
  return { token: await issueLoginCode(db, ids.learner!) };
});
// A learner, opted in to supervision, with one wrong practice answer that the
// trigger table linked to a declared misconception: one teaching hypothesis and
// a declared probe exist. Its own workspace keeps these learners' supervision
// events out of the shared workspace's outbox, which other fixtures claim in
// bounded batches.
const hypothesisReleaseId = randomUUID(), hypothesisWorkspaceId = randomUUID();
{
  const course = hypothesisCourse({ placement: false });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [hypothesisWorkspaceId, "browser-hypotheses", "Teaching hypotheses acceptance"]);
  await db.query(
    "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [hypothesisReleaseId, hypothesisWorkspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), ownerId],
  );
  await ensureCatalog(db, hypothesisReleaseId);
}
app.post("/test/hypothesis-session", async (request) => {
  // ?check=1 also finishes the reading and leaves one practice check (which
  // declares optional confidence) open to answer.
  const openCheck = (request.query as { check?: string }).check === "1";
  const userId = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [userId, "hypothesis-browser:" + userId, "Hypothesis learner"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [hypothesisWorkspaceId, userId]);
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const enrollment = (await app.inject({ method: "POST", url: "/api/enrollments", headers, payload: { releaseId: hypothesisReleaseId } })).json().id;
  const send = async (action: string, body: Record<string, unknown>) => {
    const revision = (await app.inject({ url: `/api/enrollments/${enrollment}`, headers })).json().revision;
    const r = await app.inject({ method: "POST", url: `/api/enrollments/${enrollment}/${action}`, headers, payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...body } });
    if (r.statusCode !== 200) throw Error("Hypothesis fixture failed: " + r.body);
    return r.json();
  };
  // Automatic ideas from answers need the learner's supervision opt-in.
  await send("supervision", { adaptiveTeaching: true });
  const issued = await send("challenges", { episodeId: "min", assessmentId: "min-practice", mode: "practice" });
  await send("answers", { challengeId: issued.challengeId, answer: "nine" });
  if (openCheck) {
    const min = hypothesisCourse({ placement: false }).server.chapters.flatMap((c) => c.episodes).find((e) => e.id === "min")!;
    for (const block of min.blocks) if (block.type !== "assessment") await send("read", { episodeId: "min", blockId: block.id });
    await send("challenges", { episodeId: "min", assessmentId: "min-practice", mode: "practice" });
  }
  return { token: await issueLoginCode(db, userId) };
});
// Closes a /test/session enrollment at its reached cap with read-only material and a
// closed-course question budget, as the deadline wakeup would.
app.post("/test/closed-course", async (request) => {
  const { enrollmentId, budget } = request.body as { enrollmentId: string; budget: number };
  const row = (await db.query("SELECT p.snapshot FROM policy_states p JOIN enrollments e ON e.id=p.enrollment_id WHERE p.enrollment_id=$1 AND e.workspace_id=$2", [enrollmentId, workspaceId])).rows[0];
  if (!row) throw Error("Not a /test/session enrollment");
  const state = row.snapshot;
  for (const scope of state.scopes) scope.existingMaterialAccess = "read_only";
  state.afterClosure = { questionBudget: budget };
  // The course cap was reached a day ago.
  const day = 86_400_000, scope = state.scopes[0];
  if (scope.window) {
    scope.window.anchorInstant = new Date(Date.now() - (1 + scope.window.calendarDays) * day).toISOString();
    scope.window.resolvedDeadline = new Date(Date.now() - day).toISOString();
  } else scope.hardDeadline = { at: new Date(Date.now() - day).toISOString(), timeZone: "UTC", disambiguation: "reject" };
  const now = new Date().toISOString(), command = { now, reason: "cap" as const, coveredObjectiveIds: [], demonstratedConceptIds: [] };
  const preview = previewClosure(state, command);
  const closed = closeEnrollment(state, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
    idempotencyKey: "cap:" + enrollmentId, authorityReceipt: { receiptId: randomUUID(), actorId: "system:reached-course-cap", enrollmentId, scopeId: "course",
      permission: "close_enrollment", termsDigest: preview.previewDigest, authorizedAt: now } });
  await db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollmentId, JSON.stringify(closed.state), closed.state.policyRevision, closed.state.ledgerRevision]);
  await db.query("UPDATE enrollments SET status='closed',policy_revision=$2,closed_at=now(),revision=revision+1 WHERE id=$1", [enrollmentId, closed.state.policyRevision]);
  return { ok: true };
});
// Delivers a /test/closed-course enrollment's latest companion question to the real
// supervisor bridge, as the worker would. The answer text is a scripted synthetic fixture
// (no provider). With `refuse`, material access closes for the delivery, so the bridge
// refuses the question (then access reopens), as a late access-policy change would.
app.post("/test/closed-course-answer", async (request) => {
  const { enrollmentId, refuse } = request.body as { enrollmentId: string; refuse?: boolean };
  const event = (await db.query("SELECT l.id FROM learning_events l JOIN enrollments e ON e.id=l.enrollment_id WHERE l.enrollment_id=$1 AND e.workspace_id=$2 AND e.status='closed' AND l.event_type='companion.requested' ORDER BY l.sequence DESC LIMIT 1", [enrollmentId, workspaceId])).rows[0];
  if (!event) throw Error("No closed-course question to deliver");
  const access = async (value: "read_only" | "closed") =>
    db.query("UPDATE policy_states SET snapshot=jsonb_set(snapshot,'{scopes}',(SELECT jsonb_agg(jsonb_set(s,'{existingMaterialAccess}',to_jsonb($2::text))) FROM jsonb_array_elements(snapshot->'scopes') s)) WHERE enrollment_id=$1", [enrollmentId, value]);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10000000, tokens: 100000000 });
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 1000000, tokens: 2000000 });
  const bridge = createPostgresSupervisorBridge(db, supervisorOptions);
  const outbox = await bridge.claimOutboxEvent(event.id, randomUUID(), 30000);
  if (!outbox) throw Error("Closed-course question event unavailable");
  if (refuse) await access("closed");
  let refs;
  try { refs = await bridge.prepareOutbox(outbox); } finally { if (refuse) await access("read_only"); }
  await bridge.ackOutbox(outbox);
  if (refuse) return { answered: false, jobs: refs.length };
  const ref = refs[0];
  if (!ref) throw Error("Closed-course question was not admitted");
  const claim = await bridge.transition({ type: "claim", ref, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } }),
    operation = claim.snapshot.operations[0]!;
  const artifact = await storeSupervisorArtifact(db, ref, operation.id, operation.ownerId, { kind: "companion_message", text: "Scripted answer: the minimum is the one value no other value is smaller than." });
  await bridge.transition({ type: "settle", ref, operationId: operation.id, ownerId: operation.ownerId, outcome: { status: "succeeded", artifact, usage: { microUsd: 10, tokens: 20 } } });
  const verifierId = randomUUID();
  await db.query("INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,'Browser fixture verifier',true,false)", [verifierId, workspaceId]);
  await recordSupervisorVerification(db, ref, verifierId, "verified");
  for (const type of ["verify", "apply"] as const) await bridge.transition({ type, ref });
  return { answered: (await bridge.load(ref)).state === "applied", jobs: 1 };
});
// Lets the main test workspace's courses be retaken in placement (staff settings).
app.post("/test/placement-retests", async (request) => {
  const { maxRuns, cooldownHours } = request.body as { maxRuns: number; cooldownHours?: number };
  await db.query("UPDATE placement_settings SET max_runs=$2,retest_cooldown_hours=$3 WHERE workspace_id=$1", [workspaceId, maxRuns, cooldownHours ?? 0]);
  return { ok: true };
});
// Companion context: its own workspace (no supervisor watches it), the public ordering course without
// placement. The session asks two questions, the second about a selection in the lesson, and records a
// synthetic answer to it through the real provider-context capsule (no provider is called).
const contextReleaseId = randomUUID(), contextWorkspaceId = randomUUID();
{
  const source = fixture();
  source.placement = { ...source.placement!, enabled: false };
  const course = compileCourse(source);
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [contextWorkspaceId, "browser-companion-context", "Companion context acceptance"]);
  await db.query(
    "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [contextReleaseId, contextWorkspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), ownerId],
  );
  await ensureCatalog(db, contextReleaseId);
}
app.post("/test/companion-context-session", async () => {
  const userId = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [userId, "companion-context:" + userId, "Context learner"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [contextWorkspaceId, userId]);
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const enrollment = (await app.inject({ method: "POST", url: "/api/enrollments", headers, payload: { releaseId: contextReleaseId } })).json().id;
  const digest = (await db.query("SELECT digest FROM course_releases WHERE id=$1", [contextReleaseId])).rows[0].digest;
  const ask = async (content: string, extra: Record<string, unknown> = {}) => {
    const revision = (await app.inject({ url: `/api/enrollments/${enrollment}`, headers })).json().revision;
    const r = await app.inject({ method: "POST", url: `/api/enrollments/${enrollment}/companion`, headers, payload: { expectedRevision: revision, idempotencyKey: randomUUID(), episodeId: "min", content, ...extra } });
    if (r.statusCode !== 200) throw Error("Companion context fixture failed: " + r.body);
    return r.json() as { messageId: string; eventId: string };
  };
  await ask("What does minimum mean here?");
  const question = await ask("Why does it say no greater than?", { selection: { kind: "text", courseDigest: digest, excerpt: "no greater than" } });
  const jobId = randomUUID();
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES ($1,$2,$3,$4,'companion','running',1,'{}')`,
    [jobId, enrollment, contextWorkspaceId, `browser-context-${jobId}`]);
  await db.query("UPDATE companion_messages SET job_id=$2 WHERE id=$1", [question.messageId, jobId]);
  await teachingContext(db, { jobId, workspaceId: contextWorkspaceId, enrollmentId: enrollment, generation: 1 },
    { kind: "learning_event", eventId: question.eventId, eventType: "companion.requested", courseReleaseId: contextReleaseId, episodeId: "min", messageId: question.messageId });
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,'{}',$4)",
    [randomUUID(), enrollment, "Because the minimum may be equal to another member, not only smaller.", jobId]);
  await db.query("UPDATE supervisor_jobs SET state='applied' WHERE id=$1", [jobId]);
  // Older rows: an answer saved before answers carried their lesson, to a question asked in the next
  // lesson, and one with no question at all.
  const olderJob = randomUUID();
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES ($1,$2,$3,$4,'companion','applied',1,'{}')`,
    [olderJob, enrollment, contextWorkspaceId, `browser-context-${olderJob}`]);
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'learner',$3,$4,$5)",
    [randomUUID(), enrollment, "Is the maximum the mirror of this?", JSON.stringify({ episodeId: "max", courseDigest: digest }), olderJob]);
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,'{}',$4)",
    [randomUUID(), enrollment, "Yes: the maximum is no less than any other member.", olderJob]);
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,'assistant',$3,'{}')",
    [randomUUID(), enrollment, "A note saved before replies recorded their lesson."]);
  return { token: await issueLoginCode(db, userId) };
});
// Test-only: a question whose reply Core refused (the job ended failed/verification_rejected and only the
// refusal reason was kept), asked through the real API.
app.post("/test/companion-refused-session", async () => {
  const userId = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [userId, "companion-refused:" + userId, "Refused learner"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [contextWorkspaceId, userId]);
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const enrollment = (await app.inject({ method: "POST", url: "/api/enrollments", headers, payload: { releaseId: contextReleaseId } })).json().id;
  const revision = (await app.inject({ url: `/api/enrollments/${enrollment}`, headers })).json().revision;
  const asked = await app.inject({ method: "POST", url: `/api/enrollments/${enrollment}/companion`, headers,
    payload: { expectedRevision: revision, idempotencyKey: randomUUID(), episodeId: "min", content: "Can you list every minimum rule at once?" } });
  if (asked.statusCode !== 200) throw Error("Companion refused fixture failed: " + asked.body);
  const jobId = randomUUID();
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,result)
    VALUES ($1,$2,$3,$4,'companion','failed',1,'{}',$5)`, [jobId, enrollment, contextWorkspaceId, `browser-refused-${jobId}`, JSON.stringify({ reason: "verification_rejected", applicationReceiptId: null })]);
  await db.query("UPDATE companion_messages SET job_id=$2 WHERE id=$1", [asked.json().messageId, jobId]);
  return { token: await issueLoginCode(db, userId) };
});
// Two linked courses (a staff concept mapping) in their own workspace, and a learner who demonstrated
// "minimum" in the first. The browser starts the second, opts in and sees the suggestions that one
// learner-coordinator pass (/test/cross-course-plan, the host call the Temporal workflow makes) stores.
app.post("/test/cross-course-session", async () => {
  const workspace = randomUUID(), origin = hostOrigin, ids: Record<string, string> = {};
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "cross-" + workspace, "Cross-course browser workspace"]);
  for (const role of ["owner", "learner"]) {
    ids[role] = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "cross-browser:" + ids[role], role === "owner" ? "Owner" : "Cross-course learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
  }
  const login = async (id: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { origin, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ids.owner!), learner = await login(ids.learner!);
  const post = async (url: string, headers: Record<string, string>, payload: unknown = {}) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw Error(`Cross-course fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const practice = fixture();
  practice.id = "ordering-practice";
  practice.title = "Ordering practice";
  const releases: string[] = [];
  for (const course of [fixture(), practice]) {
    const id = (await post(`/api/workspaces/${workspace}/releases`, owner, course)).id as string;
    await post(`/api/releases/${id}/publish`, owner);
    releases.push(id);
  }
  await post("/api/admin/concept-mappings", owner, { releaseIds: releases, expectedRevision: 0, idempotencyKey: "browser-map-" + workspace, links: [
    { relation: "equivalent", from: { releaseId: releases[0], objectiveId: "minimum" }, to: { releaseId: releases[1], objectiveId: "minimum" } },
    { relation: "prerequisite_of", from: { releaseId: releases[0], objectiveId: "maximum" }, to: { releaseId: releases[1], objectiveId: "minimum" } }] });
  const enrollment = (await post("/api/enrollments", learner, { releaseId: releases[0] })).id as string;
  const send = async (action: string, body: Record<string, unknown>) => {
    const revision = (await app.inject({ url: `/api/enrollments/${enrollment}`, headers: learner })).json().revision;
    return post(`/api/enrollments/${enrollment}/${action}`, learner, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
  };
  for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
    const issued = await send("challenges", { episodeId: "min", assessmentId, mode: "independent" });
    await send("answers", { challengeId: issued.challengeId, answer });
  }
  return { token: await issueLoginCode(db, ids.learner!), learnerId: ids.learner, workspaceId: workspace };
});
app.post("/test/cross-course-plan", async (request) => {
  const body = request.body as { learnerId: string; workspaceId: string };
  return createPostgresSupervisorBridge(db, { workspaceIds: [body.workspaceId] }).planCrossCourse(body.learnerId, 0);
});
// A course with a recruiting research study whose arms are both the fixed path, so the joining
// learner's version is known: the companion is off for them until they leave the study.
app.post("/test/study-session", async () => {
  const studyWorkspace = randomUUID(), ownerId = randomUUID(), userId = randomUUID(), origin = hostOrigin;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [studyWorkspace, `study-${studyWorkspace}`, "Study workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Study owner"], [userId, "learner", "Study learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `study:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [studyWorkspace, id, role]);
  }
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, ownerId) } });
  const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw Error(`Study fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (await post(`/api/workspaces/${studyWorkspace}/releases`, { ...fixture(), title: "Study ordering" })).id;
  await post(`/api/releases/${releaseId}/publish`, {});
  const courseId = (await app.inject({ url: "/api/admin/session", headers })).json().courses[0].id;
  const created = await post(`/api/admin/courses/${courseId}/studies`, { releaseId, title: "Ordering study",
    purpose: "We compare versions of this course to learn which helps people learn ordering best.",
    arms: [{ id: "fixed_a", label: "Fixed path A", behaviour: "fixed" }, { id: "fixed_b", label: "Fixed path B", behaviour: "fixed" }],
    instruments: { pre: ["min-a"], post: ["min-b"], transfer: [], delayed: [] }, minCellSize: 3 });
  await post(`/api/admin/studies/${created.study.id}/open`, { expectedRevision: created.study.revision });
  return { token: await issueLoginCode(db, userId) };
});
app.post("/test/session", async () => {
  const userId = randomUUID();
  await db.query(
    "INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)",
    [userId, `test:${userId}`, "Browser learner"],
  );
  await db.query(
    "INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')",
    [workspaceId, userId],
  );
  return { token: await issueLoginCode(db, userId) };
});
// A member with a username and password (optionally a temporary one that must be
// replaced at first sign-in). Returns the credentials for the browser to type.
app.post("/test/password-session", async (request) => {
  const body = (request.body ?? {}) as { role?: string; mustChange?: boolean };
  const role = body.role === "owner" ? "owner" : "learner";
  const userId = randomUUID(), login = `browser-${userId.slice(0, 8)}`;
  const password = `synthetic passphrase ${randomUUID().slice(0, 8)}`;
  await db.query("INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)", [userId, `test:${userId}`, role === "owner" ? "Browser owner" : "Browser learner"]);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)", [workspaceId, userId, role]);
  await storePassword(db, userId, await hashPassword(password), { mustChange: body.mustChange === true, loginName: login });
  return { login, password };
});
app.post("/test/model-session", async (request) => {
  const repair =
    (request.body as { repair?: boolean } | undefined)?.repair === true;
  const generated =
    (request.body as { generated?: boolean } | undefined)?.generated === true;
  const optional =
    (request.body as { optional?: boolean } | undefined)?.optional === true;
  // A generated simulation; with midAttempt the learner has a practice question open meanwhile.
  const generatedContent = (request.body as { content?: boolean } | undefined)?.content === true;
  const midAttempt = (request.body as { midAttempt?: boolean } | undefined)?.midAttempt === true;
  const writesComponent = (request.body as { component?: boolean } | undefined)?.component === true;
  const userId = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [userId, "model-browser:" + userId, "Model review learner"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')",
    [workspaceId, userId],
  );
  const login = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin: hostOrigin },
    payload: { token: await issueLoginCode(db, userId) },
  });
  if (login.statusCode !== 200) throw Error("Model fixture login failed");
  const headers = {
    origin: hostOrigin,
    cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    "x-csrf-token": login.json().csrfToken,
  };
  const enrolled = await app.inject({
    method: "POST",
    url: "/api/enrollments",
    headers,
    payload: { releaseId: generatedContent ? contentReleaseId : optional ? optionalReleaseId : generated ? generatedReleaseId : releaseId },
  });
  if (enrolled.statusCode !== 200)
    throw Error("Model fixture enrollment failed");
  const id = enrolled.json().id;
  const current = await app.inject({ url: `/api/enrollments/${id}`, headers });
  const permission = await app.inject({
    method: "POST",
    url: `/api/enrollments/${id}/supervision`,
    headers,
    payload: {
      expectedRevision: current.json().revision,
      idempotencyKey: randomUUID(),
      adaptiveTeaching: true,
    },
  });
  if (permission.statusCode !== 200)
    throw Error("Model fixture consent failed");
  if (midAttempt) {
    const revision = (await app.inject({ url: `/api/enrollments/${id}`, headers })).json().revision;
    const opened = await app.inject({ method: "POST", url: `/api/enrollments/${id}/challenges`, headers,
      payload: { expectedRevision: revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-a", mode: "practice" } });
    if (opened.statusCode !== 200) throw Error("Model fixture challenge failed");
  }
  await transaction(db, (client) =>
    appendEvent(client, {
      workspaceId,
      enrollmentId: id,
      actorId: userId,
      actorKind: "learner",
      type: "block.read",
      payload: { episodeId: "min", blockId: "public-example" },
      idempotencyKey: randomUUID(),
      supervise: false,
    }),
  );
  await configureSupervisorBudget(
    db,
    { workspaceId },
    { microUsd: 10000000, tokens: 100000000 },
  );
  await configureSupervisorBudget(
    db,
    { workspaceId, enrollmentId: id },
    { microUsd: 1000000, tokens: 2000000 },
  );
  const bridge = createPostgresSupervisorBridge(db, supervisorOptions),
    event = (
      await db.query(
        "SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'",
        [id],
      )
    ).rows[0];
  // Claim exactly this fixture's event: a bounded batch claim would lease (and
  // count attempts on) other fixtures' events, and miss this one behind them.
  const outbox = await bridge.claimOutboxEvent(event.id, randomUUID(), 30000);
  if (!outbox) throw Error("Model fixture event unavailable");
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({
      type: "claim",
      ref: ref!,
      checkpointId: "generate",
      ownerId: randomUUID(),
      availability: { status: "ready" },
    }),
    operation = claim.snapshot.operations[0]!;
  if (repair)
    repairOperations.add(
      createHash("sha256").update(operation.id).digest("hex"),
    );
  if (writesComponent) componentOperations.add(createHash("sha256").update(operation.id).digest("hex"));
  const output = await app.inject({
    method: "POST",
    url: "/v1/operations",
    headers: {
      authorization: "Bearer " + supervisorToken,
      "idempotency-key": operation.id,
    },
    payload: {
      schemaVersion: 1,
      operationId: operation.id,
      job: claim.snapshot.specification.key,
      role: "supervisor",
      checkpoint: claim.snapshot.specification.checkpoints[0],
      fence: claim.snapshot.specification.fence,
    },
  });
  if (output.json().status !== "succeeded")
    throw Error("Model fixture generation failed");
  await bridge.transition({
    type: "settle",
    ref: ref!,
    operationId: operation.id,
    ownerId: operation.ownerId,
    outcome: output.json(),
  });
  for (const type of ["verify", "apply"]) {
    const result = await app.inject({
      method: "POST",
      url: "/v1/supervisor/bridge",
      headers: { authorization: "Bearer " + supervisorToken },
      payload: { method: "transition", command: { type, ref } },
    });
    if (
      result.statusCode !== 200 ||
      result.json().snapshot.state !== (type === "verify" ? "ready" : "applied")
    )
      throw Error("Model fixture delivery failed");
  }
  return { token: await issueLoginCode(db, userId) };
});
// WebAuthn refuses IP-address relying parties, so passkey journeys run against a
// second loopback server whose public origin is http://localhost:<passkeyPort>. It
// shares this database (accounts created on the main host sign in there) and serves
// the same exports.
const passkeyOrigin = `http://localhost:${passkeyPort}`;
const passkeyApp = await createServer(db, {
  origin: passkeyOrigin,
  secureCookies: false,
  learnerDirectory: fileURLToPath(new URL("../../../apps/learner/dist", import.meta.url)),
  ...(existsSync(fileURLToPath(new URL("../../../apps/admin/dist/index.html", import.meta.url)))
    ? { adminDirectory: fileURLToPath(new URL("../../../apps/admin/dist", import.meta.url)) }
    : {}),
});
await passkeyApp.listen({ host: "127.0.0.1", port: passkeyPort });
app.addHook("onClose", async () => {
  await passkeyApp.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(storage, { recursive: true, force: true });
});
await app.listen({ host: "127.0.0.1", port });
process.on("SIGINT", () => {
  void app.close();
});
process.on("SIGTERM", () => {
  void app.close();
});
