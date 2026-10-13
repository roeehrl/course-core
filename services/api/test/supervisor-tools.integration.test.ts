import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, it, expect } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import type { HostBridge, ProviderRequest } from "@course-core/supervisor";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import {
  configureSupervisorBudget,
  createPostgresSupervisorBridge,
  resolveSupervisorOperation,
  storeSupervisorArtifact,
} from "../src/supervisor-bridge.js";
import { teachingContext } from "../src/provider-context.js";
import { supervisorTools } from "../src/supervisor-tools.js";
import { composeProviders } from "../src/provider-composition.js";
import { supervisorGeneratedTeachingFixture } from "./generated-teaching-fixture.js";
import { readLearnerModel } from "../src/learner-model.js";

const schema = "supervisor_tools_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  token = randomUUID(),
  fixture = supervisorGeneratedTeachingFixture();
let db: Database,
  admin: Database,
  app: Awaited<ReturnType<typeof createServer>>,
  bridge: HostBridge,
  owner: { id: string; cookie: string; csrf: string },
  releaseId: string,
  calls = 0;
const usage: UsageReceipt = {
  accounting: { accountingKey: "synthetic" },
  providerId: "test",
  modelId: "planner",
  operation: "assess",
  attempts: [
    {
      attempt: 1,
      status: 200,
      outcome: "response",
      tokens: {
        input: 10,
        output: 20,
        total: 30,
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
const adapter: ProviderAdapter = {
  providerId: "test",
  validateModel() {},
  ports: {
    structured_assessment: {
      async assess(req) {
        calls++;
        const count = Number(req.accounting.accountingKey.split(":round-")[1]);
        const scripted = modelScripts.get(
          req.accounting.accountingKey.split(":round-")[0]!,
        );
        if (scripted)
          return {
            usage,
            output: scripted(count, JSON.parse(req.messages[0]!.text)),
          };
        return {
          usage,
          output:
            count === 0
              ? {
                  decision: "tool",
                  tool: "list_support",
                  argumentsJson: "{}",
                  summary: "",
                }
              : count === 1
                ? {
                    decision: "tool",
                    tool: "choose_support",
                    argumentsJson: JSON.stringify({
                      profileId: "ordering-support-profile",
                      entryId: "number-line-support",
                    }),
                    summary: "",
                  }
                : {
                    decision: "finish",
                    tool: "none",
                    argumentsJson: "{}",
                    summary: "Use the reviewed number-line explanation.",
                  },
        };
      },
    },
  },
};
const modelScripts = new Map<string, (round: number, prompt: any) => any>();
const jobPolicy = { allowance: { microUsd: 100000, tokens: 600000 } };
const headers = (s: { cookie: string; csrf: string }) => ({
  cookie: s.cookie,
  origin,
  "x-csrf-token": s.csrf,
});
async function login(role = "learner") {
  const id = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [id, "test:" + id, "Scoped learner"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [workspace, id, role],
  );
  const r = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, id) },
  });
  expect(r.statusCode, r.body).toBe(200);
  return {
    id,
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    csrf: r.json().csrfToken,
  };
}
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
    throw Error("Disposable TEST_DATABASE_URL required");
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error("Disposable loopback database required");
  admin = createDatabase(url.href);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  const providers = composeProviders(
    {
      registry: {
        revision: "tools-test",
        models: [
          {
            id: "planner",
            providerId: "test",
            remoteModel: "planner",
            providerConfig: {},
            enabled: true,
            capabilities: ["structured_assessment"],
            limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 },
          },
        ],
      },
      adapters: [
        {
          id: "test",
          kind: "test",
          credentialEnv: "COURSE_PROVIDER_TEST_API_KEY",
        },
      ],
      roles: {
        supervisor: {
          modelId: "planner",
          maxInputCharacters: 30000,
          maxOutputTokens: 1000,
          maxToolRounds: 4,
        },
      },
    },
    () => "synthetic",
    { test: () => adapter },
  );
  app = await createServer(db, {
    origin,
    secureCookies: false,
    adaptation: fixture.runtime,
    providers,
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy },
  });
  bridge = createPostgresSupervisorBridge(db, {
    workspaceIds: [workspace],
    jobPolicy,
  });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspace,
    "tools",
    "Public tool qualification",
  ]);
  owner = await login("owner");
  const imported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace}/releases`,
    headers: headers(owner),
    payload: fixture.course,
  });
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  const publish = await app.inject({
    method: "POST",
    url: `/api/releases/${releaseId}/publish`,
    headers: headers(owner),
  });
  expect(publish.statusCode, publish.body).toBe(200);
  const approved = await app.inject({
    method: "POST",
    url: `/api/admin/releases/${releaseId}/adaptation-registry`,
    headers: headers(owner),
    payload: { expectedRegistryRevision: 0, configuration: fixture.config },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  await configureSupervisorBudget(
    db,
    { workspaceId: workspace },
    { microUsd: 10000000, tokens: 10000000 },
  );
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
async function prepare(
  consent = true,
  independent = false,
  explanationStyle?: string,
) {
  const learner = await login(),
    enrolled = await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: headers(learner),
      payload: { releaseId },
    });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id;
  const snapshot = async () => {
    const r = await app.inject({
      url: `/api/enrollments/${id}`,
      headers: headers(learner),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const setting = await app.inject({
    method: "POST",
    url: `/api/enrollments/${id}/supervision`,
    headers: headers(learner),
    payload: {
      expectedRevision: (await snapshot()).revision,
      idempotencyKey: randomUUID(),
      adaptiveTeaching: consent,
    },
  });
  expect(setting.statusCode, setting.body).toBe(200);
  if (explanationStyle) {
    const saved = await app.inject({
      method: "POST",
      url: `/api/enrollments/${id}/learner-model/profile`,
      headers: headers(learner),
      payload: {
        expectedRevision: (await snapshot()).revision,
        idempotencyKey: randomUUID(),
        profile: {
          preferences: { explanationStyle },
          priorKnowledge: [],
          thoughts: "",
        },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  if (independent) {
    const challenge = await app.inject({
      method: "POST",
      url: `/api/enrollments/${id}/challenges`,
      headers: headers(learner),
      payload: {
        expectedRevision: (await snapshot()).revision,
        idempotencyKey: randomUUID(),
        episodeId: "min",
        mode: "independent",
      },
    });
    expect(challenge.statusCode, challenge.body).toBe(200);
  }
  await configureSupervisorBudget(
    db,
    { workspaceId: workspace, enrollmentId: id },
    { microUsd: 1000000, tokens: 1000000 },
  );
  const event = await transaction(db, (client) =>
    appendEvent(client, {
      workspaceId: workspace,
      enrollmentId: id,
      actorId: learner.id,
      actorKind: "learner",
      type: "learning.review_requested",
      payload: { episodeId: "min" },
      idempotencyKey: randomUUID(),
      supervise: true,
    }),
  );
  const outbox = (await bridge.claimOutbox(randomUUID(), 100, 30000)).find(
    (e) => e.eventId === event.id,
  )!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({
    type: "claim",
    ref: ref!,
    checkpointId: "generate",
    ownerId: randomUUID(),
    availability: { status: "ready" },
  });
  expect(claim.effect).toBe("invoke");
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = {
    schemaVersion: 1,
    operationId: operation.id,
    job: claim.snapshot.specification.key,
    role: "supervisor",
    checkpoint: claim.snapshot.specification.checkpoints[0]!,
    fence: claim.snapshot.specification.fence,
  };
  return { learner, id, ref: ref!, request, operation, snapshot };
}
async function invoke(job: Awaited<ReturnType<typeof prepare>>) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/operations",
    headers: {
      authorization: "Bearer " + token,
      "idempotency-key": job.request.operationId,
    },
    payload: job.request,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().status).toBe("succeeded");
  await bridge.transition({
    type: "settle",
    ref: job.ref,
    operationId: job.operation.id,
    ownerId: job.operation.ownerId,
    outcome: r.json(),
  });
  return r.json();
}
const transition = (command: unknown) =>
  app.inject({
    method: "POST",
    url: "/v1/supervisor/bridge",
    headers: { authorization: "Bearer " + token },
    payload: { method: "transition", command },
  });
async function modelSource(
  job: Awaited<ReturnType<typeof prepare>>,
  actorKind: "learner" | "agent" = "learner",
) {
  return transaction(db, (client) =>
    appendEvent(client, {
      workspaceId: workspace,
      enrollmentId: job.id,
      actorId: job.learner.id,
      actorKind,
      type: "block.read",
      payload: { episodeId: "min", blockId: "public-example" },
      idempotencyKey: randomUUID(),
      supervise: false,
    }),
  );
}
function modelScript(job: Awaited<ReturnType<typeof prepare>>) {
  modelScripts.set(
    createHash("sha256").update(job.request.operationId).digest("hex"),
    (round, prompt) =>
      round === 0
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
              summary:
                "Propose a source-linked explanation preference for learner review.",
            },
  );
}
async function readModel(job: Awaited<ReturnType<typeof prepare>>) {
  const r = await app.inject({
    url: `/api/enrollments/${job.id}/learner-model?episodeId=min`,
    headers: headers(job.learner),
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
it("the supervisor produces exactly one pending source-linked model suggestion and the learner controls its use", async () => {
  const job = await prepare(),
    source = await modelSource(job),
    before = await job.snapshot(),
    preferences = (await readModel(job)).selfReport.preferences;
  modelScript(job);
  await invoke(job);
  expect((await readModel(job)).suggestions.items).toEqual([]);
  const verified = await transition({ type: "verify", ref: job.ref });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(verified.json().snapshot.state).toBe("ready");
  const applied = await transition({ type: "apply", ref: job.ref });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().snapshot.state).toBe("applied");
  const model = await readModel(job);
  expect(model.suggestions.items).toHaveLength(1);
  const proposal = model.suggestions.items[0];
  expect(proposal).toMatchObject({
    status: "pending",
    suggestion: { kind: "explanation_style", value: "step_by_step" },
    grantsMastery: false,
  });
  expect(proposal.sourceEventRefs[0].eventId).toBe(source.id);
  expect(model.selfReport.preferences).toEqual(preferences);
  expect((await job.snapshot()).lessons[0].gate).toEqual(
    before.lessons[0].gate,
  );
  const timeline = await app.inject({
    url: `/api/enrollments/${job.id}/supervision/tools`,
    headers: headers(job.learner),
  });
  expect(timeline.statusCode, timeline.body).toBe(200);
  expect(
    timeline.json().calls.find((c: any) => c.tool === "suggest_model").outcome
      .delivery,
  ).toBe("pending_learner_review");
  const providerContext = await readLearnerModel(
    db,
    { id: job.learner.id, displayName: "Learner" },
    { workspaceId: workspace, enrollmentId: job.id, episodeId: "min" },
  );
  expect(providerContext.suggestions.items).toEqual([]);
}, 30000);
it("source-linked suggestions survive duplicate apply without granting evidence or creating a supervisor feedback loop", async () => {
  const job = await prepare();
  await modelSource(job);
  modelScript(job);
  await invoke(job);
  await transition({ type: "verify", ref: job.ref });
  const first = await transition({ type: "apply", ref: job.ref }),
    second = await transition({ type: "apply", ref: job.ref });
  expect(first.statusCode, first.body).toBe(200);
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json().snapshot.applicationReceiptId).toBe(
    first.json().snapshot.applicationReceiptId,
  );
  expect(
    (
      await db.query(
        "SELECT count(*) FROM learner_model_proposals WHERE enrollment_id=$1",
        [job.id],
      )
    ).rows[0].count,
  ).toBe("1");
  expect(
    (
      await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
        job.id,
      ])
    ).rows[0].count,
  ).toBe("0");
  expect(
    (
      await db.query(
        "SELECT count(*) FROM outbox o JOIN learning_events e ON e.id=o.event_id WHERE e.enrollment_id=$1 AND e.event_type='learner_model.proposal.created' AND o.kind='supervisor.event'",
        [job.id],
      )
    ).rows[0].count,
  ).toBe("0");
  const pending = (await readModel(job)).suggestions.items[0];
  const correction = await app.inject({
    method: "POST",
    url: `/api/enrollments/${job.id}/learner-model/proposals/${pending.proposalId}/decision`,
    headers: headers(job.learner),
    payload: {
      expectedRevision: (await job.snapshot()).revision,
      idempotencyKey: randomUUID(),
      action: "correct",
      correction: { kind: "explanation_style", value: "worked_example" },
    },
  });
  expect(correction.statusCode, correction.body).toBe(200);
  expect((await readModel(job)).suggestions.items[0]).toMatchObject({
    status: "corrected",
    suggestion: { kind: "explanation_style", value: "worked_example" },
    grantsMastery: false,
  });
  const context = await readLearnerModel(
    db,
    { id: job.learner.id, displayName: "Learner" },
    { workspaceId: workspace, enrollmentId: job.id, episodeId: "min" },
  );
  expect(context.suggestions.items[0]).toMatchObject({
    status: "corrected",
    suggestion: { kind: "explanation_style", value: "worked_example" },
  });
  const timeline = await app.inject({
    url: `/api/enrollments/${job.id}/supervision/tools`,
    headers: headers(job.learner),
  });
  expect(
    timeline.json().calls.find((c: any) => c.tool === "suggest_model").outcome
      .delivery,
  ).toBe("learner_corrected");
  for (const action of ["dispute", "accept"]) {
    const review = await app.inject({
      method: "POST",
      url: `/api/enrollments/${job.id}/learner-model/proposals/${pending.proposalId}/decision`,
      headers: headers(job.learner),
      payload: {
        expectedRevision: (await job.snapshot()).revision,
        idempotencyKey: randomUUID(),
        action,
      },
    });
    expect(review.statusCode, review.body).toBe(200);
    expect((await readModel(job)).suggestions.items[0].suggestion).toEqual({
      kind: "explanation_style",
      value: "worked_example",
    });
    const current = await readLearnerModel(
      db,
      { id: job.learner.id, displayName: "Learner" },
      { workspaceId: workspace, enrollmentId: job.id, episodeId: "min" },
    );
    expect(current.suggestions.items).toHaveLength(
      action === "dispute" ? 0 : 1,
    );
    if (action === "accept")
      expect(current.suggestions.items[0].suggestion).toEqual({
        kind: "explanation_style",
        value: "worked_example",
      });
  }
}, 30000);
it("source changes after staging reject verification and source changes after review roll back application", async () => {
  for (const afterVerification of [false, true]) {
    const job = await prepare(),
      source = await modelSource(job);
    modelScript(job);
    await invoke(job);
    if (afterVerification)
      expect(
        (await transition({ type: "verify", ref: job.ref })).json().snapshot
          .state,
      ).toBe("ready");
    await db.query(
      "UPDATE learning_events SET payload=payload||'{\"changed\":true}'::jsonb WHERE id=$1",
      [source.id],
    );
    const result = afterVerification
      ? await transition({ type: "apply", ref: job.ref })
      : await transition({ type: "verify", ref: job.ref });
    if (afterVerification) {
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json().error).toBe("MODEL_SOURCE_CHANGED");
    } else {
      expect(result.json().snapshot.state).toBe("failed");
      expect(
        (
          await db.query(
            "SELECT verdict FROM supervisor_verifications WHERE job_id=$1",
            [job.ref.jobId],
          )
        ).rows[0].verdict,
      ).toBe("rejected");
    }
    expect((await readModel(job)).suggestions.items).toEqual([]);
  }
}, 30000);
it("model tools reject unobserved or another learner sources, forged knowledge fields and missing consent", async () => {
  const one = await prepare(),
    two = await prepare(),
    own = await modelSource(one),
    foreign = await modelSource(two),
    tools = await scopedTools(one);
  await expect(
    tools.invoke(
      "suggest_model",
      {
        suggestion: { kind: "pace", value: "gentle" },
        sourceEventIds: [own.id],
      },
      0,
    ),
  ).rejects.toMatchObject({ code: "MODEL_SOURCE_NOT_RETRIEVED" });
  await tools.invoke("get_model_sources", {}, 0);
  await expect(
    tools.invoke(
      "suggest_model",
      {
        suggestion: { kind: "pace", value: "gentle" },
        sourceEventIds: [foreign.id],
      },
      1,
    ),
  ).rejects.toMatchObject({ code: "SOURCE_EVENT_OUT_OF_SCOPE" });
  await expect(
    tools.invoke(
      "suggest_model",
      {
        suggestion: { kind: "knowledge", mastered: true },
        sourceEventIds: [own.id],
      },
      1,
    ),
  ).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  const denied = await prepare(false),
    source = await modelSource(denied),
    deniedTools = await scopedTools(denied);
  await deniedTools.invoke("get_model_sources", {}, 0);
  await expect(
    deniedTools.invoke(
      "suggest_model",
      {
        suggestion: { kind: "pace", value: "gentle" },
        sourceEventIds: [source.id],
      },
      1,
    ),
  ).rejects.toMatchObject({ code: "SUPERVISION_CONSENT_REQUIRED" });
});
it("learner manual preferences stay authoritative after accepting an AI suggestion, and disputed suggestions leave provider context", async () => {
  const job = await prepare(true, false, "concise");
  await modelSource(job);
  modelScript(job);
  await invoke(job);
  await transition({ type: "verify", ref: job.ref });
  await transition({ type: "apply", ref: job.ref });
  const proposal = (await readModel(job)).suggestions.items[0];
  for (const action of ["accept", "dispute"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/enrollments/${job.id}/learner-model/proposals/${proposal.proposalId}/decision`,
      headers: headers(job.learner),
      payload: {
        expectedRevision: (await job.snapshot()).revision,
        idempotencyKey: randomUUID(),
        action,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const context = await readLearnerModel(
      db,
      { id: job.learner.id, displayName: "Learner" },
      { workspaceId: workspace, enrollmentId: job.id, episodeId: "min" },
    );
    expect(context.selfReport.preferences.explanationStyle).toBe("concise");
    expect(context.suggestions.items).toHaveLength(action === "accept" ? 1 : 0);
  }
  expect(
    (
      await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
        job.id,
      ])
    ).rows[0].count,
  ).toBe("0");
});
it("an active independent check and revoked opt-in prevent model suggestion delivery", async () => {
  const independent = await prepare(true, true),
    source = await modelSource(independent),
    tools = await scopedTools(independent);
  await tools.invoke("get_model_sources", {}, 0);
  await expect(
    tools.invoke(
      "suggest_model",
      {
        suggestion: { kind: "pace", value: "gentle" },
        sourceEventIds: [source.id],
      },
      1,
    ),
  ).rejects.toMatchObject({ code: "INDEPENDENT_ASSESSMENT_ACTIVE" });
  const job = await prepare();
  await modelSource(job);
  modelScript(job);
  await invoke(job);
  expect(
    (await transition({ type: "verify", ref: job.ref })).json().snapshot.state,
  ).toBe("ready");
  const revoked = await app.inject({
    method: "POST",
    url: `/api/enrollments/${job.id}/supervision`,
    headers: headers(job.learner),
    payload: {
      expectedRevision: (await job.snapshot()).revision,
      idempotencyKey: randomUUID(),
      adaptiveTeaching: false,
    },
  });
  expect(revoked.statusCode, revoked.body).toBe(200);
  const applied = await transition({ type: "apply", ref: job.ref });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().snapshot.state).not.toBe("applied");
  expect((await readModel(job)).suggestions.items).toEqual([]);
});
it("real tools, separate verification and atomic application actually change the lesson without granting mastery", async () => {
  const job = await prepare(),
    before = await job.snapshot(),
    count = calls;
  const outcome = await invoke(job);
  expect(calls - count).toBe(3);
  expect(outcome.usage.tokens).toBe(90);
  expect((await job.snapshot()).planRevision).toBe(0);
  const verified = await transition({ type: "verify", ref: job.ref });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(verified.json().snapshot.state).toBe("ready");
  const applied = await transition({ type: "apply", ref: job.ref });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().snapshot.state).toBe("applied");
  const after = await job.snapshot();
  expect(after.planRevision).toBe(1);
  expect(
    after.course.chapters[0].episodes[0].blocks.some(
      (b: any) => b.type === "text" && b.markdown === fixture.markdown,
    ),
  ).toBe(true);
  expect(after.lessons[0].gate).toEqual(before.lessons[0].gate);
  expect(
    (
      await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
        job.id,
      ])
    ).rows[0].count,
  ).toBe("0");
  const replay = await transition({ type: "apply", ref: job.ref });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().snapshot.applicationReceiptId).toBe(
    applied.json().snapshot.applicationReceiptId,
  );
  expect(
    (
      await db.query(
        "SELECT count(*) FROM supervisor_plan_effects WHERE enrollment_id=$1",
        [job.id],
      )
    ).rows[0].count,
  ).toBe("1");
  const catalog = (
    await db.query(
      "SELECT id FROM admin_course_catalog WHERE workspace_id=$1",
      [workspace],
    )
  ).rows[0];
  const inspector = await app.inject({
    url: `/api/admin/courses/${catalog.id}/runs/${job.ref.jobId}`,
    headers: headers(owner),
  });
  expect(inspector.statusCode, inspector.body).toBe(200);
  expect(inspector.json().toolCalls).toBe(2);
  expect(inspector.json().providerAttempts).toBe(3);
  expect(
    inspector.json().decisions.some((d: any) => d.tool === "choose_support"),
  ).toBe(true);
  expect(inspector.body).not.toContain(fixture.markdown);
  const timeline = await app.inject({
    url: `/api/enrollments/${job.id}/supervision/tools`,
    headers: headers(job.learner),
  });
  expect(timeline.statusCode, timeline.body).toBe(200);
  expect(timeline.json().calls).toHaveLength(2);
  expect(
    timeline.json().calls.find((c: any) => c.tool === "choose_support"),
  ).toMatchObject({
    jobState: "applied",
    appliedPlanRevision: 1,
    outcome: { delivery: "applied" },
  });
  expect(timeline.body).not.toContain(fixture.markdown);
  const events = (
    await db.query(
      "SELECT actor_kind FROM learning_events WHERE enrollment_id=$1 AND event_type='adaptation.applied'",
      [job.id],
    )
  ).rows;
  expect(events).toEqual([{ actor_kind: "agent" }]);
}, 30000);
it("lack of learner opt-in prevents a model from selecting or delivering support", async () => {
  const job = await prepare(false);
  await invoke(job);
  const verify = await transition({ type: "verify", ref: job.ref });
  expect(verify.statusCode, verify.body).toBe(200);
  const applied = await transition({ type: "apply", ref: job.ref });
  expect(applied.statusCode, applied.body).toBe(200);
  expect((await job.snapshot()).planRevision).toBe(0);
  expect(
    (
      await db.query(
        "SELECT count(*) FROM supervisor_plan_effects WHERE enrollment_id=$1",
        [job.id],
      )
    ).rows[0].count,
  ).toBe("0");
});
it("learner permission changes fence a ready job; staff cannot manufacture learner consent", async () => {
  const job = await prepare();
  await invoke(job);
  expect(
    (await transition({ type: "verify", ref: job.ref })).json().snapshot.state,
  ).toBe("ready");
  const before = await job.snapshot(),
    denied = await app.inject({
      method: "POST",
      url: `/api/enrollments/${job.id}/supervision`,
      headers: headers(owner),
      payload: {
        expectedRevision: before.revision,
        idempotencyKey: randomUUID(),
        adaptiveTeaching: true,
      },
    });
  expect([403, 404]).toContain(denied.statusCode);
  const revoked = await app.inject({
    method: "POST",
    url: `/api/enrollments/${job.id}/supervision`,
    headers: headers(job.learner),
    payload: {
      expectedRevision: before.revision,
      idempotencyKey: randomUUID(),
      adaptiveTeaching: false,
    },
  });
  expect(revoked.statusCode, revoked.body).toBe(200);
  const stale = await transition({ type: "apply", ref: job.ref });
  expect(stale.json().snapshot.state).not.toBe("applied");
  expect((await job.snapshot()).planRevision).toBe(0);
});

async function scopedTools(
  job: Awaited<ReturnType<typeof prepare>>,
  generated = false,
) {
  const resolved = await resolveSupervisorOperation(db, job.request);
  return supervisorTools(
    db,
    job.request,
    await teachingContext(db, resolved.ref, resolved.input.context),
    ...(generated ? [fixture.runtime] : []),
  );
}
it("scopes history and timeline reads, rejects injected authority, and deduplicates simultaneous tool retries", async () => {
  const job = await prepare(),
    other = await prepare(),
    tools = await scopedTools(job),
    foreignId = randomUUID();
  await db.query(
    "INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,'learner','FOREIGN_HISTORY_CANARY',$3)",
    [foreignId, other.id, JSON.stringify({ episodeId: "min" })],
  );
  // All eight fall within one JS millisecond: a rounded Date cursor skips rows.
  for (let i = 0; i < 8; i++)
    await db.query(
      "INSERT INTO companion_messages(id,enrollment_id,role,content,context,created_at) VALUES($1,$2,'learner',$3,$4,$5)",
      [
        randomUUID(),
        job.id,
        "Own retained message " + i,
        JSON.stringify({ episodeId: "min" }),
        `2026-01-01T00:00:00.12300${i}Z`,
      ],
    );
  await expect(
    tools.invoke("get_history", { beforeMessageId: foreignId }, 0),
  ).rejects.toMatchObject({ code: "SUPERVISOR_HISTORY_SCOPE" });
  await expect(
    tools.invoke("get_profile", { userId: other.learner.id }, 0),
  ).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  const [first, replay] = await Promise.all([
    tools.invoke("get_history", {}, 0),
    tools.invoke("get_history", {}, 0),
  ]);
  expect(first).toEqual(replay);
  expect(JSON.stringify(first)).not.toContain("FOREIGN_HISTORY_CANARY");
  const page = first.result as any;
  expect(page.messages).toHaveLength(5);
  expect(page.beforeMessageId).toBeTruthy();
  const next = await tools.invoke(
    "get_history",
    { beforeMessageId: page.beforeMessageId },
    1,
  );
  expect((next.result as any).messages).toHaveLength(3);
  expect((next.result as any).beforeMessageId).toBeNull();
  const ownIds = page.messages.map((m: any) => m.id);
  expect(
    (next.result as any).messages.every((m: any) => !ownIds.includes(m.id)),
  ).toBe(true);
  await expect(tools.invoke("get_profile", {}, 0)).rejects.toMatchObject({
    code: "SUPERVISOR_TOOL_CONFLICT",
  });
  expect(
    (
      await db.query(
        "SELECT count(*) FROM supervisor_tool_calls WHERE job_id=$1",
        [job.ref.jobId],
      )
    ).rows[0].count,
  ).toBe("2");
  for (const path of ["supervision", "supervision/tools"]) {
    const denied = await app.inject({
      url: `/api/enrollments/${job.id}/${path}`,
      headers: headers(other.learner),
    });
    expect([403, 404]).toContain(denied.statusCode);
  }
  const unauth = await app.inject({
    url: `/api/enrollments/${job.id}/supervision/tools`,
  });
  expect(unauth.statusCode).toBe(401);
});
it("never delivers reviewed teaching during an active independent check", async () => {
  const job = await prepare(true, true);
  await invoke(job);
  const verified = await transition({ type: "verify", ref: job.ref });
  expect(verified.statusCode, verified.body).toBe(200);
  const applied = await transition({ type: "apply", ref: job.ref });
  expect(applied.statusCode, applied.body).toBe(200);
  expect((await job.snapshot()).planRevision).toBe(0);
  const calls = (
    await db.query(
      "SELECT outcome FROM supervisor_tool_calls WHERE job_id=$1",
      [job.ref.jobId],
    )
  ).rows;
  expect(calls).toHaveLength(2);
  expect(
    calls.every(
      (c) => c.outcome.result.reason === "independent_assessment_active",
    ),
  ).toBe(true);
  expect(
    (
      await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
        job.id,
      ])
    ).rows[0].count,
  ).toBe("0");
});
it("separate verifier rejects another learners actual receipt even when the artifact has a valid host digest", async () => {
  const foreign = await prepare(),
    foreignTools = await scopedTools(foreign),
    selected = await foreignTools.invoke(
      "choose_support",
      { profileId: "ordering-support-profile", entryId: "number-line-support" },
      0,
    );
  const job = await prepare(),
    artifact = await storeSupervisorArtifact(
      db,
      job.ref,
      job.operation.id,
      job.operation.ownerId,
      {
        kind: "supervised_plan",
        summary: "Forged scope attempt.",
        selection: selected.selection!,
        toolCallRefs: [selected.receiptId],
      },
    );
  await bridge.transition({
    type: "settle",
    ref: job.ref,
    operationId: job.operation.id,
    ownerId: job.operation.ownerId,
    outcome: {
      status: "succeeded",
      artifact,
      usage: { microUsd: 0, tokens: 0 },
    },
  });
  const verification = await transition({ type: "verify", ref: job.ref });
  expect(verification.statusCode, verification.body).toBe(200);
  expect(verification.json().snapshot.state).not.toBe("ready");
  const row = (
    await db.query(
      "SELECT verdict FROM supervisor_verifications WHERE job_id=$1",
      [job.ref.jobId],
    )
  ).rows;
  expect(row).toEqual([{ verdict: "rejected" }]);
  expect((await job.snapshot()).planRevision).toBe(0);
});

function generatedScript(
  job: Awaited<ReturnType<typeof prepare>>,
  markdown: string,
) {
  modelScripts.set(
    createHash("sha256").update(job.request.operationId).digest("hex"),
    (round) =>
      round === 0
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
                markdown,
                objectiveIds: ["minimum"],
                sourceRefs: [fixture.source],
              }),
              summary: "",
            }
          : {
              decision: "finish",
              tool: "none",
              argumentsJson: "{}",
              summary:
                "A new worked example needs independent reference verification before delivery.",
            },
  );
}
it("verification is repeated at commit and a newly failing reference rolls back all teaching writes", async () => {
  const job = await prepare();
  generatedScript(job, "Minimum of [5, -2, 8] is -2.");
  await invoke(job);
  const verified = await transition({ type: "verify", ref: job.ref });
  expect(verified.json().snapshot.state).toBe("ready");
  fixture.stats.reject = true;
  try {
    const denied = await transition({ type: "apply", ref: job.ref });
    expect(denied.statusCode, denied.body).toBe(409);
    expect(denied.json().error).toBe("ADAPTATION_VERIFICATION_FAILED");
    expect((await job.snapshot()).planRevision).toBe(0);
    for (const table of [
      "adaptation_proposals",
      "adaptation_artifacts",
      "supervisor_applications",
    ])
      expect(
        (
          await db.query(
            `SELECT count(*) FROM ${table} WHERE enrollment_id=$1`,
            [job.id],
          )
        ).rows[0].count,
      ).toBe("0");
  } finally {
    fixture.stats.reject = false;
  }
});
it("new generated examples pass a real independent reference and reach the lesson once, consuming the approved work only", async () => {
  for (const markdown of [
    "Minimum of [15, -8, 3] is -8.",
    "Minimum of [0, 0, 12, -1] is -1.",
  ]) {
    const job = await prepare(),
      before = await job.snapshot(),
      checks = fixture.stats.verifications;
    generatedScript(job, markdown);
    await invoke(job);
    expect(fixture.stats.verifications).toBe(checks);
    expect((await job.snapshot()).planRevision).toBe(0);
    const verified = await transition({ type: "verify", ref: job.ref });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().snapshot.state).toBe("ready");
    expect(fixture.stats.verifications).toBe(checks + 1);
    const applied = await transition({ type: "apply", ref: job.ref });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().snapshot.state).toBe("applied");
    expect(fixture.stats.verifications).toBe(checks + 2);
    const timeline = await app.inject({
      url: `/api/enrollments/${job.id}/supervision/tools`,
      headers: headers(job.learner),
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    expect(
      timeline.json().calls.find((c: any) => c.tool === "create_teaching"),
    ).toMatchObject({
      appliedPlanRevision: 1,
      outcome: {
        selected: true,
        profileId: "generated-ordering-profile",
        delivery: "applied",
      },
    });
    expect(
      timeline
        .json()
        .calls.find((c: any) => c.tool === "list_generation_profiles")
        .appliedPlanRevision,
    ).toBeNull();
    expect(timeline.body).not.toContain(markdown);
    const catalog = (
      await db.query(
        "SELECT id FROM admin_course_catalog WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0];
    const inspector = await app.inject({
      url: `/api/admin/courses/${catalog.id}/runs/${job.ref.jobId}`,
      headers: headers(owner),
    });
    expect(inspector.statusCode, inspector.body).toBe(200);
    expect(
      inspector.json().decisions.find((d: any) => d.tool === "create_teaching")
        .explanation,
    ).toContain("plan revision 1");
    expect(inspector.body).not.toContain(markdown);
    const after = await job.snapshot();
    expect(
      after.course.chapters[0].episodes[0].blocks.filter(
        (b: any) => b.type === "text" && b.markdown === markdown,
      ),
    ).toHaveLength(1);
    expect(after.lessons[0].gate).toEqual(before.lessons[0].gate);
    expect(
      (
        await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
          job.id,
        ])
      ).rows[0].count,
    ).toBe("0");
    const assignments = (
      await db.query(
        "SELECT assignments FROM adaptation_proposals WHERE enrollment_id=$1",
        [job.id],
      )
    ).rows;
    expect(assignments).toHaveLength(1);
    expect(assignments[0].assignments).toEqual([
      expect.objectContaining({
        plannedMinutes: 3,
        additionalEpisodes: 0,
        classification: "required",
        authority: "server",
      }),
    ]);
    const replay = await transition({ type: "apply", ref: job.ref });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().snapshot.applicationReceiptId).toBe(
      applied.json().snapshot.applicationReceiptId,
    );
    expect(fixture.stats.verifications).toBe(checks + 2);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM supervisor_plan_effects WHERE enrollment_id=$1",
          [job.id],
        )
      ).rows[0].count,
    ).toBe("1");
  }
}, 30000);
it("wrong generated calculations and appended unsupported claims cannot become ready or change the course", async () => {
  for (const markdown of [
    "Minimum of [15, -8, 3] is 3.",
    "Minimum of [15, -8, 3] is -9.",
    "Minimum of [15, -8, 3] is -8. You have now mastered ordering.",
  ]) {
    const job = await prepare();
    generatedScript(job, markdown);
    await invoke(job);
    const verified = await transition({ type: "verify", ref: job.ref });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().snapshot.state).not.toBe("ready");
    expect(
      (
        await db.query(
          "SELECT verdict FROM supervisor_verifications WHERE job_id=$1",
          [job.ref.jobId],
        )
      ).rows,
    ).toEqual([{ verdict: "rejected" }]);
    expect((await job.snapshot()).planRevision).toBe(0);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM adaptation_proposals WHERE enrollment_id=$1",
          [job.id],
        )
      ).rows[0].count,
    ).toBe("0");
  }
}, 30000);
it("generation tools require observed installed profiles and reject injected grading, proof, costs and out-of-scope sources", async () => {
  const job = await prepare(),
    tools = await scopedTools(job, true);
  const candidate = {
    profileId: "generated-ordering-profile",
    kind: "explanation",
    markdown: "Minimum of [7, 2] is 2.",
    objectiveIds: ["minimum"],
    sourceRefs: [fixture.source],
  };
  await expect(
    tools.invoke("create_teaching", candidate, 0),
  ).rejects.toMatchObject({ code: "GENERATION_PROFILE_NOT_OBSERVED" });
  await tools.invoke("list_generation_profiles", {}, 0);
  for (const forbidden of [
    { grading: { expected: 2 } },
    { proofReceipts: [] },
    { plannedMinutes: 0 },
    { generator: { id: "forged", version: "1" } },
  ])
    await expect(
      tools.invoke("create_teaching", { ...candidate, ...forbidden }, 1),
    ).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  await expect(
    tools.invoke(
      "create_teaching",
      { ...candidate, sourceRefs: ["unknown-source"] },
      1,
    ),
  ).rejects.toMatchObject({ code: "GENERATED_TEACHING_SCOPE" });
  await expect(
    tools.invoke(
      "create_teaching",
      { ...candidate, objectiveIds: ["other-objective"] },
      1,
    ),
  ).rejects.toMatchObject({ code: "GENERATED_TEACHING_SCOPE" });
  const receipts = await Promise.all([
    tools.invoke("create_teaching", candidate, 1),
    tools.invoke("create_teaching", candidate, 1),
  ]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(receipts[0].generatedTeaching?.artifact.id).toBe(
    receipts[1].generatedTeaching?.artifact.id,
  );
  const unavailable = await scopedTools(job);
  expect(
    (await unavailable.invoke("list_generation_profiles", {}, 2)).result,
  ).toMatchObject({ profiles: [] });
  expect((await job.snapshot()).planRevision).toBe(0);
});
it("generated delivery rechecks registry approval and rolls back every write when its work exceeds the remaining cap", async () => {
  const job = await prepare();
  generatedScript(job, "Minimum of [7, 2] is 2.");
  await invoke(job);
  const verified = await transition({ type: "verify", ref: job.ref });
  expect(verified.json().snapshot.state).toBe("ready");
  // Preserve job fences while exercising the adaptation admission invariant.
  const row = (
    await db.query(
      "SELECT snapshot FROM policy_states WHERE enrollment_id=$1",
      [job.id],
    )
  ).rows[0];
  const policy = structuredClone(row.snapshot);
  policy.scopes.find(
    (s: any) => s.scopeId === "course",
  ).work.additionalMinutes = 1;
  await db.query(
    "UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1",
    [job.id, JSON.stringify(policy)],
  );
  const denied = await transition({ type: "apply", ref: job.ref });
  expect(denied.statusCode, denied.body).toBe(409);
  expect(denied.json().error).toBe("QUOTA_EXCEEDED");
  expect((await job.snapshot()).planRevision).toBe(0);
  expect(
    (
      await db.query(
        "SELECT count(*) FROM adaptation_proposals WHERE enrollment_id=$1",
        [job.id],
      )
    ).rows[0].count,
  ).toBe("0");
  expect(
    (
      await db.query(
        "SELECT count(*) FROM supervisor_applications WHERE job_id=$1",
        [job.ref.jobId],
      )
    ).rows[0].count,
  ).toBe("0");
  await db.query(
    "UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1",
    [job.id, JSON.stringify(row.snapshot)],
  );
  // A re-approved identical profile has a new identity; the old candidate cannot
  // silently borrow the new approval, even though its text is still correct.
  const reg = (
    await db.query(
      "SELECT revision FROM adaptation_registries WHERE course_release_id=$1",
      [releaseId],
    )
  ).rows[0];
  const approval = await app.inject({
    method: "POST",
    url: `/api/admin/releases/${releaseId}/adaptation-registry`,
    headers: headers(owner),
    payload: {
      expectedRegistryRevision: reg.revision,
      configuration: fixture.config,
    },
  });
  expect(approval.statusCode, approval.body).toBe(200);
  const stale = await transition({ type: "apply", ref: job.ref });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.json().error).toBe("GENERATED_TEACHING_REGISTRY_CHANGED");
  expect((await job.snapshot()).planRevision).toBe(0);
});
