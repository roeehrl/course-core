import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { definiteRejection, priceUsage, pricingCovers, ProviderError, type ModelPricing, type UsageReceipt } from "@course-core/providers";
import type { Actor, authService } from "./auth.js";
import { workspaceRole } from "./course-access.js";
import { afterCommitTransaction, onCommit } from "./after-commit.js";
import { transaction, type Database } from "./database.js";
import { ApiError, requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { evaluateActivation, roleChecks, uncheckedRoles, type ProviderEvaluations, type VersionEvaluation } from "./agent-evals/gate.js";
import { runSuite, type CallRecord, type EvalReport } from "./agent-evals/runner.js";
import { dialoguesFor, EVAL_ROLES, type Dialogue, type EvalRole } from "./agent-evals/suite.js";
import { composeProviders, providerConfigurationSchema } from "./provider-composition.js";
import { pricingInForce, recordSpendEvents, type SpendEvent } from "./provider-costs.js";
import { jobPolicySchema, type WorkspaceProviders } from "./provider-setup.js";
import { roleModels } from "./provider-drafts.js";

/**
 * Quality checks run from the admin "AI services" page. The server runs Core's eval suite against
 * the open setup draft's models (target `draft`), or against the active setup's jobs that are on
 * without a passing check or an owner approval for their current revision and suite (target
 * `active`, e.g. after an upgrade brought new checks), with the workspace's own stored key, as a
 * durable background job:
 *
 * - Admission (one transaction): owners and administrators only; idempotent per key; one running
 *   check per workspace and a per-hour limit; the draft's checked models must have a price in
 *   force and the workspace a spending limit. Every paid conversation reserves the checked setup's
 *   per-request allowance against the workspace budget and gets its own spend ledger row, as any
 *   paid call. Media conversations call no model (Core grades the request it assembles): they need
 *   no price, cost nothing and reserve nothing.
 * - Each conversation settles its ledger row right after its model call: the reported usage at the
 *   saved price (the rest of the reservation is released), nothing when the provider certainly
 *   refused it, the full reservation when the outcome is unknown.
 * - A finished run is recorded through `ProviderEvaluations.record`, exactly like an uploaded
 *   report: Core regrades the answers and a pass lets the waiting models turn on.
 * - A provider fault (key, quota, network) stops the run and records nothing; the reason is kept.
 *   A run past its deadline, or left behind by a stopped server, ends as an error and keeps what it
 *   may have spent charged.
 *
 * No model answer, prompt, key or learner data is stored with a check.
 */
export interface QualityCheckOptions {
  /** How long one check may run. */
  deadlineMs: number;
  /** Checks a workspace may start in one hour. */
  perHour: number;
  /** Test seam: told which practice conversation is about to be sent (scripted test providers). */
  beforeDialogue?: (dialogue: Dialogue) => void | Promise<void>;
}
export const defaultQualityCheckOptions: QualityCheckOptions = { deadlineMs: 10 * 60_000, perHour: 6 };
/** Typical size of one model call of a practice conversation, for the estimate shown before running. */
export const TYPICAL_TOKENS = { input: 3000, output: 600 } as const;
/** Typical size of one tool result a tool-loop round adds to the next round's input. */
export const TYPICAL_TOOL_RESULT_TOKENS = 400;
/** Core's tool loop never runs more rounds than this, whatever the binding says (agent-strategies.ts). */
export const TOOL_LOOP_ROUND_CAP = 8;
/** A running check is treated as stopped this long after its deadline (no server finished it). */
const ABANDONED_AFTER_MS = 60_000;
type Configuration = z.infer<typeof providerConfigurationSchema>;
const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const startSchema = z.union([
  z.strictObject({ idempotencyKey, draftId: z.string().uuid() }),
  z.strictObject({ idempotencyKey, target: z.literal("active") }),
]);
type Target = "draft" | "active";
interface CheckRow {
  id: string; workspace_id: string; draft_id: string | null; target: Target; provider_revision: number; actor_id: string; request_digest: string;
  state: "running" | "passed" | "failed" | "error"; reason_code: string | null; roles: EvalRole[]; total_dialogues: number;
  completed_dialogues: number; estimate_micro_usd: string; reserved_micro_usd: string; outcome: RoleOutcome[] | null;
  deadline_at: Date; created_at: Date; finished_at: Date | null;
}
interface RoleOutcome { role: EvalRole; passed: boolean; dialogues: number; failed: { dialogueId: string; graders: string[] }[] }
const iso = (value: Date | null) => (value ? value.toISOString() : null);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Provider codes that mean the provider or the key failed, not the model's answer. */
const PROVIDER_FAULTS: Record<string, string> = {
  MISSING_CREDENTIAL: "PROVIDER_METADATA_CREDENTIAL_MISSING",
  AUTHENTICATION: "PROVIDER_METADATA_KEY_INVALID",
  PERMISSION_DENIED: "PROVIDER_METADATA_PERMISSION_DENIED",
  NOT_FOUND: "PROVIDER_GUIDE_MODEL_UNAVAILABLE",
  UNKNOWN_MODEL: "PROVIDER_GUIDE_MODEL_UNAVAILABLE",
  THROTTLED: "PROVIDER_METADATA_RATE_LIMITED",
  SUBSCRIPTION_QUOTA_EXHAUSTED: "PROVIDER_METADATA_RATE_LIMITED",
  SUBSCRIPTION_EXPIRED: "PROVIDER_METADATA_REJECTED",
  SUBSCRIPTION_OVERAGE_REQUIRED: "PROVIDER_METADATA_REJECTED",
  UPSTREAM_REJECTED: "PROVIDER_METADATA_REJECTED",
  UPSTREAM_UNAVAILABLE: "PROVIDER_METADATA_UPSTREAM_ERROR",
  NETWORK_ERROR: "PROVIDER_METADATA_NETWORK",
  TIMEOUT: "PROVIDER_METADATA_TIMEOUT",
  ADAPTER_UNAVAILABLE: "PROVIDER_METADATA_UNSUPPORTED",
  CAPABILITY_MISMATCH: "PROVIDER_GUIDE_MODEL_UNAVAILABLE",
  INVALID_CONFIG: "PROVIDER_CONFIGURATION_INVALID",
};
class StopRun extends Error {}

/** The typical model usage of one practice conversation. */
export interface TypicalUsage { calls: number; inputTokens: number; outputTokens: number }
/**
 * The typical usage of one practice conversation. Most conversations are one model call of
 * `TYPICAL_TOKENS`. A tool-loop conversation runs one model round per tool it is expected to use
 * plus a final answer (its fixture's tool results + 1), at most the binding's round limit (itself
 * capped at `TOOL_LOOP_ROUND_CAP`). Every round re-sends the conversation so far: round k's input is
 * the typical input plus k × (the previous output + a typical tool result).
 */
export function typicalUsage(dialogue: Pick<Dialogue, "expect">, maxToolRounds?: number): TypicalUsage {
  const tools = dialogue.expect.tools;
  if (!tools) return { calls: 1, inputTokens: TYPICAL_TOKENS.input, outputTokens: TYPICAL_TOKENS.output };
  const limit = Math.max(1, Math.min(maxToolRounds ?? 1, TOOL_LOOP_ROUND_CAP));
  const calls = Math.min(limit, Object.keys(tools.results).length + 1), growth = TYPICAL_TOKENS.output + TYPICAL_TOOL_RESULT_TOKENS;
  return { calls, inputTokens: calls * TYPICAL_TOKENS.input + (growth * calls * (calls - 1)) / 2, outputTokens: calls * TYPICAL_TOKENS.output };
}
/**
 * The estimate for one job at the saved price, rounded up per conversation: either a number of
 * one-call conversations of `TYPICAL_TOKENS`, or each conversation's typical usage.
 */
export function estimateMicroUsd(pricing: ModelPricing, conversations: number | readonly TypicalUsage[]) {
  const usages = typeof conversations === "number"
    ? Array.from({ length: conversations }, () => ({ calls: 1, inputTokens: TYPICAL_TOKENS.input, outputTokens: TYPICAL_TOKENS.output }))
    : conversations;
  let total = 0;
  for (const usage of usages) {
    const tokens = BigInt(usage.inputTokens) * BigInt(pricing.inputMicroUsdPerMillionTokens ?? 0)
      + BigInt(usage.outputTokens) * BigInt(pricing.outputMicroUsdPerMillionTokens ?? 0);
    total += Number((tokens + 999_999n) / 1_000_000n) + usage.calls * (pricing.microUsdPerRequest ?? 0);
  }
  return total;
}

export class ProviderQualityChecks {
  /** Checks this process is running, so the server can stop them on shutdown. */
  private readonly running = new Map<string, Promise<void>>();
  constructor(readonly db: Database, readonly providers: WorkspaceProviders, readonly evaluations: ProviderEvaluations,
    readonly options: QualityCheckOptions = defaultQualityCheckOptions) {}

  /** Waits for checks this process started (tests, graceful shutdown). */
  async idle() { await Promise.allSettled([...this.running.values()]); }

  private async draft(client: Database | PoolClient, workspace: string) {
    return (await client.query<{ id: string; base_revision: number; configuration: unknown; job_policy: unknown }>(
      "SELECT id,base_revision,configuration,job_policy FROM provider_setup_drafts WHERE workspace_id=$1", [workspace])).rows[0];
  }

  /**
   * What a check would run, cost and need; `blocked` says why it cannot start. `draft` checks the
   * open draft's changed jobs; `active` checks the active setup's covered jobs that lack a passing
   * check or an owner approval for their current revision and the current suite.
   */
  private async plan(client: Database | PoolClient, workspace: string, target: Target) {
    const suite = this.providers.evalSuite, old = await this.providers.version(client, workspace);
    const nothing = (code: string) => ({ target, draft: null, old, configuration: null, jobPolicy: null, runtime: null, roles: [], conversations: 0,
      reserve: { microUsd: 0, tokens: 0 }, blocked: { code } as { code: string; roles?: EvalRole[]; neededMicroUsd?: number; availableMicroUsd?: number },
      estimateMicroUsd: 0 } as const);
    let draft: Awaited<ReturnType<ProviderQualityChecks["draft"]>> | null = null, configuration: Configuration, jobPolicy, needed: EvalRole[];
    let secrets: Record<string, string>;
    if (target === "draft") {
      draft = await this.draft(client, workspace);
      if (!draft) return nothing("PROVIDER_QUALITY_CHECK_NO_DRAFT");
      configuration = providerConfigurationSchema.parse(draft.configuration);
      jobPolicy = jobPolicySchema.parse(draft.job_policy);
      const previousEvaluation = old ? (await client.query<{ evaluation: VersionEvaluation | null }>(
        "SELECT evaluation FROM workspace_provider_versions WHERE workspace_id=$1 AND revision=$2", [workspace, old.revision])).rows[0]?.evaluation ?? null : null;
      const checks = roleChecks(await evaluateActivation(client as PoolClient, workspace, suite,
        old ? { configuration: providerConfigurationSchema.parse(old.configuration), evaluation: previousEvaluation } : undefined, configuration));
      needed = EVAL_ROLES.filter((role) => checks[role]?.check === "needed" || checks[role]?.check === "failed");
      secrets = old ? this.providers.activeSecrets(workspace, old) : {};
    } else {
      if (!old) return nothing("PROVIDER_QUALITY_CHECK_NOT_NEEDED");
      configuration = providerConfigurationSchema.parse(old.configuration);
      jobPolicy = jobPolicySchema.parse(old.job_policy);
      const unchecked = await uncheckedRoles(client, workspace, suite, configuration);
      needed = EVAL_ROLES.filter((role) => unchecked.some((r) => r.role === role && r.covered));
      if (!needed.length) return nothing("PROVIDER_QUALITY_CHECK_NOT_NEEDED");
      secrets = this.providers.activeSecrets(workspace, old);
    }
    const runtime = composeProviders(configuration, (name) => secrets[name], this.providers.factories);
    const bound = runtime.strategyContracts().bound as Partial<Record<string, string>>, models = roleModels(configuration), bindings = runtime.roleModels();
    const roles = [];
    for (const role of needed) {
      const dialogues = dialoguesFor(suite, role, bound[role]), conversations = dialogues.length;
      if (!conversations) continue;
      const modelId = bindings[role]!.modelId, ready = runtime.availability(role).status === "ready";
      // Media conversations call no model: Core grades the request it assembles, so nothing is paid.
      if (role === "media") {
        roles.push({ role, modelId, remoteModel: models[role]?.remoteModel ?? null, conversations, paid: false, pricing: null, ready, estimateMicroUsd: 0 });
        continue;
      }
      const found = await pricingInForce(client, workspace, modelId);
      const pricing = found && pricingCovers(found, "tokens") ? found : null;
      const maxToolRounds = (configuration.roles as Partial<Record<string, { maxToolRounds?: number }>>)[role]?.maxToolRounds;
      roles.push({ role, modelId, remoteModel: models[role]?.remoteModel ?? null, conversations, paid: true, pricing, ready,
        estimateMicroUsd: pricing ? estimateMicroUsd(pricing, dialogues.map((d) => typicalUsage(d, maxToolRounds))) : null });
    }
    const conversations = roles.reduce((n, r) => n + r.conversations, 0), paid = roles.reduce((n, r) => n + (r.paid ? r.conversations : 0), 0);
    const reserve = { microUsd: paid * jobPolicy.allowance.microUsd, tokens: paid * jobPolicy.allowance.tokens };
    const budget = (await client.query<{ limit_micro_usd: string; limit_tokens: string; used_micro_usd: string; used_tokens: string }>(
      "SELECT limit_micro_usd,limit_tokens,used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1", [workspace])).rows[0];
    const available = { microUsd: Math.max(0, Number(budget?.limit_micro_usd ?? 0) - Number(budget?.used_micro_usd ?? 0)),
      tokens: Math.max(0, Number(budget?.limit_tokens ?? 0) - Number(budget?.used_tokens ?? 0)) };
    const unpriced = roles.filter((r) => r.paid && !r.pricing).map((r) => r.role), keyless = roles.filter((r) => !r.ready).map((r) => r.role);
    const blocked: { code: string; roles?: EvalRole[]; neededMicroUsd?: number; availableMicroUsd?: number } | null =
      draft && draft.base_revision !== (old?.revision ?? 0) ? { code: "STALE_PROVIDER_REVISION" }
      : !roles.length ? { code: "PROVIDER_QUALITY_CHECK_NOT_NEEDED" }
      : keyless.length ? { code: "PROVIDER_QUALITY_CHECK_KEY_MISSING", roles: keyless }
      : unpriced.length ? { code: "PROVIDER_QUALITY_CHECK_PRICES_MISSING", roles: unpriced }
      // Nothing to reserve (only media is checked): no spending limit is needed.
      : !paid ? null
      : !budget || Number(budget.limit_micro_usd) === 0 ? { code: "PROVIDER_QUALITY_CHECK_LIMIT_MISSING" }
      : available.microUsd < reserve.microUsd || available.tokens < reserve.tokens
        ? { code: "PROVIDER_QUALITY_CHECK_BUDGET_REACHED", neededMicroUsd: reserve.microUsd, availableMicroUsd: available.microUsd }
      : null;
    return { target, draft, old, configuration, jobPolicy, runtime, roles, conversations, reserve, blocked,
      estimateMicroUsd: roles.reduce((n, r) => n + (r.estimateMicroUsd ?? 0), 0) };
  }

  private view(row: CheckRow, charged: number | null = null) {
    return { id: row.id, target: row.target ?? "draft", draftId: row.draft_id, state: row.state, reason: row.reason_code, roles: row.roles,
      total: row.total_dialogues, completed: row.completed_dialogues, estimateMicroUsd: Number(row.estimate_micro_usd),
      reservedMicroUsd: Number(row.reserved_micro_usd), chargedMicroUsd: charged, outcome: row.outcome ?? [],
      createdAt: iso(row.created_at), finishedAt: iso(row.finished_at), deadlineAt: iso(row.deadline_at) };
  }
  private async charged(client: Database | PoolClient, id: string) {
    return Number((await client.query<{ charged: string }>(
      "SELECT COALESCE(sum(charged_micro_usd),0)::text AS charged FROM provider_spend_ledger WHERE source='quality_check' AND source_ref LIKE $1",
      [id + ":%"])).rows[0]!.charged);
  }

  /** Ends running checks whose deadline passed long ago (a stopped server): their unsettled calls stay charged. */
  private async expire(client: PoolClient, workspace: string) {
    const stale = (await client.query<{ id: string }>(
      `UPDATE provider_quality_checks SET state='error',reason_code='PROVIDER_QUALITY_CHECK_INTERRUPTED',finished_at=clock_timestamp()
       WHERE workspace_id=$1 AND state='running' AND deadline_at < clock_timestamp() - ($2 * interval '1 millisecond') RETURNING id`,
      [workspace, ABANDONED_AFTER_MS])).rows;
    for (const { id } of stale) await this.closeOpenCalls(client, workspace, id, "uncertain");
  }
  /** Settles every still-open ledger row of a check: `not_started` releases it, `uncertain` keeps it charged. */
  private async closeOpenCalls(client: PoolClient, workspace: string, id: string, mode: "not_started" | "uncertain") {
    await client.query("INSERT INTO supervisor_workspace_budgets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING", [workspace]);
    await client.query("SELECT 1 FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE", [workspace]);
    if (mode === "uncertain") {
      await client.query(`UPDATE provider_spend_ledger SET state='uncertain',settled_at=clock_timestamp()
        WHERE source='quality_check' AND source_ref LIKE $1 AND state='reserved' AND settled_at IS NULL`, [id + ":%"]);
      return;
    }
    const released = (await client.query<{ usd: string; tokens: string }>(
      `WITH done AS (UPDATE provider_spend_ledger SET state='not_started',charged_micro_usd=0,released_micro_usd=reserved_micro_usd,settled_at=clock_timestamp()
         WHERE source='quality_check' AND source_ref LIKE $1 AND state='reserved' AND settled_at IS NULL RETURNING reserved_micro_usd,reserved_tokens)
       SELECT COALESCE(sum(reserved_micro_usd),0)::text AS usd,COALESCE(sum(reserved_tokens),0)::text AS tokens FROM done`, [id + ":%"])).rows[0]!;
    await client.query("UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd-$2,used_tokens=used_tokens-$3 WHERE workspace_id=$1",
      [workspace, Number(released.usd), Number(released.tokens)]);
  }

  /**
   * The page's view: what a check would run and cost, why it cannot start, and the latest check.
   * With an open draft it is the draft's check; otherwise the active setup's jobs that need one
   * (`target: "active"`), or nothing to check (`target: null`).
   */
  async status(actor: Actor, workspace: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    return transaction(this.db, async (client) => {
      await this.expire(client, workspace);
      const hasDraft = !!(await this.draft(client, workspace));
      let plan = await this.plan(client, workspace, hasDraft ? "draft" : "active");
      // Nothing on needs a check: say there is nothing to check, as before there were active checks.
      if (!hasDraft && !plan.roles.length) plan = await this.plan(client, workspace, "draft");
      const offered = plan.configuration !== null && (plan.target === "draft" || plan.roles.length > 0);
      const latest = (await client.query<CheckRow>(
        "SELECT * FROM provider_quality_checks WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 1", [workspace])).rows[0];
      const running = latest?.state === "running";
      return {
        target: offered ? plan.target : null,
        draftId: plan.draft?.id ?? null,
        roles: offered ? plan.roles.map((r) => ({ role: r.role, remoteModel: r.remoteModel, conversations: r.conversations,
          priced: !r.paid || !!r.pricing, estimateMicroUsd: r.estimateMicroUsd })) : [],
        conversations: offered ? plan.conversations : 0,
        estimateMicroUsd: offered ? plan.estimateMicroUsd : 0,
        reserveMicroUsd: offered ? plan.reserve.microUsd : 0,
        typicalTokens: TYPICAL_TOKENS,
        blocked: running ? { code: "PROVIDER_QUALITY_CHECK_RUNNING" } : plan.blocked,
        latest: latest ? this.view(latest, await this.charged(client, latest.id)) : null,
      };
    });
  }

  async get(actor: Actor, workspace: string, id: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    return transaction(this.db, async (client) => {
      await this.expire(client, workspace);
      const row = (await client.query<CheckRow>("SELECT * FROM provider_quality_checks WHERE workspace_id=$1 AND id=$2", [workspace, id])).rows[0];
      requireCondition(row, "PROVIDER_QUALITY_CHECK_NOT_FOUND", 404);
      return this.view(row, await this.charged(client, row.id));
    });
  }

  /** Starts a check of the open draft (`draftId`) or of the active setup (`target: "active"`), for owners and
   * administrators. Returns at once; the run continues on the server. */
  async start(actor: Actor, workspace: string, raw: unknown) {
    const parsed = startSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_QUALITY_CHECK_INVALID", 400);
    const input = parsed.data, target: Target = "draftId" in input ? "draft" : "active";
    const digest = sha256(JSON.stringify("draftId" in input ? { workspace, actor: actor.id, draftId: input.draftId } : { workspace, actor: actor.id, target }));
    let launch: (() => void) | undefined;
    const result = await afterCommitTransaction(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["provider-quality-check:" + workspace]);
      const member = (await client.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [workspace, actor.id])).rows[0];
      requireCondition(member && ["owner", "admin"].includes(member.role), "FORBIDDEN", 403);
      const earlier = (await client.query<CheckRow>("SELECT * FROM provider_quality_checks WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspace, input.idempotencyKey])).rows[0];
      if (earlier) {
        requireCondition(earlier.request_digest === digest, "IDEMPOTENCY_CONFLICT", 409);
        return this.view(earlier, await this.charged(client, earlier.id));
      }
      await this.expire(client, workspace);
      const busy = (await client.query("SELECT 1 FROM provider_quality_checks WHERE workspace_id=$1 AND state='running'", [workspace])).rowCount;
      if (busy) throw new ApiError(409, "PROVIDER_QUALITY_CHECK_RUNNING");
      const recent = Number((await client.query<{ count: string }>(
        "SELECT count(*) FROM provider_quality_checks WHERE workspace_id=$1 AND created_at > clock_timestamp() - interval '1 hour'", [workspace])).rows[0]!.count);
      requireCondition(recent < this.options.perHour, "PROVIDER_QUALITY_CHECK_RATE_LIMITED", 429);
      // The workspace budget row is locked before the headroom decision, as every paid admission does.
      await client.query("INSERT INTO supervisor_workspace_budgets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING", [workspace]);
      await client.query("SELECT 1 FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE", [workspace]);
      const locked = await this.plan(client, workspace, target);
      if ("draftId" in input && (!locked.draft || locked.draft.id !== input.draftId)) throw new ApiError(404, "PROVIDER_DRAFT_NOT_FOUND");
      if (locked.blocked) {
        const { code, ...details } = locked.blocked;
        throw new ApiError(code === "STALE_PROVIDER_REVISION" ? 409 : code === "PROVIDER_QUALITY_CHECK_NO_DRAFT" ? 404 : 409, code, code,
          Object.keys(details).length ? details : undefined);
      }
      if (!locked.configuration) throw new ApiError(409, "PROVIDER_QUALITY_CHECK_NOT_NEEDED");
      const id = randomUUID(), roles = locked.roles.map((r) => r.role);
      const row = (await client.query<CheckRow>(
        `INSERT INTO provider_quality_checks(id,workspace_id,draft_id,target,provider_revision,actor_id,idempotency_key,request_digest,state,roles,total_dialogues,
           estimate_micro_usd,reserved_micro_usd,deadline_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10,$11,$12,clock_timestamp()+($13*interval '1 millisecond')) RETURNING *`,
        [id, workspace, locked.draft?.id ?? null, target, locked.old?.revision ?? 0, actor.id, input.idempotencyKey, digest, roles, locked.conversations,
          locked.estimateMicroUsd, locked.reserve.microUsd, this.options.deadlineMs])).rows[0]!;
      // Every paid conversation reserves the per-request allowance against the workspace budget. Refs
      // `${id}:${n}` follow runSuite's per-dialogue order (one afterCall per dialogue, media included),
      // so a media conversation takes its number but holds no ledger row.
      const allowance = locked.jobPolicy.allowance, events: SpendEvent[] = [];
      let n = 0;
      for (const role of locked.roles)
        for (let i = 0; i < role.conversations; i++, n++) {
          if (!role.paid) continue;
          await client.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,model_id,state,reserved_micro_usd,reserved_tokens,charged_micro_usd)
            VALUES($1,'quality_check',$2,1,$3,NULL,$4,$5,'reserved',$6,$7,$6)`, [randomUUID(), `${id}:${n}`, workspace, role.role, role.modelId, allowance.microUsd, allowance.tokens]);
          events.push({ kind: "reserved", role: role.role, microUsd: allowance.microUsd, modelId: role.modelId, basis: "reserved_ceiling" });
        }
      await client.query("UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd+$2,used_tokens=used_tokens+$3 WHERE workspace_id=$1",
        [workspace, locked.reserve.microUsd, locked.reserve.tokens]);
      onCommit(client, () => recordSpendEvents(events));
      await appendEvent(client, { workspaceId: workspace, actorId: actor.id, actorKind: "staff", type: "provider.quality_check.started",
        payload: { checkId: id, target, draftId: locked.draft?.id ?? null, roles, conversations: locked.conversations, estimateMicroUsd: locked.estimateMicroUsd,
          reservedMicroUsd: locked.reserve.microUsd }, idempotencyKey: `provider.quality_check.started:${id}` });
      const runtime = locked.runtime, configuration = locked.configuration, pricing = new Map(locked.roles.flatMap((r) => (r.pricing ? [[r.role, r.pricing] as const] : [])));
      launch = () => this.launch(actor, workspace, row, runtime, configuration, pricing);
      return this.view(row, locked.reserve.microUsd);
    });
    launch?.();
    return result;
  }

  private launch(actor: Actor, workspace: string, row: CheckRow, runtime: ReturnType<typeof composeProviders>, configuration: Configuration,
    pricing: Map<EvalRole, ModelPricing>) {
    const task = this.run(actor, workspace, row, runtime, configuration, pricing)
      .catch(() => this.finish(actor, workspace, row.id, { state: "error", reason: "PROVIDER_QUALITY_CHECK_FAILED" }, "uncertain").catch(() => undefined))
      .finally(() => this.running.delete(row.id));
    this.running.set(row.id, task);
  }

  private async run(actor: Actor, workspace: string, row: CheckRow, runtime: ReturnType<typeof composeProviders>, configuration: Configuration,
    pricing: Map<EvalRole, ModelPricing>) {
    const signal = AbortSignal.timeout(Math.max(1, row.deadline_at.getTime() - Date.now()));
    let index = 0, fault: string | null = null;
    const settle = async (call: CallRecord) => {
      const ref = `${row.id}:${index++}`, error = call.error;
      const code = error instanceof ProviderError ? error.code : error ? "UNEXPECTED" : null;
      if (code && Object.hasOwn(PROVIDER_FAULTS, code) && !(code === "TIMEOUT" && signal.aborted)) fault ??= PROVIDER_FAULTS[code]!;
      await this.settleCall(workspace, row.id, ref, call, pricing.get(call.role) ?? null);
    };
    let report: EvalReport | null = null;
    try {
      report = await runSuite({ suite: this.providers.evalSuite, configuration, runtime, mode: "live", roles: row.roles, signal,
        beforeDialogue: async (dialogue) => {
          if (fault || signal.aborted) throw new StopRun();
          await this.options.beforeDialogue?.(dialogue);
          if (signal.aborted) throw new StopRun();
        },
        afterCall: settle });
    } catch (error) {
      if (!(error instanceof StopRun)) throw error;
    }
    if (signal.aborted) return this.finish(actor, workspace, row.id, { state: "error", reason: "PROVIDER_QUALITY_CHECK_TIMEOUT" }, "not_started");
    if (fault || !report) return this.finish(actor, workspace, row.id, { state: "error", reason: fault ?? "PROVIDER_QUALITY_CHECK_FAILED" }, "not_started");
    // Recorded exactly as an uploaded report: Core regrades every answer against its own suite.
    let recorded: Awaited<ReturnType<ProviderEvaluations["record"]>>;
    try {
      recorded = await this.evaluations.record(actor, workspace, { idempotencyKey: `quality-check:${row.id}`, report });
    } catch (error) {
      const reason = error instanceof ApiError && error.code === "FORBIDDEN" ? "PROVIDER_QUALITY_CHECK_SCOPE_CHANGED" : "PROVIDER_QUALITY_CHECK_FAILED";
      return this.finish(actor, workspace, row.id, { state: "error", reason }, "not_started");
    }
    const outcome: RoleOutcome[] = recorded.results.map((r) => {
      const grades = r.grades as { dialogueId: string; passed: boolean; graders: { grader: string; passed: boolean }[] }[];
      return { role: r.role as EvalRole, passed: r.outcome === "passed", dialogues: grades.length,
        failed: grades.filter((g) => !g.passed).map((g) => ({ dialogueId: g.dialogueId, graders: g.graders.filter((x) => !x.passed).map((x) => x.grader) })) };
    });
    return this.finish(actor, workspace, row.id, { state: outcome.every((o) => o.passed) ? "passed" : "failed", reason: null, outcome }, "not_started");
  }

  /** Settles one conversation's ledger row from what the provider reported, and counts progress. */
  private async settleCall(workspace: string, id: string, ref: string, call: CallRecord, pricing: ModelPricing | null) {
    const error = call.error;
    const notSent = error instanceof ProviderError && error.submission === "not_sent" && !error.usage?.attempts.length;
    const rejected = error && !notSent ? definiteRejection(error) : null;
    const usage: UsageReceipt | null = call.usage;
    // No pricing (a media conversation, which holds no ledger row): nothing to price.
    const cost = !error && usage && pricing ? priceUsage(usage, pricing).cost : null;
    const totals = usage?.attempts.map((a) => a.tokens.total) ?? [];
    const tokens = !error && totals.length && totals.every((t) => t !== null) ? totals.reduce<number>((n, t) => n + t!, 0) : null;
    await afterCommitTransaction(this.db, async (client) => {
      await client.query("SELECT 1 FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE", [workspace]);
      const open = (await client.query<{ reserved_micro_usd: string; reserved_tokens: string; model_id: string | null; role: string }>(
        "SELECT reserved_micro_usd,reserved_tokens,model_id,role FROM provider_spend_ledger WHERE source='quality_check' AND source_ref=$1 AND attempt=1 AND state='reserved' AND settled_at IS NULL FOR UPDATE",
        [ref])).rows[0];
      await client.query("UPDATE provider_quality_checks SET completed_dialogues=LEAST(total_dialogues,completed_dialogues+1) WHERE id=$1 AND state='running'", [id]);
      if (!open) return;
      const reserved = Number(open.reserved_micro_usd), reservedTokens = Number(open.reserved_tokens), events: SpendEvent[] = [];
      let release = 0, releaseTokens = 0;
      if (notSent || rejected) {
        await client.query(`UPDATE provider_spend_ledger SET state='not_started',charged_micro_usd=0,released_micro_usd=reserved_micro_usd,settled_at=clock_timestamp()
          WHERE source='quality_check' AND source_ref=$1 AND attempt=1`, [ref]);
        release = reserved; releaseTokens = reservedTokens;
      } else if (cost && cost.microUsd <= reserved) {
        await client.query(`UPDATE provider_spend_ledger SET state='reconciled',pricing_version_id=$2,actual_micro_usd=$3,charged_micro_usd=$3,
            released_micro_usd=$4,settled_at=clock_timestamp() WHERE source='quality_check' AND source_ref=$1 AND attempt=1`,
          [ref, cost.pricingVersionId, cost.microUsd, reserved - cost.microUsd]);
        release = reserved - cost.microUsd;
        releaseTokens = tokens !== null ? Math.max(0, reservedTokens - tokens) : 0;
        events.push({ kind: "actual", role: open.role, microUsd: cost.microUsd, modelId: open.model_id, basis: "reported" });
      } else
        // Answered but not priceable, or the outcome is unknown: the reservation stays charged.
        await client.query(`UPDATE provider_spend_ledger SET state=$2,settled_at=clock_timestamp() WHERE source='quality_check' AND source_ref=$1 AND attempt=1`,
          [ref, error ? "uncertain" : "unpriced"]);
      if (release || releaseTokens) {
        await client.query("UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd-$2,used_tokens=used_tokens-$3 WHERE workspace_id=$1",
          [workspace, release, releaseTokens]);
        if (release) events.push({ kind: "released", role: open.role, microUsd: release, modelId: open.model_id, basis: "reported" });
      }
      if (events.length) onCommit(client, () => recordSpendEvents(events));
    });
  }

  private async finish(actor: Actor, workspace: string, id: string,
    result: { state: "passed" | "failed" | "error"; reason: string | null; outcome?: RoleOutcome[] }, open: "not_started" | "uncertain") {
    await afterCommitTransaction(this.db, async (client) => {
      const done = await client.query(
        "UPDATE provider_quality_checks SET state=$3,reason_code=$4,outcome=$5,finished_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND state='running'",
        [id, workspace, result.state, result.reason, result.outcome ? JSON.stringify(result.outcome) : null]);
      // Conversations never sent (stopped early) release their reservation.
      await this.closeOpenCalls(client, workspace, id, open);
      if (!done.rowCount) return;
      await appendEvent(client, { workspaceId: workspace, actorId: actor.id, actorKind: "staff", type: "provider.quality_check.finished",
        payload: { checkId: id, state: result.state, reason: result.reason, chargedMicroUsd: await this.charged(client, id),
          roles: (result.outcome ?? []).map((o) => ({ role: o.role, passed: o.passed })) },
        idempotencyKey: `provider.quality_check.finished:${id}` });
    });
  }
}

export function registerProviderQualityCheckRoutes(app: FastifyInstance, auth: ReturnType<typeof authService>, service: ProviderQualityChecks) {
  const base = "/api/admin/workspaces/:workspaceId/provider-setup/quality-check",
    params = { type: "object", additionalProperties: false, required: ["workspaceId"], properties: { workspaceId: { type: "string", format: "uuid" } } },
    withId = { type: "object", additionalProperties: false, required: ["workspaceId", "id"],
      properties: { workspaceId: { type: "string", format: "uuid" }, id: { type: "string", format: "uuid" } } };
  const p = (request: { params: unknown }) => request.params as { workspaceId: string; id: string };
  app.get(base, { schema: { params }, logLevel: "silent" }, async (request) => service.status(await auth.authenticate(request), p(request).workspaceId));
  app.post(base, { schema: { params }, bodyLimit: 2048, logLevel: "silent" },
    async (request) => service.start(await auth.authenticate(request), p(request).workspaceId, request.body));
  app.get(base + "/:id", { schema: { params: withId }, logLevel: "silent" },
    async (request) => service.get(await auth.authenticate(request), p(request).workspaceId, p(request).id));
  app.addHook("onClose", async () => service.idle());
}
