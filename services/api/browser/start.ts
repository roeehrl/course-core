import { randomUUID, createHash } from "node:crypto";
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
} from "../src/supervisor-bridge.js";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { ensureCatalog } from "../src/admin-routes.js";
import { fixture } from "../test/fixture.js";
import { syntheticResearchInspector } from "../test/research-fixture.js";
import { rubricCourse } from "../test/rubric-fixture.js";
import { retentionCourse } from "../test/retention-fixture.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { toVisualExperience } from "@course-core/visuals/headless";
import { sortingDemo } from "@course-core/visuals/demos";
import { svgRenderer } from "../src/svg-renderer.js";
import { supervisorGeneratedTeachingFixture } from "../test/generated-teaching-fixture.js";
import { recoveryFixture } from "../test/recovery-fixture.js";
import {
  approveAdaptationRegistry,
  createAdaptationRuntime,
} from "../src/adaptation-store.js";
import { codeEvaluator } from "../src/code-evaluator.js";
import {
  comparisonFixtures,
  codeRecoveryFixture,
} from "../test/code-recovery-fixture.js";

// Test-only loopback host. Not included in the API build or production routes.
if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  throw new Error(
    "Use only TEST_DATABASE_URL for real browser/database acceptance.",
  );
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
const workspaceId = randomUUID(),
  ownerId = randomUUID(),
  releaseId = randomUUID(),
  supervisorToken = randomUUID();
const generatedFixture = supervisorGeneratedTeachingFixture();
generatedFixture.course.id = "generated-ordering";
generatedFixture.course.title = "Verified teaching examples";
const generatedReleaseId = randomUUID(),
  generatedCourse = compileCourse(generatedFixture.course);
const generatedMarkdown = "Minimum of [31, -14, 9] is -14.";
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
          : prompt.context.course.digest === generatedCourse.digest
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
  codeRecovery = codeRecoveryFixture(grader);
const app = await createServer(db, {
  origin: "http://127.0.0.1:4317",
  secureCookies: false,
  learnerDirectory: fileURLToPath(
    new URL("../../../apps/learner/dist", import.meta.url),
  ),
  installedExtensions: [renderer, grader, reviewedRubricEvaluator()],
  adaptation: createAdaptationRuntime([
    ...recovery.runtime.adapters,
    ...codeRecovery.runtime.adapters,
    ...generatedFixture.runtime.adapters.filter(
      (a) => a.kind === "generated-teaching",
    ),
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
const codeWorkspaceId = randomUUID(),
  codeReleaseId = randomUUID(),
  codeCourse = compileCourse(codeRecovery.course);
await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
  codeWorkspaceId,
  "browser-code",
  "Code recovery acceptance",
]);
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
// Raw fixture inserts must establish the same catalogue records as real import.
for (const id of [releaseId, generatedReleaseId, codeReleaseId]) await ensureCatalog(db, id);
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
    origin = "http://127.0.0.1:4317";
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspace,
    "research-" + workspace,
    "Research browser workspace",
  ]);
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
app.post("/test/rubric-session", async () => {
  const workspace = randomUUID(), origin = "http://127.0.0.1:4317";
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "rubric-" + workspace, "Rubric browser workspace"]);
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
  return { token: await issueLoginCode(db, ids.learner!), reviewer: headers };
});
// A learner who demonstrated "minimum" a day ago (schedule aged in the test DB).
app.post("/test/retention-session", async () => {
  const workspace = randomUUID(), origin = "http://127.0.0.1:4317";
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ret-" + workspace, "Retention browser workspace"]);
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
  await db.query("UPDATE retention_schedules SET demonstrated_at=demonstrated_at-interval '1 day',due_at=due_at-interval '1 day' WHERE enrollment_id=$1", [enrollment]);
  return { token: await issueLoginCode(db, ids.learner!) };
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
app.post("/test/model-session", async (request) => {
  const repair =
    (request.body as { repair?: boolean } | undefined)?.repair === true;
  const generated =
    (request.body as { generated?: boolean } | undefined)?.generated === true;
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
    headers: { origin: "http://127.0.0.1:4317" },
    payload: { token: await issueLoginCode(db, userId) },
  });
  if (login.statusCode !== 200) throw Error("Model fixture login failed");
  const headers = {
    origin: "http://127.0.0.1:4317",
    cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    "x-csrf-token": login.json().csrfToken,
  };
  const enrolled = await app.inject({
    method: "POST",
    url: "/api/enrollments",
    headers,
    payload: { releaseId: generated ? generatedReleaseId : releaseId },
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
  const outbox = (await bridge.claimOutbox(randomUUID(), 100, 30000)).find(
    (e) => e.eventId === event.id,
  );
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
app.addHook("onClose", async () => {
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(storage, { recursive: true, force: true });
});
await app.listen({ host: "127.0.0.1", port: 4317 });
process.on("SIGINT", () => {
  void app.close();
});
process.on("SIGTERM", () => {
  void app.close();
});
