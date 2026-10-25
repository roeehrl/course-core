import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  transaction,
} from "../../../services/api/src/database.ts";
import { appendEvent } from "../../../services/api/src/events.ts";
import {
  configureSupervisorBudget,
  createPostgresSupervisorBridge,
  parkSupervisorJob,
} from "../../../services/api/src/supervisor-bridge.ts";
import { migrate } from "../../../services/api/src/migrations.ts";
import { createServer } from "../../../services/api/src/server.ts";
import { authService, issueLoginCode } from "../../../services/api/src/auth.ts";
import {
  registerAdminRoutes,
  ensureCatalog,
} from "../../../services/api/src/admin-routes.ts";
import { unconfiguredProviders } from "../../../services/api/src/provider-composition.ts";
import { roleRevisions } from "../../../services/api/src/agent-evals/revision.ts";
import { fixture } from "../../../services/api/test/fixture.ts";
import { retentionCourse } from "../../../services/api/test/retention-fixture.ts";
import { buildPackage } from "../../../services/api/test/course-package-fixture.ts";
import {
  activityCourse,
  sandboxedActivity,
  sandboxedDeclaration,
} from "../../../services/api/test/activity-fixture.ts";
import { packageDirectories } from "../../../services/api/src/course-package-directory.ts";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  syntheticResearchInspector,
  syntheticYouTubeFetch,
} from "../../../services/api/test/research-fixture.ts";
import { workspaceYouTubeSearch } from "../../../services/api/src/research-media.ts";
import {
  rubricCourse,
  rubricExplanation,
} from "../../../services/api/test/rubric-fixture.ts";
import {
  gatedCourse,
  repairEvaluatorStub,
} from "../../../services/api/test/gated-fixture.ts";
import { recordSyntheticRun } from "../../../services/api/test/run-fixture.ts";
import { reviewedRubricEvaluator } from "../../../services/api/src/rubric-evaluator.ts";
import { svgRenderer } from "../../../services/api/src/svg-renderer.ts";
import { adminRealPort } from "../../../services/api/browser/ports.ts";
import { toVisualExperience } from "@course-core/visuals/headless";
import { sortingDemo } from "@course-core/visuals/demos";
import {
  createMediaJobService,
  workspaceMediaResolver,
} from "../../../services/api/src/media-jobs.ts";
import {
  MEDIA_CREDENTIAL,
  SYNTHETIC_CAPTIONS,
  ScriptedAssist,
  ScriptedImage,
  ScriptedVideo,
  mediaConfiguration,
  mediaJobPolicy,
  pipelineConfiguration,
  approveRevisionsForTest,
} from "../../../services/api/test/media-fixture.ts";
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
  // Synthetic keys that the scripted listing refuses the way the Gemini API does.
  const refusal = {
    SYNTHETIC_REVOKED_KEY: [400, "INVALID_ARGUMENT", "API_KEY_INVALID"],
    SYNTHETIC_DISABLED_API_KEY: [403, "PERMISSION_DENIED", "SERVICE_DISABLED"],
  }[new Headers(init?.headers).get("x-goog-api-key") ?? ""] as
    [number, string, string] | undefined;
  if (refusal)
    return new Response(
      JSON.stringify({
        error: {
          code: refusal[0],
          message: "Synthetic refusal",
          status: refusal[1],
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: refusal[2],
            },
          ],
        },
      }),
      { status: refusal[0], headers: { "content-type": "application/json" } },
    );
  return new Response(
    JSON.stringify({
      // Synthetic names that follow the Gemini naming the suggestion rules read.
      models: [
        {
          name: "models/public-text-model",
          displayName: "Public test model",
          inputTokenLimit: 131072,
          outputTokenLimit: 4000,
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/gemini-9.0-flash",
          displayName: "Gemini 9 Flash",
          inputTokenLimit: 1048576,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ["generateContent"],
        },
        {
          // In Core's bundled price table, so its prices are prefilled.
          name: "models/gemini-3.8-flash",
          displayName: "Gemini 3.8 Flash",
          inputTokenLimit: 1048576,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/gemini-9.0-pro",
          displayName: "Gemini 9 Pro",
          inputTokenLimit: 1048576,
          outputTokenLimit: 8192,
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
// Test-only synthetic Gemini generation for the quality check run from the AI services page.
// It answers each practice conversation with Core's public "reference" scripted answers (the
// server's quality-check seam says which conversation is next). No provider is contacted and
// nothing it says reflects a real model's quality.
const { googleAdapterFactory } =
  await import("../../../services/api/src/provider-composition.ts");
const { PUBLIC_SCRIPTED_MODELS } =
  await import("../../../services/api/src/agent-evals/public-suite.ts");
let scriptedDialogue: string | undefined;
const scriptedRounds = new Map<string, number>();
const syntheticGemini: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (
    url.origin !== "https://generativelanguage.googleapis.com" ||
    init?.method !== "POST" ||
    !url.pathname.endsWith(":generateContent")
  )
    throw Error("Synthetic Gemini permits only generateContent");
  const output = scriptedDialogue
    ? PUBLIC_SCRIPTED_MODELS.reference[scriptedDialogue]
    : undefined;
  if (!output || output.kind === "error" || output.kind === "refusal")
    return new Response(
      JSON.stringify({
        error: { code: 500, message: "Synthetic failure", status: "INTERNAL" },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  // A tool-loop conversation answers round by round (every agent role is evaluated, N07).
  const round = (scriptedRounds.get(scriptedDialogue!) ?? 0) + 1;
  scriptedRounds.set(scriptedDialogue!, round);
  const text =
    output.kind === "text"
      ? output.text
      : output.kind === "plan"
        ? JSON.stringify({ summary: output.summary, needs: output.needs })
        : output.kind === "tool_script"
          ? JSON.stringify(
              output.rounds[Math.min(round, output.rounds.length) - 1],
            )
          : output.kind === "review_answer"
            ? JSON.stringify({
                summary: output.summary,
                criteria: output.criteria,
              })
            : JSON.stringify(output);
  const prompt = Math.ceil(String(init.body).length / 4),
    answer = Math.ceil(text.length / 4);
  return new Response(
    JSON.stringify({
      candidates: [
        {
          index: 0,
          finishReason: "STOP",
          content: { role: "model", parts: [{ text }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: prompt,
        candidatesTokenCount: answer,
        totalTokenCount: prompt + answer,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
};
const { WorkspaceProviders } =
  await import("../../../services/api/src/provider-setup.ts");
const { credentialVault } =
  await import("../../../services/api/src/key-vault.ts");
// Test-only scripted video adapter: no network, no credential, records submissions.
const scriptedVideo = new ScriptedVideo();
// Test-only scripted image model and structured-output assistant (storyboards, checks).
const scriptedImage = new ScriptedImage(),
  scriptedAssist = new ScriptedAssist();
const workspaceProviders = new WorkspaceProviders(
  db,
  credentialVault(randomBytes(32)),
  {
    google: googleAdapterFactory(syntheticGemini),
    "scripted-video": scriptedVideo.factory(),
    "scripted-image": scriptedImage.factory(),
    "scripted-assist": scriptedAssist.factory(),
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
// Test-only stand-ins for the clip tools (rsvg-convert, ffmpeg): they write fixed public bytes
// with the MP4 signature. qualification/clip-export-flow.ts runs the real tools.
const clipTools = mkdtempSync(joinPath(tmpdir(), "course-admin-clip-tools-"));
const clipTool = (name: string, body: string) => {
  const file = joinPath(clipTools, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`,
  );
  chmodSync(file, 0o755);
  return file;
};
const mediaOptions = {
  pollIntervalMs: 1000,
  clipToolchain: {
    rasterizerPath: clipTool(
      "raster",
      "fs.readFileSync(0); process.stdout.write(Buffer.from([137,80,78,71,13,10,26,10,1]));",
    ),
    ffmpegPath: clipTool(
      "ffmpeg",
      "const target = args.at(-1); if (!args.includes('-filter_complex')) fs.readFileSync(0); fs.writeFileSync(target, Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,1,2,3,4]));",
    ),
  },
};
const renderer = await svgRenderer();
// Test-only package directory for course-update browser tests (a disposable temporary folder).
const packageRoot = realpathSync(
  mkdtempSync(joinPath(tmpdir(), "course-admin-packages-")),
);
const app = await createServer(db, {
  loginCodes: true,
  coursePackageDirectories: packageDirectories(JSON.stringify([packageRoot])),
  workspaceProviders,
  // Test-only: tells the synthetic Gemini model which practice conversation comes next.
  qualityChecks: {
    beforeDialogue: (dialogue) => {
      scriptedDialogue = dialogue.id;
    },
  },
  media: { options: mediaOptions },
  origin,
  secureCookies: false,
  // Test-only: no network inspection from browser tests.
  researchInspector: syntheticResearchInspector(),
  // Test-only: the admin-entered workspace key is used, but YouTube is a synthetic stub (no network).
  youtubeSearch: workspaceYouTubeSearch(
    (workspaceId, name) => workspaceProviders.credential(workspaceId, name),
    syntheticYouTubeFetch(),
  ),
  // The repair evaluator is the labelled data-only stub from the gated fixture (no code runs).
  installedExtensions: [
    reviewedRubricEvaluator(),
    repairEvaluatorStub(),
    renderer,
  ],
  adminDirectory: directory,
  providers,
});
if (!app.hasRoute({ method: "GET", url: "/api/admin/session" }))
  throw new Error("Production admin routes are not registered.");
if (!app.hasRoute({ method: "GET", url: "/admin/demo" }))
  app.get("/admin/demo", (_request, reply) =>
    reply.sendFile("index.html", directory),
  );
// Test-only: a brand-new workspace with an owner and an administrator and no course.
app.post("/test/empty-workspace-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    adminId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `empty-${workspaceId}`,
    "New school workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "New workspace owner"],
    [adminId, "admin", "New workspace administrator"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `empty:${id}`, name],
    );
    await db.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspaceId, id, role],
    );
  }
  return {
    workspaceId,
    ownerCode: await issueLoginCode(db, ownerId),
    adminCode: await issueLoginCode(db, adminId),
  };
});
// Test-only fixture endpoint on loopback, never imported by production code.
app.post("/test/admin-fixture", async () => {
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID(),
    observerId = randomUUID(),
    // The owner records agent-eval overrides, which administrators cannot.
    ownerId = randomUUID();
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
    [ownerId, "owner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [
        id,
        `browser:${id}`,
        role === "admin"
          ? "Browser administrator"
          : role === "observer"
            ? "Course observer"
            : role === "owner"
              ? "Workspace owner"
              : "Public learner",
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
    ownerCode: await issueLoginCode(db, ownerId),
  };
});
// Test-only: a workspace with one pending written answer awaiting review.
app.post("/test/rubric-fixture", async (request) => {
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `rubric-${workspaceId}`,
    "Rubric workspace",
  ]);
  for (const [id, role, name] of [
    [adminId, "admin", "Rubric reviewer"],
    [learnerId, "learner", "Written learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `rubric:${id}`, name],
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
  const admin = await login(adminId),
    learner = await login(learnerId);
  const releaseId = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/releases`,
      headers: admin,
      payload: rubricCourse(),
    })
  ).json().id;
  const published = await app.inject({
    method: "POST",
    url: `/api/releases/${releaseId}/publish`,
    headers: admin,
  });
  if (published.statusCode !== 200)
    throw new Error("Rubric fixture publication failed");
  const enrollmentId = (
    await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: learner,
      payload: { releaseId },
    })
  ).json().id;
  const revision = async () =>
    (
      await app.inject({
        url: `/api/enrollments/${enrollmentId}`,
        headers: learner,
      })
    ).json().revision;
  const challenge = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollmentId}/challenges`,
    headers: learner,
    payload: {
      expectedRevision: await revision(),
      idempotencyKey: randomUUID(),
      episodeId: "min",
      assessmentId: "min-explain",
      mode: "independent",
    },
  });
  const answered = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollmentId}/answers`,
    headers: learner,
    payload: {
      expectedRevision: await revision(),
      idempotencyKey: randomUUID(),
      challengeId: challenge.json().challengeId,
      answer: rubricExplanation,
    },
  });
  if (answered.statusCode !== 200)
    throw new Error("Rubric fixture answer failed");
  // Optionally, a reviewer draft that Core's checks rejected: the learner opts in through the API,
  // and the ended request is recorded as the verifier leaves it (no model runs in this harness).
  if ((request.query as { assist?: string }).assist === "rejected") {
    const consent = await app.inject({
      method: "POST",
      url: `/api/enrollments/${enrollmentId}/review-assist`,
      headers: learner,
      payload: {
        expectedRevision: await revision(),
        idempotencyKey: randomUUID(),
        granted: true,
      },
    });
    if (consent.statusCode !== 200)
      throw new Error("Rubric fixture consent failed");
    const attemptId = (
      await db.query("SELECT id FROM attempts WHERE enrollment_id=$1", [
        enrollmentId,
      ])
    ).rows[0].id;
    await db.query(
      `INSERT INTO rubric_assist_requests(id,attempt_id,enrollment_id,workspace_id,requested_by,consent_revision,rubric_digest,response_digest,state,rejection_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'rejected','quote_not_in_answer')`,
      [
        randomUUID(),
        attemptId,
        enrollmentId,
        workspaceId,
        adminId,
        consent.json().consentRevision,
        "a".repeat(64),
        "b".repeat(64),
      ],
    );
  }
  return { code: await issueLoginCode(db, adminId) };
});
// Test-only: a gated course where two learners asked for a review of their gate decision,
// an instructor (may grant exceptions) and a reviewer (may only uphold). Made through the real HTTP API.
app.post("/test/gate-review-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    instructorId = randomUUID(),
    reviewerId = randomUUID();
  const learners = [randomUUID(), randomUUID()];
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `gate-review-${workspaceId}`,
    "Gate review workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Course owner"],
    [instructorId, "instructor", "Gate instructor"],
    [reviewerId, "reviewer", "Gate reviewer"],
    [learners[0]!, "learner", "Avery Learner"],
    [learners[1]!, "learner", "Blake Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `gate-review:${id}`, name],
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
  const owner = await login(ownerId);
  const call = async (
    url: string,
    payload: unknown,
    headers: Record<string, string>,
    method: "POST" | "GET" = "POST",
  ) => {
    const r = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: payload as object } : {}),
    });
    if (r.statusCode !== 200)
      throw new Error(`Gate review fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await call(
      `/api/workspaces/${workspaceId}/releases`,
      gatedCourse(`7.0.${Date.now() % 100000}`),
      owner,
    )
  ).id;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  for (const learnerId of learners) {
    const learner = await login(learnerId);
    const enrollmentId = (
      await call("/api/enrollments", { releaseId }, learner)
    ).id as string;
    const send = async (action: string, body: Record<string, unknown>) =>
      call(
        `/api/enrollments/${enrollmentId}/${action}`,
        {
          expectedRevision: (
            await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")
          ).revision,
          idempotencyKey: randomUUID(),
          ...body,
        },
        learner,
      );
    await send("read", { episodeId: "min", blockId: "min-text" });
    const challenge = await send("challenges", {
      episodeId: "min",
      assessmentId: "min-b",
      mode: "independent",
    });
    await send("answers", { challengeId: challenge.challengeId, answer: 4 });
    const decision = (
      await call(
        `/api/enrollments/${enrollmentId}/gates/min-gate/decision`,
        null,
        learner,
        "GET",
      )
    ).decision;
    await send("gates/min-gate/review-requests", {
      decisionId: decision.decisionId,
      reason:
        "I worked through the lesson but ran out of time for the transfer task.",
    });
  }
  return {
    instructorCode: await issueLoginCode(db, instructorId),
    reviewerCode: await issueLoginCode(db, reviewerId),
  };
});
// Test-only: an owner, version 1.0.0 with a learner who answered min-a, and a live version 1.1.0
// that changes min-b. Made through the real HTTP API.
app.post("/test/release-safety-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `release-${workspaceId}`,
    "Release workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Release owner"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `release:${id}`, name],
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
    headers: Record<string, string>,
    method: "POST" | "GET" = "POST",
  ) => {
    const r = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: payload as object } : {}),
    });
    if (r.statusCode !== 200)
      throw new Error(`Release safety fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const publish = async (manifest: ReturnType<typeof fixture>) => {
    const id = (
      await call(`/api/workspaces/${workspaceId}/releases`, manifest, owner)
    ).id as string;
    await call(`/api/releases/${id}/publish`, {}, owner);
    return id;
  };
  const first = fixture();
  first.version = "1.0.0";
  const v1 = await publish(first);
  const enrollmentId = (
    await call("/api/enrollments", { releaseId: v1 }, learner)
  ).id as string;
  const send = async (action: string, body: Record<string, unknown>) =>
    call(
      `/api/enrollments/${enrollmentId}/${action}`,
      {
        expectedRevision: (
          await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")
        ).revision,
        idempotencyKey: randomUUID(),
        ...body,
      },
      learner,
    );
  await send("read", { episodeId: "min", blockId: "min-text" });
  const challenge = await send("challenges", {
    episodeId: "min",
    assessmentId: "min-a",
    mode: "independent",
  });
  await send("answers", { challengeId: challenge.challengeId, answer: "two" });
  const second = fixture();
  second.version = "1.1.0";
  second.assessments.find((a) => a.id === "min-b")!.prompt =
    "Minimum of 6 and 3?";
  await publish(second);
  return { code: await issueLoginCode(db, ownerId) };
});
// Test-only (K13): an owner, version 1.0.0 of the fixture course with three learners (one passed the
// first checkpoint and completed its lesson, one has not started, one has a personal change waiting
// for a safe boundary), and version 1.1.0 published with a changed question in that checkpoint, so
// moving them to 1.1.0 can be previewed, offered, forced and undone.
app.post("/test/version-moves-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `moves-${workspaceId}`,
    "Version moves workspace",
  ]);
  const people = [
    [ownerId, "owner", "Moves owner"],
    [randomUUID(), "learner", "Avery Learner"],
    [randomUUID(), "learner", "Blake Learner"],
    [randomUUID(), "learner", "Casey Learner"],
  ] as const;
  for (const [id, role, name] of people) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `moves:${id}`, name],
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
  const call = async (
    url: string,
    payload: unknown,
    headers: Record<string, string>,
    method: "POST" | "GET" = "POST",
  ) => {
    const r = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: payload as object } : {}),
    });
    if (r.statusCode !== 200)
      throw new Error(`Version moves fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const owner = await login(ownerId);
  const publish = async (manifest: ReturnType<typeof fixture>) => {
    const id = (
      await call(`/api/workspaces/${workspaceId}/releases`, manifest, owner)
    ).id as string;
    await call(`/api/releases/${id}/publish`, {}, owner);
    return id;
  };
  const v1 = await publish(fixture());
  for (const [index, [userId]] of people.slice(1).entries()) {
    const learner = await login(userId);
    const enrollmentId = (
      await call("/api/enrollments", { releaseId: v1 }, learner)
    ).id as string;
    if (index === 2) {
      // A generated practice addition waiting for a safe boundary: a personal change.
      const job = randomUUID();
      await db.query(
        "INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES($1,$2,$3,$4,'supervisor','applied',1,'{}')",
        [job, enrollmentId, workspaceId, `moves-${job}`],
      );
      await db.query(
        "INSERT INTO adaptation_pending_changes(id,enrollment_id,workspace_id,job_id,episode_id,artifact_kind,selection,reason) VALUES($1,$2,$3,$4,'min','practice','{}','attempt_in_progress')",
        [randomUUID(), enrollmentId, workspaceId, job],
      );
    }
    if (index > 0) continue;
    const send = async (action: string, body: Record<string, unknown>) =>
      call(
        `/api/enrollments/${enrollmentId}/${action}`,
        {
          expectedRevision: (
            await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")
          ).revision,
          idempotencyKey: randomUUID(),
          ...body,
        },
        learner,
      );
    await send("read", { episodeId: "min", blockId: "min-text" });
    for (const [assessmentId, answer] of [
      ["min-a", "two"],
      ["min-b", 4],
    ] as const) {
      const challenge = await send("challenges", {
        episodeId: "min",
        assessmentId,
        mode: "independent",
      });
      await send("answers", { challengeId: challenge.challengeId, answer });
    }
    await send("complete", { episodeId: "min" });
  }
  const second = fixture();
  second.version = "1.1.0";
  second.assessments.find((a) => a.id === "min-b")!.prompt =
    "Minimum of 6 and 3?";
  await publish(second);
  return { code: await issueLoginCode(db, ownerId) };
});
// Test-only (Q09): an owner with version 1.0.0 of the fixture course published and a draft of
// 1.0.1, so the answer keys page can test a key change against test answers and save it.
app.post("/test/answer-keys-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `keys-${workspaceId}`,
    "Answer keys workspace",
  ]);
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [ownerId, `keys:${ownerId}`, "Keys owner"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [workspaceId, ownerId, "owner"],
  );
  const r = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, ownerId) },
  });
  const owner = {
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    origin,
    "x-csrf-token": r.json().csrfToken,
  };
  const create = async (version: string) => {
    const created = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/releases`,
      headers: owner,
      payload: { ...fixture(), version },
    });
    if (created.statusCode !== 200)
      throw new Error(`Answer keys fixture import failed: ${created.body}`);
    return created.json().id as string;
  };
  const published = await create("1.0.0");
  const publish = await app.inject({
    method: "POST",
    url: `/api/releases/${published}/publish`,
    headers: owner,
  });
  if (publish.statusCode !== 200)
    throw new Error("Answer keys fixture publication failed");
  await create("1.0.1");
  return { code: await issueLoginCode(db, ownerId) };
});
// Test-only: an owner with version 1.0.0 of the fixture course published, and synthetic
// course-package files built in-process from public fixtures (a new version, a new course).
app.post("/test/course-package-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `packages-${workspaceId}`,
    "Package workspace",
  ]);
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [ownerId, `packages:${ownerId}`, "Package owner"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [workspaceId, ownerId, "owner"],
  );
  const r = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, ownerId) },
  });
  const owner = {
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    origin,
    "x-csrf-token": r.json().csrfToken,
  };
  const imported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/releases`,
    headers: owner,
    payload: fixture(),
  });
  if (imported.statusCode !== 200)
    throw new Error("Package fixture import failed");
  const published = await app.inject({
    method: "POST",
    url: `/api/releases/${imported.json().id}/publish`,
    headers: owner,
  });
  if (published.statusCode !== 200)
    throw new Error("Package fixture publication failed");
  const update = fixture();
  update.version = "1.1.0";
  update.summary = "Installed from a synthetic course package.";
  const other = fixture();
  other.id = "ordering-companion";
  other.title = "Ordering companion";
  // An older version than the published 1.0.0: installing it needs an explicit choice.
  const older = fixture();
  older.version = "0.9.0";
  // A course that brings its own sandboxed activity script (course-supplied-extensions.ts). The
  // id is new on every call, so each run sees a file that still needs approval.
  const labId = `lab-activity-${randomUUID().slice(0, 8)}`;
  const labScript = `(() => { "use strict"; window.courseActivity.onInit(() => { document.getElementById("activity").textContent = "${labId}"; }); })();`;
  const lab = activityCourse(
    {
      ...sandboxedActivity(),
      rendererRefs: [
        { target: "web_desktop", rendererId: labId },
        { target: "web_mobile", rendererId: labId },
      ],
    },
    {},
  );
  lab.id = "ordering-lab";
  lab.title = "Ordering lab";
  lab.extensions = lab.extensions.filter((row) => row.execution !== "server");
  lab.extensions.push({
    ...sandboxedDeclaration(labScript),
    id: labId,
    entrypoint: "activities/lab.js",
  });
  return {
    code: await issueLoginCode(db, ownerId),
    supplied: buildPackage(lab, {
      extra: [{ name: "lab.js", bytes: Buffer.from(labScript), role: "other" }],
    }).bytes.toString("base64"),
    update: buildPackage(update).bytes.toString("base64"),
    newCourse: buildPackage(other).bytes.toString("base64"),
    older: buildPackage(older).bytes.toString("base64"),
  };
});
// Test-only: an owner with version 1.0.0 published and a folder in the test package directory
// holding a synthetic 1.1.0 package of the same course (the update source).
app.post("/test/course-update-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `updates-${workspaceId}`,
    "Update workspace",
  ]);
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [ownerId, `updates:${ownerId}`, "Update owner"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [workspaceId, ownerId, "owner"],
  );
  const r = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, ownerId) },
  });
  const owner = {
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    origin,
    "x-csrf-token": r.json().csrfToken,
  };
  const imported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/releases`,
    headers: owner,
    payload: fixture(),
  });
  if (imported.statusCode !== 200)
    throw new Error("Update fixture import failed");
  if (
    (
      await app.inject({
        method: "POST",
        url: `/api/releases/${imported.json().id}/publish`,
        headers: owner,
      })
    ).statusCode !== 200
  )
    throw new Error("Update fixture publication failed");
  const subpath = `course-${workspaceId.slice(0, 8)}`;
  mkdirSync(joinPath(packageRoot, subpath));
  const update = fixture();
  update.version = "1.1.0";
  update.assessments.find((a) => a.id === "min-b")!.prompt =
    "Minimum of 3 and 8?";
  writeFileSync(
    joinPath(packageRoot, subpath, "ordering-1.1.0.course.tgz"),
    buildPackage(update).bytes,
  );
  return { code: await issueLoginCode(db, ownerId), subpath };
});
// Test-only: an owner, a support observer, a course-scoped member without grants yet, and a
// learner who started the course, all made through the real HTTP API.
app.post("/test/people-scope-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    supportId = randomUUID(),
    scopedId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `scope-${workspaceId}`,
    "Scoped workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Scope owner"],
    [supportId, "support_observer", "Support observer"],
    [scopedId, "course_scoped", "Visiting tutor"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `scope:${id}`, name],
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
    headers: Record<string, string>,
  ) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`People scope fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)
  ).id;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  await call("/api/enrollments", { releaseId }, learner);
  return {
    ownerCode: await issueLoginCode(db, ownerId),
    supportCode: await issueLoginCode(db, supportId),
    scopedCode: await issueLoginCode(db, scopedId),
  };
});
// Test-only: a course with one recent failed AI run, the workspace AI budget at 90% and one
// learner question held back by the workspace limit, for the staff notification center (an owner
// and an instructor).
app.post("/test/notifications-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    instructorId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `notify-${workspaceId}`,
    "Notification workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Bell owner"],
    [instructorId, "instructor", "Bell instructor"],
    [learnerId, "learner", "Bell learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `notify:${id}`, name],
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
    headers: Record<string, string>,
  ) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`Notifications fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)
  ).id;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner))
    .id;
  await db.query(
    `INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification)
     VALUES($1,$2,$3,$4,'companion','failed',1,'{}')`,
    [randomUUID(), enrollmentId, workspaceId, `notify-${randomUUID()}`],
  );
  await db.query(
    `INSERT INTO supervisor_workspace_budgets(workspace_id,limit_micro_usd,limit_tokens,used_micro_usd,used_tokens)
     VALUES($1,1000000,0,900000,0)`,
    [workspaceId],
  );
  // A question the workspace limit holds back, as a job stopped at that limit records it.
  await db.query(
    `INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,result)
     VALUES($1,$2,$3,$4,'companion','budget_wait',1,'{}',$5)`,
    [
      randomUUID(),
      enrollmentId,
      workspaceId,
      `notify-${randomUUID()}`,
      JSON.stringify({
        reason: "budget_exhausted",
        applicationReceiptId: null,
        ceiling: "workspace",
      }),
    ],
  );
  return {
    ownerCode: await issueLoginCode(db, ownerId),
    instructorCode: await issueLoginCode(db, instructorId),
  };
});
// Test-only: placement enabled by the owner through the settings route, and a learner who placed
// out of the first episode through a real placement run.
app.post("/test/placement-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `placement-${workspaceId}`,
    "Placement workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Placement owner"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `placement:${id}`, name],
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
    headers: Record<string, string>,
    method: "POST" | "GET" = "POST",
  ) => {
    const r = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: payload as object } : {}),
    });
    if (r.statusCode !== 200)
      throw new Error(`Placement fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)
  ).id as string;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  const catalogId = await ensureCatalog(db, releaseId);
  await call(
    `/api/admin/courses/${catalogId}/placement/settings`,
    {
      expectedRevision: 0,
      enabled: true,
      retestCooldownHours: 0,
      maxRuns: 1,
      maxItems: null,
      minFamiliesPerEpisode: null,
    },
    owner,
  );
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner))
    .id as string;
  const send = async (action: string, body: Record<string, unknown> = {}) =>
    call(
      `/api/enrollments/${enrollmentId}/${action}`,
      {
        expectedRevision: (
          await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")
        ).revision,
        idempotencyKey: randomUUID(),
        ...body,
      },
      learner,
    );
  const answers: Record<string, string | number> = {
    "min-a": "two",
    "min-b": 4,
    "max-a": 4,
    "max-b": -8,
  };
  await send("placement/start");
  for (let i = 0; i < 3; i++) {
    const next = (
      await call(
        `/api/enrollments/${enrollmentId}/placement`,
        null,
        learner,
        "GET",
      )
    ).run.nextItem;
    if (!next) break;
    const issued = await send("challenges", {
      episodeId: next.episodeId,
      assessmentId: next.assessmentId,
      mode: "placement",
    });
    await send("answers", {
      challengeId: issued.challengeId,
      answer: answers[next.assessmentId],
    });
  }
  await send("placement/finish");
  await send("placement/accept", { startEpisodeId: "max" });
  return { code: await issueLoginCode(db, ownerId) };
});
// Test-only: a course release declaring an admin section (SDK defineAdminSection) with settings at
// course, chapter and learner level; an owner who may change them, an instructor who may only read.
app.post("/test/admin-section-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    instructorId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `sections-${workspaceId}`,
    "Sections workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Sections owner"],
    [instructorId, "instructor", "Reading instructor"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `sections:${id}`, name],
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
    headers: Record<string, string>,
  ) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`Admin section fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const manifest = {
    ...fixture(),
    adminSections: [
      {
        id: "lab-notebook",
        version: "1.0.0",
        title: "Lab notebook",
        description: "How the practice notebook prompts learners.",
        requiredPermissions: ["course.read", "course.settings.write"],
        learnerDataAccess: "none",
        audit: "all_mutations",
        settings: [
          {
            id: "prompt-hours",
            label: "Hours between prompts",
            scope: "course",
            mutationPermission: "course.settings.write",
            type: "integer",
            default: 24,
            minimum: 1,
            maximum: 72,
          },
          {
            id: "units",
            label: "Measurement units",
            scope: "course",
            mutationPermission: "course.settings.write",
            type: "enum",
            default: "metric",
            options: ["metric", "imperial"],
          },
          {
            id: "show-hints",
            label: "Show worked hints first",
            scope: "chapter",
            mutationPermission: "course.settings.write",
            type: "boolean",
            default: true,
          },
          {
            id: "notebook-label",
            label: "Notebook label",
            scope: "enrollment",
            mutationPermission: "course.settings.write",
            type: "string",
            default: "",
            maxLength: 40,
          },
        ],
      },
    ],
  } as ReturnType<typeof fixture>;
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, manifest, owner)
  ).id as string;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  await ensureCatalog(db, releaseId);
  await call("/api/enrollments", { releaseId }, learner);
  return {
    code: await issueLoginCode(db, ownerId),
    instructorCode: await issueLoginCode(db, instructorId),
  };
});
// Test-only: an instructor, a reviewer and a learner enrolled through the real HTTP API, for the
// AI supervision pause/stop/resume controls.
// Test-only: two published courses in two workspaces and an owner of both, for the concept mapping
// editor. Made through the real HTTP API; the mapping itself is created in the browser.
app.post("/test/concept-mapping-fixture", async () => {
  const workspaces = [randomUUID(), randomUUID()],
    ownerId = randomUUID(),
    adminOfOneId = randomUUID();
  for (const [index, workspaceId] of workspaces.entries())
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
      workspaceId,
      `mapping-${workspaceId}`,
      index ? "Practice space" : "Values space",
    ]);
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,'Mapping owner'),($3,$4,'Admin of one course')",
    [ownerId, `mapping:${ownerId}`, adminOfOneId, `mapping:${adminOfOneId}`],
  );
  for (const workspaceId of workspaces)
    await db.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspaceId, ownerId],
    );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin'),($3,$2,'instructor')",
    [workspaces[0], adminOfOneId, workspaces[1]],
  );
  const r = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, ownerId) },
  });
  const owner = {
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    origin,
    "x-csrf-token": r.json().csrfToken,
  };
  const call = async (url: string, payload: unknown) => {
    const response = await app.inject({
      method: "POST",
      url,
      headers: owner,
      payload: payload as object,
    });
    if (response.statusCode !== 200)
      throw new Error(
        `Concept mapping fixture ${url} failed: ${response.body}`,
      );
    return response.json();
  };
  const practice = fixture();
  practice.id = `practice-${workspaces[1]!.slice(0, 8)}`;
  practice.title = "Ordering practice";
  for (const [workspaceId, course] of [
    [workspaces[0]!, fixture()],
    [workspaces[1]!, practice],
  ] as const) {
    const releaseId = (
      await call(`/api/workspaces/${workspaceId}/releases`, course)
    ).id as string;
    await call(`/api/releases/${releaseId}/publish`, {});
  }
  return {
    ownerCode: await issueLoginCode(db, ownerId),
    adminOfOneCode: await issueLoginCode(db, adminOfOneId),
  };
});
app.post("/test/supervision-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    instructorId = randomUUID(),
    reviewerId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `supervision-${workspaceId}`,
    "Supervision workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Supervision owner"],
    [instructorId, "instructor", "Supervising instructor"],
    [reviewerId, "reviewer", "Read-only reviewer"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `supervision:${id}`, name],
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
    headers: Record<string, string>,
  ) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`Supervision fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)
  ).id as string;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner))
    .id as string;
  // A question whose message is gone by the time it is dispatched: the real bridge refuses it for good.
  const asked = await transaction(db, (client) =>
    appendEvent(client, {
      workspaceId,
      enrollmentId,
      actorId: learnerId,
      actorKind: "learner",
      type: "companion.requested",
      payload: {
        messageId: randomUUID(),
        episodeId: "min",
        requestKind: "question",
      },
      idempotencyKey: randomUUID(),
      supervise: true,
    }),
  );
  const bridge = createPostgresSupervisorBridge(db, {
    workspaceIds: [workspaceId],
  });
  const lease = await bridge.claimOutboxEvent(asked.id, randomUUID(), 30_000);
  if (
    !lease ||
    (await bridge.prepareOutbox(lease)).length !== 0 ||
    !(await bridge.ackOutbox(lease))
  )
    throw new Error("Supervision fixture refusal failed");
  // An update whose delivery failed during an outage until the dispatcher gave up: quarantined, re-queueable once.
  const updated = await transaction(db, (client) =>
    appendEvent(client, {
      workspaceId,
      enrollmentId,
      actorId: learnerId,
      actorKind: "learner",
      type: "learning.updated",
      payload: {},
      idempotencyKey: randomUUID(),
      supervise: true,
    }),
  );
  const outage = await bridge.claimOutboxEvent(
    updated.id,
    randomUUID(),
    30_000,
  );
  if (
    !outage ||
    !(await bridge.nackOutbox(outage, "dispatch_unavailable", 0, true))
  )
    throw new Error("Supervision fixture quarantine failed");
  // A supervisor job waiting (needs_input) for an owner to decide a higher AI spending limit (B06).
  const review = await transaction(db, (client) =>
    appendEvent(client, {
      workspaceId,
      enrollmentId,
      actorId: learnerId,
      actorKind: "learner",
      type: "learning.review_requested",
      payload: { episodeId: "min" },
      idempotencyKey: randomUUID(),
      supervise: true,
    }),
  );
  const reviewLease = await bridge.claimOutboxEvent(
    review.id,
    randomUUID(),
    30_000,
  );
  const [waiting] = reviewLease ? await bridge.prepareOutbox(reviewLease) : [];
  if (!waiting || !reviewLease || !(await bridge.ackOutbox(reviewLease)))
    throw new Error("Supervision fixture job failed");
  await parkSupervisorJob(db, waiting, "needs_input");
  await db.query(
    `INSERT INTO supervisor_authority_requests(id,enrollment_id,workspace_id,job_id,kind,approver,proposal)
     VALUES($1,$2,$3,$4,'paid_ceiling','staff',$5)`,
    [
      randomUUID(),
      enrollmentId,
      workspaceId,
      waiting.jobId,
      JSON.stringify({
        limitMicroUsd: 2_500_000,
        reason: "Two more practice sessions this week.",
      }),
    ],
  );
  return {
    instructorCode: await issueLoginCode(db, instructorId),
    reviewerCode: await issueLoginCode(db, reviewerId),
    ownerCode: await issueLoginCode(db, ownerId),
  };
});
// Test-only: a published course with held-out retention items, an owner, a reviewer and six enrolled
// learners who have not joined any study. /test/study-consent then has every one of them agree
// through the real learner consent route, as each would in their own app.
const studyLearners = new Map<
  string,
  { enrollmentId: string; headers: Record<string, string> }[]
>();
app.post("/test/study-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    reviewerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `study-${workspaceId}`,
    "Study workspace",
  ]);
  const learnerIds = Array.from({ length: 6 }, () => randomUUID());
  for (const [id, role, name] of [
    [ownerId, "owner", "Study owner"],
    [reviewerId, "reviewer", "Read-only reviewer"],
    ...learnerIds.map(
      (id, i) => [id, "learner", `Study learner ${i + 1}`] as const,
    ),
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `study:${id}`, name],
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
  const call = async (
    url: string,
    payload: unknown,
    headers: Record<string, string>,
  ) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`Study fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const owner = await login(ownerId);
  const releaseId = (
    await call(
      `/api/workspaces/${workspaceId}/releases`,
      retentionCourse(),
      owner,
    )
  ).id as string;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  const learners = [];
  for (const id of learnerIds) {
    const headers = await login(id);
    learners.push({
      enrollmentId: (await call("/api/enrollments", { releaseId }, headers))
        .id as string,
      headers,
    });
  }
  studyLearners.set(workspaceId, learners);
  return {
    workspaceId,
    ownerCode: await issueLoginCode(db, ownerId),
    reviewerCode: await issueLoginCode(db, reviewerId),
  };
});
app.post("/test/study-consent", async (request) => {
  const { workspaceId } = request.body as { workspaceId: string };
  for (const learner of studyLearners.get(workspaceId) ?? []) {
    const get = async (url: string) =>
      (
        await app.inject({ method: "GET", url, headers: learner.headers })
      ).json();
    const view = await get(`/api/enrollments/${learner.enrollmentId}/study`);
    const r = await app.inject({
      method: "POST",
      url: `/api/enrollments/${learner.enrollmentId}/study/consent`,
      headers: learner.headers,
      payload: {
        expectedRevision: view.revision,
        idempotencyKey: "consent-" + randomUUID(),
        studyId: view.study.id,
        consentDigest: view.study.consentDigest,
      },
    });
    if (r.statusCode !== 200)
      throw new Error(`Study consent failed: ${r.body}`);
  }
  return { consented: studyLearners.get(workspaceId)?.length ?? 0 };
});
// Test-only: a course where two learners dispute a result (one valid, one failed answer), with an
// evidence reviewer and an observer. Made through the real HTTP API; the reason is a canary staff must never see.
app.post("/test/evidence-dispute-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    reviewerId = randomUUID(),
    observerId = randomUUID();
  const learners = [randomUUID(), randomUUID()];
  const reason = `EVIDENCE_DISPUTE_REASON_${randomUUID()}`;
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `evidence-dispute-${workspaceId}`,
    "Evidence dispute workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Course owner"],
    [reviewerId, "reviewer", "Evidence reviewer"],
    [observerId, "observer", "Course observer"],
    [learners[0]!, "learner", "Casey Learner"],
    [learners[1]!, "learner", "Devon Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `evidence-dispute:${id}`, name],
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
  const call = async (
    url: string,
    payload: unknown,
    headers: Record<string, string>,
    method: "POST" | "GET" = "POST",
  ) => {
    const r = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: payload as object } : {}),
    });
    if (r.statusCode !== 200)
      throw new Error(`Evidence dispute fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const owner = await login(ownerId);
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)
  ).id;
  await call(`/api/releases/${releaseId}/publish`, {}, owner);
  for (const [index, learnerId] of learners.entries()) {
    const learner = await login(learnerId);
    const enrollmentId = (
      await call("/api/enrollments", { releaseId }, learner)
    ).id as string;
    const send = async (action: string, body: Record<string, unknown>) =>
      call(
        `/api/enrollments/${enrollmentId}/${action}`,
        {
          expectedRevision: (
            await call(`/api/enrollments/${enrollmentId}`, null, learner, "GET")
          ).revision,
          idempotencyKey: randomUUID(),
          ...body,
        },
        learner,
      );
    const challenge = await send("challenges", {
      episodeId: "min",
      assessmentId: "min-a",
      mode: "independent",
    });
    await send("answers", {
      challengeId: challenge.challengeId,
      answer: index === 0 ? "two" : "five",
    });
    const evidenceId = (
      await db.query<{ id: string }>(
        "SELECT id FROM evidence WHERE enrollment_id=$1 ORDER BY created_at LIMIT 1",
        [enrollmentId],
      )
    ).rows[0]!.id;
    await send(`learner-model/evidence/${evidenceId}/control`, {
      action: "dispute",
      reason,
    });
  }
  return {
    reviewerCode: await issueLoginCode(db, reviewerId),
    observerCode: await issueLoginCode(db, observerId),
    reason,
  };
});
// Test-only: the client facts (event envelope) of the latest learning event of one type, so a
// browser test can check what the admin app sent. Never returns payloads.
app.get("/test/event-envelope", async (request) => {
  const type = String((request.query as { type?: string }).type ?? "");
  const row = (
    await db.query(
      "SELECT actor_kind,platform,app_version,client_sequence,occurred_at FROM learning_events WHERE event_type=$1 ORDER BY sequence DESC LIMIT 1",
      [type],
    )
  ).rows[0];
  return row
    ? {
        actorKind: row.actor_kind,
        platform: row.platform,
        appVersion: row.app_version,
        clientSequence:
          row.client_sequence === null ? null : Number(row.client_sequence),
        occurredAt: row.occurred_at
          ? new Date(row.occurred_at).toISOString()
          : null,
      }
    : null;
});
// Test-only: a workspace with a configured scripted video provider, budgets and two
// generated clips waiting for review, made through the real HTTP API and worker.
app.post("/test/media-fixture", async () => {
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `media-${workspaceId}`,
    "Media workspace",
  ]);
  for (const [id, role, name] of [
    [adminId, "admin", "Media administrator"],
    [learnerId, "learner", "Clip learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `media:${id}`, name],
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
  const admin = await login(adminId),
    learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers = admin) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`Media fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, fixture())
  ).id;
  await call(`/api/releases/${releaseId}/publish`, {});
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner))
    .id;
  const setup = `/api/admin/workspaces/${workspaceId}/provider-setup`;
  // Every agent role is gated (N07): the owner approves the scripted revisions first.
  await approveRevisionsForTest(db, workspaceId, mediaConfiguration());
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
  for (const title of ["Running minimum in motion", "Comparing two values"])
    await call(`/api/admin/enrollments/${enrollmentId}/media-jobs`, {
      episodeId: "min",
      title,
      objective:
        "Show the running minimum keeping the smaller value at each comparison.",
      script:
        "Narrated diagram: a highlight moves along a list and stays on the smaller value after each comparison.",
      idempotencyKey: "media-" + randomUUID(),
    });
  const worker = createMediaJobService(
    db,
    workspaceMediaResolver(workspaceProviders),
    mediaOptions,
  );
  for (let i = 0; i < 4; i++)
    await worker.run({ now: new Date(Date.now() + i * 2000), limit: 10 });
  return {
    code: await issueLoginCode(db, adminId),
    learnerCode: await issueLoginCode(db, learnerId),
    enrollmentId,
  };
});
// Test-only: a workspace for the media pipeline: a release with one verified course visual, a
// scripted video model and a scripted reviewer assistant, budgets and synthetic prices. Nothing
// is generated or contacted; the clip tools are stand-ins.
app.post("/test/media-pipeline-fixture", async () => {
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `media-pipeline-${workspaceId}`,
    "Media pipeline workspace",
  ]);
  for (const [id, role, name] of [
    [adminId, "admin", "Media administrator"],
    [learnerId, "learner", "Storyboard learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `media-pipeline:${id}`, name],
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
  const admin = await login(adminId),
    learner = await login(learnerId);
  const call = async (url: string, payload: unknown, headers = admin) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`Media pipeline fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const course = fixture(),
    visual = toVisualExperience(sortingDemo);
  course.extensions.push({
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
  course.visuals.push(visual);
  course.chapters[0]!.episodes[0]!.blocks.push({
    id: "min-visual",
    type: "visual",
    visualId: visual.id,
  });
  const releaseId = (
    await call(`/api/workspaces/${workspaceId}/releases`, course)
  ).id;
  await call(`/api/releases/${releaseId}/publish`, {});
  const enrollmentId = (await call("/api/enrollments", { releaseId }, learner))
    .id;
  const setup = `/api/admin/workspaces/${workspaceId}/provider-setup`;
  // Every agent role is gated (N07): the owner approves the scripted revisions first.
  await approveRevisionsForTest(
    db,
    workspaceId,
    pipelineConfiguration("video"),
  );
  await call(setup, {
    expectedRevision: 0,
    idempotencyKey: "media-" + randomUUID(),
    configuration: pipelineConfiguration("video"),
    jobPolicy: {
      ...mediaJobPolicy(250_000),
      allowance: { microUsd: 250_000, tokens: 1_000_000 },
    },
    credentials: { [MEDIA_CREDENTIAL]: "synthetic-media-credential" },
  });
  for (const scope of [{}, { enrollmentId }])
    await call(`${setup}/budgets`, {
      expectedRevision: 0,
      idempotencyKey: "media-" + randomUUID(),
      ...scope,
      limits: { microUsd: 5_000_000, tokens: 1_000_000 },
      paidWorkApproved: true,
    });
  await db.query(
    `INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
      effective_from,source_note,created_by) VALUES($1,$2,'assist',1,'active','USD',1000000,4000000,clock_timestamp()-interval '1 minute','Synthetic price',$3)`,
    [randomUUID(), workspaceId, adminId],
  );
  return { code: await issueLoginCode(db, adminId), enrollmentId };
});
// Test-only: one bounded worker pass over every due media job (renders, submissions, polls).
app.post("/test/media-run", async () => {
  const worker = createMediaJobService(
    db,
    workspaceMediaResolver(workspaceProviders),
    mediaOptions,
  );
  for (let i = 0; i < 4; i++)
    await worker.run({ now: new Date(Date.now() + i * 2000), limit: 20 });
  return { ok: true };
});
// Test-only: a workspace with one configured (never contacted) model, one operator price
// version and two settled ledger rows, so pricing and spend views have real data.
// With { scheduled: true } the model also has a later price already saved (as a Core release that
// prefilled a provider's announced change saves it), 60 days from now at midnight UTC.
app.post("/test/pricing-fixture", async (request) => {
  const scheduled =
    (request.body as { scheduled?: boolean } | undefined)?.scheduled === true;
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID(),
    ownerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `pricing-${workspaceId}`,
    "Pricing workspace",
  ]);
  for (const [id, role, name] of [
    [adminId, "admin", "Pricing administrator"],
    [learnerId, "learner", "Priced learner"],
    [ownerId, "owner", "Pricing owner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `pricing:${id}`, name],
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
  const admin = await login(adminId),
    learner = await login(learnerId),
    owner = await login(ownerId);
  const releaseId = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/releases`,
      headers: admin,
      payload: fixture(),
    })
  ).json().id;
  if (
    (
      await app.inject({
        method: "POST",
        url: `/api/releases/${releaseId}/publish`,
        headers: admin,
      })
    ).statusCode !== 200
  )
    throw new Error("Pricing fixture publication failed");
  await ensureCatalog(db, releaseId);
  const enrollmentId = (
    await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: learner,
      payload: { releaseId },
    })
  ).json().id as string;
  const pricingConfiguration = {
    registry: {
      revision: "pricing-fixture",
      models: [
        {
          id: "text-companion",
          providerId: "google-main",
          remoteModel: "public-text-model",
          providerConfig: {
            transport: "generate_content",
            apiVersion: "v1beta",
            maxResponseBytes: 1048576,
          },
          enabled: true,
          capabilities: ["tutoring"],
          tools: [],
          limits: { maxInputCharacters: 30000, maxOutputTokens: 1000 },
        },
      ],
    },
    adapters: [
      { id: "google-main", kind: "google", credentialEnv: "GOOGLE_API_KEY" },
    ],
    roles: {
      companion: {
        modelId: "text-companion",
        maxInputCharacters: 12000,
        maxOutputTokens: 1000,
      },
    },
  };
  // The never-contacted companion revision is accepted through the eval gate's owner override.
  const accepted = await app.inject({
    method: "POST",
    url: `/api/admin/workspaces/${workspaceId}/provider-evals/overrides`,
    headers: owner,
    payload: {
      idempotencyKey: randomUUID(),
      role: "companion",
      revisionDigest: (await roleRevisions(pricingConfiguration)).companion!
        .digest,
      reason: "Pricing fixture: this model is configured but never contacted.",
    },
  });
  if (accepted.statusCode !== 200)
    throw new Error(`Pricing fixture override failed: ${accepted.body}`);
  const configured = await app.inject({
    method: "POST",
    url: `/api/admin/workspaces/${workspaceId}/provider-setup`,
    headers: admin,
    payload: {
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      credentials: {},
      jobPolicy: {
        allowance: { microUsd: 100000, tokens: 1000000 },
        durationMs: 300000,
        timeoutMs: 60000,
        maxAttempts: 3,
      },
      configuration: pricingConfiguration,
    },
  });
  if (configured.statusCode !== 200)
    throw new Error(`Pricing fixture configuration failed: ${configured.body}`);
  const priceId = randomUUID();
  await db.query(
    `INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
      effective_from,source_note,created_by) VALUES($1,$2,'text-companion',1,'active','USD',300000,2500000,clock_timestamp()-interval '1 day','Synthetic fixture price',$3)`,
    [priceId, workspaceId, adminId],
  );
  if (scheduled)
    await db.query(
      `INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
        effective_from,source_note,created_by) VALUES($1,$2,'text-companion',2,'active','USD',400000,2800000,
        date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '60 days','Synthetic announced change',$3)`,
      [randomUUID(), workspaceId, adminId],
    );
  await db.query(
    `INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,model_id,pricing_version_id,state,
      reserved_micro_usd,reserved_tokens,actual_micro_usd,charged_micro_usd,released_micro_usd,settled_at)
    VALUES($1,'supervisor',$2,1,$3,$4,'companion','text-companion',$5,'reconciled',100000,20000,960,960,99040,clock_timestamp()),
      ($6,'supervisor',$7,1,$3,$4,'companion','text-companion',NULL,'uncertain',100000,20000,NULL,100000,0,NULL)`,
    [
      randomUUID(),
      `${randomUUID()}/generate`,
      workspaceId,
      enrollmentId,
      priceId,
      randomUUID(),
      `${randomUUID()}/generate`,
    ],
  );
  return { code: await issueLoginCode(db, adminId), workspaceId };
});
// Test-only: the live companion re-test's held call (finding B-2), with the same shape: a companion
// question whose streamed call got no reply at all, recorded by an older Core as CANCELLED with no
// HTTP status, its whole $0.031410 reservation charged and held. Built through the real bridge and
// ledger; no provider is contacted.
app.post("/test/uncertain-call-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `uncertain-${workspaceId}`,
    "Uncertain call workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Spending owner"],
    [learnerId, "learner", "Held learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `uncertain:${id}`, name],
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
  const post = async (
    url: string,
    payload: unknown,
    headers: Record<string, string>,
  ) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payload as object,
    });
    if (r.statusCode !== 200)
      throw new Error(`Uncertain call fixture ${url} failed: ${r.body}`);
    return r.json();
  };
  const releaseId = (
    await post(`/api/workspaces/${workspaceId}/releases`, fixture(), owner)
  ).id as string;
  await post(`/api/releases/${releaseId}/publish`, {}, owner);
  const enrollmentId = (await post("/api/enrollments", { releaseId }, learner))
    .id as string;
  const messageId = randomUUID();
  await db.query(
    "INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,'learner',$3,$4)",
    [
      messageId,
      enrollmentId,
      "Which classification should I pick?",
      JSON.stringify({ episodeId: "min" }),
    ],
  );
  const asked = await transaction(db, (client) =>
    appendEvent(client, {
      workspaceId,
      enrollmentId,
      actorId: learnerId,
      actorKind: "learner",
      type: "companion.requested",
      payload: { messageId, episodeId: "min", requestKind: "question" },
      idempotencyKey: randomUUID(),
      supervise: true,
    }),
  );
  const bridge = createPostgresSupervisorBridge(db, {
    workspaceIds: [workspaceId],
    jobPolicy: { allowance: { microUsd: 31_410, tokens: 500_000 } },
  });
  await configureSupervisorBudget(
    db,
    { workspaceId },
    { microUsd: 25_000_000, tokens: 100_000_000 },
  );
  const lease = await bridge.claimOutboxEvent(asked.id, randomUUID(), 30_000);
  const [ref] = lease ? await bridge.prepareOutbox(lease) : [];
  if (!ref || !lease || !(await bridge.ackOutbox(lease)))
    throw new Error("Uncertain call fixture job failed");
  await configureSupervisorBudget(
    db,
    { workspaceId, enrollmentId },
    { microUsd: 2_000_000, tokens: 10_000_000 },
  );
  const ownerOfCall = randomUUID();
  const claimed = await bridge.transition({
    type: "claim",
    ref,
    checkpointId: "generate",
    ownerId: ownerOfCall,
    availability: { status: "ready" },
  });
  const operation = claimed.snapshot.operations[0];
  if (claimed.effect !== "invoke" || !operation)
    throw new Error("Uncertain call fixture claim failed");
  await db.query(
    `INSERT INTO provider_dispatches(operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,outcome,provider_usage,failure_code,started_at,sent_at,finished_at)
    VALUES($1,$2,$3,$4,$5,'fixture','uncertain','{"status":"uncertain"}',$6,'CANCELLED',clock_timestamp()-interval '61 seconds',clock_timestamp()-interval '60 seconds',clock_timestamp())`,
    [
      operation.id,
      ref.jobId,
      enrollmentId,
      workspaceId,
      ownerOfCall,
      JSON.stringify({
        attempts: [
          {
            attempt: 1,
            status: null,
            outcome: "unknown",
            tokens: {
              input: null,
              output: null,
              total: null,
              cachedInput: null,
              thoughts: null,
              toolInput: null,
            },
          },
        ],
      }),
    ],
  );
  await bridge.transition({
    type: "settle",
    ref,
    operationId: operation.id,
    ownerId: ownerOfCall,
    outcome: { status: "uncertain" },
  });
  return { code: await issueLoginCode(db, ownerId) };
});
// Test-only: a workspace after a Core upgrade. Its tutor is on, approved by the owner for an older
// set of quality checks, so it now needs a check (it keeps working). The tutor's model is the
// synthetic Gemini model above, with a synthetic key, a synthetic price and a spending limit.
app.post("/test/upgraded-ai-fixture", async () => {
  const workspaceId = randomUUID(),
    adminId = randomUUID(),
    ownerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `upgraded-${workspaceId}`,
    "Upgraded workspace",
  ]);
  for (const [id, role, name] of [
    [adminId, "admin", "Upgrade administrator"],
    [ownerId, "owner", "Upgrade owner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `upgraded:${id}`, name],
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
  const admin = await login(adminId),
    owner = await login(ownerId);
  const releaseId = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/releases`,
      headers: admin,
      payload: fixture(),
    })
  ).json().id;
  if (
    (
      await app.inject({
        method: "POST",
        url: `/api/releases/${releaseId}/publish`,
        headers: admin,
      })
    ).statusCode !== 200
  )
    throw new Error("Upgrade fixture publication failed");
  const catalogId = await ensureCatalog(db, releaseId);
  const configuration = {
    registry: {
      revision: "upgraded-fixture",
      models: [
        {
          id: "text-companion",
          providerId: "google-main",
          remoteModel: "public-text-model",
          providerConfig: {
            transport: "generate_content",
            apiVersion: "v1beta",
            maxResponseBytes: 1048576,
          },
          enabled: true,
          capabilities: ["tutoring"],
          tools: [],
          limits: { maxInputCharacters: 30000, maxOutputTokens: 1000 },
        },
      ],
    },
    adapters: [
      { id: "google-main", kind: "google", credentialEnv: "GOOGLE_API_KEY" },
    ],
    roles: {
      companion: {
        modelId: "text-companion",
        maxInputCharacters: 12000,
        maxOutputTokens: 1000,
      },
    },
  };
  // The key is stored the way the page stores it, with no job on yet (revision 1)...
  const saved = await app.inject({
    method: "POST",
    url: `/api/admin/workspaces/${workspaceId}/provider-setup`,
    headers: owner,
    payload: {
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      credentials: { GOOGLE_API_KEY: "synthetic-upgrade-key" },
      jobPolicy: {
        allowance: { microUsd: 100000, tokens: 1000000 },
        durationMs: 300000,
        timeoutMs: 60000,
        maxAttempts: 3,
      },
      configuration: { ...configuration, roles: {} },
    },
  });
  if (saved.statusCode !== 200)
    throw new Error(`Upgrade fixture setup failed: ${saved.body}`);
  // ...then put in the state an older Core left it: the tutor on, approved for older checks.
  const revision = (await roleRevisions(configuration)).companion!,
    overrideId = randomUUID(),
    oldSuite = "b".repeat(64);
  await db.query(
    `INSERT INTO provider_eval_overrides(id,workspace_id,role,revision_digest,suite_id,suite_digest,reason,actor_id,idempotency_key,request_digest,created_at)
      VALUES($1,$2,'companion',$3,'core-public',$4,'Owner approved the tutor before the upgrade.',$5,$6,$7,now()-interval '30 days')`,
    [
      overrideId,
      workspaceId,
      revision.digest,
      oldSuite,
      ownerId,
      `upgrade:${randomUUID()}`,
      "0".repeat(64),
    ],
  );
  await db.query(
    "UPDATE workspace_provider_versions SET configuration=$2,evaluation=$3 WHERE workspace_id=$1 AND revision=1",
    [
      workspaceId,
      JSON.stringify(configuration),
      JSON.stringify({
        gate: "core.provider-eval-gate/1",
        suiteId: "core-public",
        suiteDigest: oldSuite,
        roles: {
          companion: {
            revisionDigest: revision.digest,
            strategy: revision.strategy,
            decision: "override",
            grandfathered: false,
            overrideId,
          },
        },
      }),
    ],
  );
  await db.query(
    `INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
      effective_from,source_note,created_by) VALUES($1,$2,'text-companion',1,'active','USD',300000,2500000,clock_timestamp()-interval '1 day','Synthetic fixture price',$3)`,
    [randomUUID(), workspaceId, adminId],
  );
  const budgets = (
    await app.inject({
      url: `/api/admin/workspaces/${workspaceId}/provider-setup/budgets`,
      headers: owner,
    })
  ).json();
  const limited = await app.inject({
    method: "POST",
    url: `/api/admin/workspaces/${workspaceId}/provider-setup/budgets`,
    headers: owner,
    payload: {
      expectedRevision: budgets.workspace.revision,
      idempotencyKey: randomUUID(),
      limits: { microUsd: 50_000_000 },
      paidWorkApproved: true,
    },
  });
  if (limited.statusCode !== 200)
    throw new Error(`Upgrade fixture limit failed: ${limited.body}`);
  return {
    catalogId,
    adminCode: await issueLoginCode(db, adminId),
    ownerCode: await issueLoginCode(db, ownerId),
  };
});
// Test-only: a learner mid-lesson (reading, evidence, an open check, a written
// answer awaiting review, a visual) plus an owner and an instructor.
app.post("/test/learner-view-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    instructorId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `view-${workspaceId}`,
    "Learner view workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Viewing owner"],
    [instructorId, "instructor", "Course instructor"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `view:${id}`, name],
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
  const course = rubricCourse(),
    visual = toVisualExperience(sortingDemo);
  course.extensions.push({
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
  course.visuals.push(visual);
  course.chapters[0]!.episodes[0]!.blocks.splice(1, 0, {
    id: "min-visual",
    type: "visual",
    visualId: visual.id,
  });
  const releaseId = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/releases`,
      headers: owner,
      payload: course,
    })
  ).json().id;
  const published = await app.inject({
    method: "POST",
    url: `/api/releases/${releaseId}/publish`,
    headers: owner,
  });
  if (published.statusCode !== 200)
    throw new Error(
      `Learner view fixture publication failed: ${published.body}`,
    );
  const enrollmentId = (
    await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: learner,
      payload: { releaseId },
    })
  ).json().id as string;
  const send = async (action: string, body: Record<string, unknown>) => {
    const revision = (
      await app.inject({
        url: `/api/enrollments/${enrollmentId}`,
        headers: learner,
      })
    ).json().revision;
    const r = await app.inject({
      method: "POST",
      url: `/api/enrollments/${enrollmentId}/${action}`,
      headers: learner,
      payload: {
        expectedRevision: revision,
        idempotencyKey: randomUUID(),
        ...body,
      },
    });
    if (r.statusCode !== 200)
      throw new Error(`Learner view fixture ${action} failed: ${r.body}`);
    return r.json();
  };
  await send("profile", {
    profile: {
      displayName: "Avery Learner",
      goal: "Understand comparisons.",
      pace: "steady",
    },
  });
  await send("read", { episodeId: "min", blockId: "min-text" });
  const choice = await send("challenges", {
    episodeId: "min",
    assessmentId: "min-a",
    mode: "independent",
  });
  await send("answers", { challengeId: choice.challengeId, answer: "two" });
  const written = await send("challenges", {
    episodeId: "min",
    assessmentId: "min-explain",
    mode: "independent",
  });
  await send("answers", {
    challengeId: written.challengeId,
    answer: rubricExplanation,
  });
  await send("challenges", {
    episodeId: "min",
    assessmentId: "min-a",
    mode: "practice",
  });
  await send("companion", {
    episodeId: "min",
    content: "A private question for my companion only.",
  });
  return {
    ownerCode: await issueLoginCode(db, ownerId),
    instructorCode: await issueLoginCode(db, instructorId),
    learnerCode: await issueLoginCode(db, learnerId),
    enrollmentId,
  };
});
// Test-only: what deploy/local/backup.mjs reports after an hourly snapshot and a restore drill.
app.post("/test/backup-reports", async () => {
  await db.query("DELETE FROM platform_backup_reports");
  for (const [kind, minutesAgo, seconds] of [
    ["snapshot", 20, 4],
    ["restore_drill", 90, 75],
  ] as const)
    await db.query(
      `INSERT INTO platform_backup_reports(id,kind,outcome,started_at,finished_at,encrypted,core_version,tables,rows,bytes)
       VALUES($1,$2,'succeeded',clock_timestamp()-make_interval(mins=>$3)-make_interval(secs=>$4),clock_timestamp()-make_interval(mins=>$3),true,'0.1.50',80,1200,2097152)`,
      [randomUUID(), kind, minutesAgo, seconds],
    );
  return { recorded: 2 };
});
// Test-only: a learner on a lesson with a visual, one recorded supervisor run of that lesson (tool
// calls, a stored plan, budgets and client facts), an owner and an instructor.
app.post("/test/inspector-fixture", async () => {
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    instructorId = randomUUID(),
    learnerId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspaceId,
    `inspector-${workspaceId}`,
    "Inspector workspace",
  ]);
  for (const [id, role, name] of [
    [ownerId, "owner", "Inspecting owner"],
    [instructorId, "instructor", "Course instructor"],
    [learnerId, "learner", "Avery Learner"],
  ] as const) {
    await db.query(
      "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
      [id, `inspector:${id}`, name],
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
  const course = fixture(),
    visual = toVisualExperience(sortingDemo);
  course.extensions.push({
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
  course.visuals.push(visual);
  course.chapters[0]!.episodes[0]!.blocks.splice(1, 0, {
    id: "min-visual",
    type: "visual",
    visualId: visual.id,
  });
  const releaseId = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/releases`,
      headers: owner,
      payload: course,
    })
  ).json().id;
  const published = await app.inject({
    method: "POST",
    url: `/api/releases/${releaseId}/publish`,
    headers: owner,
  });
  if (published.statusCode !== 200)
    throw new Error(`Inspector fixture publication failed: ${published.body}`);
  await ensureCatalog(db, releaseId);
  const enrollmentId = (
    await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: learner,
      payload: { releaseId },
    })
  ).json().id as string;
  await recordSyntheticRun(db, {
    workspaceId,
    enrollmentId,
    releaseId,
    learnerId,
    episodeId: "min",
  });
  return {
    ownerCode: await issueLoginCode(db, ownerId),
    instructorCode: await issueLoginCode(db, instructorId),
  };
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
  // Every agent role is gated (N07): the owner approves the scripted revisions first.
  await approveRevisionsForTest(db, workspaceId, mediaConfiguration());
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
      captionsLanguage: "en",
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
