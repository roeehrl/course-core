import { digestJson } from "../src/repository.js";
import { randomUUID, createHash } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import type { ProviderRequest } from "@course-core/supervisor";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import {
  configureSupervisorBudget,
  createPostgresSupervisorBridge,
  resolveSupervisorOperation,
  storeSupervisorArtifact,
  recordSupervisorVerification,
  type PostgresSupervisorBridge,
} from "../src/supervisor-bridge.js";
import { teachingContext } from "../src/provider-context.js";
import { USABLE_MESSAGE, retrieveConversation } from "../src/context-capsule.js";
import { supervisorTools } from "../src/supervisor-tools.js";
import { composeProviders } from "../src/provider-composition.js";
import { supervisorGeneratedTeachingFixture } from "./generated-teaching-fixture.js";
import { readLearnerModel, readLearnerModelForSupervisorJob } from "../src/learner-model.js";
import { remedialCourse, remedialRegistry, entry as remedialEntry } from "./remedial-episode-fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";
import { reviewedRubricEvaluator, RUBRIC_EVALUATOR_ID } from "../src/rubric-evaluator.js";
import { rubricCourse, rubricExplanation } from "./rubric-fixture.js";
import { legacyGate } from "./legacy-gate.js";
import { transferChecks } from "../src/adaptation-transfer.js";

const schema = "supervisor_tools_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  token = randomUUID(),
  fixture = supervisorGeneratedTeachingFixture();
fixture.course.research = {
  publicTopics: [1, 2, 3].map((n) => ({
    id: "ordering-research-" + n,
    objectiveIds: ["minimum"],
    queryText: "Public ordering explanation " + n,
    allowedDomains: ["docs.python.org"],
  })),
};
const researchCalls: any[] = [];
let db: Database,
  app: Awaited<ReturnType<typeof createServer>>,
  bridge: PostgresSupervisorBridge,
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
    research: {
      async research(request) {
        researchCalls.push(structuredClone(request));
        return {
          usage: {
            ...usage,
            operation: "research" as const,
            accounting: request.accounting,
          },
          output: {
            text: "A minimum is no greater than other members.",
            grounding: "grounded" as const,
            parts: [
              {
                partIndex: 0,
                text: "A minimum is no greater than other members.",
              },
            ],
            sources: [
              {
                uri: "https://docs.python.org/3/library/functions.html#min",
                title: "Public ordering source",
              },
            ],
            citations: [
              { partIndex: 0, startByte: 0, endByte: 9, sourceIndices: [0] },
            ],
            searchQueries: ["public ordering"],
            searchSuggestionsHtml: "<script>UNTRUSTED_HTML</script>",
          },
        };
      },
    },
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
const jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
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
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
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
            capabilities: ["structured_assessment", "research"],
            tools: ["web_search"],
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
        research: {
          modelId: "planner",
          maxInputCharacters: 12000,
          maxOutputTokens: 1000,
        },
        supervisor: {
          modelId: "planner",
          maxInputCharacters: 30000,
          maxOutputTokens: 1000,
          maxToolRounds: 8,
        },
      },
    },
    () => "synthetic",
    { test: () => adapter },
  );
  app = await createServer(db, { loginCodes: true,
    origin,
    secureCookies: false,
    adaptation: fixture.runtime,
    providers,
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy },
    // Written answers reviewed against a rubric (used by the transfer-check tests).
    installedExtensions: [reviewedRubricEvaluator()],
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
  await allowUnpricedPaidWork(db, workspace);
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
    { microUsd: 10000000, tokens: 100000000 },
  );
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});
async function prepare(
  consent = true,
  independent = false,
  explanationStyle?: string,
  release = releaseId,
  /** Learner actions recorded before the supervisor job is admitted. */
  setup?: (enrollment: { id: string; learner: Awaited<ReturnType<typeof login>>; revision: () => Promise<number> }) => Promise<void>,
) {
  const learner = await login(),
    enrolled = await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: headers(learner),
      payload: { releaseId: release },
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
  if (setup) await setup({ id, learner, revision: async () => (await snapshot()).revision });
  await configureSupervisorBudget(
    db,
    { workspaceId: workspace, enrollmentId: id },
    { microUsd: 1000000, tokens: 2000000 },
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
  const outbox = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
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
      expect(current.suggestions.items[0]?.suggestion).toEqual({
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
  // Provider calls appear as identifiers and counts only.
  expect(inspector.json().providerCalls).toEqual([expect.objectContaining({ state: "completed", failureCode: null, providerId: "test", modelId: "planner", operation: "assess", inputCharacters: 300 })]);
  expect(inspector.json().providerCalls[0].attempts.map((a: any) => [a.attempt, a.status, a.tokens.total])).toEqual([[1, 200, 30], [2, 200, 30], [3, 200, 30]]);
  // The settlement basis is shown per dimension, and only its known values.
  const stored = (await db.query("SELECT operation_id,outcome->'usageBasis' AS basis FROM provider_dispatches WHERE job_id=$1", [job.ref.jobId])).rows[0];
  expect(stored.basis).toEqual({ microUsd: "reserved_ceiling", tokens: "reported" });
  expect(inspector.json().providerCalls[0].usageBasis).toEqual({ microUsd: "reserved_ceiling", tokens: "reported" });
  await db.query("UPDATE provider_dispatches SET outcome=jsonb_set(outcome,'{usageBasis}',$2::jsonb) WHERE operation_id=$1",
    [stored.operation_id, JSON.stringify({ microUsd: "reported", tokens: "DO_NOT_EXPOSE_BASIS", note: "DO_NOT_EXPOSE_BASIS" })]);
  const tampered = await app.inject({ url: `/api/admin/courses/${catalog.id}/runs/${job.ref.jobId}`, headers: headers(owner) });
  expect(tampered.json().providerCalls[0].usageBasis).toEqual({ microUsd: "reported", tokens: null });
  expect(tampered.body).not.toContain("DO_NOT_EXPOSE_BASIS");
  expect(inspector.json().verification).toMatchObject({ verdict: "verified", applicationKind: "reviewed_adaptation", applied: { kind: "reviewed_adaptation" } });
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

const releaseDigest = async (release = releaseId) =>
  (await db.query<{ digest: string }>("SELECT digest FROM course_releases WHERE id=$1", [release])).rows[0]!.digest;
async function companionMessage(enrollmentId: string, content: string, context: Record<string, unknown>, role = "learner") {
  const id = randomUUID();
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,$3,$4,$5)",
    [id, enrollmentId, role, content, JSON.stringify(context)]);
  return id;
}
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
    foreignId = randomUUID(),
    courseDigest = await releaseDigest();
  await db.query(
    "INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,'learner','FOREIGN_HISTORY_CANARY',$3)",
    [foreignId, other.id, JSON.stringify({ episodeId: "min", courseDigest })],
  );
  // All eight fall within one JS millisecond: a rounded Date cursor skips rows.
  for (let i = 0; i < 8; i++)
    await db.query(
      "INSERT INTO companion_messages(id,enrollment_id,role,content,context,created_at) VALUES($1,$2,'learner',$3,$4,$5)",
      [
        randomUUID(),
        job.id,
        "Own retained message " + i,
        JSON.stringify({ episodeId: "min", courseDigest }),
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
it("get_history gives the supervisor only this lesson's usable conversation: never excluded, deleted, other-lesson or other-version messages", async () => {
  const courseDigest = await releaseDigest(), lesson = { episodeId: "min", courseDigest };
  const ids: Record<string, string> = {};
  const job = await prepare(true, false, undefined, releaseId, async ({ id, learner, revision }) => {
    ids.kept = await companionMessage(id, "KEPT_LESSON_QUESTION", lesson);
    ids.answer = await companionMessage(id, "KEPT_LESSON_ANSWER", lesson, "assistant");
    ids.excluded = await companionMessage(id, "EXCLUDED_HISTORY_CANARY", lesson);
    ids.deleted = await companionMessage(id, "DELETED_HISTORY_CANARY", lesson);
    await companionMessage(id, "OTHER_LESSON_CANARY", { episodeId: "another-episode", courseDigest });
    await companionMessage(id, "OTHER_VERSION_CANARY", { episodeId: "min", courseDigest: "0".repeat(64) });
    // The learner's own controls, through the real routes.
    const excluded = await app.inject({ method: "POST", url: `/api/enrollments/${id}/companion/context-exclusions`, headers: headers(learner),
      payload: { expectedRevision: await revision(), idempotencyKey: randomUUID(), messageId: ids.excluded, excluded: true } });
    expect(excluded.statusCode, excluded.body).toBe(200);
    const deleted = await app.inject({ method: "POST", url: `/api/enrollments/${id}/companion/messages/${ids.deleted}/delete`, headers: headers(learner),
      payload: { expectedRevision: await revision(), idempotencyKey: randomUUID() } });
    expect(deleted.statusCode, deleted.body).toBe(200);
  });
  // Through the supervisor gateway: the model asks for history, and the next round's prompt is what it was given.
  const prompts: any[] = [];
  modelScripts.set(createHash("sha256").update(job.request.operationId).digest("hex"), (round, prompt) => {
    prompts.push(prompt);
    return round === 0 ? { decision: "tool", tool: "get_history", argumentsJson: "{}", summary: "" }
      : { decision: "finish", tool: "none", argumentsJson: "{}", summary: "Reviewed the lesson conversation." };
  });
  await invoke(job);
  const seen = JSON.stringify(prompts);
  expect(seen).toContain("KEPT_LESSON_QUESTION");
  expect(seen).toContain("KEPT_LESSON_ANSWER");
  expect(seen).not.toMatch(/EXCLUDED_HISTORY_CANARY|DELETED_HISTORY_CANARY|OTHER_LESSON_CANARY|OTHER_VERSION_CANARY|\[deleted\]/);
  const page = (await toolOutcome(job, "get_history")).result;
  expect(page.messages.map((m: any) => m.id).sort()).toEqual([ids.kept, ids.answer].sort());
  expect(page.beforeMessageId).toBeNull();
  // The learner's timeline names only what the supervisor actually read.
  const timeline = await app.inject({ url: `/api/enrollments/${job.id}/supervision/tools`, headers: headers(job.learner) });
  expect(timeline.statusCode, timeline.body).toBe(200);
  expect(timeline.body).not.toContain(ids.excluded);
}, 30000);
it("the supervisor's learner-model retrieval leaves out questions the learner excluded; the learner's own history still lists them", async () => {
  const lesson = { episodeId: "min", courseDigest: await releaseDigest() }, ids: Record<string, string> = {};
  const job = await prepare(true, false, undefined, releaseId, async ({ id, learner, revision }) => {
    for (const name of ["kept", "excluded"]) {
      ids[name] = await companionMessage(id, `Retrieval lesson question ${name.toUpperCase()}_RETRIEVAL_TEXT`, lesson);
      await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: id, actorId: learner.id, actorKind: "learner",
        type: "companion.requested", payload: { messageId: ids[name], episodeId: "min", requestKind: "question" }, idempotencyKey: randomUUID(), supervise: false }));
    }
    const excluded = await app.inject({ method: "POST", url: `/api/enrollments/${id}/companion/context-exclusions`, headers: headers(learner),
      payload: { expectedRevision: await revision(), idempotencyKey: randomUUID(), messageId: ids.excluded, excluded: true } });
    expect(excluded.statusCode, excluded.body).toBe(200);
  });
  const resolved = await resolveSupervisorOperation(db, job.request);
  const model = await readLearnerModelForSupervisorJob(db, { jobId: resolved.ref.jobId, workspaceId: workspace, enrollmentId: job.id }, { episodeId: "min" },
    { retrieval: { q: "retrieval lesson question", kind: "questions", limit: 5 } });
  const retrieved = JSON.stringify((model as any).history);
  expect(retrieved).toContain("KEPT_RETRIEVAL_TEXT");
  expect(retrieved).not.toContain("EXCLUDED_RETRIEVAL_TEXT");
  const own = await app.inject({ url: `/api/enrollments/${job.id}/learner-model/history?episodeId=min&kind=questions&q=retrieval`, headers: headers(job.learner) });
  expect(own.statusCode, own.body).toBe(200);
  expect(own.body).toContain("EXCLUDED_RETRIEVAL_TEXT");
});
it("get_history returns nothing from an erased enrollment", async () => {
  const courseDigest = await releaseDigest(), job = await prepare(), tools = await scopedTools(job);
  await companionMessage(job.id, "ERASED_HISTORY_CANARY", { episodeId: "min", courseDigest });
  expect(JSON.stringify((await tools.invoke("get_history", {}, 0)).result)).toContain("ERASED_HISTORY_CANARY");
  // Erasure waits while the job is in flight, so a running tool and an erasure never overlap.
  const waiting = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/erase`, headers: headers(job.learner),
    payload: { confirmation: `ERASE ${job.id.slice(0, 8)}`, reason: "Synthetic erasure request." } });
  expect([waiting.statusCode, waiting.json().error]).toEqual([409, "ERASURE_WAITING_FOR_SUPERVISION"]);
  // Should an erased enrollment still hold text (a partial restore, a missed table), its history is not read.
  await db.query("UPDATE enrollments SET status='erased' WHERE id=$1", [job.id]);
  await expect(tools.invoke("get_history", {}, 1)).rejects.toMatchObject({ code: "SUPERVISOR_INPUT_STALE" });
  // The shared message filter excludes it on its own as well, for every provider path that applies it.
  const retrieved = await transaction(db, (client) => retrieveConversation(client, { enrollmentId: job.id, episodeId: "min", courseDigest }));
  expect(retrieved).toMatchObject({ history: [], refs: [], summary: null });
  expect((await db.query(`SELECT count(*)::int AS n FROM companion_messages m WHERE m.enrollment_id=$1 AND ${USABLE_MESSAGE}`, [job.id])).rows[0].n).toBe(0);
});
it("searches the release's lesson text and the learner's own questions by full text, within the job's scope only", async () => {
  const job = await prepare(),
    other = await prepare(),
    tools = await scopedTools(job);
  const digest = (await db.query("SELECT r.digest FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=$1", [job.id])).rows[0].digest;
  const own = randomUUID(), excluded = randomUUID();
  for (const [id, enrollmentId, role, content] of [
    [own, job.id, "learner", "Is the running minimum of an empty list defined?"],
    [randomUUID(), job.id, "assistant", "ASSISTANT_SEARCH_CANARY running minimum"],
    [excluded, job.id, "learner", "EXCLUDED_SEARCH_CANARY running minimum"],
    [randomUUID(), other.id, "learner", "FOREIGN_SEARCH_CANARY running minimum"],
  ] as const)
    await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,$3,$4,$5)",
      [id, enrollmentId, role, content, JSON.stringify({ episodeId: "min", courseDigest: digest })]);
  // The learner asked the companion not to use this question again (the exclusion cites an event of theirs).
  await db.query(`INSERT INTO companion_context_exclusions(id,enrollment_id,workspace_id,message_id,event_id)
    SELECT $1,e.id,e.workspace_id,$2,(SELECT id FROM learning_events WHERE enrollment_id=e.id ORDER BY sequence LIMIT 1) FROM enrollments e WHERE e.id=$3`, [randomUUID(), excluded, job.id]);
  const history = (await tools.invoke("search_history", { query: "running minimum" }, 0)).result as any;
  expect(history.matches.map((m: { messageId: string }) => m.messageId)).toEqual([own]);
  for (const canary of ["ASSISTANT_SEARCH", "EXCLUDED_SEARCH", "FOREIGN_SEARCH"]) expect(JSON.stringify(history)).not.toContain(canary);
  expect(history).toMatchObject({ learnerTextIsUntrusted: true, maxResults: 5 });
  const sources = (await tools.invoke("search_sources", { query: "smaller member" }, 1)).result as any;
  expect(sources.passages.length).toBeGreaterThan(0);
  expect(sources.passages.length).toBeLessThanOrEqual(5);
  expect(sources).toMatchObject({ sourceTextIsUntrusted: true });
  // Scope never comes from arguments.
  await expect(tools.invoke("search_history", { query: "minimum", enrollmentId: other.id }, 2)).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  await expect(tools.invoke("search_sources", { query: "" }, 2)).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  // The run inspector lists what each search returned as context references.
  const traced = await app.inject({ url: `/api/enrollments/${job.id}/supervision/tools`, headers: headers(job.learner) });
  expect(traced.statusCode, traced.body).toBe(200);
  expect(JSON.stringify(traced.json())).toContain(own);
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
    // The learner sees generated text labelled unverified, with its sources, and may undo it.
    const changes = await app.inject({ url: `/api/enrollments/${job.id}/personal-changes`, headers: headers(job.learner) });
    expect(changes.json().changes).toEqual([expect.objectContaining({ provenance: "generated", unverified: true, revertable: true, reverted: false })]);
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

it("the actual model/tool pipeline checks a wrong candidate, repairs it within the same job, and delivers only the corrected text", async () => {
  const job = await prepare(),
    original = "Minimum of [17, -6, 5] is 5.",
    corrected = "Minimum of [17, -6, 5] is -6.",
    before = await job.snapshot();
  modelScripts.set(
    createHash("sha256").update(job.request.operationId).digest("hex"),
    (round, prompt) => {
      if (round === 0)
        return {
          decision: "tool",
          tool: "list_generation_profiles",
          argumentsJson: "{}",
          summary: "",
        };
      if (round === 1 || round === 3)
        return {
          decision: "tool",
          tool: "create_teaching",
          argumentsJson: JSON.stringify({
            profileId: "generated-ordering-profile",
            kind: "explanation",
            markdown: round === 1 ? original : corrected,
            objectiveIds: ["minimum"],
            sourceRefs: [fixture.source],
          }),
          summary: "",
        };
      if (round === 2)
        return {
          decision: "tool",
          tool: "check_teaching",
          argumentsJson: JSON.stringify({
            artifactDigest: prompt.toolResults.at(-1).result.artifactDigest,
          }),
          summary: "",
        };
      expect(
        prompt.toolResults.find((r: any) => r.tool === "check_teaching").result,
      ).toMatchObject({
        verification: "rejected",
        failedCheckIds: ["minimum-reference"],
        doesNotGrantMastery: true,
      });
      return {
        decision: "finish",
        tool: "none",
        argumentsJson: "{}",
        summary: "Use the repaired independently verifiable example.",
      };
    },
  );
  const callsBefore = calls,
    result = await invoke(job);
  expect(calls - callsBefore).toBe(5);
  expect(result.usage.tokens).toBe(150);
  expect((await job.snapshot()).planRevision).toBe(0);
  expect(
    (await transition({ type: "verify", ref: job.ref })).json().snapshot.state,
  ).toBe("ready");
  expect(
    (await transition({ type: "apply", ref: job.ref })).json().snapshot.state,
  ).toBe("applied");
  const after = await job.snapshot(),
    blocks = after.course.chapters[0].episodes[0].blocks;
  expect(blocks.some((b: any) => b.markdown === original)).toBe(false);
  expect(blocks.filter((b: any) => b.markdown === corrected)).toHaveLength(1);
  expect(after.lessons[0].gate).toEqual(before.lessons[0].gate);
  expect(
    (
      await db.query(
        "SELECT count(*) FROM adaptation_proposals WHERE enrollment_id=$1",
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
  const timeline = await app.inject({
    url: `/api/enrollments/${job.id}/supervision/tools`,
    headers: headers(job.learner),
  });
  expect(
    timeline
      .json()
      .calls.filter(
        (c: any) =>
          c.tool === "create_teaching" && c.appliedPlanRevision !== null,
      ),
  ).toHaveLength(1);
  expect(timeline.body).not.toContain(original);
  expect(timeline.body).not.toContain(corrected);
});
it("checking and candidate repair require this job scope and duplicate check retries do not rerun the reference", async () => {
  const job = await prepare(),
    other = await prepare(),
    tools = await scopedTools(job, true),
    foreign = await scopedTools(other, true),
    candidate = {
      profileId: "generated-ordering-profile",
      kind: "explanation",
      markdown: "Minimum of [12, -1] is 12.",
      objectiveIds: ["minimum"],
      sourceRefs: [fixture.source],
    };
  await tools.invoke("list_generation_profiles", {}, 0);
  await foreign.invoke("list_generation_profiles", {}, 0);
  const first = await tools.invoke("create_teaching", candidate, 1),
    foreignCandidate = await foreign.invoke("create_teaching", candidate, 1);
  await expect(
    tools.invoke(
      "check_teaching",
      { artifactDigest: foreignCandidate.generatedTeaching!.artifact.digest },
      2,
    ),
  ).rejects.toMatchObject({ code: "GENERATED_TEACHING_CANDIDATE_NOT_FOUND" });
  await expect(
    tools.invoke(
      "check_teaching",
      {
        artifactDigest: first.generatedTeaching!.artifact.digest,
        proof: "forged",
      },
      2,
    ),
  ).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  const before = fixture.stats.verifications;
  const checked = await Promise.all([
    tools.invoke(
      "check_teaching",
      { artifactDigest: first.generatedTeaching!.artifact.digest },
      2,
    ),
    tools.invoke(
      "check_teaching",
      { artifactDigest: first.generatedTeaching!.artifact.digest },
      2,
    ),
  ]);
  expect(checked[0]).toEqual(checked[1]);
  expect(checked[0].result).toMatchObject({
    verification: "rejected",
    failedCheckIds: ["minimum-reference"],
  });
  expect(fixture.stats.verifications).toBe(before + 1);
  await tools.invoke(
    "create_teaching",
    { ...candidate, markdown: "Minimum of [12, -1] is -1." },
    3,
  );
  await expect(
    tools.invoke(
      "create_teaching",
      { ...candidate, markdown: "Minimum of [12, -1] is -1." },
      4,
    ),
  ).rejects.toMatchObject({ code: "GENERATION_CANDIDATE_LIMIT" });
  expect((await job.snapshot()).planRevision).toBe(0);
});
it("a rejected generated candidate can fall back to exact reviewed support without applying the failed text", async () => {
  const job = await prepare(),
    bad = "Minimum of [8, -4] is 8.";
  modelScripts.set(
    createHash("sha256").update(job.request.operationId).digest("hex"),
    (round, prompt) => {
      const tool = (name: string, args = {}) => ({
        decision: "tool",
        tool: name,
        argumentsJson: JSON.stringify(args),
        summary: "",
      });
      if (round === 0) return tool("list_generation_profiles");
      if (round === 1)
        return tool("create_teaching", {
          profileId: "generated-ordering-profile",
          kind: "explanation",
          markdown: bad,
          objectiveIds: ["minimum"],
          sourceRefs: [fixture.source],
        });
      if (round === 2)
        return tool("check_teaching", {
          artifactDigest: prompt.toolResults.at(-1).result.artifactDigest,
        });
      if (round === 3)
        return tool("choose_support", {
          profileId: "ordering-support-profile",
          entryId: "number-line-support",
        });
      return {
        decision: "finish",
        tool: "none",
        argumentsJson: "{}",
        summary: "Use the exact author-reviewed alternative.",
      };
    },
  );
  await invoke(job);
  expect(
    (await transition({ type: "verify", ref: job.ref })).json().snapshot.state,
  ).toBe("ready");
  expect(
    (await transition({ type: "apply", ref: job.ref })).json().snapshot.state,
  ).toBe("applied");
  const after = await job.snapshot();
  expect(
    after.course.chapters[0].episodes[0].blocks.some(
      (b: any) => b.markdown === bad,
    ),
  ).toBe(false);
  expect(
    after.course.chapters[0].episodes[0].blocks.filter(
      (b: any) => b.markdown === fixture.markdown,
    ),
  ).toHaveLength(1);
  expect(
    (
      await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
        job.id,
      ])
    ).rows[0].count,
  ).toBe("0");
});

it("cancellation during reference feedback aborts the verifier and cannot leave a partial check or lesson effect", async () => {
  const job = await prepare(),
    tools = await scopedTools(job, true),
    candidate = {
      profileId: "generated-ordering-profile",
      kind: "explanation",
      markdown: "Minimum of [4, -2] is -2.",
      objectiveIds: ["minimum"],
      sourceRefs: [fixture.source],
    };
  await tools.invoke("list_generation_profiles", {}, 0);
  const created = await tools.invoke("create_teaching", candidate, 1);
  let enter!: () => void,
    aborted = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const base = fixture.runtime.adapters.find(
    (a) => a.kind === "generated-teaching",
  )!;
  const stalled = {
    ...base,
    async createPorts(input: Parameters<typeof base.createPorts>[0]) {
      const ports = await base.createPorts(input);
      return {
        verifier: {
          ...ports.verifier,
          async verify(_input: unknown, options: { signal?: AbortSignal }) {
            enter();
            return new Promise<never>((_, reject) => {
              options.signal!.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(Error("Injected cancelled verifier"));
                },
                { once: true },
              );
            });
          },
        },
      };
    },
  };
  const resolved = await resolveSupervisorOperation(db, job.request),
    controller = new AbortController();
  const cancelling = supervisorTools(
    db,
    job.request,
    await teachingContext(db, resolved.ref, resolved.input.context),
    {
      ...fixture.runtime,
      adapters: fixture.runtime.adapters.map((a) => (a === base ? stalled : a)),
    },
  );
  const checked = cancelling.invoke(
    "check_teaching",
    { artifactDigest: created.generatedTeaching!.artifact.digest },
    2,
    controller.signal,
  );
  await entered;
  controller.abort();
  await expect(checked).rejects.toMatchObject({ code: "ADAPTATION_CANCELLED" });
  expect(aborted).toBe(true);
  expect(
    (
      await db.query(
        "SELECT count(*) FROM supervisor_tool_calls WHERE job_id=$1 AND tool='check_teaching'",
        [job.ref.jobId],
      )
    ).rows[0].count,
  ).toBe("0");
  expect((await job.snapshot()).planRevision).toBe(0);
});
it("approved creator guidance reaches the scoped model prompt without becoming grading or paid authority", async () => {
  const job = await prepare();
  let observed = false;
  modelScripts.set(
    createHash("sha256").update(job.request.operationId).digest("hex"),
    (round, prompt) => {
      if (round === 0)
        return {
          decision: "tool",
          tool: "list_generation_profiles",
          argumentsJson: "{}",
          summary: "",
        };
      const profile = prompt.toolResults
        .at(-1)
        .result.profiles.find(
          (p: any) => p.id === "generated-ordering-profile",
        );
      expect(profile.generationBrief).toBe(
        fixture.config.profiles.find(
          (p) => p.id === "generated-ordering-profile",
        )!.generationBrief,
      );
      expect(profile.guidanceTrust).toBe(
        "approved_creator_content_not_tool_authority",
      );
      observed = true;
      return {
        decision: "finish",
        tool: "none",
        argumentsJson: "{}",
        summary: "Format guidance inspected; no teaching selected.",
      };
    },
  );
  await invoke(job);
  expect(observed).toBe(true);
  expect((await job.snapshot()).planRevision).toBe(0);
  expect(
    (
      await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
        job.id,
      ])
    ).rows[0].count,
  ).toBe("0");
});
it("registry accommodates a full course beyond128profiles while enforcing the512bound, brief bounds and adapter applicability", async () => {
  const revision = async () =>
    Number(
      (
        await db.query(
          "SELECT revision FROM adaptation_registries WHERE course_release_id=$1",
          [releaseId],
        )
      ).rows[0].revision,
    );
  const profile = fixture.config.profiles.find(
    (p) => p.id === "generated-ordering-profile",
  )!;
  const approve = (configuration: unknown, expectedRegistryRevision: number) =>
    app.inject({
      method: "POST",
      url: `/api/admin/releases/${releaseId}/adaptation-registry`,
      headers: headers(owner),
      payload: { configuration, expectedRegistryRevision },
    });
  const large = {
    ...structuredClone(fixture.config),
    profiles: [
      ...structuredClone(fixture.config.profiles),
      ...Array.from({ length: 140 }, (_, i) => ({
        ...structuredClone(profile),
        id: "creator-profile-" + i,
        generationBrief: "A bounded creator format for this profile.",
      })),
    ],
  };
  const accepted = await approve(large, await revision());
  expect(accepted.statusCode, accepted.body).toBe(200);
  const pinned = await revision();
  for (const configuration of [
    {
      ...large,
      profiles: Array.from({ length: 513 }, (_, i) => ({
        ...profile,
        id: "oversized-profile-" + i,
      })),
    },
    {
      ...fixture.config,
      profiles: fixture.config.profiles.map((p) =>
        p.id === profile.id ? { ...p, generationBrief: "x".repeat(3001) } : p,
      ),
    },
    {
      ...fixture.config,
      profiles: fixture.config.profiles.map((p) =>
        p.id === profile.id ? { ...p, generationBrief: "  " } : p,
      ),
    },
    {
      ...fixture.config,
      profiles: fixture.config.profiles.map((p) =>
        p.id !== profile.id
          ? { ...p, generationBrief: "Unsupported bank guidance" }
          : p,
      ),
    },
  ]) {
    const denied = await approve(configuration, pinned);
    expect([400, 409]).toContain(denied.statusCode);
    expect(await revision()).toBe(pinned);
  }
  expect((await approve(fixture.config, pinned)).statusCode).toBe(200);
});

async function stageResearchFlow() {
  const job = await prepare();
  modelScripts.set(
    createHash("sha256").update(job.request.operationId).digest("hex"),
    (round) =>
      round === 0
        ? {
            decision: "tool",
            tool: "list_research_topics",
            argumentsJson: "{}",
            summary: "",
          }
        : round === 1
          ? {
              decision: "tool",
              tool: "request_research",
              argumentsJson: JSON.stringify({ topicId: "ordering-research-1" }),
              summary: "",
            }
          : {
              decision: "finish",
              tool: "none",
              argumentsJson: "{}",
              summary: "Collect public sources for separate review.",
            },
  );
  await invoke(job);
  return job;
}
it("a separately dispatched research job receives only immutable public query text and retains unreviewed sources without changing the lesson", async () => {
  const job = await stageResearchFlow(),
    before = await job.snapshot();
  expect(researchCalls).toHaveLength(0);
  expect(
    (
      await db.query(
        "SELECT state FROM research_requests WHERE parent_job_id=$1",
        [job.ref.jobId],
      )
    ).rows,
  ).toEqual([{ state: "staged" }]);
  expect(
    (await transition({ type: "verify", ref: job.ref })).json().snapshot.state,
  ).toBe("ready");
  const approved = await transition({ type: "apply", ref: job.ref });
  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().snapshot.state).toBe("applied");
  const requestRow = (
    await db.query("SELECT * FROM research_requests WHERE parent_job_id=$1", [
      job.ref.jobId,
    ])
  ).rows[0];
  expect(requestRow.state).toBe("dispatched");
  const replay = await transition({ type: "apply", ref: job.ref });
  expect(replay.json().snapshot.applicationReceiptId).toBe(
    approved.json().snapshot.applicationReceiptId,
  );
  const envelope = (await bridge.claimOutboxEvent(requestRow.activation_event_id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(envelope);
  expect(ref).toBeDefined();
  expect(await bridge.prepareOutbox(envelope)).toEqual([ref]);
  await bridge.ackOutbox(envelope);
  const claim = await bridge.transition({
    type: "claim",
    ref: ref!,
    checkpointId: "generate",
    ownerId: randomUUID(),
    availability: { status: "ready" },
  });
  expect(claim.snapshot.specification.role).toBe("research");
  const op = claim.snapshot.operations[0]!;
  const payload = {
    schemaVersion: 1,
    operationId: op.id,
    job: claim.snapshot.specification.key,
    role: "research",
    checkpoint: claim.snapshot.specification.checkpoints[0],
    fence: claim.snapshot.specification.fence,
  };
  await db.query(
    "INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,'learner',$3,$4)",
    [
      randomUUID(),
      job.id,
      "PRIVATE_RESEARCH_CONTEXT_CANARY",
      JSON.stringify({ episodeId: "min" }),
    ],
  );
  const collected = await app.inject({
    method: "POST",
    url: "/v1/operations",
    headers: { authorization: "Bearer " + token, "idempotency-key": op.id },
    payload,
  });
  expect(collected.statusCode, collected.body).toBe(200);
  expect(collected.json().status).toBe("succeeded");
  expect(researchCalls).toHaveLength(1);
  expect(researchCalls[0].messages).toEqual([
    { role: "user", text: "Public ordering explanation 1" },
  ]);
  expect(JSON.stringify(researchCalls)).not.toContain(
    "PRIVATE_RESEARCH_CONTEXT_CANARY",
  );
  expect(JSON.stringify(researchCalls)).not.toContain(job.id);
  await bridge.transition({
    type: "settle",
    ref: ref!,
    operationId: op.id,
    ownerId: op.ownerId,
    outcome: collected.json(),
  });
  const verified = await transition({ type: "verify", ref: ref! });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(verified.json().snapshot.state).toBe("ready");
  const queued = await transition({ type: "apply", ref: ref! });
  expect(queued.statusCode, queued.body).toBe(200);
  expect(queued.json().snapshot.state).toBe("applied");
  const candidates = (
    await db.query(
      "SELECT c.*,a.content FROM research_candidates c JOIN supervisor_artifacts a ON a.id=c.artifact_id WHERE c.enrollment_id=$1",
      [job.id],
    )
  ).rows;
  expect(candidates).toHaveLength(1);
  expect(candidates[0].review_state).toBe("unreviewed");
  expect(candidates[0].content).toMatchObject({
    reviewState: "unreviewed",
    sources: [
      {
        uri: "https://docs.python.org/3/library/functions.html#min",
        title: "Public ordering source",
      },
    ],
  });
  expect(candidates[0].content).not.toHaveProperty("searchSuggestionsHtml");
  const repeated = await app.inject({
    method: "POST",
    url: "/v1/operations",
    headers: { authorization: "Bearer " + token, "idempotency-key": op.id },
    payload,
  });
  expect(repeated.json()).toEqual(collected.json());
  expect(researchCalls).toHaveLength(1);
  const queueReplay = await transition({ type: "apply", ref: ref! });
  expect(queueReplay.json().snapshot.applicationReceiptId).toBe(
    queued.json().snapshot.applicationReceiptId,
  );
  const after = await job.snapshot();
  expect(after.planRevision).toBe(0);
  expect(after.lessons[0].gate).toEqual(before.lessons[0].gate);
  expect(
    (
      await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
        job.id,
      ])
    ).rows[0].count,
  ).toBe("0");
  const authority = (
    await db.query(
      "SELECT can_review_adaptation,can_collect_research FROM supervisor_verifier_authorities WHERE workspace_id=$1 AND label='Public-topic unreviewed research collection v1'",
      [workspace],
    )
  ).rows[0];
  expect(authority).toEqual({
    can_review_adaptation: false,
    can_collect_research: true,
  });
  const collectionAuthority = (
    await db.query(
      "SELECT id FROM supervisor_verifier_authorities WHERE workspace_id=$1 AND label='Public-topic unreviewed research collection v1'",
      [workspace],
    )
  ).rows[0];
  await expect(
    recordSupervisorVerification(
      db,
      job.ref,
      collectionAuthority.id,
      "verified",
    ),
  ).rejects.toMatchObject({ code: "SUPERVISOR_VERIFIER_FORBIDDEN" });
  const own = await app.inject({
    url: `/api/enrollments/${job.id}/research`,
    headers: headers(job.learner),
  });
  expect(own.statusCode, own.body).toBe(200);
  expect(own.json()).toMatchObject({
    sourceApproval: "not_granted",
    grantsMastery: false,
    requests: [{ state: "collected", reviewState: "unreviewed" }],
  });
  expect(own.body).not.toContain("A minimum is");
  expect(own.body).not.toContain("docs.python.org");
  const staff = await app.inject({
    url: `/api/admin/releases/${releaseId}/research`,
    headers: headers(owner),
  });
  expect(staff.statusCode, staff.body).toBe(200);
  expect(staff.json().trust).toBe("untrusted_external_content");
  expect(staff.json().contentUseApproval).toBe(false);
  expect(
    staff
      .json()
      .requests.some(
        (r: any) => r.id === requestRow.id && r.content.sources.length === 1,
      ),
  ).toBe(true);
  const denied = await app.inject({
    url: `/api/admin/releases/${releaseId}/research`,
    headers: headers(job.learner),
  });
  expect(denied.statusCode).toBe(403);
  const stranger = await login();
  expect(
    (
      await app.inject({
        url: `/api/enrollments/${job.id}/research`,
        headers: headers(stranger),
      })
    ).statusCode,
  ).toBe(404);
  const timeline = await app.inject({
    url: `/api/enrollments/${job.id}/supervision/tools`,
    headers: headers(job.learner),
  });
  expect(
    timeline.json().calls.find((c: any) => c.tool === "request_research")
      .outcome.researchState,
  ).toBe("collected");
  const catalog = (
    await db.query(
      "SELECT id FROM admin_course_catalog WHERE workspace_id=$1",
      [workspace],
    )
  ).rows[0];
  const inspected = await app.inject({
    url: `/api/admin/courses/${catalog.id}/runs/${ref!.jobId}`,
    headers: headers(owner),
  });
  expect(inspected.statusCode, inspected.body).toBe(200);
  expect(inspected.json().artifacts[0].status).toBe("pending_review");
  expect(inspected.json().artifacts[0].preview).toContain("sourceUseApproved");
  expect(inspected.body).not.toContain("A minimum is");
});
it("research selection rejects private queries, unobserved topics and stale permission before any search dispatch", async () => {
  const job = await prepare(),
    tools = await scopedTools(job, true);
  await expect(
    tools.invoke("request_research", { topicId: "ordering-research-1" }, 0),
  ).rejects.toMatchObject({ code: "RESEARCH_TOPIC_NOT_OBSERVED" });
  await tools.invoke("list_research_topics", {}, 0);
  await expect(
    tools.invoke(
      "request_research",
      { topicId: "ordering-research-1", queryText: "PRIVATE_QUERY" },
      1,
    ),
  ).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  await tools.invoke("request_research", { topicId: "ordering-research-1" }, 1);
  await tools.invoke("request_research", { topicId: "ordering-research-2" }, 2);
  await expect(
    tools.invoke("request_research", { topicId: "ordering-research-3" }, 3),
  ).rejects.toMatchObject({ code: "RESEARCH_REQUEST_LIMIT" });
  const requestRows = (
    await db.query(
      "SELECT state FROM research_requests WHERE parent_job_id=$1",
      [job.ref.jobId],
    )
  ).rows;
  expect(requestRows).toEqual([{ state: "staged" }, { state: "staged" }]);
  const staged = await stageResearchFlow();
  const setting = await app.inject({
    method: "POST",
    url: `/api/enrollments/${staged.id}/supervision`,
    headers: headers(staged.learner),
    payload: {
      expectedRevision: (await staged.snapshot()).revision,
      idempotencyKey: randomUUID(),
      adaptiveTeaching: false,
    },
  });
  expect(setting.statusCode, setting.body).toBe(200);
  const verification = await transition({ type: "verify", ref: staged.ref });
  expect(verification.statusCode, verification.body).toBe(409);
  expect(
    (
      await db.query(
        "SELECT state FROM research_requests WHERE parent_job_id=$1",
        [staged.ref.jobId],
      )
    ).rows,
  ).toEqual([{ state: "staged" }]);
});

it("the supervisor inserts an exact reviewed remedial episode after the current lesson, verified and applied by the host", async () => {
  const adapter = fixture.runtime.adapters.find((a) => a.id === "authored-teaching-bank-v1")!;
  const course = remedialCourse(adapter);
  const imported = await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers: headers(owner), payload: course });
  expect(imported.statusCode, imported.body).toBe(200);
  const release = imported.json().id;
  expect((await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers: headers(owner) })).statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `/api/admin/releases/${release}/adaptation-registry`, headers: headers(owner),
    payload: { expectedRegistryRevision: 0, configuration: remedialRegistry(adapter, "required") } });
  expect(approved.statusCode, approved.body).toBe(200);
  const job = await prepare(true, false, undefined, release);
  let listed: any;
  modelScripts.set(createHash("sha256").update(job.request.operationId).digest("hex"), (round, prompt) => {
    if (round === 1) listed = prompt.toolResults.at(-1).result;
    return round === 0
      ? { decision: "tool", tool: "list_support", argumentsJson: "{}", summary: "" }
      : round === 1
        ? { decision: "tool", tool: "choose_support", argumentsJson: JSON.stringify({ profileId: "remedial-profile", entryId: remedialEntry.id }), summary: "" }
        : { decision: "finish", tool: "none", argumentsJson: "{}", summary: "Add the reviewed step-by-step lesson before moving on." };
  });
  await invoke(job);
  expect(listed.profiles).toEqual([expect.objectContaining({ id: "remedial-profile", operation: "insert_episode",
    items: [{ id: remedialEntry.id, kind: "episode", title: remedialEntry.title, objectiveIds: ["minimum"], sourceRefs: remedialEntry.sourceRefs }] })]);
  expect((await job.snapshot()).course.chapters[0].episodes).toHaveLength(2);
  const verified = await transition({ type: "verify", ref: job.ref });
  expect(verified.json().snapshot.state, verified.body).toBe("ready");
  const applied = await transition({ type: "apply", ref: job.ref });
  expect(applied.json().snapshot.state, applied.body).toBe("applied");
  const after = await job.snapshot();
  const order = after.course.chapters[0].episodes;
  expect(order.map((e: any) => e.title)).toEqual(["Minimum", remedialEntry.title, "Maximum"]);
  expect(order[1].blocks.map((b: any) => b.markdown)).toEqual(remedialEntry.blocks.map((b) => b.markdown));
  expect(after.lessons.find((l: any) => l.id === order[1].id)).toMatchObject({ requirement: "required", gate: null });
  expect((await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [job.id])).rows[0].count).toBe("0");
  expect((await db.query("SELECT actor_kind FROM learning_events WHERE enrollment_id=$1 AND event_type='adaptation.applied'", [job.id])).rows).toEqual([{ actor_kind: "agent" }]);
}, 30000);

it("the assessment and code/lab tool families read item structure and run counts, never keys, hidden cases or source", async () => {
  const job = await prepare(),
    tools = await scopedTools(job);
  const outline = (await tools.invoke("get_assessment_outline", {}, 0)).result as any;
  expect(outline.answersIncluded).toBe(false);
  expect(outline.items.map((i: any) => i.id).sort()).toEqual(["min-a", "min-b"]);
  expect(outline.items[0]).toEqual({ id: "min-a", type: "choice", objectiveIds: ["minimum"], familyId: "compare", role: null, misconceptionIds: [] });
  expect(JSON.stringify(outline)).not.toMatch(/correctOptionId|grading|2 is below 5|4 is below 9/);
  await expect(tools.invoke("get_code_results", { assessmentId: "min-a" }, 1)).rejects.toMatchObject({ code: "SUPERVISOR_TOOL_ARGUMENTS" });
  expect((await tools.invoke("get_code_results", {}, 1)).result).toMatchObject({ runs: [], sourceIncluded: false, hiddenCasesIncluded: false });
  // A copy of the release whose episode also has a code item, so recorded runs are visible.
  const code = { id: "min-code", type: "code", objectiveIds: ["minimum"], familyId: "code", prompt: "Return the minimum.", language: "python", starterCode: "", grading: { evaluatorId: "synthetic", fixtureRef: "HIDDEN_FIXTURE_CANARY" } };
  const copy = randomUUID();
  const base = (await db.query("SELECT server_bundle FROM course_releases WHERE id=$1", [releaseId])).rows[0].server_bundle;
  const bundle = { ...base, version: "9.9.9-code", assessments: [...base.assessments, code] };
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
    SELECT $2,workspace_id,course_key,'9.9.9-code',$3,$4,learner_bundle,status,created_by FROM course_releases WHERE id=$1`,
    [releaseId, copy, digestJson(bundle), JSON.stringify(bundle)]);
  const coded = await prepare(true, false, undefined, copy), other = await prepare(true, false, undefined, copy);
  const digest = (await db.query("SELECT digest FROM course_releases WHERE id=$1", [copy])).rows[0].digest;
  for (const [i, enrollment] of [coded.id, other.id].entries())
    await db.query(`INSERT INTO attempts(id,enrollment_id,assessment_id,course_digest,family_id,mode,assistance,response,result,idempotency_key)
      VALUES($1,$2,'min-code',$3,'code','practice','none',$4,$5,$6)`, [randomUUID(), enrollment, digest,
      JSON.stringify({ source: "LEARNER_SOURCE_CANARY" }),
      JSON.stringify({ passed: false, explanation: "x", execution: { status: "graded", passedCases: 2 + i, totalCases: 5, cases: ["HIDDEN_CASE_CANARY"] } }), randomUUID()]);
  const codeTools = await scopedTools(coded);
  const runs = (await codeTools.invoke("get_code_results", {}, 0)).result as any;
  expect(runs.runs).toEqual([expect.objectContaining({ assessmentId: "min-code", passed: false, status: "graded", passedCases: 2, totalCases: 5, mode: "practice" })]);
  expect(JSON.stringify(runs)).not.toMatch(/CANARY/);
  const codeOutline = (await codeTools.invoke("get_assessment_outline", {}, 1)).result as any;
  expect(codeOutline.items.find((i: any) => i.id === "min-code")).toMatchObject({ type: "code", language: "python" });
  expect(JSON.stringify(codeOutline)).not.toContain("HIDDEN_FIXTURE_CANARY");
});

it("get_code_results and get_evidence leave out answers whose evidence the learner excluded from AI context", async () => {
  const code = { id: "min-code", type: "code", objectiveIds: ["minimum"], familyId: "code", prompt: "Return the minimum.", language: "python", starterCode: "", grading: { evaluatorId: "synthetic", fixtureRef: "fixture" } };
  const copy = randomUUID();
  const base = (await db.query("SELECT server_bundle FROM course_releases WHERE id=$1", [releaseId])).rows[0].server_bundle;
  const bundle = { ...base, version: "9.9.8-code", assessments: [...base.assessments, code] };
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
    SELECT $2,workspace_id,course_key,'9.9.8-code',$3,$4,learner_bundle,status,created_by FROM course_releases WHERE id=$1`,
    [releaseId, copy, digestJson(bundle), JSON.stringify(bundle)]);
  const digest = await releaseDigest(copy);
  const attempt = async (enrollmentId: string, assessmentId: string, familyId: string, mode: string, result: unknown) => {
    const id = randomUUID();
    // Answered an hour ago, before the teaching below was delivered: it can settle only the check it is linked to.
    await db.query(`INSERT INTO attempts(id,enrollment_id,assessment_id,course_digest,family_id,mode,assistance,response,result,idempotency_key,submitted_at)
      VALUES($1,$2,$3,$4,$5,$6,'none','{}',$7,$8,now()-interval '1 hour')`, [id, enrollmentId, assessmentId, digest, familyId, mode, JSON.stringify(result), randomUUID()]);
    return id;
  };
  const ids: Record<string, string> = {};
  const job = await prepare(true, false, undefined, copy, async ({ id, learner, revision }) => {
    ids.kept = await attempt(id, "min-code", "code", "practice", { passed: false, execution: { status: "graded", passedCases: 1, totalCases: 5 } });
    ids.excludedRun = await attempt(id, "min-code", "code", "practice", { passed: true, execution: { status: "graded", passedCases: 4, totalCases: 5 } });
    ids.excludedCheck = await attempt(id, "min-a", "compare", "independent", { passed: true, explanation: "EXCLUDED_FEEDBACK_CANARY" });
    // Delivered teaching whose transfer check the excluded independent answer settled, and one still pending.
    const registry = (await db.query("SELECT revision FROM adaptation_registries WHERE course_release_id=$1", [releaseId])).rows[0];
    for (const [n, settledBy] of [[1, ids.excludedCheck], [2, null]] as const) {
      const proposal = randomUUID();
      await db.query(`INSERT INTO adaptation_proposals(id,enrollment_id,workspace_id,course_release_id,registry_revision,proposal_key,base_digest,proposal_digest,
          expected_plan_revision,verified_policy_revision,body,assignments,evidence_fence,authority_ref,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,0,1,'{}','[]','{}','synthetic',$8)`, [proposal, id, workspace, releaseId, registry?.revision ?? 1, "transfer-" + n, digest, owner.id]);
      await db.query(`INSERT INTO adaptation_transfer_checks(enrollment_id,workspace_id,proposal_id,objective_id,status,attempt_id,resolved_at)
        VALUES($1,$2,$3,'minimum',$4,$5,$6)`, [id, workspace, proposal, settledBy ? "passed" : "pending", settledBy, settledBy ? new Date() : null]);
    }
    for (const attemptId of [ids.excludedRun, ids.excludedCheck]) {
      const evidenceId = randomUUID();
      await db.query(`INSERT INTO evidence(id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent) VALUES($1,$2,$3,'minimum','synthetic',$4,true)`,
        [evidenceId, id, attemptId, JSON.stringify({ passed: true })]);
      const excluded = await app.inject({ method: "POST", url: `/api/enrollments/${id}/learner-model/evidence/${evidenceId}/control`, headers: headers(learner),
        payload: { expectedRevision: await revision(), idempotencyKey: randomUUID(), action: "exclude" } });
      expect(excluded.statusCode, excluded.body).toBe(200);
    }
  });
  const tools = await scopedTools(job);
  const runs = (await tools.invoke("get_code_results", {}, 0)).result as any;
  expect(runs.runs).toEqual([expect.objectContaining({ assessmentId: "min-code", passed: false, passedCases: 1 })]);
  const evidence = (await tools.invoke("get_evidence", {}, 1)).result as any;
  expect(evidence.transferChecks).toEqual([expect.objectContaining({ objectiveId: "minimum", status: "pending" })]);
  expect(JSON.stringify(evidence)).not.toMatch(/EXCLUDED_FEEDBACK_CANARY|"status":"passed"/);
});

/** A release whose generated-teaching generator and verifier also make whole lessons. */
async function lessonRelease(configure?: (course: typeof fixture.course) => void) {
  const course = structuredClone(fixture.course), config = structuredClone(fixture.config);
  configure?.(course);
  course.version = "1.1." + Math.floor(Math.random() * 1_000_000);
  for (const g of course.adaptation!.generators) if (g.id === "generated-ordering-generator") g.artifactKinds = ["explanation", "episode"];
  const limits = course.adaptation!.limits;
  limits.maxAdditionalEpisodesPerAssignment = Math.max(1, limits.maxAdditionalEpisodesPerAssignment);
  if (!limits.allowedClassifications.includes("optional")) limits.allowedClassifications.push("optional");
  for (const t of course.adaptation!.targets) if (t.episodeId === "min" && !t.allowedOperations.includes("insert_episode")) t.allowedOperations.push("insert_episode");
  for (const v of course.adaptation!.verifiers) if (v.id === "generated-ordering-verifier") v.artifactKinds = ["explanation", "episode"];
  for (const v of config.verifiers) if (v.id === "generated-ordering-verifier") v.artifactKinds = ["explanation", "episode"];
  const base = config.profiles.find((p) => p.id === "generated-ordering-profile")!;
  config.profiles.push(
    { ...base, id: "generated-lesson-profile", operation: "insert_episode", classification: "required", additionalEpisodes: 1 },
    { ...base, id: "generated-advanced-profile", operation: "insert_episode", classification: "optional", additionalEpisodes: 1, branch: "advanced" },
  );
  const imported = await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers: headers(owner), payload: course });
  expect(imported.statusCode, imported.body).toBe(200);
  const release = imported.json().id;
  expect((await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers: headers(owner) })).statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `/api/admin/releases/${release}/adaptation-registry`, headers: headers(owner),
    payload: { expectedRegistryRevision: 0, configuration: config } });
  expect(approved.statusCode, approved.body).toBe(200);
  return release;
}
function lessonScript(job: Awaited<ReturnType<typeof prepare>>, profileId: string, title: string, blocks: string[]) {
  modelScripts.set(createHash("sha256").update(job.request.operationId).digest("hex"), (round, prompt) =>
    round === 0 ? { decision: "tool", tool: "list_generation_profiles", argumentsJson: "{}", summary: "" }
    : round === 1 ? { decision: "tool", tool: "create_teaching", summary: "", argumentsJson: JSON.stringify({ profileId, kind: "episode", title,
        blocks: blocks.map((markdown) => ({ markdown })), objectiveIds: ["minimum"], sourceRefs: [fixture.source] }) }
    : round === 2 ? { decision: "tool", tool: "check_teaching", summary: "",
        argumentsJson: JSON.stringify({ artifactDigest: prompt.toolResults.at(-1).result.artifactDigest }) }
    : { decision: "finish", tool: "none", argumentsJson: "{}", summary: "A short generated lesson follows the minimum lesson after verification." });
}
const toolOutcome = async (job: Awaited<ReturnType<typeof prepare>>, tool: string) =>
  (await db.query("SELECT outcome FROM supervisor_tool_calls WHERE job_id=$1 AND tool=$2", [job.ref.jobId, tool])).rows[0]?.outcome;

it("a generated whole lesson passes the verifier and the accessibility check, is inserted after its anchor and records a transfer check", async () => {
  const release = await lessonRelease(), job = await prepare(true, false, undefined, release);
  lessonScript(job, "generated-lesson-profile", "Finding a minimum, step by step", ["Minimum of [4, -3, 9] is -3.", "Minimum of [12, 5] is 5."]);
  await invoke(job);
  const profiles = (await toolOutcome(job, "list_generation_profiles")).result.profiles;
  expect(profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: "generated-lesson-profile", creates: "episode" })]));
  expect((await toolOutcome(job, "check_teaching")).result).toMatchObject({ verification: "passed", failedCheckIds: [] });
  expect((await transition({ type: "verify", ref: job.ref })).json().snapshot.state).toBe("ready");
  expect((await transition({ type: "apply", ref: job.ref })).json().snapshot.state).toBe("applied");
  const after = await job.snapshot();
  const episodes = after.course.chapters[0].episodes;
  expect(episodes[1]).toMatchObject({ title: "Finding a minimum, step by step" });
  expect(episodes[1].blocks.map((b: any) => b.markdown)).toEqual(["Minimum of [4, -3, 9] is -3.", "Minimum of [12, 5] is 5."]);
  expect(episodes[0].id).toBe("min");
  const changes = (await app.inject({ url: `/api/enrollments/${job.id}/personal-changes`, headers: headers(job.learner) })).json().changes;
  expect(changes).toEqual([expect.objectContaining({ kind: "insert_episode", provenance: "generated", unverified: true,
    transferChecks: [{ objectiveId: "minimum", status: "pending" }] })]);
  // "I don't know yet" gives no answer: the record stays pending rather than failing.
  const unsure = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/challenges`, headers: headers(job.learner),
    payload: { expectedRevision: after.revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-b", mode: "independent" } });
  expect(unsure.statusCode, unsure.body).toBe(200);
  const abstained = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/answers`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), challengeId: unsure.json().challengeId, abstain: true } });
  expect(abstained.json().result, abstained.body).toMatchObject({ abstained: true, passed: false });
  expect((await app.inject({ url: `/api/enrollments/${job.id}/personal-changes`, headers: headers(job.learner) })).json().changes[0].transferChecks)
    .toEqual([{ objectiveId: "minimum", status: "pending" }]);
  // The learner's next independent attempt on that objective resolves the record; it is not evidence itself.
  const challenge = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/challenges`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-a", mode: "independent" } });
  expect(challenge.statusCode, challenge.body).toBe(200);
  const answered = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/answers`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), challengeId: challenge.json().challengeId, answer: "two" } });
  expect(answered.statusCode, answered.body).toBe(200);
  const resolved = (await app.inject({ url: `/api/enrollments/${job.id}/personal-changes`, headers: headers(job.learner) })).json().changes;
  expect(resolved[0].transferChecks).toEqual([{ objectiveId: "minimum", status: "passed" }]);
}, 30000);

/** The lesson release with a reviewed written explanation on the objective the lesson teaches. */
const withWrittenItem = (course: typeof fixture.course) => {
  const written = rubricCourse();
  course.extensions.push(written.extensions.find((e) => e.id === RUBRIC_EVALUATOR_ID)!);
  course.assessments.push(written.assessments.find((a) => a.id === "min-explain")!);
  legacyGate(course.gates.find((g) => g.id === "min-gate")).assessmentIds.push("min-explain");
};
/** Delivers a generated lesson on "minimum", which records a pending transfer check. */
async function deliveredLesson(release: string) {
  const job = await prepare(true, false, undefined, release);
  lessonScript(job, "generated-lesson-profile", "Finding a minimum, step by step", ["Minimum of [4, -3, 9] is -3.", "Minimum of [12, 5] is 5."]);
  await invoke(job);
  expect((await transition({ type: "verify", ref: job.ref })).json().snapshot.state).toBe("ready");
  expect((await transition({ type: "apply", ref: job.ref })).json().snapshot.state).toBe("applied");
  return job;
}
async function submitWritten(job: Awaited<ReturnType<typeof prepare>>) {
  const challenge = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/challenges`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-explain", mode: "independent" } });
  expect(challenge.statusCode, challenge.body).toBe(200);
  const answered = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/answers`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), challengeId: challenge.json().challengeId, answer: rubricExplanation } });
  expect(answered.json().result, answered.body).toMatchObject({ pendingReview: true, passed: false, independent: true });
  return (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 AND assessment_id='min-explain'", [job.id])).rows[0].id as string;
}
const metFindings = [
  { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
  { criterionId: "every-element", met: true, quote: "compare every next element with it" },
  { criterionId: "edge", met: false },
];
const notMetFindings = metFindings.map((f) => f.criterionId === "invariant" ? { criterionId: f.criterionId, met: false } : f);
async function transferState(job: Awaited<ReturnType<typeof prepare>>) {
  // The learner's read-only view, the stored resolution (as the supervisor's evidence tool stores it), then the stored row.
  const learnerView = (await app.inject({ url: `/api/enrollments/${job.id}/personal-changes`, headers: headers(job.learner) })).json().changes[0].transferChecks;
  const persisted = (await transaction(db, async (client) => {
    const course = (await client.query("SELECT r.server_bundle FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=$1", [job.id])).rows[0].server_bundle;
    return transferChecks(client, job.id, course, true);
  })).map((c) => ({ objectiveId: c.objectiveId, status: c.status }));
  const stored = (await db.query("SELECT objective_id,status,attempt_id FROM adaptation_transfer_checks WHERE enrollment_id=$1", [job.id])).rows;
  return { learnerView, persisted, stored };
}

it("a written answer awaiting review leaves the transfer check pending, then the review's not-met decision fails it", async () => {
  const release = await lessonRelease(withWrittenItem), job = await deliveredLesson(release), reviewer = await login("instructor");
  const attemptId = await submitWritten(job);
  // Awaiting review is not a wrong answer: nothing resolves, in the view or in storage.
  expect(await transferState(job)).toEqual({ learnerView: [{ objectiveId: "minimum", status: "pending" }], persisted: [{ objectiveId: "minimum", status: "pending" }],
    stored: [{ objective_id: "minimum", status: "pending", attempt_id: null }] });
  // Nor does the window expire it: the learner answered in time and the review is still owed.
  await db.query("UPDATE adaptation_transfer_checks SET delivered_at=delivered_at-interval '31 days' WHERE enrollment_id=$1", [job.id]);
  // A later deterministic attempt does not jump ahead of the answer still under review.
  const challenge = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/challenges`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-a", mode: "independent" } });
  expect(challenge.statusCode, challenge.body).toBe(200);
  const answered = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/answers`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), challengeId: challenge.json().challengeId, answer: "two" } });
  expect(answered.json().result, answered.body).toMatchObject({ passed: true });
  expect((await transferState(job)).stored).toEqual([{ objective_id: "minimum", status: "pending", attempt_id: null }]);
  const reviewed = await app.inject({ method: "POST", url: `/api/admin/rubric-reviews/${attemptId}`, headers: headers(reviewer),
    payload: { decision: "not_met", criteria: notMetFindings, idempotencyKey: "k-" + randomUUID() } });
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  expect(await transferState(job)).toEqual({ learnerView: [{ objectiveId: "minimum", status: "failed" }], persisted: [{ objectiveId: "minimum", status: "failed" }],
    stored: [{ objective_id: "minimum", status: "failed", attempt_id: attemptId }] });
}, 30000);

it("a clarification request keeps the transfer check pending; the independent reply's met review passes it", async () => {
  const release = await lessonRelease(withWrittenItem), job = await deliveredLesson(release), reviewer = await login("instructor");
  const attemptId = await submitWritten(job);
  const asked = await app.inject({ method: "POST", url: `/api/admin/rubric-reviews/${attemptId}`, headers: headers(reviewer),
    payload: { decision: "needs_clarification", probeOnly: true, criteria: notMetFindings, learnerNote: "Say what stays true after each comparison.", idempotencyKey: "k-" + randomUUID() } });
  expect(asked.statusCode, asked.body).toBe(200);
  expect((await transferState(job)).stored).toEqual([{ objective_id: "minimum", status: "pending", attempt_id: null }]);
  const reply = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/reviews/${attemptId}/reply`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(),
      answer: "After each comparison the kept value is never greater than any element seen so far, because I compare every next element with it." } });
  expect(reply.statusCode, reply.body).toBe(200);
  const replyId = reply.json().attemptId;
  // The reply waits for review too.
  expect((await transferState(job)).learnerView).toEqual([{ objectiveId: "minimum", status: "pending" }]);
  const met = await app.inject({ method: "POST", url: `/api/admin/rubric-reviews/${replyId}`, headers: headers(reviewer),
    payload: { decision: "met", criteria: metFindings, idempotencyKey: "k-" + randomUUID() } });
  expect(met.statusCode, met.body).toBe(200);
  expect(await transferState(job)).toEqual({ learnerView: [{ objectiveId: "minimum", status: "passed" }], persisted: [{ objectiveId: "minimum", status: "passed" }],
    stored: [{ objective_id: "minimum", status: "passed", attempt_id: replyId }] });
}, 30000);

it("an appeal that changes the review amends a resolved transfer check beside its original resolution, with an audit record", async () => {
  const release = await lessonRelease(withWrittenItem), job = await deliveredLesson(release);
  const reviewer = await login("instructor"), second = await login("instructor");
  const attemptId = await submitWritten(job);
  const reviewed = await app.inject({ method: "POST", url: `/api/admin/rubric-reviews/${attemptId}`, headers: headers(reviewer),
    payload: { decision: "not_met", criteria: notMetFindings, idempotencyKey: "k-" + randomUUID() } });
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  expect((await transferState(job)).stored).toEqual([{ objective_id: "minimum", status: "failed", attempt_id: attemptId }]);
  const resolvedAt = (await db.query("SELECT resolved_at FROM adaptation_transfer_checks WHERE enrollment_id=$1", [job.id])).rows[0].resolved_at;
  const appeal = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/reviews/${attemptId}/appeal`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), reason: "I did state the invariant in my first sentence." } });
  expect(appeal.statusCode, appeal.body).toBe(200);
  const appealId = appeal.json().appealId;
  // An open appeal changes nothing yet.
  expect((await transferState(job)).learnerView).toEqual([{ objectiveId: "minimum", status: "failed" }]);
  const decided = await app.inject({ method: "POST", url: `/api/admin/rubric-appeals/${appealId}`, headers: headers(second),
    payload: { decision: "met", criteria: metFindings, note: "The invariant is stated and quoted.", idempotencyKey: "k-" + randomUUID() } });
  expect(decided.statusCode, decided.body).toBe(200);
  expect(decided.json().state).toBe("changed");
  // The amended outcome is reported, naming the original; the stored resolution is kept as it was.
  expect(await transferState(job)).toEqual({
    learnerView: [{ objectiveId: "minimum", status: "passed", amendedFrom: "failed" }],
    persisted: [{ objectiveId: "minimum", status: "passed" }],
    stored: [{ objective_id: "minimum", status: "failed", attempt_id: attemptId }] });
  const row = (await db.query("SELECT status,resolved_at,amended_status,amended_by_appeal_id FROM adaptation_transfer_checks WHERE enrollment_id=$1", [job.id])).rows[0];
  expect(row).toEqual({ status: "failed", resolved_at: resolvedAt, amended_status: "passed", amended_by_appeal_id: appealId });
  // Postgres refuses to rewrite the original resolution or the amendment.
  await expect(db.query("UPDATE adaptation_transfer_checks SET status='passed' WHERE enrollment_id=$1", [job.id])).rejects.toThrow(/TRANSFER_CHECK_RESOLUTION_IMMUTABLE/);
  await expect(db.query("UPDATE adaptation_transfer_checks SET amended_status='failed' WHERE enrollment_id=$1", [job.id])).rejects.toThrow(/TRANSFER_CHECK_AMENDMENT_IMMUTABLE|adaptation_transfer_checks_amendment/);
  // The amendment is audited as a system event that staff can read.
  const events = (await db.query("SELECT actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='adaptation.transfer_check_amended'", [job.id])).rows;
  expect(events).toEqual([{ actor_kind: "system", payload: { proposalId: expect.any(String), objectiveId: "minimum", attemptId, appealId,
    statusBefore: "failed", statusAfter: "passed", originalKept: true } }]);
  const audit = await app.inject({ url: `/api/admin/workspaces/${workspace}/audit?type=adaptation.transfer_check_amended`, headers: headers(owner) });
  expect(audit.statusCode, audit.body).toBe(200);
  expect(audit.json().events.filter((e: any) => e.enrollmentId === job.id)).toEqual([expect.objectContaining({ actorKind: "system",
    payload: expect.objectContaining({ appealId, statusBefore: "failed", statusAfter: "passed" }) })]);
}, 30000);

it("a reviewed conversation whose reply was not independent does not resolve a transfer check", async () => {
  const release = await lessonRelease(withWrittenItem), job = await deliveredLesson(release), reviewer = await login("instructor");
  const attemptId = await submitWritten(job);
  // Not a neutral probe: the reviewer's question shapes the reply, so the reply is assisted.
  const asked = await app.inject({ method: "POST", url: `/api/admin/rubric-reviews/${attemptId}`, headers: headers(reviewer),
    payload: { decision: "needs_clarification", criteria: notMetFindings, learnerNote: "Say what stays true after each comparison.", idempotencyKey: "k-" + randomUUID() } });
  expect(asked.statusCode, asked.body).toBe(200);
  const reply = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/reviews/${attemptId}/reply`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(),
      answer: "After each comparison the kept value is never greater than any element seen so far, because I compare every next element with it." } });
  expect(reply.json(), reply.body).toMatchObject({ independent: false });
  const met = await app.inject({ method: "POST", url: `/api/admin/rubric-reviews/${reply.json().attemptId}`, headers: headers(reviewer),
    payload: { decision: "met", criteria: metFindings, idempotencyKey: "k-" + randomUUID() } });
  expect(met.statusCode, met.body).toBe(200);
  expect((await transferState(job)).stored).toEqual([{ objective_id: "minimum", status: "pending", attempt_id: null }]);
}, 30000);

it("an answer to a check that became assisted does not resolve a transfer check; the next independent answer does", async () => {
  const release = await lessonRelease(), job = await deliveredLesson(release);
  const issue = async (assessmentId: string) => {
    const challenge = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/challenges`, headers: headers(job.learner),
      payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId, mode: "independent" } });
    expect(challenge.statusCode, challenge.body).toBe(200);
    return challenge.json().challengeId as string;
  };
  const answer = async (challengeId: string, value: unknown) => {
    const answered = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/answers`, headers: headers(job.learner),
      payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), challengeId, answer: value } });
    expect(answered.statusCode, answered.body).toBe(200);
    return answered.json().result;
  };
  // The learner reveals the answer: the check stays in independent mode but is now assisted.
  const assisted = await issue("min-a");
  const revealed = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/solution`, headers: headers(job.learner),
    payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), challengeId: assisted } });
  expect(revealed.statusCode, revealed.body).toBe(200);
  expect(await answer(assisted, "two")).toMatchObject({ passed: true, independent: false });
  expect((await db.query("SELECT mode,assistance FROM attempts WHERE enrollment_id=$1", [job.id])).rows).toEqual([{ mode: "independent", assistance: "solution" }]);
  expect(await transferState(job)).toEqual({ learnerView: [{ objectiveId: "minimum", status: "pending" }], persisted: [{ objectiveId: "minimum", status: "pending" }],
    stored: [{ objective_id: "minimum", status: "pending", attempt_id: null }] });
  // The next independent answer resolves it.
  expect(await answer(await issue("min-b"), 99)).toMatchObject({ passed: false, independent: true });
  const independentAttempt = (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 AND assistance='none'", [job.id])).rows[0].id;
  expect(await transferState(job)).toEqual({ learnerView: [{ objectiveId: "minimum", status: "failed" }], persisted: [{ objectiveId: "minimum", status: "failed" }],
    stored: [{ objective_id: "minimum", status: "failed", attempt_id: independentAttempt }] });
}, 30000);

it("names \"I don't know yet\" as an abstention in the supervisor's context, not as a wrong answer", async () => {
  const job = await prepare(true, false, undefined, releaseId, async ({ id, learner, revision }) => {
    const challenge = await app.inject({ method: "POST", url: `/api/enrollments/${id}/challenges`, headers: headers(learner),
      payload: { expectedRevision: await revision(), idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-b", mode: "independent" } });
    expect(challenge.statusCode, challenge.body).toBe(200);
    const abstained = await app.inject({ method: "POST", url: `/api/enrollments/${id}/answers`, headers: headers(learner),
      payload: { expectedRevision: await revision(), idempotencyKey: randomUUID(), challengeId: challenge.json().challengeId, abstain: true } });
    expect(abstained.json().result, abstained.body).toMatchObject({ abstained: true, passed: false });
  });
  const resolved = await resolveSupervisorOperation(db, job.request);
  const recent = (await teachingContext(db, resolved.ref, resolved.input.context)).learner.recentAttempts ?? [];
  expect(recent.find((a) => a.assessmentId === "min-b")).toMatchObject({ abstained: true, passed: false });
  expect(recent.filter((a) => a.abstained === true)).toHaveLength(1);
});

it("an inaccessible generated lesson is check feedback and never becomes ready, and an advanced branch needs the anchor's checkpoint passed", async () => {
  const release = await lessonRelease(), job = await prepare(true, false, undefined, release);
  lessonScript(job, "generated-lesson-profile", "Look at the red line", ["Minimum of [4, -3, 9] is -3."]);
  await invoke(job);
  expect((await toolOutcome(job, "check_teaching")).result).toMatchObject({ verification: "rejected",
    failedCheckIds: ["host-accessibility"], accessibilityProblems: ["color_only_reference"] });
  expect((await transition({ type: "verify", ref: job.ref })).json().snapshot?.state).not.toBe("ready");
  expect((await job.snapshot()).course.chapters[0].episodes).toHaveLength(2);
  // Not yet earned: the advanced branch is not offered, and the host refuses it at delivery too.
  const advanced = await prepare(true, false, undefined, release);
  modelScripts.set(createHash("sha256").update(advanced.request.operationId).digest("hex"), (round) =>
    round === 0 ? { decision: "tool", tool: "list_generation_profiles", argumentsJson: "{}", summary: "" }
    : { decision: "finish", tool: "none", argumentsJson: "{}", summary: "Nothing advanced to offer yet." });
  await invoke(advanced);
  expect((await toolOutcome(advanced, "list_generation_profiles")).result.profiles.map((p: any) => p.id)).not.toContain("generated-advanced-profile");
}, 30000);

it("an advanced branch is offered once the anchor's objectives are demonstrated and is inserted as an optional lesson", async () => {
  const release = await lessonRelease(), job = await prepare(true, false, undefined, release);
  for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
    const issued = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/challenges`, headers: headers(job.learner),
      payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId, mode: "independent" } });
    expect(issued.statusCode, issued.body).toBe(200);
    const answered = await app.inject({ method: "POST", url: `/api/enrollments/${job.id}/answers`, headers: headers(job.learner),
      payload: { expectedRevision: (await job.snapshot()).revision, idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer } });
    expect(answered.json().result.passed).toBe(true);
  }
  // The first job never ran (a certified non-start releases its reservation); a new job for the
  // same enrollment is admitted at the current evidence fence.
  await bridge.transition({ type: "settle", ref: job.ref, operationId: job.operation.id, ownerId: job.operation.ownerId, outcome: { status: "not_started", retryable: false } });
  const event = await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: job.id, actorId: job.learner.id,
    actorKind: "learner", type: "learning.review_requested", payload: { episodeId: "min" }, idempotencyKey: randomUUID(), supervise: true }));
  const outbox = (await bridge.claimOutbox(randomUUID(), 100, 30000)).find((e) => e.eventId === event.id)!;
  const [ref] = await bridge.prepareOutbox(outbox); await bridge.ackOutbox(outbox);
  const claimed = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  expect([claimed.effect, claimed.snapshot.state, claimed.snapshot.reason]).toEqual(["invoke", "analyzing", null]);
  const operation = claimed.snapshot.operations[0]!;
  const next = { ...job, ref: ref!, operation, request: { schemaVersion: 1 as const, operationId: operation.id, job: claimed.snapshot.specification.key,
    role: "supervisor" as const, checkpoint: claimed.snapshot.specification.checkpoints[0]!, fence: claimed.snapshot.specification.fence } };
  lessonScript(next, "generated-advanced-profile", "Going further with minimums", ["Minimum of [100, -100, 0] is -100."]);
  await invoke(next);
  expect((await toolOutcome(next, "list_generation_profiles")).result.profiles.map((p: any) => p.id)).toContain("generated-advanced-profile");
  expect((await toolOutcome(next, "check_teaching")).result).toMatchObject({ verification: "passed" });
  expect((await transition({ type: "verify", ref: next.ref })).json().snapshot.state).toBe("ready");
  expect((await transition({ type: "apply", ref: next.ref })).json().snapshot.state).toBe("applied");
  const view = await job.snapshot();
  expect(view.course.chapters[0].episodes[1]).toMatchObject({ title: "Going further with minimums", requirement: "optional" });
  expect(view.lessons.find((l: any) => l.id === view.course.chapters[0].episodes[1].id)).toMatchObject({ requirement: "optional" });
}, 30000);
