import { randomUUID, randomBytes } from "node:crypto";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import {
  HttpHostBridge,
  HttpProviderGateway,
  dispatchOnce,
  workflowId,
  type RunRef,
  type HostBridge,
  type ProviderGateway,
  type Activities,
  type WorkflowStarter,
} from "@course-core/supervisor";
import type { Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { configureSupervisorBudget } from "../src/supervisor-bridge.js";
import { composeProviders } from "../src/provider-composition.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { credentialVault } from "../src/key-vault.js";
import { transaction } from "../src/database.js";
import { appendEvent } from "../src/events.js";
import { supervisorSupportFixture } from "../test/supervisor-support-fixture.js";

export class ToolsFlowFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function check(v: unknown, code: string): asserts v {
  if (!v) throw new ToolsFlowFailure(code);
}
async function bounded<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ToolsFlowFailure("tool_flow_timeout")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Actual PG + HTTP + Temporal tool delivery. Only the external model is
 * synthetic. Loss occurs AFTER application commits, followed by worker restart. */
export async function qualifySupervisorTools(
  db: Database,
  env: TestWorkflowEnvironment,
  bundle: NonNullable<Parameters<typeof Worker.create>[0]["workflowBundle"]>,
  workspaceSetup = false,
  rotateDuringCall = false,
  modelSuggestionFlow = false,
) {
  const fixture = supervisorSupportFixture(),
    workspace = randomUUID(),
    serviceToken = randomUUID(),
    origin = "http://localhost:4310",
    historyCanary = "TOOL_HISTORY_" + randomUUID();
  const selectedKeys: string[] = [],
    workspaceKey = "WORKSPACE_KEY_" + randomUUID();
  const prompts: string[] = [],
    workers: Array<{ worker: Worker; result: Promise<unknown> }> = [];
  const usage: UsageReceipt = {
    accounting: { accountingKey: "synthetic" },
    providerId: "qualification-tools",
    modelId: "planner",
    operation: "assess",
    attempts: [
      {
        attempt: 1,
        status: 200,
        outcome: "response",
        tokens: {
          input: 20,
          output: 10,
          total: 30,
          cachedInput: 0,
          thoughts: 0,
          toolInput: 0,
        },
      },
    ],
    inputCharacters: 1000,
    requestedMaxOutputTokens: 1000,
    requestedVideoSeconds: null,
    observedImageCount: null,
    observedVideoCount: null,
    cost: null,
  };
  let releaseHeld!: () => void, enteredHeld!: () => void;
  const held = new Promise<void>((done) => {
      releaseHeld = done;
    }),
    entered = new Promise<void>((done) => {
      enteredHeld = done;
    });
  const adapter: ProviderAdapter = {
    providerId: "qualification-tools",
    validateModel() {},
    ports: {
      structured_assessment: {
        async assess(req) {
          prompts.push(req.messages[0]!.text);
          if (rotateDuringCall && prompts.length === 1) {
            enteredHeld();
            await bounded(held, 30000);
          }
          const round = Number(
            req.accounting.accountingKey.split(":round-")[1],
          );
          const prompt = JSON.parse(req.messages[0]!.text);
          const output = modelSuggestionFlow
            ? round === 0
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
                      "Propose a source-linked explanation style for learner review.",
                  }
            : round === 0
              ? {
                  decision: "tool",
                  tool: "get_history",
                  argumentsJson: "{}",
                  summary: "",
                }
              : round === 1
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
                    summary: "Use reviewed ordering support.",
                  };
          return { output, usage };
        },
      },
    },
  };
  const providers = composeProviders(
    {
      registry: {
        revision: "tool-flow",
        models: [
          {
            id: "planner",
            providerId: adapter.providerId,
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
          id: adapter.providerId,
          kind: "test",
          credentialEnv: "COURSE_PROVIDER_TOOL_FLOW_API_KEY",
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
  const workspaceProviders = workspaceSetup
    ? new WorkspaceProviders(db, credentialVault(randomBytes(32)), {
        test: ({ getCredential }) => ({
          ...adapter,
          ports: {
            structured_assessment: {
              async assess(req, options) {
                selectedKeys.push(getCredential() ?? "MISSING");
                return adapter.ports.structured_assessment!.assess(
                  req,
                  options,
                );
              },
            },
          },
        }),
      })
    : undefined;
  const app = await createServer(db, {
    ...(workspaceProviders ? { workspaceProviders } : {}),
    origin,
    secureCookies: false,
    providers,
    adaptation: fixture.runtime,
    supervisor: {
      serviceToken,
      workspaceIds: [workspace],
      jobPolicy: {
        allowance: { microUsd: 100000, tokens: 600000 },
        durationMs: 180000,
        timeoutMs: 30000,
        maxAttempts: 3,
      },
    },
  });
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    async function http(
      method: string,
      path: string,
      payload?: unknown,
      session?: { cookie: string; csrf: string },
    ) {
      const res = await fetch(base + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          origin,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(session
            ? { cookie: session.cookie, "x-csrf-token": session.csrf }
            : {}),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      check(res.ok, "tool_flow_http_rejected");
      return { res, data: (await res.json()) as any };
    }
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
      workspace,
      "tools-" + randomUUID(),
      "Tool flow qualification",
    ]);
    async function login(role: string) {
      const id = randomUUID();
      await db.query(
        "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
        [id, "tool-flow:" + id, "Qualification learner"],
      );
      await db.query(
        "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [workspace, id, role],
      );
      const { res, data } = await http("POST", "/auth/redeem", {
        token: await issueLoginCode(db, id),
      });
      return {
        id,
        cookie: res.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; "),
        csrf: String(data.csrfToken),
      };
    }
    const owner = await login("owner");
    if (workspaceSetup)
      await http(
        "POST",
        `/api/admin/workspaces/${workspace}/provider-setup`,
        {
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          configuration: {
            registry: {
              revision: "workspace-tools",
              models: [
                {
                  id: "planner",
                  providerId: "qualification-tools",
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
                id: "qualification-tools",
                kind: "test",
                credentialEnv: "COURSE_PROVIDER_TOOL_FLOW_API_KEY",
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
          jobPolicy: {
            allowance: { microUsd: 100000, tokens: 615001 },
            durationMs: 180000,
            timeoutMs: 30000,
            maxAttempts: 3,
          },
          credentials: { COURSE_PROVIDER_TOOL_FLOW_API_KEY: workspaceKey },
        },
        owner,
      );
    const release = (
      await http(
        "POST",
        `/api/workspaces/${workspace}/releases`,
        fixture.course,
        owner,
      )
    ).data;
    await http("POST", `/api/releases/${release.id}/publish`, {}, owner);
    await http(
      "POST",
      `/api/admin/releases/${release.id}/adaptation-registry`,
      { expectedRegistryRevision: 0, configuration: fixture.config },
      owner,
    );
    const learner = await login("learner"),
      id = String(
        (
          await http(
            "POST",
            "/api/enrollments",
            { releaseId: release.id },
            learner,
          )
        ).data.id,
      ),
      before = (await http("GET", `/api/enrollments/${id}`, undefined, learner))
        .data;
    await http(
      "POST",
      `/api/enrollments/${id}/supervision`,
      {
        expectedRevision: before.revision,
        idempotencyKey: randomUUID(),
        adaptiveTeaching: true,
      },
      learner,
    );
    const historyMessageId = randomUUID();
    await db.query(
      "INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,'learner',$3,$4)",
      [
        historyMessageId,
        id,
        historyCanary,
        JSON.stringify({ episodeId: "min" }),
      ],
    );
    if (modelSuggestionFlow)
      await transaction(db, (client) =>
        appendEvent(client, {
          workspaceId: workspace,
          enrollmentId: id,
          actorId: learner.id,
          actorKind: "learner",
          type: "companion.requested",
          payload: { messageId: historyMessageId, episodeId: "min" },
          idempotencyKey: randomUUID(),
          supervise: false,
        }),
      );
    await configureSupervisorBudget(
      db,
      { workspaceId: workspace },
      { microUsd: 1000000, tokens: 2000000 },
    );
    await configureSupervisorBudget(
      db,
      { workspaceId: workspace, enrollmentId: id },
      { microUsd: 1000000, tokens: 2000000 },
    );
    // The actual enrollment.started event is already in the transactional
    // outbox. Dispatch it after learner consent/history setup; do not fabricate
    // a second job just to trigger the qualification.
    const root = new URL(import.meta.resolve("@course-core/supervisor"));
    const queue = "tool-flow-" + randomUUID(),
      { temporalActivities } = (await import(
        new URL("./temporal/activities.js", root).href
      )) as {
        temporalActivities: (
          bridge: HostBridge,
          provider: ProviderGateway,
        ) => Activities;
      },
      { temporalStarter } = (await import(
        new URL("./temporal/client.js", root).href
      )) as {
        temporalStarter: (
          client: TestWorkflowEnvironment["client"],
          queue: string,
        ) => WorkflowStarter;
      };
    let dropped = false,
      resolveLost!: () => void;
    const lost = new Promise<void>((done) => {
      resolveLost = done;
    });
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init),
        body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (
        !dropped &&
        response.ok &&
        body?.method === "transition" &&
        body.command?.type === "apply"
      ) {
        const result = await response.clone().json();
        if (result.snapshot.state === "applied") {
          await response.arrayBuffer();
          dropped = true;
          resolveLost();
          throw Error("injected_apply_ack_loss");
        }
      }
      return response;
    };
    async function start(fetcher: typeof fetch) {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: queue,
        workflowBundle: bundle,
        activities: temporalActivities(
          new HttpHostBridge(base, serviceToken, 10000, fetcher),
          new HttpProviderGateway(base, serviceToken),
        ),
        shutdownGraceTime: "3 seconds",
        maxConcurrentActivityTaskExecutions: 2,
        maxConcurrentWorkflowTaskExecutions: 2,
      });
      const run = {
        worker,
        result: worker.run().then(
          () => undefined,
          (e) => e,
        ),
      };
      workers.push(run);
      return run;
    }
    const first = await start(lossy),
      refs: RunRef[] = [],
      native = temporalStarter(env.client, queue);
    const dispatch = await dispatchOnce(
      new HttpHostBridge(base, serviceToken),
      {
        async start(ref, wid) {
          refs.push(ref);
          await native.start(ref, wid);
        },
      },
      { limit: 100 },
    );
    check(
      dispatch.delivered === 1 && refs.length === 1,
      `tool_flow_dispatch_failed_delivered_${dispatch.delivered}_refs_${refs.length}_deferred_${dispatch.deferred}_failed_${dispatch.failed}`,
    );
    if (rotateDuringCall) {
      check(workspaceSetup, "rotation_requires_workspace_configuration");
      await bounded(entered, 30000);
      const settings = (
          await http(
            "GET",
            `/api/admin/workspaces/${workspace}/provider-setup`,
            undefined,
            owner,
          )
        ).data,
        rotatedKey = "ROTATED_WORKSPACE_KEY_" + randomUUID();
      await http(
        "POST",
        `/api/admin/workspaces/${workspace}/provider-setup`,
        {
          expectedRevision: settings.revision,
          idempotencyKey: randomUUID(),
          configuration: settings.configuration,
          jobPolicy: settings.jobPolicy,
          credentials: { COURSE_PROVIDER_TOOL_FLOW_API_KEY: rotatedKey },
        },
        owner,
      );
      releaseHeld();
      const ref = refs[0]!,
        wid = workflowId(ref);
      await bounded(env.client.workflow.getHandle(wid).result(), 45000);
      first.worker.shutdown();
      check(
        (await bounded(first.result, 15000)) === undefined,
        "rotation_worker_failed",
      );
      const job = (
          await db.query(
            "SELECT state,provider_revision FROM supervisor_jobs WHERE id=$1 AND workspace_id=$2",
            [ref.jobId, workspace],
          )
        ).rows[0],
        after = (
          await http("GET", `/api/enrollments/${id}`, undefined, learner)
        ).data;
      check(
        job.state === "cancelled" &&
          job.provider_revision === 1 &&
          after.planRevision === 0,
        "rotation_failed_to_fence_lesson",
      );
      check(
        prompts.length === 1 &&
          selectedKeys.length === 1 &&
          selectedKeys[0] === workspaceKey,
        "rotation_started_another_model_round",
      );
      const dispatch = (
        await db.query(
          "SELECT state,provider_usage FROM provider_dispatches WHERE job_id=$1 AND enrollment_id=$2",
          [ref.jobId, id],
        )
      ).rows;
      check(
        dispatch.length === 1 &&
          dispatch[0].state === "uncertain" &&
          dispatch[0].provider_usage.attempts.length === 1,
        "rotation_lost_observed_usage",
      );
      for (const table of ["evidence", "supervisor_plan_effects"])
        check(
          Number(
            (
              await db.query(
                `SELECT count(*) FROM ${table} WHERE enrollment_id=$1`,
                [id],
              )
            ).rows[0].count,
          ) === 0,
          "rotation_granted_an_effect",
        );
      for (const table of [
        "supervisor_workspace_budgets",
        "supervisor_enrollment_budgets",
      ]) {
        const row = (
          await db.query(
            `SELECT used_micro_usd,used_tokens FROM ${table} WHERE ${table.includes("workspace") ? "workspace_id" : "enrollment_id"}=$1`,
            [table.includes("workspace") ? workspace : id],
          )
        ).rows[0];
        check(
          Number(row.used_micro_usd) === 100000 &&
            Number(row.used_tokens) === 615001,
          "rotation_refunded_uncertain_reservation",
        );
      }
      return {
        wid,
        ref,
        canaries: [
          serviceToken,
          historyCanary,
          fixture.markdown,
          workspaceKey,
          rotatedKey,
        ],
        modelCalls: 1,
        workerRestarts: 0,
        applyAckLoss: 0,
      };
    }
    await bounded(lost, 30000);
    first.worker.shutdown();
    check(
      (await bounded(first.result, 15000)) === undefined,
      "tool_flow_worker_failed",
    );
    const second = await start(fetch),
      ref = refs[0]!,
      wid = workflowId(ref);
    await bounded(env.client.workflow.getHandle(wid).result(), 45000);
    second.worker.shutdown();
    check(
      (await bounded(second.result, 15000)) === undefined,
      "tool_flow_replacement_failed",
    );
    if (workspaceSetup) {
      const row = (
        await db.query(
          "SELECT provider_revision,specification FROM supervisor_jobs WHERE id=$1 AND workspace_id=$2",
          [ref.jobId, workspace],
        )
      ).rows[0];
      check(
        row.provider_revision === 1 &&
          row.specification.budget.tokens === 615001,
        "workspace_binding_or_admission_missing",
      );
      check(
        selectedKeys.length === 3 &&
          selectedKeys.every((k) => k === workspaceKey),
        "workspace_credentials_not_used",
      );
    }
    const after = (
      await http("GET", `/api/enrollments/${id}`, undefined, learner)
    ).data;
    if (modelSuggestionFlow) {
      check(after.planRevision === 0, "model_suggestion_changed_lesson_plan");
      const model = (
        await http(
          "GET",
          `/api/enrollments/${id}/learner-model?episodeId=min`,
          undefined,
          learner,
        )
      ).data;
      check(
        model.suggestions.items.length === 1 &&
          model.suggestions.items[0].status === "pending",
        "model_suggestion_missing_or_duplicate",
      );
      const proposal = model.suggestions.items[0];
      check(
        proposal.grantsMastery === false &&
          proposal.suggestion.value === "step_by_step",
        "model_suggestion_claimed_credit",
      );
      const feedback = (
        await db.query(
          "SELECT count(*) FROM outbox o JOIN learning_events e ON e.id=o.event_id WHERE e.enrollment_id=$1 AND e.event_type='learner_model.proposal.created' AND o.kind='supervisor.event'",
          [id],
        )
      ).rows[0];
      check(feedback.count === "0", "model_suggestion_feedback_loop");
      const decision = await http(
        "POST",
        `/api/enrollments/${id}/learner-model/proposals/${proposal.proposalId}/decision`,
        {
          expectedRevision: after.revision,
          idempotencyKey: randomUUID(),
          action: "correct",
          correction: { kind: "explanation_style", value: "worked_example" },
        },
        learner,
      );
      check(
        decision.data.grantsMastery === false,
        "model_review_granted_credit",
      );
      const corrected = (
        await http(
          "GET",
          `/api/enrollments/${id}/learner-model?episodeId=min`,
          undefined,
          learner,
        )
      ).data;
      check(
        corrected.suggestions.items[0].status === "corrected" &&
          corrected.suggestions.items[0].suggestion.value === "worked_example",
        "model_correction_not_saved",
      );
    } else
      check(
        after.planRevision === 1 &&
          after.course.chapters[0].episodes[0].blocks.some(
            (b: any) => b.type === "text" && b.markdown === fixture.markdown,
          ),
        "tool_flow_no_lesson_effect",
      );
    check(
      JSON.stringify(after.lessons[0].gate) ===
        JSON.stringify(before.lessons[0].gate),
      "tool_flow_changed_gate",
    );
    for (const table of ["evidence", "attempts"])
      check(
        Number(
          (
            await db.query(
              `SELECT count(*) FROM ${table} WHERE enrollment_id=$1`,
              [id],
            )
          ).rows[0].count,
        ) === 0,
        "tool_flow_granted_credit",
      );
    check(
      Number(
        (
          await db.query(
            modelSuggestionFlow
              ? "SELECT count(*) FROM supervisor_model_effects WHERE enrollment_id=$1"
              : "SELECT count(*) FROM supervisor_plan_effects WHERE enrollment_id=$1",
            [id],
          )
        ).rows[0].count,
      ) === 1,
      "tool_flow_duplicate_effect",
    );
    check(
      prompts.length === 3 &&
        (modelSuggestionFlow || prompts[1]!.includes(historyCanary)),
      "tool_flow_history_missing_or_recalled",
    );
    for (const table of [
      "supervisor_workspace_budgets",
      "supervisor_enrollment_budgets",
    ]) {
      const row = (
        await db.query(
          `SELECT used_micro_usd,used_tokens FROM ${table} WHERE ${table.includes("workspace") ? "workspace_id" : "enrollment_id"}=$1`,
          [table.includes("workspace") ? workspace : id],
        )
      ).rows[0];
      check(
        Number(row.used_micro_usd) === 100000 && Number(row.used_tokens) === 90,
        "tool_flow_duplicate_cost",
      );
    }
    const timeline = (
      await http(
        "GET",
        `/api/enrollments/${id}/supervision/tools`,
        undefined,
        learner,
      )
    ).data;
    check(
      timeline.calls.length === 2 &&
        !JSON.stringify(timeline).includes(historyCanary) &&
        !JSON.stringify(timeline).includes(fixture.markdown),
      "tool_flow_timeline_leak",
    );
    return {
      wid,
      ref,
      canaries: [
        serviceToken,
        historyCanary,
        fixture.markdown,
        ...(workspaceSetup ? [workspaceKey] : []),
      ],
      modelCalls: prompts.length,
      workerRestarts: 1,
      applyAckLoss: 1,
    };
  } finally {
    releaseHeld();
    for (const run of workers) {
      if (run.worker.getState() === "RUNNING") run.worker.shutdown();
      await bounded(run.result, 15000);
    }
    await app.close();
  }
}
