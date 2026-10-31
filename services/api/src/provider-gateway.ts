import { courseStrategiesFor } from './course-strategies.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { definiteRejection, ProviderError, priceUsage, pricingCovers, type ModelPricing, type ReceiptCost, type UsageReceipt } from '@course-core/providers';
import { MAX_RETRY_AFTER_MS, outcomeSchema, providerRequestSchema, type Outcome, type ProviderRequest } from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { afterCommitTransaction, onCommit } from './after-commit.js';
import { ApiError, requireCondition } from './errors.js';
import { digestJson } from './repository.js';
import { appendEvent } from './events.js';
import { endedSupervisorOperationWithin, resolveSupervisorOperation, resolveSupervisorOperationWithin, storeSupervisorArtifact, type SupervisorArtifactContent } from './supervisor-bridge.js';
import { teachingContext } from './provider-context.js';
import type { ProviderRuntime } from './provider-runtime.js';
import {supervisorTools} from './supervisor-tools.js';
import type {WorkspaceProviders} from './provider-setup.js';
import { telemetry } from './telemetry.js';
import { replyDrafts, type ReplyDrafts } from './reply-drafts.js';
import { pricedStatus, pricingDecision, pricingInForce, requiresPricing } from './provider-costs.js';
import { answeredRefusalReason } from './output-refusal.js';
import { guardCompanionReply, type CheckReplyJudge, type JudgeVerdict } from './companion-check-integrity.js';
import { checkJudgeRequest, judgeRequestBytes, judgeTokenBound, parseCheckJudgeVerdict } from './companion-check-judge.js';
import { judgeCeilingMicroUsd } from './role-reservation.js';
import type { TeachingContext } from './agent-strategies.js';
import { dispatchRevision } from './agent-evals/gate.js';
import type { ConfigurationShape } from './agent-evals/revision.js';
import { publicSuite } from './agent-evals/public-suite.js';

import type {AdaptationRuntime} from "./adaptation-store.js";

interface Options { adaptation?:AdaptationRuntime; serviceToken?: string; workspaceIds?: readonly string[]; maxConcurrent?: number;workspaceProviders?:WorkspaceProviders;
  /** The host's provider configuration file, when loaded: the configuration of the fallback runtime. */
  hostConfiguration?: unknown;
  /** Where streamed companion drafts go: the process's own by default; null turns streaming off. */
  drafts?: ReplyDrafts | null;
  /** Commit-time wake-ups (database-wake.ts): a job cancellation raises `course_outbox`, so a call
   * under way for it is stopped at once instead of at the next poll. */
  wake?: { subscribe(channel: 'course_outbox', listener: () => void): () => void };
  /** How often a call under way re-reads its job's cancellation flag (the backstop to `wake`). */
  cancellationPollMs?: number }
/** Output refusal reasons for a streamed reply that stopped part way with its usage reported. */
const STOPPED_REPLY = { cancelled: 'provider_stream_stopped', stalled: 'provider_stream_stalled' } as const;
interface DispatchRow { request_digest: string; owner_id: string; state: string; outcome: Outcome | null }
/** The recorded answer for a repeated request. A dispatch still running is uncertain. A finished
 * dispatch whose outcome was cleared by an erasure made before erasure kept the outcome's
 * non-personal fields is also uncertain: its reservation stays held rather than being guessed. */
function recordedOutcome(row: DispatchRow): Outcome {
  if (row.state === 'in_flight' || row.outcome === null) return { status: 'uncertain' };
  return outcomeSchema.parse(row.outcome);
}
/** The check judge's call of one dispatch (companion-check-judge.ts). `ceiling`: the most its
 * request could cost (role-reservation.ts judgeCeilingMicroUsd), known before it is sent when it is
 * priced; `failure`: why the call failed, when it did. */
interface JudgeRun { modelId: string; pricing: ModelPricing | null; usage: UsageReceipt | null; cost: ReceiptCost | null; verdict: string;
  ceiling: number | null; tokenBound: number | null; sent: boolean; failure: unknown }
/** How the judge's part of a dispatch is settled (migration 124, docs/provider-stalls.md): at its
 * reported usage; not charged when no byte of the request could have been accepted or every
 * attempt was refused with a documented rejection; held at its ceiling for the owner when it was
 * sent and nothing came back that says what it used. */
export type JudgeSettlement = 'reported' | 'not_charged' | 'held';
export function judgeSettlement(run: Pick<JudgeRun, 'usage' | 'sent' | 'failure'>): JudgeSettlement {
  if (!run.sent) return 'not_charged';
  const error = run.failure, attempts = run.usage?.attempts ?? [];
  if (error === undefined || error === null) return run.usage && receiptTokens(run.usage) !== null ? 'reported' : 'held';
  if (error instanceof ProviderError) {
    if (error.submission === 'not_sent' && attempts.every(a => a.outcome === 'not_sent')) return 'not_charged';
    if (attempts.length > 0 && attempts.every(a => a.outcome === 'rejected' || a.outcome === 'not_sent') && definiteRejection(error)) return 'not_charged';
    // Usage the provider reported (an answer Core refused, usage up to a stop) is what it used.
    if (run.usage && attempts.some(a => a.outcome === 'response' || a.outcome === 'partial') && receiptTokens(run.usage) !== null) return 'reported';
  }
  return 'held';
}
/** Tokens of a receipt's attempts: a refused or unsent attempt counts nothing; null when any other
 * attempt's usage is unknown. */
function receiptTokens(receipt: UsageReceipt): number | null {
  let sum = 0;
  for (const attempt of receipt.attempts) {
    if (attempt.outcome === 'rejected' || attempt.outcome === 'not_sent') continue;
    if (attempt.outcome !== 'response' && attempt.outcome !== 'partial') return null;
    const t = attempt.tokens, total = t.total ?? (t.input === null ? null : t.input + (t.output ?? 0) + (t.thoughts ?? 0));
    if (total === null) return null;
    sum += total;
  }
  return sum;
}
let suite: ReturnType<typeof publicSuite> | undefined;
/** Core's public eval suite, for hosts without a workspace provider vault. */
const defaultSuite = () => (suite ??= publicSuite());
export function registerProviderGateway(app: FastifyInstance, db: Database, runtime: ProviderRuntime, options: Options) {
  const expected = options.serviceToken ? createHash('sha256').update(options.serviceToken).digest() : null;
  const limit = options.maxConcurrent ?? 2; requireCondition(Number.isSafeInteger(limit) && limit >= 1 && limit <= 8, 'PROVIDER_INVALID_CONCURRENCY');
  let active = 0;
  function authorize(request: FastifyRequest) {
    requireCondition(expected, 'PROVIDER_UNCONFIGURED', 503);
    const header = request.headers.authorization, value = typeof header === 'string' && /^Bearer \S+$/.test(header) ? header.slice(7) : '';
    requireCondition(timingSafeEqual(expected, createHash('sha256').update(value).digest()), 'PROVIDER_UNAUTHENTICATED', 401);
  }
  app.get('/v1/capabilities',{schema:{querystring:{type:'object',additionalProperties:false,properties:{workspaceId:{type:'string',format:'uuid'}}}}}, async request => { authorize(request);const {workspaceId} = request.query as {workspaceId?:string};if(workspaceId){requireCondition(options.workspaceIds?.includes(workspaceId),'PROVIDER_FORBIDDEN',403);return pricedStatus(db,workspaceId,await options.workspaceProviders?.resolve(workspaceId)??runtime);}return runtime.status(); });
  app.post('/v1/operations', { bodyLimit: 262144, logLevel: 'silent' }, async (request, reply) => {
    authorize(request);
    const parsed = providerRequestSchema.safeParse(request.body);
    requireCondition(parsed.success, 'PROVIDER_INVALID_REQUEST');
    const body = parsed.data;
    requireCondition(options.workspaceIds?.includes(body.job.workspaceId), 'PROVIDER_FORBIDDEN', 403);
    requireCondition(request.headers['idempotency-key'] === body.operationId, 'PROVIDER_IDEMPOTENCY_REQUIRED');
    const digest = digestJson(body);
    const recorded = async () => {
      const row = (await db.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4',
        [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId])).rows[0];
      // The same identity with a different request is never a replay.
      if (row) requireCondition(row.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409);
      return row;
    };
    const cached = await recorded();
    // A completed receipt remains retrievable after cancellation so usage can be settled.
    if (cached?.state === 'completed') return recordedOutcome(cached);
    // Provider retries must resolve the committed host operation, never accept a worker-supplied owner.
    let operation: Awaited<ReturnType<typeof resolveSupervisorOperation>>;
    try { operation = await resolveSupervisorOperation(db, body); }
    catch (error) {
      // The job has ended (cancelled, failed, applied, expired, fenced out), so nothing new may be
      // dispatched. A repeat of a request the gateway already recorded still gets that record's
      // outcome, read-only: no provider call, no dispatch or budget change. Re-read so a dispatch
      // that finished meanwhile answers with its final outcome; one still running is uncertain.
      // An erased enrollment's job keeps no snapshot (SUPERVISOR_NOT_FOUND), but its dispatch
      // receipt still answers a repeat.
      if (!(error instanceof ApiError && (error.code === 'SUPERVISOR_INPUT_STALE' || error.code === 'SUPERVISOR_NOT_FOUND'))) throw error;
      const replay = await recorded();
      if (replay) return recordedOutcome(replay);
      if (error.code !== 'SUPERVISOR_INPUT_STALE') throw error;
      // A first request for an ended job: nothing was ever sent for this identity, and nothing
      // may be now. Certify that durably, under the same lock admission takes, so the activity
      // releases its reservation once. The receipt row then blocks any later admission of this
      // operation by its owner, and a dispatch that was admitted first is answered from its own row.
      return transaction(db, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider:${body.operationId}`]);
        const old = (await client.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 FOR UPDATE', [body.operationId])).rows[0];
        if (old) { requireCondition(old.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409); return recordedOutcome(old); }
        const ended = await endedSupervisorOperationWithin(client, body);
        // Live again (a transient fence) or already succeeded: no certificate; the refusal stands.
        if (!ended || ended.operationStatus === 'succeeded') throw error;
        const outcome: Outcome = { status: 'not_started', retryable: false };
        await client.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,outcome,failure_code,finished_at,trace_id)
          VALUES ($1,$2,$3,$4,$5,$6,'not_started',$7,'SUPERVISOR_JOB_ENDED',now(),$8)`,
          [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId, ended.ownerId, digest, JSON.stringify(outcome), telemetry().traceId()]);
        return outcome;
      });
    }
    const admitted = await transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider:${body.operationId}`]);
      const old = (await client.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 FOR UPDATE', [body.operationId])).rows[0];
      if (old) {
        requireCondition(old.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409);
        if (old.state === 'completed') return { invoke: false as const, outcome: recordedOutcome(old) };
        if (old.state !== 'not_started' || old.owner_id === operation.ownerId) return { invoke: false as const, outcome: old.state === 'not_started' ? recordedOutcome(old) : { status: 'uncertain' as const } };
        // A new host attempt may reuse the logical ID only after a certified non-start.
        // The row now describes the new attempt, so it links that attempt's trace (or none).
        await client.query("UPDATE provider_dispatches SET owner_id=$2,state='in_flight',outcome=NULL,failure_code=NULL,started_at=now(),finished_at=NULL,sent_at=NULL,trace_id=$3 WHERE operation_id=$1",
          [body.operationId, operation.ownerId, telemetry().traceId()]);
      } else {
        requireCondition(operation.operationStatus === 'in_flight', 'PROVIDER_OPERATION_NOT_ADMITTED', 409);
        await client.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,trace_id) VALUES ($1,$2,$3,$4,$5,$6,'in_flight',$7)`,
          [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId, operation.ownerId, digest, telemetry().traceId()]);
      }
      return { invoke: true as const };
    });
    if (!admitted.invoke) return admitted.outcome;
    /** A completed reply the adapter refused, recorded as a refusal artifact (reason code only, never
     * the reply) and priced at its reported usage. Null when the outcome stays uncertain: an
     * attempt without a read response or reported total, a role without a refusal record, or a
     * refusal that could not be stored. */
    const settleRefusedAnswer = async (error: ProviderError, context: TeachingContext | null) => {
      const reason = answeredRefusalReason(error), receipt = error.usage;
      if (!reason || !receipt) return null;
      const content: SupervisorArtifactContent | null = body.role === 'companion' || body.role === 'supervisor'
        ? { kind: 'output_refusal', role: body.role, reason }
        : body.role === 'reviewer' && context?.rubricReview
          ? { kind: 'rubric_refusal', requestId: context.rubricReview.requestId, attemptId: context.rubricReview.attemptId, reason: 'host_check_failed', problems: [reason] }
          : null;
      if (!content) return null;
      let artifact: Awaited<ReturnType<typeof storeSupervisorArtifact>>;
      try { artifact = await storeSupervisorArtifact(db, operation.ref, body.operationId, operation.ownerId, content); }
      catch { return null; }
      const tokens = receipt.attempts.reduce((sum, attempt) => sum + attempt.tokens.total!, 0);
      const priced = pricing ? priceUsage(receipt, pricing).cost : null;
      const charge = priced && priced.microUsd <= 1_000_000_000 ? priced : null;
      receipt.cost = charge;
      const outcome: Outcome = { status: 'succeeded', artifact, usage: { microUsd: charge ? charge.microUsd : body.checkpoint.allowance.microUsd, tokens },
        usageBasis: { microUsd: charge ? 'reported' : 'reserved_ceiling', tokens: 'reported' } };
      return { outcome, cost: charge };
    };
    /**
     * A streamed reply stopped part way (the job was cancelled, or the stream stalled or timed
     * out) after the provider reported its cumulative usage up to the stop: a definite outcome,
     * charged at that usage (or, unpriced, at the reservation) and recorded as a refusal (reason
     * code only, nothing of the reply), so the rest of the reservation is released. Null when any
     * attempt's usage is unknown (nothing reported, or a count only sent at the end): that call
     * stays uncertain.
     */
    const settleStoppedReply = async (error: ProviderError, reason: (typeof STOPPED_REPLY)[keyof typeof STOPPED_REPLY]) => {
      const receipt = error.usage;
      if (!receipt || (body.role !== 'companion' && body.role !== 'supervisor')) return null;
      const attempts = receipt.attempts;
      if (!attempts.some(a => a.outcome === 'partial') || attempts.some(a => !['partial', 'response', 'rejected', 'not_sent'].includes(a.outcome))) return null;
      let artifact: Awaited<ReturnType<typeof storeSupervisorArtifact>>;
      try { artifact = await storeSupervisorArtifact(db, operation.ref, body.operationId, operation.ownerId, { kind: 'output_refusal', role: body.role, reason }); }
      catch { return null; }
      const tokens = attempts.reduce((sum, a) => sum + (a.outcome === 'partial' || a.outcome === 'response'
        ? a.tokens.total ?? (a.tokens.input ?? 0) + (a.tokens.output ?? 0) + (a.tokens.thoughts ?? 0) : 0), 0);
      const priced = pricing ? priceUsage(receipt, pricing).cost : null;
      const charge = priced && priced.microUsd <= 1_000_000_000 ? priced : null;
      receipt.cost = charge;
      const outcome: Outcome = { status: 'succeeded', artifact, usage: { microUsd: charge ? charge.microUsd : body.checkpoint.allowance.microUsd, tokens },
        usageBasis: { microUsd: charge ? 'reported' : 'reserved_ceiling', tokens: 'reported' } };
      return { outcome, cost: charge };
    };
    let assembled: TeachingContext | null = null;
    // Why the call under way was stopped by Core, if it was: its job was cancelled (the learner's
    // Stop, staff, erasure), seen through the cancellation flag.
    let stoppedBy: 'cancelled' | null = null;
    let draft: ReturnType<ReplyDrafts['open']> = null;
    let started = false, acquired = false, result = { status: 'uncertain' } as Outcome, usage: unknown = null, candidate: unknown = null, failureCode: string | null = null;
    let watching: (() => void) | null = null;
    let modelId: string | null = null, pricing: ModelPricing | null = null, cost: ReceiptCost | null = null, pricingState: 'priced' | 'unpriced' | 'refused' | undefined;
    // The check judge's call for this dispatch (companion-check-judge.ts), when one ran: charged to
    // this operation with the companion's own call, recorded on the dispatch beside it.
    let judged: JudgeRun | null = null, judgeSettled: JudgeSettlement | null = null, judgeHeld: number | null = null;
    let charged: number | null = null;
    // A reply in check-coaching mode, and how its check ended: kept, withheld (Core's coaching
    // message in its place) or failed. Recorded as a learning event with the receipt (below).
    let checkMode: { messageId: string } | null = null, checked: 'kept' | 'withheld' | 'failed' | null = null;
    // Which strategy answered and the revision it ran as, recorded on the dispatch (requirement B08).
    let ran: { id: string; version: string; source: 'core' | 'course'; revisionDigest: string | null; standing: string } | null = null;
    // Role, checkpoint, outcome, usage counts and cost estimate only; never the request, context or candidate.
    const observed = telemetry(), span = observed.start('provider.operation', { 'course.supervisor.role': body.role, 'course.supervisor.checkpoint': body.checkpoint.id });
    let counted: Record<string, string | number | null | undefined> = {};
    try { await span.run(async () => {
    try {
      if (active >= limit) { result = { status: 'not_started', retryable: true }; failureCode = 'CONCURRENCY_LIMIT'; }
      else {
        active += 1; acquired = true;
        const resolved = options.workspaceProviders ? await options.workspaceProviders.resolveJobConfigured(body.job.jobId, body.job.workspaceId)
          : { runtime, configuration: null, key: 'host' };
        const selected = resolved.runtime;
        // Paid-work admission: the price in force now prices this call. Without one, a
        // workspace that requires prices refuses before any context is read or sent.
        const decision = await pricingDecision(db, body.job.workspaceId, selected, body.role);
        modelId = decision.modelId; pricingState = decision.admit ? decision.pricing ? 'priced' : 'unpriced' : 'refused';
        requireCondition(decision.admit, 'PROVIDER_PRICING_REQUIRED', 409);
        pricing = decision.pricing;
        const context = await teachingContext(db, operation.ref, operation.input.context);
        assembled = context;
        // Strategies the course release declared, bound by Core to narrow its own (course-strategies.ts).
        // A declaration's tool references name tools the course declares, so both are read.
        const release = (await db.query<{ digest: string; strategies: unknown; tools: unknown }>(`SELECT r.digest,r.server_bundle->'agentStrategies' AS strategies,
          r.server_bundle->'tools' AS tools FROM enrollments e
          JOIN course_releases r ON r.id=e.course_release_id AND r.workspace_id=e.workspace_id WHERE e.id=$1 AND e.workspace_id=$2`, [body.job.enrollmentId, body.job.workspaceId])).rows[0];
        const course = release?.strategies ? courseStrategiesFor(release.digest, { agentStrategies: release.strategies, tools: release.tools ?? undefined }) : [];
        const selection = selected.selection(body.role, course);
        if (selection) {
          const configuration = (resolved.configuration ?? (resolved.key === 'host' ? options.hostConfiguration ?? null : null)) as ConfigurationShape | null;
          const revision = await dispatchRevision(db, { workspace: body.job.workspaceId, suite: options.workspaceProviders?.evalSuite ?? defaultSuite(),
            configuration, configurationKey: configuration ? resolved.key : null, role: body.role, strategy: selection.strategy, source: selection.source });
          ran = { id: selection.strategy.contract.id, version: selection.strategy.contract.version, source: selection.source, ...revision };
          // A course's own strategy answers only once its exact revision has a passing check or an
          // owner's approval (agent-evals/gate.ts). Core's wider strategy never runs in its place.
          requireCondition(selection.source === 'core' || revision.standing === 'passed' || revision.standing === 'approved', 'COURSE_STRATEGY_NOT_CHECKED', 409);
        }
        requireCondition(selected.tokenReservationBound(body.role, context, course) <= body.checkpoint.allowance.tokens, 'PROVIDER_TOKEN_RESERVATION_TOO_SMALL', 409);
        // Context assembly may have waited; fence one last time before sending data to a provider,
        // and record that this dispatch may now be sent, in one transaction under the enrollment
        // lock. Until then the dispatch has certainly not reached a provider: data erasure releases
        // its reservation and closes the receipt, and this fence then refuses (never sent).
        const fresh = await transaction(db, async client => {
          const resolved = await resolveSupervisorOperationWithin(client, body);
          const marked = await client.query("UPDATE provider_dispatches SET sent_at=clock_timestamp() WHERE operation_id=$1 AND owner_id=$2 AND state='in_flight' AND sent_at IS NULL",
            [body.operationId, operation.ownerId]);
          requireCondition(marked.rowCount === 1, 'PROVIDER_DISPATCH_CLOSED', 409);
          return resolved;
        });
        // The call stops at the checkpoint's deadline, or as soon as its job is cancelled: the
        // cancellation flag is committed before the workflow is told, so the gateway reads it on
        // the commit's wake-up, on a short poll, and when the worker's request to it closes (the
        // activity aborts it when Temporal cancels the activity). A worker that only went away is
        // not a cancellation: the call goes on and its receipt is reconciled.
        const stop = new AbortController();
        const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1,Math.min(body.checkpoint.timeoutMs,fresh.remainingMs))), stop.signal]);
        let checking = false;
        const check = async () => {
          if (checking || stop.signal.aborted) return;
          checking = true;
          try {
            const job = (await db.query<{ cancellation_requested: boolean; state: string }>('SELECT cancellation_requested,state FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3',
              [body.job.jobId, body.job.enrollmentId, body.job.workspaceId])).rows[0];
            if (!job || job.cancellation_requested || job.state === 'cancelled') { stoppedBy = 'cancelled'; stop.abort(); }
          } catch { /* the next poll reads it again */ } finally { checking = false; }
        };
        const closed = () => { if (!reply.raw.writableFinished) void check(); };
        reply.raw.on('close', closed);
        const poll = setInterval(() => void check(), options.cancellationPollMs ?? 1_000); poll.unref();
        const unsubscribe = options.wake?.subscribe('course_outbox', () => void check());
        watching = () => { clearInterval(poll); unsubscribe?.(); reply.raw.off('close', closed); };
        started = true;
        // A companion answer streams to the learner as a draft while it arrives (reply-drafts.ts):
        // only now, after admission, pricing, the reservation check and the last fence, and only
        // the text the strategy receives. The final result below is still the only stored output.
        const messageId = (operation.input.context as { messageId?: unknown }).messageId;
        // In check-coaching mode the draft is a checking one: nothing of the reply is sent before
        // Core has checked it, and the learner sees that the reply is being checked.
        draft = body.role === 'companion' && typeof messageId === 'string' && options.drafts !== null
          ? (options.drafts ?? replyDrafts()).open({ enrollmentId: body.job.enrollmentId, jobId: body.job.jobId, messageId,
            checking: Boolean(context.checkCoaching?.items.length) }) : null;
        if (body.role === 'companion' && typeof messageId === 'string' && context.checkCoaching?.items.length) { checkMode = { messageId }; checked = 'failed'; }
        let generated: Awaited<ReturnType<ProviderRuntime['execute']>>;
        try {
          generated = await selected.execute(body.role, context, createHash('sha256').update(body.operationId).digest('hex'), signal,body.role==='supervisor'?supervisorTools(db,body,context,options.adaptation):undefined,async()=>{await resolveSupervisorOperation(db,body);},course,
            draft ? draft.push : undefined);
        } catch (error) { watching?.(); watching = null; throw error; }
        usage = generated.usage;
        const totals = generated.usage.attempts.map(attempt => attempt.tokens.total);
        const knownTokens = totals.length > 0 && totals.every(total => total !== null);
        const companionTokens = knownTokens ? totals.reduce<number>((sum, total) => sum + total!, 0) : null;
        // Reported usage times the operator's price version, rounded up in whole micro-USD.
        // Without a price or with any unknown attempt, the full allowance stays charged.
        const priced = pricing ? priceUsage(generated.usage, pricing).cost : null;
        cost = priced && priced.microUsd <= 1_000_000_000 ? priced : null;
        generated.usage.cost = cost;
        if (!cost) pricingState = 'unpriced';
        // The semantic judge of a reply in check-coaching mode (companion-check-judge.ts). It runs
        // only when the job's reservation still has room for its ceiling on top of what the reply
        // used, and fails closed: no verdict withholds the reply.
        const allowance = body.checkpoint.allowance;
        const judge: CheckReplyJudge = async input => {
          const unavailable = (code: string): JudgeVerdict => { if (judged) judged.verdict = `unavailable:${code}`; return { verdict: 'unavailable', code }; };
          const plan = selected.checkJudge();
          if (!plan) return unavailable('judge_not_configured');
          // Recorded on the dispatch whatever happens next; only a call that ran has a receipt.
          judged = { modelId: plan.modelId, pricing: null, usage: null, cost: null, verdict: 'unavailable:judge_not_run', ceiling: null, tokenBound: null, sent: false, failure: null };
          const found = await pricingInForce(db, body.job.workspaceId, plan.modelId);
          const judgePricing = found && pricingCovers(found, 'tokens') ? found : null;
          if (!judgePricing && await requiresPricing(db, body.job.workspaceId)) return unavailable('judge_unpriced');
          const request = checkJudgeRequest(input);
          if (request.systemInstruction.length + request.prompt.length > plan.maxInputCharacters) return unavailable('judge_input_too_large');
          const tokenBound = judgeTokenBound(request, plan.maxOutputTokens);
          if (companionTokens === null || companionTokens + tokenBound > allowance.tokens) return unavailable('judge_reservation');
          const ceiling = judgePricing ? judgeCeilingMicroUsd(judgeRequestBytes(request), plan.maxOutputTokens, judgePricing) : null;
          if (cost && judgePricing && (ceiling === null || cost.microUsd + ceiling > allowance.microUsd)) return unavailable('judge_reservation');
          judged.pricing = judgePricing; judged.verdict = 'unavailable:judge_failed'; judged.ceiling = ceiling; judged.tokenBound = tokenBound; judged.sent = true;
          try {
            const result = await selected.judgeCheckReply(plan, request, createHash('sha256').update(`${body.operationId}:check-judge`).digest('hex'), signal);
            judged!.usage = result.usage;
            const verdict = parseCheckJudgeVerdict(result.output);
            if (!verdict) return unavailable('judge_malformed');
            judged!.verdict = verdict.verdict === 'leak' ? `leak:${verdict.findings.join(',')}` : verdict.verdict;
            return verdict;
          } catch (error) {
            judged!.usage = error instanceof ProviderError ? error.usage ?? null : null;
            judged!.failure = error;
            return unavailable(error instanceof ProviderError ? `judge_${error.code.toLowerCase()}` : 'judge_failed');
          }
        };
        // Graded-check integrity (companion-check-integrity.ts): a reply in check-coaching mode that
        // gives away a matched check's answer, by the deterministic patterns or the judge, is withheld
        // here, before anything of it is stored or its draft completed; Core's coaching message takes
        // its place, charged at what the calls used.
        const guarded = generated.role === 'companion'
          ? await guardCompanionReply(db, { workspaceId: body.job.workspaceId, courseReleaseId: operation.input.context.courseReleaseId, lessonText: context.episode.teaching },
            context.question, generated.content, judge)
          : { content: generated.content, withheld: null };
        // The job's cancellation is watched through the judge's call too (the learner's Stop ends it).
        watching?.(); watching = null;
        if (guarded.withheld) draft?.withdraw(guarded.withheld === 'check_judge_unavailable' || guarded.withheld === 'check_keys_unavailable' ? 'check_unverified' : 'check_answer_withheld');
        candidate = guarded.content;
        requireCondition(JSON.stringify(candidate).length <= 2 * 1024 * 1024, 'PROVIDER_CANDIDATE_TOO_LARGE', 413);
        const value = guarded.content as Record<string, unknown>;
        const artifactContent: SupervisorArtifactContent = value.kind === 'output_refusal' ? guarded.content as unknown as SupervisorArtifactContent
          : generated.role === 'companion'
          ? { kind: 'companion_message', text: String(value.text), ...(value.cutShort === true ? { cutShort: true as const } : {}),
            ...(guarded.withheld ? { withheld: guarded.withheld } : {}) }
          : (value.kind==='supervised_plan'||value.kind==='research_candidate'||value.kind==='rubric_suggestion'||value.kind==='rubric_refusal')?generated.content as unknown as SupervisorArtifactContent:{ kind: 'proposed_adaptation', summary: typeof value.summary === 'string' ? value.summary : 'Generated candidate requires scoped review before it can become course material.' };
        const artifact = await storeSupervisorArtifact(db, operation.ref, body.operationId, operation.ownerId, artifactContent);
        // The judge's part, settled on its own (judgeSettlement): its reported usage priced at its
        // own model's price version; nothing when it certainly never ran; or, sent with no answer,
        // its ceiling held for the owner. The reply's own call stays priced either way.
        const judgeRun = judged as JudgeRun | null;
        let judgeTokens: number | null = 0, judgeMicroUsd: number | null = 0;
        if (judgeRun?.sent) {
          judgeSettled = judgeSettlement(judgeRun);
          if (judgeSettled === 'reported') {
            judgeTokens = receiptTokens(judgeRun.usage!);
            const judgeCost = judgeRun.pricing ? priceUsage(judgeRun.usage!, judgeRun.pricing).cost : null;
            judgeRun.cost = judgeCost && judgeCost.microUsd <= 1_000_000_000 ? judgeCost : null;
            judgeRun.usage!.cost = judgeRun.cost;
            judgeMicroUsd = judgeRun.cost?.microUsd ?? null;
          } else if (judgeSettled === 'held') {
            judgeTokens = judgeRun.tokenBound;
            judgeHeld = judgeRun.ceiling;
            judgeMicroUsd = judgeRun.ceiling;
          }
        }
        const tokensKnown = companionTokens !== null && judgeTokens !== null;
        const tokens = tokensKnown ? companionTokens! + judgeTokens! : body.checkpoint.allowance.tokens;
        charged = cost && judgeMicroUsd !== null ? cost.microUsd + judgeMicroUsd : null;
        if (charged === null) { pricingState = 'unpriced'; judgeHeld = null; }
        // The draft ends with the answer Core kept, or is withdrawn when Core refused it.
        if (value.kind === 'output_refusal') draft?.withdraw('output_refused'); else draft?.complete();
        if (checkMode && value.kind !== 'output_refusal') checked = guarded.withheld ? 'withheld' : 'kept';
        result = { status: 'succeeded', artifact, usage: { microUsd: charged ?? body.checkpoint.allowance.microUsd, tokens },
          usageBasis: { microUsd: charged !== null ? 'reported' : 'reserved_ceiling', tokens: tokensKnown ? 'reported' : 'reserved_ceiling' } };
      }
    } catch (error) {
      // The provider answered in full and reported its usage, but the adapter's own checks refused
      // the reply (cut off at the output limit, malformed, blocked): a definite outcome, charged at
      // the reported usage like any answer and then rejected by the verifier, never an uncertain one.
      watching?.(); watching = null;
      // Assigned by the cancellation watch above; widen what control-flow narrowing assumed.
      const cancelled = (stoppedBy as 'cancelled' | null) === 'cancelled';
      const answered = started && error instanceof ProviderError ? await settleRefusedAnswer(error, assembled) : null;
      const stoppedReply = !answered && started && error instanceof ProviderError
        ? await settleStoppedReply(error, cancelled ? STOPPED_REPLY.cancelled : STOPPED_REPLY.stalled) : null;
      const refusedAnswer = answered ?? stoppedReply;
      if (refusedAnswer) {
        draft?.withdraw(error instanceof ProviderError && error.code === 'BLOCKED' ? 'provider_refused' : stoppedReply ? 'provider_failed' : 'output_refused');
        usage = error instanceof ProviderError ? error.usage ?? null : null; failureCode = cancelled ? 'JOB_CANCELLED' : error instanceof ProviderError ? error.code : null;
        cost = refusedAnswer.cost; charged = cost ? cost.microUsd : null; if (!cost) pricingState = 'unpriced';
        result = refusedAnswer.outcome;
      } else {
      const attempts = error instanceof ProviderError ? error.usage?.attempts ?? [] : [];
      // Admitted and started, but the connection to the provider never opened on any attempt (name
      // lookup, refused connection, TLS failure, connect timeout): no byte of the request could have
      // been accepted, so nothing was charged; a later attempt may well succeed.
      const neverOpened = started && error instanceof ProviderError && error.submission === 'not_sent' && attempts.length > 0 && attempts.every(a => a.outcome === 'not_sent');
      const definitelyNotSent = !started || neverOpened || (error instanceof ProviderError && error.submission === 'not_sent' && !attempts.length);
      // Sent, but every attempt was refused with a documented rejection status (auth, permission,
      // invalid request, rate limit...): the model never ran, so the reservation is released.
      // Anything that might have run (no reply in time, a stall, timeouts, 5xx, 529, resets, later
      // tool rounds) stays uncertain.
      const rejected = definitelyNotSent ? null : definiteRejection(error);
      result = definitelyNotSent ? { status: 'not_started', retryable: neverOpened }
        : rejected ? { status: 'not_started', retryable: rejected.retryable,
          ...(rejected.retryAfterMs !== null ? { retryAfterMs: Math.min(rejected.retryAfterMs, MAX_RETRY_AFTER_MS) } : {}) }
        : { status: 'uncertain' };
      // A call Core stopped because its job was cancelled is recorded as such (the uncertain-call
      // list explains it to the owner); NO_RESPONSE marks a request that got no reply at all.
      failureCode = cancelled ? 'JOB_CANCELLED' : error instanceof ProviderError ? error.code : error instanceof ApiError ? error.code : 'PROVIDER_OPERATION_FAILED';
      draft?.withdraw(error instanceof ProviderError && error.code === 'BLOCKED' ? 'provider_refused' : 'provider_failed');
      if (error instanceof ProviderError) usage = error.usage ?? null;
      }
    } finally { watching?.(); watching = null; if (acquired) active -= 1; }
    result = outcomeSchema.parse(result);
    }); } finally {
      const final = result, succeeded = final.status === 'succeeded' ? final : null;
      const attributes = { 'course.supervisor.role': body.role, 'course.supervisor.outcome': final.status, 'error.type': failureCode,
        'course.cost.estimate_micro_usd': succeeded?.usage.microUsd, 'course.cost.basis': succeeded ? succeeded.usageBasis?.microUsd ?? 'reported' : undefined,
        'course.usage.total_tokens': succeeded?.usage.tokens, 'course.usage.tokens_basis': succeeded ? succeeded.usageBasis?.tokens ?? 'reported' : undefined,
        'course.cost.pricing': pricingState };
      span.setAttributes(attributes);
      if (failureCode) span.fail(failureCode);
      span.end();
      counted = attributes;
    }
    const state = result.status === 'succeeded' ? 'completed' : result.status;
    // Assigned inside the traced callback above; widen what control-flow narrowing assumed.
    const charge = cost as ReceiptCost | null, chargedMicroUsd = charged as number | null, judgeReceipt = judged as JudgeRun | null;
    const judgePart = judgeSettled as JudgeSettlement | null, heldPart = judgeHeld as number | null;
    const final = result;
    // A response that arrives after the learner's data was erased keeps only what erasure keeps: the
    // generated candidate is dropped. Erasure holds the enrollment row while it redacts, so waiting
    // for a share lock on it orders this write before or after the whole erasure. The spend ledger
    // is not touched here; erasure already finished this operation's reservation.
    await afterCommitTransaction(db, async client => {
      const erased = (await client.query<{ status: string }>('SELECT status FROM enrollments WHERE id=$1 FOR SHARE', [body.job.enrollmentId])).rows[0]?.status === 'erased';
      const strategy = ran as { id: string; version: string; source: 'core' | 'course'; revisionDigest: string | null; standing: string } | null;
      // cost_micro_usd is what the operation is charged: the reply's call and, in check-coaching
      // mode, the judge's part (its own model, price version and receipt in the judge_* columns;
      // how it was settled, and any amount held for the owner, in judge_settlement and
      // judge_held_micro_usd, migration 124).
      const stored = await client.query(`UPDATE provider_dispatches SET state=$2,outcome=$3,provider_usage=$4,candidate=$5,failure_code=$6,finished_at=now(),model_id=$8,pricing_version_id=$9,cost_micro_usd=$10,
          strategy_id=$11,strategy_version=$12,strategy_source=$13,role_revision_digest=$14,eval_standing=$15,
          judge_model_id=$16,judge_pricing_version_id=$17,judge_cost_micro_usd=$18,judge_usage=$19,judge_verdict=$20,judge_settlement=$21,judge_held_micro_usd=$22
        WHERE operation_id=$1 AND owner_id=$7`,
        [body.operationId, state, JSON.stringify(result), usage === null ? null : JSON.stringify(usage), candidate === null || erased ? null : JSON.stringify(candidate), failureCode, operation.ownerId,
          modelId, charge && chargedMicroUsd !== null ? charge.pricingVersionId : null, charge && chargedMicroUsd !== null ? chargedMicroUsd : null,
          strategy?.id.slice(0, 200) ?? null, strategy?.version.slice(0, 64) ?? null, strategy?.source ?? null, strategy?.revisionDigest ?? null, strategy?.standing ?? null,
          judgeReceipt?.modelId ?? null, judgeReceipt?.cost?.pricingVersionId ?? null, judgeReceipt?.cost?.microUsd ?? null,
          judgeReceipt?.usage ? JSON.stringify(judgeReceipt.usage) : null, judgeReceipt?.verdict.slice(0, 120) ?? null,
          chargedMicroUsd !== null ? judgePart : null, chargedMicroUsd !== null && judgePart === 'held' ? heldPart : null]);
      // The check of a reply in check-coaching mode has ended. The learner's app is told by a
      // learning event, which reaches every API process's event streams at commit (a draft frame
      // reaches only this process's), so it reads the conversation again at once instead of at its
      // safety read. Ids and a code only.
      const reached = checkMode as { messageId: string } | null, result_ = checked as 'kept' | 'withheld' | 'failed' | null;
      if (stored.rowCount === 1 && !erased && reached && result_)
        await appendEvent(client, { workspaceId: body.job.workspaceId, enrollmentId: body.job.enrollmentId, actorKind: 'system', type: 'companion.reply.checked',
          payload: { jobId: body.job.jobId, messageId: reached.messageId, result: result_ }, idempotencyKey: `companion-reply-checked:${body.operationId}:${operation.ownerId}`, supervise: false });
      // Counted once the receipt is committed: a failed or superseded write reports nothing, and a
      // retried request answered from the stored receipt never reaches this point.
      if (stored.rowCount === 1) onCommit(client, () => {
        observed.count('course.provider.operations', 1, counted);
        if (final.status === 'succeeded') observed.count('course.provider.cost.estimate', final.usage.microUsd, counted);
      });
    });
    return result;
  });
}
