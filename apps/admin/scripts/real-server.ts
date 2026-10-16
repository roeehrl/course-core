import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../../services/api/src/database.ts";
import { migrate } from "../../../services/api/src/migrations.ts";
import { createServer } from "../../../services/api/src/server.ts";
import { authService, issueLoginCode } from "../../../services/api/src/auth.ts";
import {
  registerAdminRoutes,
  ensureCatalog,
} from "../../../services/api/src/admin-routes.ts";
import { unconfiguredProviders } from "../../../services/api/src/provider-composition.ts";
import { fixture } from "../../../services/api/test/fixture.ts";
import { syntheticResearchInspector, syntheticYouTubeFetch } from "../../../services/api/test/research-fixture.ts";
import { workspaceYouTubeSearch } from "../../../services/api/src/research-media.ts";
import { rubricCourse, rubricExplanation } from "../../../services/api/test/rubric-fixture.ts";
import { gatedCourse, repairEvaluatorStub } from "../../../services/api/test/gated-fixture.ts";
import { recordSyntheticRun } from "../../../services/api/test/run-fixture.ts";
import { reviewedRubricEvaluator } from "../../../services/api/src/rubric-evaluator.ts";
import { svgRenderer } from "../../../services/api/src/svg-renderer.ts";
import { adminRealPort } from "../../../services/api/browser/ports.ts";
import { toVisualExperience } from "@course-core/visuals/headless";
import { sortingDemo } from "@course-core/visuals/demos";
import { createMediaJobService, workspaceMediaResolver } from "../../../services/api/src/media-jobs.ts";
import { MEDIA_CREDENTIAL, SYNTHETIC_CAPTIONS, ScriptedVideo, mediaConfiguration, mediaJobPolicy } from "../../../services/api/test/media-fixture.ts";
import {
  subscriptionAdapter,
  type ProviderAdapter,
} from "../../../packages/providers/src/index.ts";

const connection = process.env.TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    "TEST_DATABASE_URL is required for real admin browser tests.",
  );
const url = new URL(connection);
if (
  process.env.DATABASE_URL ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !/^\/(course_core_ci|course_core_test(?:_[a-z0-9_]+)?)$/.test(url.pathname) ||
  url.search ||
  url.hash
)
  throw new Error(
    "Use a disposable loopback TEST_DATABASE_URL without overrides or DATABASE_URL.",
  );
const schema = `admin_browser_${randomUUID().replaceAll("-", "")}`,
  root = createDatabase(connection);
await root.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-csearch_path=${schema}`);
const db = createDatabase(url.toString()),
  // The Playwright config passes its chosen port (4384 in CI, free locally).
  port = adminRealPort(),
  origin = `http://127.0.0.1:${port}`,
  providers = unconfiguredProviders();
await migrate(
  db,
  fileURLToPath(new URL("../../../services/api/migrations", import.meta.url)),
);
const directory = fileURLToPath(new URL("../dist", import.meta.url));
const { googleMetadataAdapter } =
  await import("../../../services/api/src/provider-metadata.ts");
const metadata = googleMetadataAdapter(async (input, init) => {
  if (
    new URL(String(input)).origin !==
      "https://generativelanguage.googleapis.com" ||
    init?.method !== "GET"
  )
    throw Error("Synthetic metadata permits only Google metadata GET");
  return new Response(
    JSON.stringify({
      models: [
        {
          name: "models/public-text-model",
          displayName: "Public test model",
          inputTokenLimit: 131072,
          outputTokenLimit: 4000,
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
});
// Test-only scripted Models API page (shape per GET /v1/models). Synthetic values; no
// live Anthropic call and no generation endpoint is reachable from this fetch.
const { anthropicMetadataAdapter } =
  await import("../../../services/api/src/provider-metadata.ts");
const yes = { supported: true },
  no = { supported: false };
const anthropicMetadata = anthropicMetadataAdapter(async (input, init) => {
  const url = new URL(String(input));
  if (
    url.origin + url.pathname !== "https://api.anthropic.com/v1/models" ||
    init?.method !== "GET"
  )
    throw Error("Synthetic metadata permits only Anthropic Models API GET");
  const model = (id: string, name: string, disabled: boolean) => ({
    type: "model",
    id,
    display_name: name,
    created_at: "2026-09-01T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      structured_outputs: yes,
      effort: { supported: true, low: yes, medium: yes, high: yes },
      thinking: {
        supported: true,
        types: { adaptive: yes, disabled: disabled ? yes : no },
      },
      server_tools: { supported: true, web_search: yes },
      image_input: yes,
    },
  });
  return new Response(
    JSON.stringify({
      data: [
        model("claude-haiku-5-5", "Claude Haiku 5.5", true),
        model("claude-sonnet-5-5", "Claude Sonnet 5.5", false),
      ],
      has_more: false,
      first_id: "claude-haiku-5-5",
      last_id: "claude-sonnet-5-5",
    }),
    { headers: { "content-type": "application/json" } },
  );
});
const { WorkspaceProviders } =
  await import("../../../services/api/src/provider-setup.ts");
const { credentialVault } =
  await import("../../../services/api/src/key-vault.ts");
// Test-only scripted video adapter: no network, no credential, records submissions.
const scriptedVideo = new ScriptedVideo();
const workspaceProviders = new WorkspaceProviders(
    db,
    credentialVault(randomBytes(32)),
    {
      "scripted-video": scriptedVideo.factory(),
      "subscription-fixture": (options) => {
        const native: ProviderAdapter = {
          providerId: options.providerId,
          validateModel() {},
          ports: {},
        };
        const fail = async () => {
          throw Error("Synthetic setup fixture cannot invoke a model");
        };
        return subscriptionAdapter({
          adapter: native,
          subscriptionRef: options.subscription!.reference,
          applicationAccess: {
            supported: true,
            documentationUrl:
              "https://provider.example.invalid/subscription-application-access",
            reviewedAt: "2026-01-01T00:00:00Z",
          },
          isConfigured: () => false,
          getStatus: fail,
          authorize: fail,
          ...(options.subscription?.automaticFallback.enabled
            ? {
                automaticFallback: {
                  enabled: true,
                  adapter: native,
                  authorize: fail,
                },
              }
            : {}),
        });
      },
    },
    undefined,
    { google: metadata, anthropic: anthropicMetadata },
  );
const mediaOptions = { pollIntervalMs: 1000 };
const renderer = await svgRenderer();
const app = await createServer(db, { loginCodes: true,
  workspaceProviders,
  media: { options: mediaOptions },
  origin,
  secureCookies: false,
  // Test-only: no network inspection from browser tests.
  researchInspector: syntheticResearchInspector(),
  // Test-only: the admin-entered workspace key is used, but YouTube is a synthetic stub (no network).
  youtubeSearch: workspaceYouTubeSearch((workspaceId, name) => workspaceProviders.credential(workspaceId, name), syntheticYouTubeFetch()),
  // The repair evaluator is the labelled data-only stub from the gated fixture (no code runs).
  installedExtensions: [reviewedRubricEvaluator(), repairEvaluatorStub(), renderer],
  adminDirectory: directory,
  providers,
});
if (!app.hasRoute({ method: "GET", url: "/api/admin/session" }))
  throw new Error("Production admin routes are not registered.");
if (!app.hasRoute({ method: "GET", url: "/admin/demo" }))
  app.get("/admin/demo", (_request, reply) =>
    reply.sendFile("index.html", directory),
  );
// Test-only fixture endpoint on loopback, never imported by production code.
app.post("/test/admin-fixture", async () => {
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID(),
    observerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `browser-${workspaceId}`,
    "Browser workspace",
  ]);
  for (const [id, role] of [
    [adminId, "admin"],
    [learnerId, "learner"],
    // Read-only staff: sees the runtime capability slots, cannot configure them.
    [observerId, "observer"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [
        id,
        `browser:${id}`,
        role === "admin" ? "Browser administrator" : role === "observer" ? "Course observer" : "Public learner",
      ],
    );
    await db.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspaceId, id, role],
    );
  }
  async function login(userId: string) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/redeem",
      headers: { origin },
      payload: { token: await issueLoginCode(db, userId) },
    });
    if (response.statusCode !== 200) throw new Error("Fixture sign-in failed");
    return {
      cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin,
      "x-csrf-token": response.json().csrfToken,
    };
  }
  const adminHeaders = await login(adminId);
  const imported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/releases`,
    headers: adminHeaders,
    payload: {
      ...fixture(),
      research: {
        publicTopics: [
          {
            id: "minimum-research",
            objectiveIds: ["minimum"],
            queryText: "Public explanation of finding the minimum of a list",
            allowedDomains: ["docs.python.org"],
          },
        ],
      },
    },
  });
  if (imported.statusCode !== 200) throw new Error("Fixture import failed");
  const releaseId = imported.json().id as string;
  const published = await app.inject({
    method: "POST",
    url: `/api/releases/${releaseId}/publish`,
    headers: adminHeaders,
  });
  if (published.statusCode !== 200)
    throw new Error("Fixture publication failed");
  const catalogId = await ensureCatalog(db, releaseId);
  const current = await app.inject({
    url: `/api/admin/courses/${catalogId}`,
    headers: adminHeaders,
  });
  const enrollment = await app.inject({
    method: "POST",
    url: `/api/admin/courses/${catalogId}/enrollments`,
    headers: {
      ...adminHeaders,
      "if-match": current.json().revision,
      "idempotency-key": randomUUID(),
    },
    payload: {
      learnerRef: learnerId,
      releaseId,
      profile: {
        displayName: "Public learner",
        goal: "Understand comparisons.",
        pace: "steady",
      },
    },
  });
  if (enrollment.statusCode !== 200)
    throw new Error(`Fixture enrollment failed: ${enrollment.json().error}`);
  const enrollmentId = enrollment.json().workspace.enrollments[0].id as string;
  const learnerHeaders = await login(learnerId);
  const challenge = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollmentId}/challenges`,
    headers: learnerHeaders,
    payload: {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      episodeId: "min",
      assessmentId: "min-a",
      mode: "independent",
    },
  });
  if (challenge.statusCode !== 200) throw new Error("Fixture challenge failed");
  const answer = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollmentId}/answers`,
    headers: learnerHeaders,
    payload: {
      expectedRevision: challenge.json().revision,
      idempotencyKey: randomUUID(),
      challengeId: challenge.json().challengeId,
      answer: "five",
    },
  });
  if (answer.statusCode !== 200) throw new Error("Fixture answer failed");
  return {
    code: await issueLoginCode(db, adminId),
    catalogId,
    enrollmentId,
    learnerId,
    learnerCode: await issueLoginCode(db, learnerId),
    observerCode: await issueLoginCode(db, observerId),
    observerId,
  };
});
// Test-only: a workspace with one pending written answer awaiting review.
app.post("/test/rubric-fixture", async () => {
  const workspaceId = randomUUID(), adminId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `rubric-${workspaceId}`, "Rubric workspace"]);
  for (const [id, role, name] of [[adminId, "admin", "Rubric reviewer"], [learnerId, "learner", "Written learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `rubric:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const admin = await login(adminId), learner = await login(learnerId);
  const releaseId = (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/releases`, headers: admin, payload: rubricCourse() })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${releaseId}/publish`, headers: admin });
  if (published.statusCode !== 200) throw new Error("Rubric fixture publication failed");
  const enrollmentId = (await app.inject({ method: "POST", url: "/api/enrollments", headers: learner, payload: { releaseId } })).json().id;
  const revision = async () => (await app.inject({ url: `/api/enrollments/${enrollmentId}`, headers: learner })).json().revision;
  const challenge = await app.inject({ method: "POST", url: `/api/enrollments/${enrollmentId}/challenges`, headers: learner,
    payload: { expectedRevision: await revision(), idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-explain", mode: "independent" } });
  const answered = await app.inject({ method: "POST", url: `/api/enrollments/${enrollmentId}/answers`, headers: learner,
    payload: { expectedRevision: await revision(), idempotencyKey: randomUUID(), challengeId: challenge.json().challengeId, answer: rubricExplanation } });
  if (answered.statusCode !== 200) throw new Error("Rubric fixture answer failed");
  return { code: await issueLoginCode(db, adminId) };
});
// Test-only: a gated course where two learners asked for a review of their gate decision,
// an instructor (may grant exceptions) and a reviewer (may only uphold). Made through the real HTTP API.
app.post("/test/gate-review-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), instructorId = randomUUID(), reviewerId = randomUUID();
  const learners = [randomUUID(), randomUUID()];
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `gate-review-${workspaceId}`, "Gate review workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Course owner"], [instructorId, "instructor", "Gate instructor"], [reviewerId, "reviewer", "Gate reviewer"],
    [learners[0]!, "learner", "Avery Learner"], [learners[1]!, "learner", "Blake Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `gate-review:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId);
  const call = async (url: string, payload: unknown, headers: Record<string, string>, method: "POST" | "GET" = "POST") => {
    const r = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: payload as object } : {}) });
    if (r.statusCode !== 200) throw new Error(`Gate review fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (await call(`/api/workspaces/${workspaceId}/releases`, gatedCourse(`7.0.${Date.now() % 100000}`), owner)).id;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  for (const learnerId of learners) {
    const learner = await login(learnerId);
    const enrollmentId = (await call("/api/enrollments", { releaseId }, learner)).id as string;
    const send = async (action: string, body: Record<string, unknown>) =>
      call(`/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: (await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")).revision,
        idempotencyKey: randomUUID(), ...body }, learner);
    await send("read", { episodeId: "min", blockId: "min-text" });
    const challenge = await send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
    await send("answers", { challengeId: challenge.challengeId, answer: 4 });
    const decision = (await call(`/api/enrollments/${enrollmentId}/gates/min-gate/decision`, null, learner, "GET")).decision;
    await send("gates/min-gate/review-requests", { decisionId: decision.decisionId, reason: "I worked through the lesson but ran out of time for the transfer task." });
  }
  return { instructorCode: await issueLoginCode(db, instructorId), reviewerCode: await issueLoginCode(db, reviewerId) };
});
// Test-only: an owner, version 1.0.0 with a learner who answered min-a, and a live version 1.1.0
// that changes min-b. Made through the real HTTP API.
app.post("/test/release-safety-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `release-${workspaceId}`, "Release workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Release owner"], [learnerId, "learner", "Avery Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `release:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId), learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers: Record<string, string>, method: "POST" | "GET" = "POST") => {
    const r = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: payload as object } : {}) });
    if (r.statusCode !== 200) throw new Error(`Release safety fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const publish = async (manifest: ReturnType<typeof fixture>) => {
    const id = (await call(`/api/workspaces/${workspaceId}/releases`, manifest, owner)).id as string;
    await call(`/api/releases/${id}/publish`, {}, owner);
    return id;
  };
  const first = fixture();
  first.version = "1.0.0";
  const v1 = await publish(first);
  const enrollmentId = (await call("/api/enrollments", { releaseId: v1 }, learner)).id as string;
  const send = async (action: string, body: Record<string, unknown>) =>
    call(`/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: (await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")).revision, idempotencyKey: randomUUID(), ...body }, learner);
  await send("read", { episodeId: "min", blockId: "min-text" });
  const challenge = await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
  await send("answers", { challengeId: challenge.challengeId, answer: "two" });
  const second = fixture();
  second.version = "1.1.0";
  second.assessments.find((a) => a.id === "min-b")!.prompt = "Minimum of 6 and 3?";
  await publish(second);
  return { code: await issueLoginCode(db, ownerId) };
});
// Test-only: an owner, a support observer, a course-scoped member without grants yet, and a
// learner who started the course, all made through the real HTTP API.
app.post("/test/people-scope-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), supportId = randomUUID(), scopedId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `scope-${workspaceId}`, "Scoped workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Scope owner"], [supportId, "support_observer", "Support observer"],
    [scopedId, "course_scoped", "Visiting tutor"], [learnerId, "learner", "Avery Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `scope:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId), learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers: Record<string, string>) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw new Error(`People scope fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)).id;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  await call("/api/enrollments", { releaseId }, learner);
  return { ownerCode: await issueLoginCode(db, ownerId), supportCode: await issueLoginCode(db, supportId), scopedCode: await issueLoginCode(db, scopedId) };
});
// Test-only: placement enabled by the owner through the settings route, and a learner who placed
// out of the first episode through a real placement run.
app.post("/test/placement-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `placement-${workspaceId}`, "Placement workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Placement owner"], [learnerId, "learner", "Avery Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `placement:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId), learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers: Record<string, string>, method: "POST" | "GET" = "POST") => {
    const r = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: payload as object } : {}) });
    if (r.statusCode !== 200) throw new Error(`Placement fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)).id as string;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  const catalogId = await ensureCatalog(db, releaseId);
  await call(`/api/admin/courses/${catalogId}/placement/settings`, { expectedRevision: 0, enabled: true, retestCooldownHours: 0, maxRuns: 1, maxItems: null, minFamiliesPerEpisode: null }, owner);
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner)).id as string;
  const send = async (action: string, body: Record<string, unknown> = {}) =>
    call(`/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: (await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")).revision, idempotencyKey: randomUUID(), ...body }, learner);
  const answers: Record<string, string | number> = { "min-a": "two", "min-b": 4, "max-a": 4, "max-b": -8 };
  await send("placement/start");
  for (let i = 0; i < 3; i++) {
    const next = (await call(`/api/enrollments/${enrollmentId}/placement`, null, learner, "GET")).run.nextItem;
    if (!next) break;
    const issued = await send("challenges", { episodeId: next.episodeId, assessmentId: next.assessmentId, mode: "placement" });
    await send("answers", { challengeId: issued.challengeId, answer: answers[next.assessmentId] });
  }
  await send("placement/finish");
  await send("placement/accept", { startEpisodeId: "max" });
  return { code: await issueLoginCode(db, ownerId) };
});
// Test-only: a course release declaring an admin section (SDK defineAdminSection) with settings at
// course, chapter and learner level; an owner who may change them, an instructor who may only read.
app.post("/test/admin-section-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), instructorId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `sections-${workspaceId}`, "Sections workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Sections owner"], [instructorId, "instructor", "Reading instructor"], [learnerId, "learner", "Avery Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `sections:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId), learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers: Record<string, string>) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw new Error(`Admin section fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const manifest = { ...fixture(), adminSections: [{
    id: "lab-notebook", version: "1.0.0", title: "Lab notebook", description: "How the practice notebook prompts learners.",
    requiredPermissions: ["course.read", "course.settings.write"], learnerDataAccess: "none", audit: "all_mutations",
    settings: [
      { id: "prompt-hours", label: "Hours between prompts", scope: "course", mutationPermission: "course.settings.write", type: "integer", default: 24, minimum: 1, maximum: 72 },
      { id: "units", label: "Measurement units", scope: "course", mutationPermission: "course.settings.write", type: "enum", default: "metric", options: ["metric", "imperial"] },
      { id: "show-hints", label: "Show worked hints first", scope: "chapter", mutationPermission: "course.settings.write", type: "boolean", default: true },
      { id: "notebook-label", label: "Notebook label", scope: "enrollment", mutationPermission: "course.settings.write", type: "string", default: "", maxLength: 40 },
    ],
  }] } as ReturnType<typeof fixture>;
  const releaseId = (await call(`/api/workspaces/${workspaceId}/releases`, manifest, owner)).id as string;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  await ensureCatalog(db, releaseId);
  await call("/api/enrollments", { releaseId }, learner);
  return { code: await issueLoginCode(db, ownerId), instructorCode: await issueLoginCode(db, instructorId) };
});
// Test-only: an instructor, a reviewer and a learner enrolled through the real HTTP API, for the
// AI supervision pause/stop/resume controls.
app.post("/test/supervision-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), instructorId = randomUUID(), reviewerId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `supervision-${workspaceId}`, "Supervision workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Supervision owner"], [instructorId, "instructor", "Supervising instructor"],
    [reviewerId, "reviewer", "Read-only reviewer"], [learnerId, "learner", "Avery Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `supervision:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId), learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers: Record<string, string>) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw new Error(`Supervision fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)).id as string;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  await call("/api/enrollments", { releaseId }, learner);
  return { instructorCode: await issueLoginCode(db, instructorId), reviewerCode: await issueLoginCode(db, reviewerId) };
});
// Test-only: a course where two learners dispute a result (one valid, one failed answer), with an
// evidence reviewer and an observer. Made through the real HTTP API; the reason is a canary staff must never see.
app.post("/test/evidence-dispute-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), reviewerId = randomUUID(), observerId = randomUUID();
  const learners = [randomUUID(), randomUUID()];
  const reason = `EVIDENCE_DISPUTE_REASON_${randomUUID()}`;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `evidence-dispute-${workspaceId}`, "Evidence dispute workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Course owner"], [reviewerId, "reviewer", "Evidence reviewer"], [observerId, "observer", "Course observer"],
    [learners[0]!, "learner", "Casey Learner"], [learners[1]!, "learner", "Devon Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `evidence-dispute:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const call = async (url: string, payload: unknown, headers: Record<string, string>, method: "POST" | "GET" = "POST") => {
    const r = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: payload as object } : {}) });
    if (r.statusCode !== 200) throw new Error(`Evidence dispute fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const owner = await login(ownerId);
  const releaseId = (await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)).id;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  for (const [index, learnerId] of learners.entries()) {
    const learner = await login(learnerId);
    const enrollmentId = (await call("/api/enrollments", { releaseId }, learner)).id as string;
    const send = async (action: string, body: Record<string, unknown>) =>
      call(`/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: (await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")).revision,
        idempotencyKey: randomUUID(), ...body }, learner);
    const challenge = await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
    await send("answers", { challengeId: challenge.challengeId, answer: index === 0 ? "two" : "five" });
    const evidenceId = (await db.query<{ id: string }>("SELECT id FROM evidence WHERE enrollment_id=$1 ORDER BY created_at LIMIT 1", [enrollmentId])).rows[0]!.id;
    await send(`learner-model/evidence/${evidenceId}/control`, { action: "dispute", reason });
  }
  return { reviewerCode: await issueLoginCode(db, reviewerId), observerCode: await issueLoginCode(db, observerId), reason };
});
// Test-only: the client facts (event envelope) of the latest learning event of one type, so a
// browser test can check what the admin app sent. Never returns payloads.
app.get("/test/event-envelope", async (request) => {
  const type = String((request.query as { type?: string }).type ?? "");
  const row = (await db.query("SELECT actor_kind,platform,app_version,client_sequence,occurred_at FROM learning_events WHERE event_type=$1 ORDER BY sequence DESC LIMIT 1", [type])).rows[0];
  return row ? { actorKind: row.actor_kind, platform: row.platform, appVersion: row.app_version, clientSequence: row.client_sequence === null ? null : Number(row.client_sequence),
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null } : null;
});
// Test-only: a workspace with a configured scripted video provider, budgets and two
// generated clips waiting for review, made through the real HTTP API and worker.
app.post("/test/media-fixture", async () => {
  const workspaceId = randomUUID(), adminId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `media-${workspaceId}`, "Media workspace"]);
  for (const [id, role, name] of [[adminId, "admin", "Media administrator"], [learnerId, "learner", "Clip learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `media:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const admin = await login(adminId), learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers = admin) => {
    const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
    if (r.statusCode !== 200) throw new Error(`Media fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (await call(`/api/workspaces/${workspaceId}/releases`, fixture())).id;
  await call(`/api/releases/${releaseId}/publish`, {});
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner)).id;
  const setup = `/api/admin/workspaces/${workspaceId}/provider-setup`;
  await call(setup, { expectedRevision: 0, idempotencyKey: "media-" + randomUUID(), configuration: mediaConfiguration(),
    jobPolicy: mediaJobPolicy(250_000), credentials: { [MEDIA_CREDENTIAL]: "synthetic-media-credential" } });
  await call(`${setup}/budgets`, { expectedRevision: 0, idempotencyKey: "media-" + randomUUID(), limits: { microUsd: 5_000_000, tokens: 1_000_000 }, paidWorkApproved: true });
  await call(`${setup}/budgets`, { expectedRevision: 0, idempotencyKey: "media-" + randomUUID(), enrollmentId, limits: { microUsd: 5_000_000, tokens: 1_000_000 }, paidWorkApproved: true });
  for (const title of ["Running minimum in motion", "Comparing two values"])
    await call(`/api/admin/enrollments/${enrollmentId}/media-jobs`, { episodeId: "min", title,
      objective: "Show the running minimum keeping the smaller value at each comparison.",
      script: "Narrated diagram: a highlight moves along a list and stays on the smaller value after each comparison.", idempotencyKey: "media-" + randomUUID() });
  const worker = createMediaJobService(db, workspaceMediaResolver(workspaceProviders), mediaOptions);
  for (let i = 0; i < 4; i++) await worker.run({ now: new Date(Date.now() + i * 2000), limit: 10 });
  return { code: await issueLoginCode(db, adminId), learnerCode: await issueLoginCode(db, learnerId), enrollmentId };
});
// Test-only: a workspace with one configured (never contacted) model, one operator price
// version and two settled ledger rows, so pricing and spend views have real data.
app.post("/test/pricing-fixture", async () => {
  const workspaceId = randomUUID(), adminId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `pricing-${workspaceId}`, "Pricing workspace"]);
  for (const [id, role, name] of [[adminId, "admin", "Pricing administrator"], [learnerId, "learner", "Priced learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `pricing:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const admin = await login(adminId), learner = await login(learnerId);
  const releaseId = (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/releases`, headers: admin, payload: fixture() })).json().id;
  if ((await app.inject({ method: "POST", url: `/api/releases/${releaseId}/publish`, headers: admin })).statusCode !== 200) throw new Error("Pricing fixture publication failed");
  await ensureCatalog(db, releaseId);
  const enrollmentId = (await app.inject({ method: "POST", url: "/api/enrollments", headers: learner, payload: { releaseId } })).json().id as string;
  const configured = await app.inject({ method: "POST", url: `/api/admin/workspaces/${workspaceId}/provider-setup`, headers: admin, payload: {
    expectedRevision: 0, idempotencyKey: randomUUID(), credentials: {},
    jobPolicy: { allowance: { microUsd: 100000, tokens: 1000000 }, durationMs: 300000, timeoutMs: 60000, maxAttempts: 3 },
    configuration: { registry: { revision: "pricing-fixture", models: [{ id: "text-companion", providerId: "google-main", remoteModel: "public-text-model",
      providerConfig: { transport: "generate_content", apiVersion: "v1beta", maxResponseBytes: 1048576 }, enabled: true, capabilities: ["tutoring"], tools: [],
      limits: { maxInputCharacters: 30000, maxOutputTokens: 1000 } }] },
      adapters: [{ id: "google-main", kind: "google", credentialEnv: "GOOGLE_API_KEY" }],
      roles: { companion: { modelId: "text-companion", maxInputCharacters: 12000, maxOutputTokens: 1000 } } } } });
  if (configured.statusCode !== 200) throw new Error(`Pricing fixture configuration failed: ${configured.body}`);
  const priceId = randomUUID();
  await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
      effective_from,source_note,created_by) VALUES($1,$2,'text-companion',1,'active','USD',300000,2500000,clock_timestamp()-interval '1 day','Synthetic fixture price',$3)`,
    [priceId, workspaceId, adminId]);
  await db.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,model_id,pricing_version_id,state,
      reserved_micro_usd,reserved_tokens,actual_micro_usd,charged_micro_usd,released_micro_usd,settled_at)
    VALUES($1,'supervisor',$2,1,$3,$4,'companion','text-companion',$5,'reconciled',100000,20000,960,960,99040,clock_timestamp()),
      ($6,'supervisor',$7,1,$3,$4,'companion','text-companion',NULL,'uncertain',100000,20000,NULL,100000,0,NULL)`,
    [randomUUID(), `${randomUUID()}/generate`, workspaceId, enrollmentId, priceId, randomUUID(), `${randomUUID()}/generate`]);
  return { code: await issueLoginCode(db, adminId) };
});
// Test-only: a learner mid-lesson (reading, evidence, an open check, a written
// answer awaiting review, a visual) plus an owner and an instructor.
app.post("/test/learner-view-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), instructorId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `view-${workspaceId}`, "Learner view workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Viewing owner"], [instructorId, "instructor", "Course instructor"], [learnerId, "learner", "Avery Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `view:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId), learner = await login(learnerId);
  const course = rubricCourse(), visual = toVisualExperience(sortingDemo);
  course.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: "declarative", entrypoint: "renderers/svg-v1.js",
    platforms: ["web"], capabilities: ["visual.render"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: visual.accessibility.description } });
  course.visuals.push(visual);
  course.chapters[0]!.episodes[0]!.blocks.splice(1, 0, { id: "min-visual", type: "visual", visualId: visual.id });
  const releaseId = (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/releases`, headers: owner, payload: course })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${releaseId}/publish`, headers: owner });
  if (published.statusCode !== 200) throw new Error(`Learner view fixture publication failed: ${published.body}`);
  const enrollmentId = (await app.inject({ method: "POST", url: "/api/enrollments", headers: learner, payload: { releaseId } })).json().id as string;
  const send = async (action: string, body: Record<string, unknown>) => {
    const revision = (await app.inject({ url: `/api/enrollments/${enrollmentId}`, headers: learner })).json().revision;
    const r = await app.inject({ method: "POST", url: `/api/enrollments/${enrollmentId}/${action}`, headers: learner, payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...body } });
    if (r.statusCode !== 200) throw new Error(`Learner view fixture ${action} failed: ${r.body}`);
    return r.json();
  };
  await send("profile", { profile: { displayName: "Avery Learner", goal: "Understand comparisons.", pace: "steady" } });
  await send("read", { episodeId: "min", blockId: "min-text" });
  const choice = await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
  await send("answers", { challengeId: choice.challengeId, answer: "two" });
  const written = await send("challenges", { episodeId: "min", assessmentId: "min-explain", mode: "independent" });
  await send("answers", { challengeId: written.challengeId, answer: rubricExplanation });
  await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "practice" });
  await send("companion", { episodeId: "min", content: "A private question for my companion only." });
  return {
    ownerCode: await issueLoginCode(db, ownerId),
    instructorCode: await issueLoginCode(db, instructorId),
    learnerCode: await issueLoginCode(db, learnerId),
    enrollmentId,
  };
});
// Test-only: a learner on a lesson with a visual, one recorded supervisor run of that lesson (tool
// calls, a stored plan, budgets and client facts), an owner and an instructor.
app.post("/test/inspector-fixture", async () => {
  const workspaceId = randomUUID(), ownerId = randomUUID(), instructorId = randomUUID(), learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspaceId, `inspector-${workspaceId}`, "Inspector workspace"]);
  for (const [id, role, name] of [[ownerId, "owner", "Inspecting owner"], [instructorId, "instructor", "Course instructor"], [learnerId, "learner", "Avery Learner"]] as const) {
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `inspector:${id}`, name]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  }
  const login = async (userId: string) => {
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
    return { cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), origin, "x-csrf-token": r.json().csrfToken };
  };
  const owner = await login(ownerId), learner = await login(learnerId);
  const course = fixture(), visual = toVisualExperience(sortingDemo);
  course.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: "declarative", entrypoint: "renderers/svg-v1.js",
    platforms: ["web"], capabilities: ["visual.render"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: visual.accessibility.description } });
  course.visuals.push(visual);
  course.chapters[0]!.episodes[0]!.blocks.splice(1, 0, { id: "min-visual", type: "visual", visualId: visual.id });
  const releaseId = (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/releases`, headers: owner, payload: course })).json().id;
  const published = await app.inject({ method: "POST", url: `/api/releases/${releaseId}/publish`, headers: owner });
  if (published.statusCode !== 200) throw new Error(`Inspector fixture publication failed: ${published.body}`);
  await ensureCatalog(db, releaseId);
  const enrollmentId = (await app.inject({ method: "POST", url: "/api/enrollments", headers: learner, payload: { releaseId } })).json().id as string;
  await recordSyntheticRun(db, { workspaceId, enrollmentId, releaseId, learnerId, episodeId: "min" });
  return { ownerCode: await issueLoginCode(db, ownerId), instructorCode: await issueLoginCode(db, instructorId) };
});
// Test-only: a learner with one course-made clip attached to their first lesson (generated by
// the scripted video adapter, reviewed and attached through the real HTTP API and worker), one
// revoked clip, and an owner who may open the read-only learner view.
app.post("/test/learner-view-media-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `view-media-${workspaceId}`,
    "Learner view media",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Viewing owner"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `view-media:${id}`, name],
    );
    await db.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspaceId, id, role],
    );
  }
  const login = async (userId: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/auth/redeem",
      headers: { origin },
      payload: { token: await issueLoginCode(db, userId) },
    });
    return {
      cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin,
      "x-csrf-token": r.json().csrfToken,
    };
  };
  const owner = await login(ownerId),
    learner = await login(learnerId);
  const call = async (
    url: string,
    payload: unknown,
    headers = owner,
    method: "POST" | "GET" = "POST",
  ) => {
    const r = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: payload as object } : {}),
    });
    if (r.statusCode !== 200)
      throw new Error(`Learner view media fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, fixture())
  ).id;
  await call(`/api/releases/${releaseId}/publish`, {});
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner))
    .id;
  await call(
    `/api/enrollments/${enrollmentId}/profile`,
    {
      expectedRevision: (
        await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")
      ).revision,
      idempotencyKey: randomUUID(),
      profile: { displayName: "Avery Learner", goal: "", pace: "steady" },
    },
    learner,
  );
  const setup = `/api/admin/workspaces/${workspaceId}/provider-setup`;
  await call(setup, {
    expectedRevision: 0,
    idempotencyKey: "media-" + randomUUID(),
    configuration: mediaConfiguration(),
    jobPolicy: mediaJobPolicy(250_000),
    credentials: { [MEDIA_CREDENTIAL]: "synthetic-media-credential" },
  });
  await call(`${setup}/budgets`, {
    expectedRevision: 0,
    idempotencyKey: "media-" + randomUUID(),
    limits: { microUsd: 5_000_000, tokens: 1_000_000 },
    paidWorkApproved: true,
  });
  await call(`${setup}/budgets`, {
    expectedRevision: 0,
    idempotencyKey: "media-" + randomUUID(),
    enrollmentId,
    limits: { microUsd: 5_000_000, tokens: 1_000_000 },
    paidWorkApproved: true,
  });
  const jobs: string[] = [];
  for (const title of ["Running minimum in motion", "Superseded minimum clip"])
    jobs.push(
      (
        await call(`/api/admin/enrollments/${enrollmentId}/media-jobs`, {
          episodeId: "min",
          title,
          objective:
            "Show the running minimum keeping the smaller value at each comparison.",
          script:
            "Narrated diagram: a highlight moves along a list and stays on the smaller value after each comparison.",
          idempotencyKey: "media-" + randomUUID(),
        })
      ).id,
    );
  const worker = createMediaJobService(
    db,
    workspaceMediaResolver(workspaceProviders),
    mediaOptions,
  );
  for (let i = 0; i < 4; i++)
    await worker.run({ now: new Date(Date.now() + i * 2000), limit: 10 });
  const attachments: string[] = [];
  for (const jobId of jobs) {
    const job = await call(
      `/api/admin/media-jobs/${jobId}`,
      null,
      owner,
      "GET",
    );
    await call(`/api/admin/media-jobs/${jobId}/review`, {
      decision: "approved",
      assetSha256: job.asset.sha256,
      captionsVtt: SYNTHETIC_CAPTIONS,
      transcript:
        "The running minimum keeps the smaller value after each comparison in the list.",
      visualDescription:
        "A list of five boxes; a highlight moves left to right and stays on the smallest value so far.",
      findings: {
        factualAccuracy: true,
        labelsAndEquations: true,
        captionsMatchNarration: true,
        noMisleadingMotion: true,
      },
      rationale:
        "Matches the reference trace for the minimum episode and the captions follow the narration.",
      idempotencyKey: "media-" + randomUUID(),
    });
    attachments.push(
      (
        await call(`/api/admin/media-jobs/${jobId}/attach`, {
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          idempotencyKey: "media-" + randomUUID(),
        })
      ).attachmentId,
    );
  }
  await call(`/api/admin/media-attachments/${attachments[1]}/revoke`, {
    reason: "Superseded by a corrected clip.",
    idempotencyKey: "media-" + randomUUID(),
  });
  return {
    ownerCode: await issueLoginCode(db, ownerId),
    learnerCode: await issueLoginCode(db, learnerId),
    enrollmentId,
    attachmentId: attachments[0],
  };
});
app.addHook("onClose", async () => {
  await db.end();
  await root.query(`DROP SCHEMA ${schema} CASCADE`);
  await root.end();
});
await app.listen({ host: "127.0.0.1", port });
process.on("SIGINT", () => {
  void app.close();
});
process.on("SIGTERM", () => {
  void app.close();
});
