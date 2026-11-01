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
import { upgradeLegacyProviderConfiguration } from "./provider-defaults.js";
import { evaluateActivation, roleChecks, uncheckedRoles, type ProviderEvaluations, type VersionEvaluation } from "./agent-evals/gate.js";
import { runSuite, type CallRecord, type EvalReport, type MeaningJudge, type ToolCallRecord } from "./agent-evals/runner.js";
import { JUDGE_SCHEMA, TYPICAL_JUDGE_TOKENS, judgeRequest, judgementOf } from "./agent-evals/judge.js";
import { answerText, type MeaningJudgement } from "./agent-evals/graders.js";
import type { MeaningJudgePlan } from "./provider-runtime.js";
import { dialogueDetail, type DialogueDetail } from "./agent-evals/details.js";
import type { DialogueGrade } from "./agent-evals/graders.js";
import { covers, dialoguesFor, EVAL_ROLES, type Dialogue, type EvalRole } from "./agent-evals/suite.js";
import { roleRevisions } from "./agent-evals/revision.js";
import { composeProviders, providerConfigurationSchema } from "./provider-composition.js";
import { pricingInForce, recordSpendEvents, type SpendEvent } from "./provider-costs.js";
import { jobPolicySchema, type WorkspaceProviders } from "./provider-setup.js";
import { roleModels } from "./provider-drafts.js";
import { answeredRefusalReason, PROVIDER_OUTPUT_REASONS } from "./output-refusal.js";

/**
 * Quality checks run from the admin "AI services" page. The server runs Core's eval suite against
 * the open setup draft's models (target `draft`), or against the active setup's jobs that are on
 * (target `active`: every job the suite covers, or the one `role` asked for), with the workspace's
 * own stored key, as a durable background job. A check of the jobs that are on runs whatever their
 * standing: one with a passing check or an owner's approval can be checked again (an approval
 * without a check is then put to the test). A failed result records a failure; it never turns a
 * job off (an owner or administrator does that, provider-setup.ts `turnOff`).
 *
 * - Admission (one transaction): owners and administrators only; idempotent per key; one running
 *   check per workspace and a per-hour limit; the draft's checked models must have a price in
 *   force and the workspace a spending limit. Every paid conversation reserves the checked setup's
 *   per-request allowance against the workspace budget and gets its own spend ledger row, as any
 *   paid call. Media conversations call no model (Core grades the request it assembles): they need
 *   no price, cost nothing and reserve nothing.
 * - Each conversation settles its ledger row right after its model call: the reported usage at the
 *   saved price (the rest of the reservation is released), nothing when the provider certainly
 *   refused it, the full reservation when the outcome is unknown. A reply the provider returned in
 *   full that the adapter's output checks refused (cut off, malformed, blocked; output-refusal.ts)
 *   is settled like an answer and recorded as a failed conversation with its reason code.
 * - A finished run is recorded through `ProviderEvaluations.record`, exactly like an uploaded
 *   report: Core regrades the answers and a pass lets the waiting models turn on.
 * - A provider fault (key, quota, network, a refused request) stops the run and records no result; the
 *   reason is kept, with the first faulting call's job, HTTP status and the provider's documented
 *   reason code (`reason_detail`), so a refusal is diagnosable without logs. A "not found" answer
 *   for the job's model (NOT_FOUND) also records that model as unavailable for the connection
 *   (`provider_unavailable_models`), so the model picker stops offering and suggesting it.
 *   A run past its deadline, or left behind by a stopped server, ends as an error and keeps what it
 *   may have spent charged.
 *
 * Grounding and factuality are judged by meaning (agent-evals/judge.ts): after each answer a judge
 * model reads the lesson, the stated facts, the learner's turns and the reply and answers a
 * structured verdict. The judge is the reviewer job's model when one is set, else the setup's
 * strongest stable text model on the tutor's connection, else the tutor's model (labelled when it
 * judges itself). Each judge call is a paid call like a conversation: it is in the estimate, it
 * reserves the per-request allowance (ledger ref `${id}:j${n}`) and settles from its usage. A judge
 * that cannot answer (fault, invalid verdict) leaves that conversation undetermined: a job with no
 * failure but an undetermined conversation is not recorded, and the check says the judge could not
 * run (`PROVIDER_QUALITY_CHECK_JUDGE_UNAVAILABLE`) instead of passing or failing it.
 *
 * A finished check (passed or failed) also keeps, per practice conversation, what it tests, what
 * the model was given, the model's answer (bounded, `agent-evals/details.ts`) and each rule's result
 * with its evidence (`provider_quality_check_dialogues`), for the owners and administrators who can
 * see the check. The conversations are Core's public practice fixtures, so no learner data is
 * involved; their private test strings are removed. No prompt or key is stored.
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
  // `role` checks that one job of the active setup only (the page's "Run check" beside a flagged job).
  z.strictObject({ idempotencyKey, target: z.literal("active"), role: z.enum(EVAL_ROLES as [EvalRole, ...EvalRole[]]).optional() }),
]);
type Target = "draft" | "active";
interface CheckRow {
  id: string; workspace_id: string; draft_id: string | null; target: Target; provider_revision: number; actor_id: string; request_digest: string;
  state: "running" | "passed" | "failed" | "error"; reason_code: string | null; reason_detail: FaultDetail | null; roles: EvalRole[]; total_dialogues: number;
  completed_dialogues: number; estimate_micro_usd: string; reserved_micro_usd: string; outcome: RoleOutcome[] | null;
  deadline_at: Date; created_at: Date; finished_at: Date | null;
}
/** `reason` names why a conversation has no answer to grade (e.g. `provider_output_invalid`); absent when it was answered. */
/** `undetermined`: the job had no failure, but the judge could not run on some conversation, so it has no result. */
interface RoleOutcome { role: EvalRole; passed: boolean; dialogues: number; failed: { dialogueId: string; graders: string[]; reason?: string }[]; undetermined?: true }
/** The check's meaning judge: its model, how it is asked, and its saved price. */
interface JudgeChoice { plan: MeaningJudgePlan; pricing: ModelPricing }
/**
 * The first provider fault of a stopped check: the job, Core's provider code, the HTTP status and
 * the provider's documented reason code (`ProviderError.reason`). Codes and numbers only.
 */
interface FaultDetail { role: EvalRole; providerCode: string; status: number | null; providerReason: string | null }
/** A job's model the provider answered "not found" for, recorded in `provider_unavailable_models`. */
interface UnavailableModel { connectionId: string; remoteModel: string; status: number | null; providerReason: string | null }
/** One practice conversation's stored detail, in the check's order (`position`). */
interface DialogueRow { position: number; role: EvalRole; dialogueId: string; passed: boolean; detail: DialogueDetail }
const iso = (value: Date | null) => (value ? value.toISOString() : null);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Provider codes that mean the provider, the key or the workspace's own setup failed, not the
 * model's answer. Only NOT_FOUND (the provider's HTTP 404) says the service lacks the model; the
 * runtime's own UNKNOWN_MODEL (the job's model is not in this workspace's model registry) and
 * CAPABILITY_MISMATCH (the bound model is not set up with what the job needs) are local setup
 * problems with their own codes.
 */
export const PROVIDER_FAULTS: Readonly<Record<string, string>> = {
  MISSING_CREDENTIAL: "PROVIDER_METADATA_CREDENTIAL_MISSING",
  AUTHENTICATION: "PROVIDER_METADATA_KEY_INVALID",
  PERMISSION_DENIED: "PROVIDER_METADATA_PERMISSION_DENIED",
  NOT_FOUND: "PROVIDER_GUIDE_MODEL_UNAVAILABLE",
  UNKNOWN_MODEL: "PROVIDER_QUALITY_CHECK_MODEL_NOT_CONFIGURED",
  THROTTLED: "PROVIDER_METADATA_RATE_LIMITED",
  SUBSCRIPTION_QUOTA_EXHAUSTED: "PROVIDER_METADATA_QUOTA_EXHAUSTED",
  SUBSCRIPTION_EXPIRED: "PROVIDER_METADATA_BILLING_REQUIRED",
  SUBSCRIPTION_OVERAGE_REQUIRED: "PROVIDER_METADATA_BILLING_REQUIRED",
  // A refusal of the request itself (malformed, unsupported setting): never reported as quota or billing.
  UPSTREAM_REJECTED: "PROVIDER_REQUEST_REJECTED",
  // Only the provider's documented billing and daily-quota refusals say so; any other 429 is THROTTLED.
  BILLING_REQUIRED: "PROVIDER_METADATA_BILLING_REQUIRED",
  QUOTA_EXHAUSTED: "PROVIDER_METADATA_QUOTA_EXHAUSTED",
  UPSTREAM_UNAVAILABLE: "PROVIDER_METADATA_UPSTREAM_ERROR",
  NETWORK_ERROR: "PROVIDER_METADATA_NETWORK",
  TIMEOUT: "PROVIDER_METADATA_TIMEOUT",
  ADAPTER_UNAVAILABLE: "PROVIDER_METADATA_UNSUPPORTED",
  CAPABILITY_MISMATCH: "PROVIDER_QUALITY_CHECK_CAPABILITY_MISSING",
  INVALID_CONFIG: "PROVIDER_CONFIGURATION_INVALID",
};
class StopRun extends Error {}
/** The reason code of a conversation that had no answer to grade (graders.ts `no_answer:<code>`). */
function noAnswerReason(graders: readonly { findings?: readonly string[] }[]) {
  const finding = graders[0]?.findings?.[0];
  return finding?.startsWith("no_answer:") ? finding.slice("no_answer:".length) : null;
}

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
    const row = (await client.query<{ id: string; base_revision: number; configuration: unknown; job_policy: unknown }>(
      "SELECT id,base_revision,configuration,job_policy FROM provider_setup_drafts WHERE workspace_id=$1", [workspace])).rows[0];
    return row ? { ...row, configuration: upgradeLegacyProviderConfiguration(row.configuration as never,
      (row.job_policy as { allowance?: { tokens?: number } } | null)?.allowance?.tokens) as unknown } : row;
  }

  /**
   * What a check would run, cost and need; `blocked` says why it cannot start. `draft` checks the
   * open draft's changed jobs. `active` checks the active setup's covered jobs (only `only`, when
   * given): with `scope` "needed" only those that lack a passing check or an owner approval for their
   * current revision and the current suite (what the page flags), with "on" every one that is on
   * (what an explicit check of the jobs that are on runs).
   */
  private async plan(client: Database | PoolClient, workspace: string, target: Target, only?: EvalRole, scope: "needed" | "on" = "on") {
    const suite = this.providers.evalSuite, old = await this.providers.version(client, workspace);
    const nothing = (code: string) => ({ target, draft: null, old, configuration: null, jobPolicy: null, runtime: null, roles: [], conversations: 0,
      judge: null, judged: 0, judgeEstimateMicroUsd: 0, reserve: { microUsd: 0, tokens: 0 }, blocked: { code } as { code: string; roles?: EvalRole[]; neededMicroUsd?: number; availableMicroUsd?: number },
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
      if (scope === "needed") {
        const unchecked = await uncheckedRoles(client, workspace, suite, configuration);
        needed = EVAL_ROLES.filter((role) => unchecked.some((r) => r.role === role && r.covered) && (!only || role === only));
      } else {
        const revisions = await roleRevisions(configuration);
        needed = EVAL_ROLES.filter((role) => !!revisions[role] && covers(suite, role, revisions[role]!.strategy) && (!only || role === only));
      }
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
    // The meaning judge (agent-evals/judge.ts) judges every paid conversation's answer: the first
    // ready candidate with a saved token price. One judge call per paid conversation.
    let judge: JudgeChoice | null = null;
    if (paid) for (const plan of runtime.meaningJudgeCandidates(roles.map((r) => r.role))) {
      const found = await pricingInForce(client, workspace, plan.modelId);
      if (found && pricingCovers(found, "tokens")) { judge = { plan, pricing: found }; break; }
    }
    const judged = judge ? paid : 0;
    const judgeEstimate = judge ? estimateMicroUsd(judge.pricing, Array.from({ length: judged },
      () => ({ calls: 1, inputTokens: TYPICAL_JUDGE_TOKENS.input, outputTokens: TYPICAL_JUDGE_TOKENS.output }))) : 0;
    const reserve = { microUsd: (paid + judged) * jobPolicy.allowance.microUsd, tokens: (paid + judged) * jobPolicy.allowance.tokens };
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
      // No model that could judge has a price (every checked model is priced, so this is rare).
      : paid && !judge ? { code: "PROVIDER_QUALITY_CHECK_PRICES_MISSING", roles: roles.filter((r) => r.paid).map((r) => r.role) }
      // Nothing to reserve (only media is checked): no spending limit is needed.
      : !paid ? null
      : !budget || Number(budget.limit_micro_usd) === 0 ? { code: "PROVIDER_QUALITY_CHECK_LIMIT_MISSING" }
      : available.microUsd < reserve.microUsd || available.tokens < reserve.tokens
        ? { code: "PROVIDER_QUALITY_CHECK_BUDGET_REACHED", neededMicroUsd: reserve.microUsd, availableMicroUsd: available.microUsd }
      : null;
    return { target, draft, old, configuration, jobPolicy, runtime, roles, conversations, reserve, blocked, judge, judged, judgeEstimateMicroUsd: judgeEstimate,
      estimateMicroUsd: roles.reduce((n, r) => n + (r.estimateMicroUsd ?? 0), 0) + judgeEstimate };
  }
  /** Who would judge a plan's conversations, how many and at what estimate; `self` when it is a model being checked. */
  private judgeView(plan: Awaited<ReturnType<ProviderQualityChecks["plan"]>>) {
    const judge = plan.judge;
    return judge ? { remoteModel: judge.plan.remoteModel, conversations: plan.judged, estimateMicroUsd: plan.judgeEstimateMicroUsd,
      self: plan.roles.some((r) => r.modelId === judge.plan.modelId) } : null;
  }

  private view(row: CheckRow, charged: number | null = null) {
    return { id: row.id, target: row.target ?? "draft", draftId: row.draft_id, state: row.state, reason: row.reason_code, reasonDetail: row.reason_detail ?? null, roles: row.roles,
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
   * With an open draft it is the draft's check; otherwise, when a job that is on needs one,
   * `target: "active"` with what checking every job that is on runs (what `start` runs), or nothing
   * to check (`target: null`). `activeRoles` are the jobs that are on and need a check; `onRoles`
   * every job that is on that the check covers, each with what checking it alone runs, and `onAll`
   * what checking all of them runs, so any job can be checked again.
   */
  async status(actor: Actor, workspace: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    return transaction(this.db, async (client) => {
      await this.expire(client, workspace);
      const hasDraft = !!(await this.draft(client, workspace));
      const needing = await this.plan(client, workspace, "active", undefined, "needed");
      const onAll = await this.plan(client, workspace, "active");
      let plan = hasDraft ? await this.plan(client, workspace, "draft") : onAll;
      // Nothing on needs a check: say there is nothing to check, as before there were active checks.
      if (!hasDraft && !needing.roles.length) plan = await this.plan(client, workspace, "draft");
      const offered = plan.configuration !== null && (plan.target === "draft" || plan.roles.length > 0);
      const latest = (await client.query<CheckRow>(
        "SELECT * FROM provider_quality_checks WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 1", [workspace])).rows[0];
      const running = latest?.state === "running";
      // Each job that is on and needs a check, with what checking it alone would run and cost and why
      // it cannot start now: the page flags each one with its own "Run check", draft open or not.
      const onRoles = [];
      for (const r of onAll.roles) {
        const alone = await this.plan(client, workspace, "active", r.role);
        onRoles.push({ role: r.role, remoteModel: r.remoteModel, conversations: alone.conversations, priced: !r.paid || !!r.pricing,
          estimateMicroUsd: alone.estimateMicroUsd, reserveMicroUsd: alone.reserve.microUsd, judge: this.judgeView(alone),
          blocked: running ? { code: "PROVIDER_QUALITY_CHECK_RUNNING" } : alone.blocked });
      }
      const activeRoles = onRoles.filter((r) => needing.roles.some((n) => n.role === r.role));
      return {
        target: offered ? plan.target : null,
        draftId: plan.draft?.id ?? null,
        roles: offered ? plan.roles.map((r) => ({ role: r.role, remoteModel: r.remoteModel, conversations: r.conversations,
          priced: !r.paid || !!r.pricing, estimateMicroUsd: r.estimateMicroUsd })) : [],
        conversations: offered ? plan.conversations : 0,
        estimateMicroUsd: offered ? plan.estimateMicroUsd : 0,
        reserveMicroUsd: offered ? plan.reserve.microUsd : 0,
        /** The model that judges grounding and factuality, its calls and their share of the estimate. */
        judge: offered ? this.judgeView(plan) : null,
        typicalTokens: TYPICAL_TOKENS,
        blocked: running ? { code: "PROVIDER_QUALITY_CHECK_RUNNING" } : plan.blocked,
        latest: latest ? this.view(latest, await this.charged(client, latest.id)) : null,
        activeRoles,
        onRoles,
        onAll: onAll.roles.length ? { conversations: onAll.conversations, estimateMicroUsd: onAll.estimateMicroUsd,
          reserveMicroUsd: onAll.reserve.microUsd, judge: this.judgeView(onAll), blocked: running ? { code: "PROVIDER_QUALITY_CHECK_RUNNING" } : onAll.blocked } : null,
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

  /** Starts a check of the open draft (`draftId`) or of the active setup (`target: "active"`, optionally one `role`), for owners and
   * administrators. Returns at once; the run continues on the server. */
  async start(actor: Actor, workspace: string, raw: unknown) {
    const parsed = startSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_QUALITY_CHECK_INVALID", 400);
    const input = parsed.data, target: Target = "draftId" in input ? "draft" : "active", only = "role" in input ? input.role : undefined;
    const digest = sha256(JSON.stringify("draftId" in input ? { workspace, actor: actor.id, draftId: input.draftId }
      : { workspace, actor: actor.id, target, ...(only ? { role: only } : {}) }));
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
      const locked = await this.plan(client, workspace, target, only);
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
      // Each paid conversation's judge call reserves the same allowance, at ref `${id}:j${n}` (n as above).
      const judge = locked.judge;
      if (judge) {
        let m = 0;
        for (const role of locked.roles)
          for (let i = 0; i < role.conversations; i++, m++) {
            if (!role.paid) continue;
            await client.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,model_id,state,reserved_micro_usd,reserved_tokens,charged_micro_usd)
              VALUES($1,'quality_check',$2,1,$3,NULL,$4,$5,'reserved',$6,$7,$6)`, [randomUUID(), `${id}:j${m}`, workspace, role.role, judge.plan.modelId, allowance.microUsd, allowance.tokens]);
            events.push({ kind: "reserved", role: role.role, microUsd: allowance.microUsd, modelId: judge.plan.modelId, basis: "reserved_ceiling" });
          }
      }
      await client.query("UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd+$2,used_tokens=used_tokens+$3 WHERE workspace_id=$1",
        [workspace, locked.reserve.microUsd, locked.reserve.tokens]);
      onCommit(client, () => recordSpendEvents(events));
      await appendEvent(client, { workspaceId: workspace, actorId: actor.id, actorKind: "staff", type: "provider.quality_check.started",
        payload: { checkId: id, target, draftId: locked.draft?.id ?? null, roles, conversations: locked.conversations, estimateMicroUsd: locked.estimateMicroUsd,
          reservedMicroUsd: locked.reserve.microUsd }, idempotencyKey: `provider.quality_check.started:${id}` });
      const runtime = locked.runtime, configuration = locked.configuration, pricing = new Map(locked.roles.flatMap((r) => (r.pricing ? [[r.role, r.pricing] as const] : [])));
      launch = () => this.launch(actor, workspace, row, runtime, configuration, pricing, judge);
      return this.view(row, locked.reserve.microUsd);
    });
    launch?.();
    return result;
  }

  private launch(actor: Actor, workspace: string, row: CheckRow, runtime: ReturnType<typeof composeProviders>, configuration: Configuration,
    pricing: Map<EvalRole, ModelPricing>, judge: JudgeChoice | null) {
    const task = this.run(actor, workspace, row, runtime, configuration, pricing, judge)
      .catch(() => this.finish(actor, workspace, row.id, { state: "error", reason: "PROVIDER_QUALITY_CHECK_FAILED" }, "uncertain").catch(() => undefined))
      .finally(() => this.running.delete(row.id));
    this.running.set(row.id, task);
  }

  private async run(actor: Actor, workspace: string, row: CheckRow, runtime: ReturnType<typeof composeProviders>, configuration: Configuration,
    pricing: Map<EvalRole, ModelPricing>, judge: JudgeChoice | null) {
    const signal = AbortSignal.timeout(Math.max(1, row.deadline_at.getTime() - Date.now()));
    let index = 0, fault: string | null = null, detail: FaultDetail | null = null;
    const toolCalls = new Map<string, readonly ToolCallRecord[]>();
    const settle = async (call: CallRecord) => {
      const ref = `${row.id}:${index++}`, error = call.error;
      if (call.toolCalls.length) toolCalls.set(`${call.role}:${call.dialogue.id}`, call.toolCalls);
      const code = error instanceof ProviderError ? error.code : error ? "UNEXPECTED" : null;
      if (code && Object.hasOwn(PROVIDER_FAULTS, code) && !(code === "TIMEOUT" && signal.aborted) && !fault) {
        fault = PROVIDER_FAULTS[code]!;
        const failed = error as ProviderError;
        detail = { role: call.role, providerCode: failed.code, status: failed.status, providerReason: failed.reason };
      }
      await this.settleCall(workspace, row.id, ref, call, pricing.get(call.role) ?? null);
    };
    // The meaning judge, right after each answer (runSuite calls it after `settle`, so the answer's
    // position is index - 1). Its call is settled like the answer's; it never stops the run.
    const judgements = new Map<string, MeaningJudgement>();
    const bound = configuration.roles as Partial<Record<string, { modelId: string }>>;
    const meaningJudge: MeaningJudge | undefined = judge ? async (role, dialogue, output, signal) => {
      const position = index - 1, reply = answerText(output) ?? "";
      const identity = { model: judge.plan.remoteModel, self: bound[role]?.modelId === judge.plan.modelId };
      let answered: { output: unknown; usage: UsageReceipt } | null = null, failure: unknown = null;
      // Past the deadline nothing is sent; the reservation is released when the check finishes.
      if (signal.aborted) return judgementOf(identity, null, reply, "deadline");
      try {
        answered = await runtime.judgeMeaning(judge.plan, { ...judgeRequest(dialogue, reply), outputSchema: JUDGE_SCHEMA },
          `agent-eval-judge-${role}-${position}`, signal);
      } catch (error) { failure = error; }
      await this.settleLedger(workspace, row.id, `${row.id}:j${position}`, answered?.usage ?? (failure instanceof ProviderError ? failure.usage ?? null : null),
        failure, judge.pricing, false);
      const judgement = judgementOf(identity, answered?.output, reply,
        // A structured answer the adapter refused as not matching the schema is an invalid verdict too.
        failure ? (failure instanceof ProviderError ? (failure.code === "INVALID_RESPONSE" ? "verdict_invalid" : failure.code.toLowerCase()) : "unexpected") : undefined);
      judgements.set(`${role}:${dialogue.id}`, judgement);
      return judgement;
    } : undefined;
    let report: EvalReport | null = null;
    try {
      report = await runSuite({ suite: this.providers.evalSuite, configuration, runtime, mode: "live", roles: row.roles, signal,
        beforeDialogue: async (dialogue) => {
          if (fault || signal.aborted) throw new StopRun();
          await this.options.beforeDialogue?.(dialogue);
          if (signal.aborted) throw new StopRun();
        },
        afterCall: settle, ...(meaningJudge ? { meaningJudge } : {}) });
    } catch (error) {
      if (!(error instanceof StopRun)) throw error;
    }
    if (signal.aborted) return this.finish(actor, workspace, row.id, { state: "error", reason: "PROVIDER_QUALITY_CHECK_TIMEOUT" }, "not_started");
    if (fault || !report) {
      // The provider said the job's model is not there (HTTP 404 NOT_FOUND) although its model list
      // may still name it: record that, so the model picker stops offering it (provider-connections.ts).
      const failed = detail as FaultDetail | null, model = failed?.providerCode === "NOT_FOUND" ? roleModels(configuration)[failed.role] : undefined;
      const unavailable = model?.connectionId && model.remoteModel
        ? { connectionId: model.connectionId, remoteModel: model.remoteModel, status: failed!.status, providerReason: failed!.providerReason } : null;
      return this.finish(actor, workspace, row.id, { state: "error", reason: fault ?? "PROVIDER_QUALITY_CHECK_FAILED", detail, unavailable }, "not_started");
    }
    // A job with no failure whose judge could not run on some conversation has no result: it is not
    // recorded (neither passed nor failed). Every other job is recorded as an uploaded report is:
    // Core regrades every answer against its own suite, with the judge's verdicts for the judged graders.
    const undetermined = new Set(report.roles.filter((r) => r.dialogues.some((d) => d.grade.undetermined)
      && r.dialogues.every((d) => d.grade.passed || d.grade.undetermined)).map((r) => r.role));
    const recordable = { ...report, roles: report.roles.filter((r) => !undetermined.has(r.role)) };
    let recorded: Awaited<ReturnType<ProviderEvaluations["record"]>> = { results: [] };
    if (recordable.roles.length) try {
      recorded = await this.evaluations.record(actor, workspace, { idempotencyKey: `quality-check:${row.id}`, report: recordable }, judgements);
    } catch (error) {
      const reason = error instanceof ApiError && error.code === "FORBIDDEN" ? "PROVIDER_QUALITY_CHECK_SCOPE_CHANGED" : "PROVIDER_QUALITY_CHECK_FAILED";
      return this.finish(actor, workspace, row.id, { state: "error", reason }, "not_started");
    }
    const failures = (grades: readonly DialogueGrade[]) => grades.filter((g) => !g.passed).map((g) => {
      const reason = noAnswerReason(g.graders);
      return { dialogueId: g.dialogueId, graders: g.graders.filter((x) => !x.passed).map((x) => x.grader), ...(reason ? { reason } : {}) };
    });
    const outcome: RoleOutcome[] = report.roles.flatMap((run): RoleOutcome[] => {
      if (undetermined.has(run.role)) {
        const grades = run.dialogues.map((d) => d.grade);
        return [{ role: run.role, passed: false, dialogues: grades.length, failed: failures(grades), undetermined: true }];
      }
      const r = recorded.results.find((x) => x.role === run.role);
      if (!r) return [];
      const grades = r.grades as DialogueGrade[];
      return [{ role: r.role as EvalRole, passed: r.outcome === "passed", dialogues: grades.length, failed: failures(grades) }];
    });
    // Each conversation's detail, in the order it ran, graded by Core's own regrade.
    const dialogues: DialogueRow[] = [], suite = this.providers.evalSuite;
    for (const run of report.roles) {
      const grades = new Map((undetermined.has(run.role) ? run.dialogues.map((d) => d.grade)
        : recorded.results.find((r) => r.role === run.role)?.grades as DialogueGrade[] | undefined ?? []).map((g) => [g.dialogueId, g]));
      for (const d of run.dialogues) {
        const fixture = suite.dialogues.find((x) => x.id === d.dialogueId), grade = grades.get(d.dialogueId);
        if (!fixture || !grade) continue;
        dialogues.push({ position: dialogues.length, role: run.role, dialogueId: d.dialogueId, passed: grade.passed,
          detail: dialogueDetail(fixture, d.output, grade, toolCalls.get(`${run.role}:${d.dialogueId}`), judgements.get(`${run.role}:${d.dialogueId}`)) });
      }
    }
    // A failure stands; otherwise a job the judge could not finish leaves the check without a result.
    const state = outcome.some((o) => !o.passed && !o.undetermined) ? "failed" : outcome.some((o) => o.undetermined) ? "error" : "passed";
    return this.finish(actor, workspace, row.id, { state, reason: state === "error" ? "PROVIDER_QUALITY_CHECK_JUDGE_UNAVAILABLE" : null, outcome, dialogues }, "not_started");
  }

  /**
   * What each practice conversation of a finished check said (owners and administrators, as the
   * check itself). `recorded` is false for a check that kept no details: one still running, one
   * that stopped without a result, or one an older Core ran.
   */
  async details(actor: Actor, workspace: string, id: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const check = (await this.db.query<{ id: string; state: CheckRow["state"]; roles: EvalRole[] }>(
      "SELECT id,state,roles FROM provider_quality_checks WHERE workspace_id=$1 AND id=$2", [workspace, id])).rows[0];
    requireCondition(check, "PROVIDER_QUALITY_CHECK_NOT_FOUND", 404);
    const rows = (await this.db.query<{ position: number; role: EvalRole; dialogue_id: string; passed: boolean; detail: DialogueDetail }>(
      "SELECT position,role,dialogue_id,passed,detail FROM provider_quality_check_dialogues WHERE workspace_id=$1 AND check_id=$2 ORDER BY position",
      [workspace, id])).rows;
    const roles = [...check.roles, ...new Set(rows.map((r) => r.role).filter((role) => !check.roles.includes(role)))];
    return { checkId: check.id, state: check.state, recorded: rows.length > 0,
      roles: roles.map((role) => ({ role, dialogues: rows.filter((r) => r.role === role)
        .map((r) => ({ position: r.position, dialogueId: r.dialogue_id, passed: r.passed, ...r.detail })) })).filter((r) => r.dialogues.length > 0) };
  }

  /** Settles one conversation's ledger row from what the provider reported, and counts progress. */
  private settleCall(workspace: string, id: string, ref: string, call: CallRecord, pricing: ModelPricing | null) {
    return this.settleLedger(workspace, id, ref, call.usage, call.error, pricing, true);
  }
  /** Settles one paid call's ledger row (a conversation's answer, or its judge call with `progress` false). */
  private async settleLedger(workspace: string, id: string, ref: string, usage: UsageReceipt | null, error: unknown, pricing: ModelPricing | null, progress: boolean) {
    const notSent = error instanceof ProviderError && error.submission === "not_sent" && !error.usage?.attempts.length;
    const rejected = error && !notSent ? definiteRejection(error) : null;
    // A reply the provider returned in full (usage reported) that the adapter's output checks refused
    // is a definite outcome (output-refusal.ts): it is paid like an answer, never held as uncertain.
    const refused = error ? answeredRefusalReason(error) : null, answered = !error || refused !== null;
    // No pricing (a media conversation, which holds no ledger row): nothing to price.
    const cost = answered && usage && pricing ? priceUsage(usage, pricing).cost : null;
    const totals = usage?.attempts.map((a) => a.tokens.total) ?? [];
    const tokens = answered && totals.length && totals.every((t) => t !== null) ? totals.reduce<number>((n, t) => n + t!, 0) : null;
    await afterCommitTransaction(this.db, async (client) => {
      await client.query("SELECT 1 FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE", [workspace]);
      const open = (await client.query<{ reserved_micro_usd: string; reserved_tokens: string; model_id: string | null; role: string }>(
        "SELECT reserved_micro_usd,reserved_tokens,model_id,role FROM provider_spend_ledger WHERE source='quality_check' AND source_ref=$1 AND attempt=1 AND state='reserved' AND settled_at IS NULL FOR UPDATE",
        [ref])).rows[0];
      if (progress) await client.query("UPDATE provider_quality_checks SET completed_dialogues=LEAST(total_dialogues,completed_dialogues+1) WHERE id=$1 AND state='running'", [id]);
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
        // Answered (or refused after answering) but not priceable, or the outcome is unknown: the reservation stays charged.
        await client.query(`UPDATE provider_spend_ledger SET state=$2,settled_at=clock_timestamp() WHERE source='quality_check' AND source_ref=$1 AND attempt=1`,
          [ref, answered ? "unpriced" : "uncertain"]);
      if (release || releaseTokens) {
        await client.query("UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd-$2,used_tokens=used_tokens-$3 WHERE workspace_id=$1",
          [workspace, release, releaseTokens]);
        if (release) events.push({ kind: "released", role: open.role, microUsd: release, modelId: open.model_id, basis: "reported" });
      }
      if (events.length) onCommit(client, () => recordSpendEvents(events));
    });
  }

  private async finish(actor: Actor, workspace: string, id: string,
    result: { state: "passed" | "failed" | "error"; reason: string | null; outcome?: RoleOutcome[]; detail?: FaultDetail | null; dialogues?: DialogueRow[];
      unavailable?: UnavailableModel | null },
    open: "not_started" | "uncertain") {
    await afterCommitTransaction(this.db, async (client) => {
      const done = await client.query(
        "UPDATE provider_quality_checks SET state=$3,reason_code=$4,outcome=$5,reason_detail=$6,finished_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND state='running'",
        [id, workspace, result.state, result.reason, result.outcome ? JSON.stringify(result.outcome) : null, result.detail ? JSON.stringify(result.detail) : null]);
      // Conversations never sent (stopped early) release their reservation.
      await this.closeOpenCalls(client, workspace, id, open);
      if (!done.rowCount) return;
      const unavailable = result.unavailable;
      if (unavailable)
        await client.query(`INSERT INTO provider_unavailable_models(workspace_id,connection_id,remote_model,reason_code,provider_status,provider_reason,check_id)
          VALUES($1,$2,$3,'PROVIDER_GUIDE_MODEL_UNAVAILABLE',$4,$5,$6) ON CONFLICT (workspace_id,connection_id,remote_model) DO UPDATE SET
          provider_status=EXCLUDED.provider_status,provider_reason=EXCLUDED.provider_reason,check_id=EXCLUDED.check_id,marked_at=clock_timestamp()`,
        [workspace, unavailable.connectionId, unavailable.remoteModel, unavailable.status !== null && unavailable.status >= 100 && unavailable.status <= 599 ? unavailable.status : null,
          unavailable.providerReason?.slice(0, 128) ?? null, id]);
      for (const d of result.dialogues ?? [])
        await client.query(`INSERT INTO provider_quality_check_dialogues(check_id,workspace_id,position,role,dialogue_id,passed,detail)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, workspace, d.position, d.role, d.dialogueId, d.passed, JSON.stringify(d.detail)]);
      await appendEvent(client, { workspaceId: workspace, actorId: actor.id, actorKind: "staff", type: "provider.quality_check.finished",
        payload: { checkId: id, state: result.state, reason: result.reason, ...(result.detail ? { reasonDetail: result.detail } : {}),
          ...(unavailable ? { unavailableModel: { connectionId: unavailable.connectionId, remoteModel: unavailable.remoteModel } } : {}), chargedMicroUsd: await this.charged(client, id),
          roles: (result.outcome ?? []).map((o) => ({ role: o.role, passed: o.passed })) },
        idempotencyKey: `provider.quality_check.finished:${id}` });
    });
  }
}

/**
 * The reconcile pass for quality-check calls an older Core left `uncertain` although the provider had
 * answered in full and only the adapter's output checks refused the reply (INVALID_RESPONSE,
 * INCOMPLETE_OUTPUT, BLOCKED). The check's own recorded result is the evidence: the conversation at
 * that ledger position (refs follow the check's role order and each role's dialogues, as `start`
 * numbered them) failed with that code and no answer. Those calls are definite, so each row becomes
 * `unpriced`. Older Core kept no usage receipt for them, so nothing can be priced and the
 * reservation stays charged (the gateway's basis for a refused reply without a price); it is never
 * guessed down. A row whose check recorded no result, or whose position or role does not match,
 * is left for staff. Each row changes at most once (guarded update). Returns the rows settled.
 */
export async function settleRefusedQualityCheckCalls(db: Database, workspaces: readonly string[], limit: number) {
  const rows = (await db.query<{ id: string; workspace_id: string; role: string; position: string; check_id: string; roles: EvalRole[]; total_dialogues: number }>(
    `SELECT l.id,l.workspace_id,l.role,split_part(l.source_ref,':',2) AS position,c.id AS check_id,c.roles,c.total_dialogues
     FROM provider_spend_ledger l JOIN provider_quality_checks c ON c.workspace_id=l.workspace_id AND l.source_ref LIKE c.id::text || ':%'
     WHERE l.source='quality_check' AND l.state='uncertain' AND l.workspace_id=ANY($1::uuid[]) AND c.state<>'running'
       AND EXISTS (SELECT 1 FROM provider_eval_results r WHERE r.workspace_id=c.workspace_id AND r.idempotency_key='quality-check:' || c.id::text)
     ORDER BY l.reserved_at,l.id LIMIT $2`, [workspaces, limit])).rows;
  const codes = new Set<string>([...Object.keys(PROVIDER_OUTPUT_REASONS), ...Object.values(PROVIDER_OUTPUT_REASONS)]);
  const results = new Map<string, { role: string; reason: string | null }[] | null>();
  let settled = 0;
  for (const row of rows) {
    if (!results.has(row.check_id)) {
      const recorded = (await db.query<{ role: string; grades: { graders: { findings?: string[] }[] }[] }>(
        "SELECT role,grades FROM provider_eval_results WHERE workspace_id=$1 AND idempotency_key=$2", [row.workspace_id, `quality-check:${row.check_id}`])).rows;
      const ordered = row.roles.flatMap((role) => recorded.find((r) => r.role === role)?.grades.map((g) => ({ role, reason: noAnswerReason(g.graders) })) ?? []);
      results.set(row.check_id, recorded.length && ordered.length === row.total_dialogues ? ordered : null);
    }
    const position = /^[0-9]+$/.test(row.position) ? Number(row.position) : -1, entry = results.get(row.check_id)?.[position];
    if (!entry || entry.role !== row.role || !entry.reason || !codes.has(entry.reason)) continue;
    const updated = await db.query("UPDATE provider_spend_ledger SET state='unpriced' WHERE id=$1 AND source='quality_check' AND state='uncertain'", [row.id]);
    settled += updated.rowCount ?? 0;
  }
  return settled;
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
  app.get(base + "/:id/details", { schema: { params: withId }, logLevel: "silent" },
    async (request) => service.details(await auth.authenticate(request), p(request).workspaceId, p(request).id));
  app.addHook("onClose", async () => service.idle());
}
