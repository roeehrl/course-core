import {resolveResearchInputWithin} from './research-store.js';
import {researchCandidateSchema,type ResearchCandidate} from './research-contracts.js';
import { rubricSuggestionSchema, type RubricSuggestion } from './rubric-assist-contracts.js';
import { resolveRubricAssistWithin } from './rubric-assist-store.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { checkAction, type PolicyState } from '@course-core/policy';
import {
  accounting, allowanceSchema, ContractError, createJob, fenceSchema, jobCommandSchema, jobSpecSchema,
  outboxEventSchema, preparedSchema, providerRequestSchema, rpcRequestSchema, runRefSchema, sameFence, snapshotSchema,
  transition as reduce, transitionSchema, uuid, verificationSchema, workflowId, nextGeneration, resumable, outcomeSchema,
  type Command, type Fence, type HostBridge, type HostContext, type JobSpec, type OutboxEvent,
  type RunRef, type Snapshot, type Verification, type ProviderRequest, type SupervisionState,
} from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { digestJson, policyEpisodeIdFor, type Enrollment } from './repository.js';
import {supervisedPlanSchema,type SupervisedPlan} from './supervisor-tool-loop.js';
import type {SupervisorJobPolicy} from './provider-setup.js';
import { recordSpendEvents, syncSupervisorSpend } from './provider-costs.js';
import { afterCommitTransaction, onCommit } from './after-commit.js';
import { ackControlDelivery, claimControlDeliveries, supervisionStateWithin } from './supervision-control.js';
import { ackCancellationDelivery, claimCancellationDeliveries } from './supervisor-cancellation.js';

/** Ceiling on a learning event payload that may start supervision (design N06). */
export const MAX_EVENT_PAYLOAD_BYTES = 16_384;
/** What each role's checkpoint does, shown as the job state while its call is out. The companion
 * keeps the plain 'running' state its learner-facing labels already know. */
const PHASE: Partial<Record<string, 'analyze' | 'build' | 'evaluate'>> = { supervisor: 'analyze', research: 'analyze', reviewer: 'evaluate' };
export interface SupervisorBridgeOptions {
  serviceToken?: string;
  /** Explicit service authorization; omitted/empty denies every workspace. */
  workspaceIds?: readonly string[];
  jobPolicy?: {
    allowance?: { microUsd: number; tokens: number };
    durationMs?: number;
    timeoutMs?: number;
    maxAttempts?: number;
  };
  maxOutboxAttempts?: number;
  /** Trusted server composition only; RPC verify authorizes ref before calling, then rechecks all fences. */
  beforeVerify?: (ref: RunRef) => Promise<void>;
  applyPlan?:(client:PoolClient,ref:RunRef,plan:SupervisedPlan)=>Promise<unknown>;
  providerBinding?:(client:PoolClient,workspaceId:string)=>Promise<{revision:number;jobPolicy:SupervisorJobPolicy}|null>;
}
interface Settings {
  workspaces: string[]; allowance: { microUsd: number; tokens: number };
  durationMs: number; timeoutMs: number; maxAttempts: number; maxOutboxAttempts: number;
}
function bounded(value: number, min: number, max: number) {
  requireCondition(Number.isSafeInteger(value) && value >= min && value <= max, 'SUPERVISOR_INVALID_CONFIGURATION'); return value;
}
function settings(options: SupervisorBridgeOptions): Settings {
  const allowance = allowanceSchema.parse(options.jobPolicy?.allowance ?? { microUsd: 100_000, tokens: 10_000 });
  // A zero allowance would allow an invocation against the default zero shared budget.
  requireCondition(allowance.microUsd > 0 && allowance.tokens > 0, 'SUPERVISOR_INVALID_CONFIGURATION');
  return { workspaces: [...new Set((options.workspaceIds ?? []).map(id => uuid.parse(id)))], allowance,
    durationMs: bounded(options.jobPolicy?.durationMs ?? 300_000, 1_000, 86_400_000),
    timeoutMs: bounded(options.jobPolicy?.timeoutMs ?? 60_000, 100, 120_000),
    maxAttempts: bounded(options.jobPolicy?.maxAttempts ?? 3, 1, 5),
    maxOutboxAttempts: bounded(options.maxOutboxAttempts ?? 8, 1, 20) };
}
interface EnrollmentRow {
  id: string; workspace_id: string; user_id: string; course_release_id: string; current_episode_id: string | null;
  revision: number; navigation_revision: number; profile_revision: number; policy_revision: number; status: string;
}
interface Current {
  enrollment: EnrollmentRow; fence: Fence; policy: PolicyState; nowMs: number; releaseActive: boolean;
  membershipActive: boolean; scopeEpisodeId?: string | null;
  /** Staff pause/stop control, read right after the enrollment lock (the order a change uses). */
  supervision: SupervisionState;
}
async function clock(client: PoolClient) {
  return Number((await client.query<{ ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms")).rows[0]!.ms);
}
// All paths use enrollment -> membership -> release -> policy -> job -> workspace budget -> enrollment budget.
async function current(client: PoolClient, workspaceId: string, enrollmentId: string): Promise<Current> {
  const enrollment = (await client.query<EnrollmentRow>('SELECT * FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [enrollmentId, workspaceId])).rows[0];
  requireCondition(enrollment, 'SUPERVISOR_NOT_FOUND', 404);
  const supervision = await supervisionStateWithin(client, enrollmentId);
  // Existence is active membership in the current schema. Hold a share lock so removal and
  // authorization serialize. Do not throw here: receipts for already dispatched work must settle.
  const membership = await client.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, enrollment.user_id]);
  const release = (await client.query<{ digest: string; status: string }>('SELECT digest,status FROM course_releases WHERE id=$1 AND workspace_id=$2 FOR SHARE', [enrollment.course_release_id, workspaceId])).rows[0];
  const policy = (await client.query<{ policy_revision: number; ledger_revision: number; snapshot: PolicyState }>('SELECT policy_revision,ledger_revision,snapshot FROM policy_states WHERE enrollment_id=$1 FOR UPDATE', [enrollmentId])).rows[0];
  requireCondition(release && policy, 'SUPERVISOR_STATE_MISSING', 409);
  requireCondition(policy.policy_revision === enrollment.policy_revision && policy.snapshot.policyRevision === policy.policy_revision
    && policy.snapshot.ledgerRevision === policy.ledger_revision && policy.snapshot.enrollmentId === enrollmentId, 'SUPERVISOR_POLICY_INCONSISTENT', 409);
  // An archived release stays live for the learners pinned to it; only drafts are not.
  return { enrollment, supervision, membershipActive: membership.rowCount === 1, releaseActive: release.status === 'published' || release.status === 'archived', policy: policy.snapshot, nowMs: await clock(client),
    // Navigation (reading, switching episode, asking) is not a context change: see migration 053.
    fence: fenceSchema.parse({ enrollmentRevision: enrollment.revision - enrollment.navigation_revision, profileRevision: enrollment.profile_revision,
      policyRevision: policy.policy_revision, ledgerRevision: policy.ledger_revision, courseDigest: release.digest }) };
}
/** After closure, completed or capped (a reached deadline or quota, status 'closed'), only the
 * companion may answer bounded explanatory questions, and only while the course policy keeps
 * existing material readable (a 'read' check, so ACCESS_CLOSED still refuses). Planning,
 * research and adaptation never resume on a closed enrollment, and an answer grants nothing. */
function closedCourseCompanion(c: Current, role?: string) {
  return role === 'companion' && (c.enrollment.status === 'completed' || c.enrollment.status === 'closed') && c.membershipActive && c.releaseActive;
}
function enrollmentActive(c: Current, role?: string) {
  // Login sessions are intentionally irrelevant to authorized background supervision.
  return (c.membershipActive && c.enrollment.status === 'active' && c.releaseActive) || closedCourseCompanion(c, role);
}
/** Policy scopes exist only for base episodes; an inserted episode is governed
 * by its anchor. Teaching context keeps the episode id itself. */
async function scopeEpisode(client: PoolClient, c: Current, episodeId: string | null | undefined): Promise<string | null> {
  return episodeId ? policyEpisodeIdFor(client, c.enrollment as unknown as Enrollment, episodeId) : null;
}
function policyCheck(c: Current, kind: 'admit_job' | 'tool_call' | 'publish', role?: string) {
  const episodeId = c.scopeEpisodeId === undefined ? c.enrollment.current_episode_id : c.scopeEpisodeId;
  return checkAction(c.policy, { scopeId: episodeId ? `episode:${episodeId}` : 'course',
    kind: closedCourseCompanion(c, role) ? 'read' : kind, now: new Date(c.nowMs).toISOString(), expectedPolicyRevision: c.fence.policyRevision });
}
interface Locked { snapshot: Snapshot; cancelled: boolean; current: Current; episodeId: string | null }
async function lockedJob(client: PoolClient, raw: RunRef): Promise<Locked> {
  const ref = runRefSchema.parse(raw);
  const c = await current(client, ref.workspaceId, ref.enrollmentId);
  const row = (await client.query<{ runtime_snapshot: unknown; cancellation_requested: boolean }>(
    'SELECT runtime_snapshot,cancellation_requested FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR UPDATE',
    [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(row?.runtime_snapshot, 'SUPERVISOR_NOT_FOUND', 404);
  const snapshot = snapshotSchema.parse(row.runtime_snapshot), key = snapshot.specification.key;
  requireCondition(key.jobId === ref.jobId && key.enrollmentId === ref.enrollmentId && key.workspaceId === ref.workspaceId, 'SUPERVISOR_SCOPE_MISMATCH', 409);
  requireCondition(snapshot.generation === ref.generation, 'SUPERVISOR_STALE_GENERATION', 409);
  const input = (await client.query<{ context: SupervisorInputContext }>('SELECT context FROM supervisor_inputs WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4',
    [snapshot.specification.checkpoints[0]!.inputRef, ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(input, 'SUPERVISOR_INPUT_NOT_FOUND', 409);
  if (input.context.episodeId !== undefined) c.scopeEpisodeId = await scopeEpisode(client, c, input.context.episodeId);
  return { snapshot, cancelled: row.cancellation_requested, current: c, episodeId: input.context.episodeId ?? null };
}
interface BudgetRow { limit_micro_usd: string; limit_tokens: string; used_micro_usd: string; used_tokens: string }
/** Host-owned paid work outside the supervisor engine (media jobs) uses the same
 * enrollment/membership/release/policy locks and the same budget rows; there is
 * no second money path. Callers lock their own job row between the two calls. */
export interface PaidWorkScope { workspaceId: string; enrollmentId: string; episodeId: string | null }
export async function paidWorkPolicy(client: PoolClient, scope: PaidWorkScope, kind: 'admit_job' | 'publish') {
  const c = await current(client, scope.workspaceId, scope.enrollmentId);
  c.scopeEpisodeId = await scopeEpisode(client, c, scope.episodeId);
  c.nowMs = await clock(client);
  const check = policyCheck(c, kind), active = enrollmentActive(c);
  // Host-owned paid work obeys the same staff pause/stop as supervisor jobs.
  const controlled = c.supervision === 'active' ? [] : [c.supervision === 'paused' ? 'supervision_paused' : 'supervision_stopped'];
  return { allowed: active && check.allowed && !controlled.length, active, violations: [...check.violations.map(v => v.code), ...controlled], nowMs: c.nowMs,
    effectiveDeadlineMs: check.snapshot.effectiveDeadline ? Date.parse(check.snapshot.effectiveDeadline) : null };
}
/** Locks workspace then enrollment budget rows and returns the remaining allowance. */
export async function lockPaidWorkBudgets(client: PoolClient, scope: Pick<PaidWorkScope, 'workspaceId' | 'enrollmentId'>) {
  return lockBudgets(client, scope);
}
/** Returns an unused part of a reservation to both budgets, after `lockPaidWorkBudgets`
 * in the same transaction. Callers guard it so each reservation is released at most once. */
export async function releasePaidWork(client: PoolClient, scope: Pick<PaidWorkScope, 'workspaceId' | 'enrollmentId'>, microUsd: number) {
  requireCondition(Number.isSafeInteger(microUsd) && microUsd >= 0, 'SUPERVISOR_INVALID_CONFIGURATION');
  await client.query('UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd-$2 WHERE workspace_id=$1', [scope.workspaceId, microUsd]);
  await client.query('UPDATE supervisor_enrollment_budgets SET used_micro_usd=used_micro_usd-$2 WHERE enrollment_id=$1 AND workspace_id=$3', [scope.enrollmentId, microUsd, scope.workspaceId]);
}
/** Debits both budgets after `lockPaidWorkBudgets` in the same transaction. */
export async function chargePaidWork(client: PoolClient, scope: Pick<PaidWorkScope, 'workspaceId' | 'enrollmentId'>, microUsd: number, tokens: number) {
  requireCondition(Number.isSafeInteger(microUsd) && microUsd >= 0 && Number.isSafeInteger(tokens) && tokens >= 0, 'SUPERVISOR_INVALID_CONFIGURATION');
  await client.query('UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd+$2,used_tokens=used_tokens+$3 WHERE workspace_id=$1', [scope.workspaceId, microUsd, tokens]);
  await client.query('UPDATE supervisor_enrollment_budgets SET used_micro_usd=used_micro_usd+$2,used_tokens=used_tokens+$3 WHERE enrollment_id=$1 AND workspace_id=$4', [scope.enrollmentId, microUsd, tokens, scope.workspaceId]);
}
async function lockBudgets(client: PoolClient, ref: Pick<RunRef, 'workspaceId' | 'enrollmentId'>) {
  return (await lockBudgetCeilings(client, ref)).available;
}
/** Which ceiling a stopped job hit, so the state can be explained. */
export type BudgetCeiling = 'workspace' | 'enrollment' | 'daily' | 'artifact';
interface LimitRow extends BudgetRow { daily_limit_micro_usd: string | null; daily_limit_tokens: string | null; artifact_limit_micro_usd: string | null; artifact_limit_tokens: string | null }
/** Workspace, enrollment, per-UTC-day and per-artifact (this episode, this UTC day) headroom.
 * Day and artifact use come from the job spend ledger (reservations and charges) under the same
 * enrollment budget lock, so concurrent jobs see each other's reservations. */
async function lockBudgetCeilings(client: PoolClient, ref: Pick<RunRef, 'workspaceId' | 'enrollmentId'>, episodeId?: string | null) {
  await client.query('INSERT INTO supervisor_workspace_budgets (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [ref.workspaceId]);
  const workspace = (await client.query<BudgetRow>('SELECT * FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE', [ref.workspaceId])).rows[0]!;
  await client.query('INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ref.enrollmentId, ref.workspaceId]);
  const enrollment = (await client.query<LimitRow>('SELECT * FROM supervisor_enrollment_budgets WHERE enrollment_id=$1 AND workspace_id=$2 FOR UPDATE', [ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(enrollment, 'SUPERVISOR_SCOPE_MISMATCH', 409);
  const remaining: { ceiling: BudgetCeiling; microUsd: number; tokens: number }[] = [
    { ceiling: 'workspace', microUsd: Number(workspace.limit_micro_usd) - Number(workspace.used_micro_usd), tokens: Number(workspace.limit_tokens) - Number(workspace.used_tokens) },
    { ceiling: 'enrollment', microUsd: Number(enrollment.limit_micro_usd) - Number(enrollment.used_micro_usd), tokens: Number(enrollment.limit_tokens) - Number(enrollment.used_tokens) },
  ];
  const periodic = async (ceiling: 'daily' | 'artifact', usd: string | null, tokens: string | null) => {
    if (usd === null && tokens === null) return;
    const used = (await client.query<{ usd: string; tokens: string }>(`SELECT COALESCE(sum(s.micro_usd),0) AS usd,COALESCE(sum(s.tokens),0) AS tokens
      FROM supervisor_job_spend s JOIN supervisor_jobs j ON j.id=s.job_id AND j.enrollment_id=s.enrollment_id AND j.workspace_id=s.workspace_id
      WHERE s.enrollment_id=$1 AND s.workspace_id=$2 AND j.created_at>=date_trunc('day',clock_timestamp(),'UTC')
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM supervisor_inputs i WHERE i.job_id=j.id AND i.context->>'episodeId'=$3))`,
      [ref.enrollmentId, ref.workspaceId, ceiling === 'artifact' ? episodeId : null])).rows[0]!;
    remaining.push({ ceiling, microUsd: usd === null ? Infinity : Number(usd) - Number(used.usd), tokens: tokens === null ? Infinity : Number(tokens) - Number(used.tokens) });
  };
  await periodic('daily', enrollment.daily_limit_micro_usd, enrollment.daily_limit_tokens);
  if (episodeId) await periodic('artifact', enrollment.artifact_limit_micro_usd, enrollment.artifact_limit_tokens);
  const microUsd = remaining.reduce((a, b) => b.microUsd < a.microUsd ? b : a), tokens = remaining.reduce((a, b) => b.tokens < a.tokens ? b : a);
  return { available: { microUsd: Math.max(0, microUsd.microUsd), tokens: Math.max(0, tokens.tokens) },
    /** The tighter of the money and token ceilings. */
    binding: (microUsd.microUsd <= tokens.tokens ? microUsd : tokens).ceiling };
}
async function save(client: PoolClient, old: Snapshot, next: Snapshot, ceiling?: BudgetCeiling) {
  const key = next.specification.key, before = accounting(old), after = accounting(next);
  const usd = after.microUsd - before.microUsd, tokens = after.tokens - before.tokens;
  await client.query('UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd+$2,used_tokens=used_tokens+$3 WHERE workspace_id=$1', [key.workspaceId, usd, tokens]);
  await client.query('UPDATE supervisor_enrollment_budgets SET used_micro_usd=used_micro_usd+$2,used_tokens=used_tokens+$3 WHERE enrollment_id=$1 AND workspace_id=$4', [key.enrollmentId, usd, tokens, key.workspaceId]);
  await client.query(`INSERT INTO supervisor_job_spend (job_id,enrollment_id,workspace_id,micro_usd,tokens) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (job_id) DO UPDATE SET micro_usd=EXCLUDED.micro_usd,tokens=EXCLUDED.tokens`, [key.jobId, key.enrollmentId, key.workspaceId, after.microUsd, after.tokens]);
  // Same transaction and locks as the budget change above: the ledger records what was
  // reserved, released and actually charged, exactly once per settled operation attempt.
  // Counted only once this transaction commits: a rolled-back transition reports nothing.
  const events = await syncSupervisorSpend(client, old, next);
  if (events.length) onCommit(client, () => recordSpendEvents(events));
  const updated = await client.query(`UPDATE supervisor_jobs SET runtime_snapshot=$2,state=$3,result=$4,updated_at=clock_timestamp()
    WHERE id=$1 AND workspace_id=$5 AND enrollment_id=$6 AND (runtime_snapshot->>'version')::integer=$7`,
    [key.jobId, JSON.stringify(next), next.state, JSON.stringify({ reason: next.reason, applicationReceiptId: next.applicationReceiptId,
      // A budget stop names the ceiling it hit, so staff and learners can be told why.
      ...(next.reason === 'budget_exhausted' && ceiling ? { ceiling } : {}) }), key.workspaceId, key.enrollmentId, old.version]);
  requireCondition(updated.rowCount === 1, 'SUPERVISOR_WRITE_CONFLICT', 409);
}

export type SupervisorArtifactContent = { kind: 'companion_message'; text: string } | { kind: 'proposed_adaptation'; summary: string }|SupervisedPlan|ResearchCandidate|RubricSuggestion;
export interface SupervisorInputContext {
  kind: 'learning_event'; eventId: string; eventType: string; courseReleaseId: string;
  episodeId: string | null; messageId?: string; blockId?: string; researchRequestId?:string; rubricRequestId?: string;
}
function content(input: unknown): SupervisorArtifactContent {
  requireCondition(input && typeof input === 'object' && !Array.isArray(input), 'SUPERVISOR_INVALID_ARTIFACT');
  const value = input as Record<string, unknown>, field = value.kind === 'companion_message' ? 'text' : value.kind === 'proposed_adaptation' ? 'summary' : '';
  if(value.kind==='research_candidate'){const parsed=researchCandidateSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  if(value.kind==='rubric_suggestion'){const parsed=rubricSuggestionSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  if(value.kind==='supervised_plan'){const parsed=supervisedPlanSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  requireCondition(field && Object.keys(value).length === 2 && typeof value[field] === 'string' && (value[field] as string).trim().length > 0
    && (value[field] as string).length <= 16_000, 'SUPERVISOR_INVALID_ARTIFACT');
  return value as SupervisorArtifactContent;
}
interface ArtifactRow { id: string; digest: string; content: unknown; operation_id: string; owner_id: string }
async function artifact(client: PoolClient, ref: RunRef, id: string, expectedDigest: string) {
  const row = (await client.query<ArtifactRow>(`SELECT * FROM supervisor_artifacts
    WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4 FOR SHARE`, [id, ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(row && row.digest === expectedDigest && digestJson(content(row.content)) === row.digest, 'SUPERVISOR_ARTIFACT_MISMATCH', 409);
  return { ...row, content: content(row.content) };
}
interface VerificationRow {
  id: string; job_id: string; fence: Fence; artifacts: Verification['artifacts']; verdict: Verification['verdict'];
  application_kind: 'companion_message' | 'reviewed_adaptation' | 'research_candidate' | 'rubric_suggestion'; verifier_id: string;
}
async function storedVerification(client: PoolClient, ref: RunRef, snapshot: Snapshot): Promise<{ receipt: Verification; row: VerificationRow } | undefined> {
  const row = (await client.query<VerificationRow>(`SELECT v.* FROM supervisor_verifications v
    JOIN supervisor_verifier_authorities a ON a.id=v.verifier_id AND a.workspace_id=v.workspace_id
    WHERE v.job_id=$1 AND v.enrollment_id=$2 AND v.workspace_id=$3 AND v.revoked_at IS NULL AND a.enabled
      AND ((v.application_kind='companion_message' AND a.can_verify_companion) OR (v.application_kind='reviewed_adaptation' AND a.can_review_adaptation) OR (v.application_kind='research_candidate' AND a.can_collect_research) OR (v.application_kind='rubric_suggestion' AND a.can_suggest_rubric))
    FOR SHARE OF v,a`, [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  if (!row) return undefined;
  const receipt = verificationSchema.parse({ receiptId: row.id, jobId: row.job_id, fence: row.fence, artifacts: row.artifacts, verdict: row.verdict });
  requireCondition(sameFence(receipt.fence, snapshot.specification.fence), 'SUPERVISOR_VERIFICATION_MISMATCH', 409);
  for (const output of receipt.artifacts) {
    const a = await artifact(client, ref, output.artifactId, output.digest);
    requireCondition((row.application_kind === 'research_candidate') === (a.content.kind === 'research_candidate'),'SUPERVISOR_VERIFICATION_MISMATCH',409);
    requireCondition((row.application_kind === 'rubric_suggestion') === (a.content.kind === 'rubric_suggestion'),'SUPERVISOR_VERIFICATION_MISMATCH',409);
    requireCondition((row.application_kind === 'companion_message') === (a.content.kind === 'companion_message'), 'SUPERVISOR_VERIFICATION_MISMATCH', 409);
  }
  return { receipt, row };
}
async function applyVerified(client: PoolClient, ref: RunRef, snapshot: Snapshot, verified: { receipt: Verification; row: VerificationRow }, receiptId: string,applyPlan?:SupervisorBridgeOptions['applyPlan']) {
  requireCondition(verified.receipt.verdict === 'verified' && snapshot.verification?.receiptId === verified.receipt.receiptId, 'SUPERVISOR_VERIFICATION_REQUIRED', 409);
  requireCondition(verified.receipt.artifacts.length === 1, 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
  const a = await artifact(client, ref, verified.receipt.artifacts[0]!.artifactId, verified.receipt.artifacts[0]!.digest);
  const targetId = randomUUID();
  if (a.content.kind === 'companion_message') {
    requireCondition(snapshot.specification.role === 'companion', 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
    // The answer belongs to the lesson its question was asked in, wherever the learner is now.
    const question = (await client.query<{ episode_id: string | null; block_id: string | null; message_id: string }>(`SELECT id AS message_id,context->>'episodeId' AS episode_id,context->>'blockId' AS block_id
      FROM companion_messages WHERE job_id=$1 AND enrollment_id=$2 AND role='learner' LIMIT 1`, [ref.jobId, ref.enrollmentId])).rows[0];
    await client.query(`INSERT INTO companion_messages (id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,$4,$5)`,
      [targetId, ref.enrollmentId, a.content.text, JSON.stringify({ verificationReceiptId: verified.receipt.receiptId, artifactId: a.id,
        ...(question?.episode_id ? { episodeId: question.episode_id, blockId: question.block_id, answersMessageId: question.message_id } : {}) }), ref.jobId]);
  } else if (a.content.kind === 'rubric_suggestion') {
    // A draft for a human reviewer: no evidence, grade or learner-visible change.
    requireCondition(snapshot.specification.role === 'reviewer' && verified.row.application_kind === 'rubric_suggestion', 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
    await client.query('INSERT INTO rubric_suggestions(id,request_id,job_id,enrollment_id,workspace_id,artifact_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [targetId, a.content.requestId, ref.jobId, ref.enrollmentId, ref.workspaceId, a.id, a.digest]);
    const updated = await client.query("UPDATE rubric_assist_requests SET state='suggested' WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND job_id=$4 AND state='requested'",
      [a.content.requestId, ref.enrollmentId, ref.workspaceId, ref.jobId]);
    requireCondition(updated.rowCount === 1, 'RUBRIC_ASSIST_NOT_PENDING', 409);
  } else if(a.content.kind==='research_candidate') {
    requireCondition(snapshot.specification.role==='research'&&verified.row.application_kind==='research_candidate','SUPERVISOR_APPLICATION_UNSUPPORTED',409);
    await client.query('INSERT INTO research_candidates(id,request_id,job_id,enrollment_id,workspace_id,artifact_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7)',[targetId,a.content.requestId,ref.jobId,ref.enrollmentId,ref.workspaceId,a.id,a.digest]);
    const updated=await client.query("UPDATE research_requests SET state='collected' WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND research_job_id=$4 AND state='dispatched'",[a.content.requestId,ref.enrollmentId,ref.workspaceId,ref.jobId]);requireCondition(updated.rowCount===1,'RESEARCH_REQUEST_NOT_ACTIVATED',409);
  } else {
    if(a.content.kind==='supervised_plan'&&(a.content.selection||a.content.modelSuggestion||a.content.generatedTeaching||a.content.researchSelections?.length||a.content.resourceChoices?.length)){requireCondition(applyPlan,'SUPERVISOR_APPLICATION_UNSUPPORTED',409);await applyPlan(client,ref,a.content);}
    await client.query(`INSERT INTO supervisor_adaptations (id,job_id,enrollment_id,workspace_id,verification_id,summary) VALUES ($1,$2,$3,$4,$5,$6)`,
      [targetId, ref.jobId, ref.enrollmentId, ref.workspaceId, verified.receipt.receiptId, a.content.summary]);
  }
  const event = await appendEvent(client, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, actorKind: 'system',
    type: 'supervisor.applied', payload: { jobId: ref.jobId, receiptId, targetId, kind: verified.row.application_kind },
    idempotencyKey: `supervisor:apply:${ref.jobId}`, supervise: false });
  // Delivery event for parent subscribers, deliberately not a supervisor.event feedback loop.
  await client.query('INSERT INTO outbox (event_id,kind,payload) VALUES ($1,$2,$3)', [event.id, 'supervisor.applied', JSON.stringify({ eventId: event.id, jobId: ref.jobId, enrollmentId: ref.enrollmentId })]);
  await client.query(`INSERT INTO supervisor_applications (id,job_id,enrollment_id,workspace_id,verification_id,application_kind,target_id,event_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [receiptId, ref.jobId, ref.enrollmentId, ref.workspaceId, verified.receipt.receiptId, verified.row.application_kind, targetId, event.id]);
}

/** Consumes an event whose preparation hit a permanent state conflict: no job, the conflict's
 * code on the preparation receipt, and a system learning event (caused by the refused event) so
 * staff can see why the request never ran. The event's payload is never copied. */
async function refusePreparation(client: PoolClient, row: { event_id: string; workspace_id: string; enrollment_id: string; event_type: string; event_payload: unknown }, code: string) {
  const reasonCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SUPERVISOR_PREPARATION_CONFLICT';
  const requestId = (row.event_payload as { requestId?: unknown } | null)?.requestId;
  if (row.event_type === 'research.requested' && uuid.safeParse(requestId).success) {
    // The research request this event activated ends too, so no view shows it as still queued:
    // expired (cancelled for the deadline) when its deadline passed, otherwise refused with the code.
    // A request already cancelled or collected keeps its own terminal state.
    const expired = reasonCode === 'RESEARCH_DEADLINE_PASSED';
    await client.query(`UPDATE research_requests SET state=$5::text,
        cancelled_at=CASE WHEN $5::text='cancelled' THEN clock_timestamp() END, cancel_reason=CASE WHEN $5::text='cancelled' THEN 'deadline' END,
        refusal_code=CASE WHEN $5::text='refused' THEN $6::text END
      WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND activation_event_id=$4 AND state IN ('staged','dispatched')`,
      [requestId, row.enrollment_id, row.workspace_id, row.event_id, expired ? 'cancelled' : 'refused', reasonCode]);
  }
  await client.query(`INSERT INTO supervisor_preparations (event_id,workspace_id,enrollment_id,jobs,disposition,reason_code)
    VALUES ($1,$2,$3,'[]','refused',$4)`, [row.event_id, row.workspace_id, row.enrollment_id, reasonCode]);
  await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, actorKind: 'system',
    type: 'supervisor.event_refused', payload: { eventId: row.event_id, eventType: row.event_type, reasonCode },
    causationId: row.event_id, idempotencyKey: `supervisor:refused:${row.event_id}`, supervise: false });
}

/** The Postgres host bridge, plus a claim of one known event for trusted
 * in-process callers (fixtures, operator tooling). It is not exposed over RPC. */
export interface PostgresSupervisorBridge extends HostBridge {
  /** Claims exactly this event when it is claimable, under the same envelope
   * checks, attempt accounting and lease as claimOutbox. It never leases,
   * counts an attempt on, or quarantines any other event, so concurrent callers
   * waiting for their own events cannot hide or exhaust each other's. */
  claimOutboxEvent(eventId: string, ownerId: string, leaseMs: number): Promise<OutboxEvent | null>;
}

export function createPostgresSupervisorBridge(db: Database, options: SupervisorBridgeOptions): PostgresSupervisorBridge {
  const config = settings(options);
  const authorize = (workspaceId: string) => requireCondition(config.workspaces.includes(workspaceId), 'SUPERVISOR_FORBIDDEN', 403);
  /** Oldest claimable events first across the authorized workspaces. Every
   * claimed event is the claimer's to deliver or release (dispatchOnce does
   * both), so the queue is FIFO and no event waits behind a lease forever. */
  async function claim(ownerId: string, limit: number, leaseMs: number, eventId: string | null) {
    return transaction(db, async client => {
      const rows = (await client.query<{ event_id: string; payload: unknown; attempts: number; enrollment_id: string }>(
        `SELECT o.event_id,o.payload,o.attempts,e.enrollment_id FROM outbox o JOIN learning_events e ON e.id=o.event_id
         WHERE o.kind='supervisor.event' AND o.delivered_at IS NULL AND o.quarantined_at IS NULL AND o.available_at<=clock_timestamp()
           AND (o.claimed_until IS NULL OR o.claimed_until<=clock_timestamp()) AND e.workspace_id=ANY($1::uuid[])${eventId ? ' AND o.event_id=$3' : ''}
           -- A paused enrollment's events wait, without spending attempts, until supervision resumes.
           AND NOT EXISTS (SELECT 1 FROM supervisor_controls sc WHERE sc.enrollment_id=e.enrollment_id AND sc.state='paused')
         ORDER BY o.available_at,o.event_id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, eventId ? [config.workspaces, limit, eventId] : [config.workspaces, limit])).rows;
      const result: OutboxEvent[] = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const envelope = outboxEventSchema.safeParse({ eventId: row.event_id, kind: 'supervisor.event', payload: row.payload, leaseToken, attempts: row.attempts + 1 });
        const invalid = !envelope.success || envelope.data.payload.enrollmentId !== row.enrollment_id;
        if (invalid || row.attempts >= config.maxOutboxAttempts) {
          await client.query(`UPDATE outbox SET quarantined_at=clock_timestamp(),last_error_code=$2,claimed_until=NULL,lease_token=NULL,lease_owner=NULL WHERE event_id=$1`,
            [row.event_id, invalid ? 'invalid_envelope' : 'attempts_exhausted']); continue;
        }
        await client.query(`UPDATE outbox SET attempts=attempts+1,lease_token=$2,lease_owner=$3,
          claimed_until=clock_timestamp()+($4 * interval '1 millisecond') WHERE event_id=$1`, [row.event_id, leaseToken, ownerId, leaseMs]);
        result.push(envelope.data);
      }
      return result;
    });
  }
  async function leased(client: PoolClient, eventId: string, leaseToken: string) {
    const row = (await client.query<{ event_id: string; kind: string; payload: unknown; attempts: number; lease_token: string; workspace_id: string; enrollment_id: string; actor_kind: string; event_type: string; event_payload: unknown }>(
      `SELECT o.*,e.workspace_id,e.enrollment_id,e.actor_kind,e.event_type,e.payload AS event_payload FROM outbox o JOIN learning_events e ON e.id=o.event_id
       WHERE o.event_id=$1 AND o.lease_token=$2 AND o.claimed_until>clock_timestamp() AND o.delivered_at IS NULL AND o.quarantined_at IS NULL
         AND e.workspace_id=ANY($3::uuid[]) AND o.kind='supervisor.event' FOR UPDATE OF o`, [eventId, leaseToken, config.workspaces])).rows[0];
    requireCondition(row, 'SUPERVISOR_LEASE_LOST', 409); return row;
  }
  /** Prepares one leased, not yet prepared event inside the caller's transaction. */
  async function prepareLeased(client: PoolClient, row: Awaited<ReturnType<typeof leased>>): Promise<RunRef[]> {
    const c = await current(client, row.workspace_id, row.enrollment_id);
    // Event payload ceiling: an oversized event never reaches a job or a provider.
    if (Buffer.byteLength(JSON.stringify(row.event_payload ?? null), 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      await client.query("INSERT INTO supervisor_preparations (event_id,workspace_id,enrollment_id,jobs,disposition) VALUES ($1,$2,$3,'[]','oversized')",
        [row.event_id, row.workspace_id, row.enrollment_id]);
      return [];
    }
    const context: SupervisorInputContext = { kind: 'learning_event', eventId: row.event_id, eventType: row.event_type,
      courseReleaseId: c.enrollment.course_release_id, episodeId: c.enrollment.current_episode_id };
    const role = row.event_type === 'companion.requested' ? 'companion' : row.event_type==='research.requested'?'research':row.event_type==='rubric.assist_requested'?'reviewer':'supervisor';
    if (role === 'reviewer') {
      // Only a staff request for a learner who opted in; the answer stays unchanged since.
      const requestId = (row.event_payload as { requestId?: string } | null)?.requestId;
      requireCondition(row.actor_kind === 'staff' && uuid.safeParse(requestId).success, 'RUBRIC_ASSIST_NOT_ACTIVATED', 409);
      const resolved = await resolveRubricAssistWithin(client, row.enrollment_id, row.workspace_id, requestId!);
      context.rubricRequestId = requestId!; context.episodeId = resolved.episodeId; c.scopeEpisodeId = await scopeEpisode(client, c, resolved.episodeId);
    }
    if(role==='research'){requireCondition(row.actor_kind==='system'&&uuid.safeParse((row.event_payload as {requestId?:string}).requestId).success,'RESEARCH_REQUEST_NOT_ACTIVATED',409);const research=await resolveResearchInputWithin(client,row.enrollment_id,row.workspace_id,(row.event_payload as {requestId:string}).requestId,row.event_id);context.researchRequestId=research.requestId;context.episodeId=research.episodeId;c.scopeEpisodeId=await scopeEpisode(client,c,research.episodeId);}
    if (role === 'companion') {
      const p = row.event_payload as Record<string, unknown> | null;
      requireCondition(p && typeof p === 'object' && p.requestKind === 'question' && uuid.safeParse(p.messageId).success
        && typeof p.episodeId === 'string' && p.episodeId.length > 0 && p.episodeId.length <= 200
        && (p.blockId === undefined || p.blockId === null || typeof p.blockId === 'string' && p.blockId.length > 0 && p.blockId.length <= 200)
        && (p.downgradedChallengeIds === undefined || Array.isArray(p.downgradedChallengeIds) && p.downgradedChallengeIds.length <= 100
          && p.downgradedChallengeIds.every(id => uuid.safeParse(id).success) && new Set(p.downgradedChallengeIds).size === p.downgradedChallengeIds.length)
        && Object.keys(p).every(k => ['messageId', 'episodeId', 'blockId', 'requestKind', 'downgradedChallengeIds'].includes(k)), 'SUPERVISOR_COMPANION_CONTEXT_INVALID', 409);
      const message = await client.query("SELECT 1 FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='learner' FOR SHARE", [p.messageId, row.enrollment_id]);
      requireCondition(message.rowCount === 1, 'SUPERVISOR_COMPANION_CONTEXT_INVALID', 409);
      context.messageId = p.messageId as string; context.episodeId = p.episodeId as string;
      if (typeof p.blockId === 'string') context.blockId = p.blockId;
      c.scopeEpisodeId = await scopeEpisode(client, c, context.episodeId);
    }
    const binding=await options.providerBinding?.(client,row.workspace_id);
    // Configuration binding can wait for an operator transaction. Recheck
    // wall-clock deadlines after that serialization wait, before admission.
    c.nowMs=await clock(client);
    const check = policyCheck(c, 'admit_job', role);
    // A stop consumes the event for good; a pause that raced this claim admits a job that holds.
    let disposition = row.actor_kind === 'agent' ? 'agent_event' : c.supervision === 'stopped' ? 'supervision_stopped'
      : !enrollmentActive(c, role) ? 'inactive' : !check.allowed ? 'policy_denied' : 'prepared';
    const jobs: RunRef[] = [];
    // Noisy learning events coalesce into a supervisor job that has not started its call yet:
    // it reads its context when the call starts, so it sees this event too. Explicit requests
    // (companion questions, research, written-answer assistance) are never coalesced.
    let coalescedInto: string | null = null;
    if (disposition === 'prepared' && role === 'supervisor') {
      coalescedInto = (await client.query<{ id: string }>(`SELECT id FROM supervisor_jobs WHERE enrollment_id=$1 AND workspace_id=$2 AND role='supervisor'
        AND state='queued' AND NOT (runtime_snapshot->'operations' @> '[{"status":"succeeded"}]')
        ORDER BY created_at DESC,id LIMIT 1`, [row.enrollment_id, row.workspace_id])).rows[0]?.id ?? null;
      if (coalescedInto) disposition = 'coalesced';
    }
    if (disposition === 'prepared') {
      const policy=binding?.jobPolicy;
      const admission=policy?{allowance:policy.allowance,durationMs:policy.durationMs,timeoutMs:policy.timeoutMs,maxAttempts:policy.maxAttempts}:config;
      const ref = { jobId: randomUUID(), workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: 1 };
      const inputRef = randomUUID();
      const spec = jobSpecSchema.parse({ schemaVersion: 1, key: { jobId: ref.jobId, workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId },
        inputEventId: row.event_id, role, fence: c.fence,
        checkpoints: [{ id: 'generate', capability: role, inputRef, allowance: admission.allowance, timeoutMs: admission.timeoutMs, maxAttempts: admission.maxAttempts,
          ...(PHASE[role] ? { phase: PHASE[role] } : {}) }],
        // A closed-course answer is read-only: the course deadline that closed it (already
        // past for a capped course) governs work, not reading, so only the job duration bounds it.
        budget: admission.allowance, deadlineAtMs: Math.min(c.nowMs + admission.durationMs,
          check.snapshot.effectiveDeadline && !closedCourseCompanion(c, role) ? Date.parse(check.snapshot.effectiveDeadline) : Infinity) });
      const snapshot = createJob(spec);
      await client.query(`INSERT INTO supervisor_jobs (id,enrollment_id,workspace_id,workflow_id,role,state,input_event_id,expected_revision,specification,runtime_snapshot,provider_revision)
        VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10)`, [ref.jobId, ref.enrollmentId, ref.workspaceId, workflowId(ref), role, row.event_id, c.fence.enrollmentRevision, JSON.stringify(spec), JSON.stringify(snapshot),binding?.revision??null]);
      await client.query(`INSERT INTO supervisor_inputs (id,job_id,enrollment_id,workspace_id,checkpoint_id,fence,context) VALUES ($1,$2,$3,$4,'generate',$5,$6)`,
        [inputRef, ref.jobId, ref.enrollmentId, ref.workspaceId, JSON.stringify(c.fence), JSON.stringify(context)]);
      if (role === 'companion') {
        const linked = await client.query(`UPDATE companion_messages SET job_id=$3
          WHERE id=$1 AND enrollment_id=$2 AND role='learner' AND (job_id IS NULL OR job_id=$3)`,
          [context.messageId, ref.enrollmentId, ref.jobId]);
        requireCondition(linked.rowCount === 1, 'SUPERVISOR_MESSAGE_JOB_CONFLICT', 409);
      }
      if(role==='research'){const linked=await client.query('UPDATE research_requests SET research_job_id=$2 WHERE id=$1 AND research_job_id IS NULL',[context.researchRequestId,ref.jobId]);requireCondition(linked.rowCount===1,'RESEARCH_REQUEST_JOB_CONFLICT',409);}
      if (role === 'reviewer') {
        const linked = await client.query('UPDATE rubric_assist_requests SET job_id=$2 WHERE id=$1 AND job_id IS NULL', [context.rubricRequestId, ref.jobId]);
        requireCondition(linked.rowCount === 1, 'RUBRIC_ASSIST_JOB_CONFLICT', 409);
      }
      jobs.push(ref);
    }
    await client.query('INSERT INTO supervisor_preparations (event_id,workspace_id,enrollment_id,jobs,disposition,coalesced_into) VALUES ($1,$2,$3,$4,$5,$6)',
      [row.event_id, row.workspace_id, row.enrollment_id, JSON.stringify(jobs), disposition, coalescedInto]);
    return jobs;
  }
  const bridge: PostgresSupervisorBridge = {
    async load(raw) {
      const ref = runRefSchema.parse(raw); authorize(ref.workspaceId);
      return transaction(db, async client => {
        const locked = await lockedJob(client, ref);
        await client.query('UPDATE supervisor_jobs SET resume_requested_at=NULL WHERE id=$1 AND resume_requested_at IS NOT NULL', [ref.jobId]);
        return locked.snapshot;
      });
    },
    async transition(raw) {
      const command = jobCommandSchema.parse(raw), ref = command.ref; authorize(ref.workspaceId);
      return afterCommitTransaction(db, async client => {
        const locked = await lockedJob(client, ref), old = locked.snapshot;
        const budgets = await lockBudgetCeilings(client, ref, locked.episodeId), availableBudget = budgets.available;
        // Read wall clock AFTER waiting for all serialization locks.
        locked.current.nowMs = await clock(client);
        const role = old.specification.role;
        const check = policyCheck(locked.current, command.type === 'apply' ? 'publish' : 'tool_call', role);
        const host: HostContext = { nowMs: locked.current.nowMs, currentFence: locked.current.fence,
          enrollmentActive: enrollmentActive(locked.current, role) && check.allowed,
          cancellationRequested: locked.cancelled, availableBudget, supervision: locked.current.supervision };
        if (command.type === 'halt' && (command.reason === 'cancel_requested' || command.reason === 'supervision_stopped')) {
          // Persist the cancellation; a stop keeps its own terminal reason through the reducer's halt.
          await client.query('UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1', [ref.jobId]);
          if (command.reason === 'cancel_requested') host.cancellationRequested = true;
        }
        if (command.type === 'settle' && command.outcome.status === 'succeeded') {
          const a = await artifact(client, ref, command.outcome.artifact.artifactId, command.outcome.artifact.digest);
          requireCondition(a.operation_id === command.operationId && a.owner_id === command.ownerId, 'SUPERVISOR_ARTIFACT_MISMATCH', 409);
        }
        if (command.type === 'settle' && command.outcome.status === 'not_started') {
          const staged = await client.query('SELECT 1 FROM supervisor_artifacts WHERE operation_id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4',
            [command.operationId, ref.jobId, ref.enrollmentId, ref.workspaceId]);
          requireCondition(staged.rowCount === 0, 'SUPERVISOR_OUTCOME_CONFLICT', 409);
        }
        let verified: Awaited<ReturnType<typeof storedVerification>>;
        if (command.type === 'verify' || command.type === 'apply') {
          verified = await storedVerification(client, ref, old);
          if (verified) host.verification = verified.receipt;
        }
        if (command.type === 'apply') host.applicationReceiptId = old.applicationReceiptId ?? randomUUID();
        // Verifier/artifact row locks may have waited past a deadline; never use pre-wait time.
        host.nowMs = locked.current.nowMs = await clock(client);
        host.enrollmentActive = enrollmentActive(locked.current, role)
          && policyCheck(locked.current, command.type === 'apply' ? 'publish' : 'tool_call', role).allowed;
        // The pure engine performs all terminal/fence checks before accepting an application receipt.
        const result = reduce(old, command, host);
        if (result.snapshot.state === 'applied' && old.state !== 'applied') {
          requireCondition(verified!, 'SUPERVISOR_VERIFICATION_REQUIRED', 409);
          // Re-run the receipt binding validation: stored authority/hash may have been revoked or changed since verify.
          const validated = reduce({ ...old, state: 'verifying' }, { type: 'verify', ref }, host);
          requireCondition(validated.snapshot.state === 'ready' && validated.snapshot.verification?.receiptId === old.verification?.receiptId,
            'SUPERVISOR_VERIFICATION_REQUIRED', 409);
          await applyVerified(client, ref, old, verified!, result.snapshot.applicationReceiptId!,options.applyPlan);
        }
        await save(client, old, result.snapshot, budgets.binding);
        if (result.effect === 'invoke' || result.snapshot.state === 'applied' && old.state !== 'applied') {
          // A slow database write must not commit an expired permit/application. Roll back all effects.
          requireCondition(await clock(client) < old.specification.deadlineAtMs, 'SUPERVISOR_DEADLINE_REACHED', 409);
        }
        return transitionSchema.parse(result);
      });
    },
    async claimOutbox(ownerId, limit, leaseMs) {
      rpcRequestSchema.parse({ method: 'outbox.claim', ownerId, limit, leaseMs });
      return claim(ownerId, limit, leaseMs, null);
    },
    async claimOutboxEvent(eventId, ownerId, leaseMs) {
      rpcRequestSchema.parse({ method: 'outbox.claim', ownerId, limit: 1, leaseMs });
      return (await claim(ownerId, 1, leaseMs, uuid.parse(eventId)))[0] ?? null;
    },
    async prepareOutbox(event) {
      const parsed = outboxEventSchema.parse(event);
      return transaction(db, async client => {
        const row = await leased(client, parsed.eventId, parsed.leaseToken);
        requireCondition(row.enrollment_id === parsed.payload.enrollmentId, 'SUPERVISOR_SCOPE_MISMATCH', 409);
        const previous = (await client.query<{ jobs: RunRef[] }>('SELECT jobs FROM supervisor_preparations WHERE event_id=$1', [row.event_id])).rows[0];
        if (previous) return preparedSchema.parse(previous).jobs;
        // A permanent state conflict (consent changed, request withdrawn or already linked, invalid
        // context) can never succeed on a retry: undo this attempt's writes, consume the event with
        // the conflict's code and record it. Anything else (storage, configuration) stays retryable.
        await client.query('SAVEPOINT supervisor_prepare');
        try {
          const jobs = await prepareLeased(client, row);
          await client.query('RELEASE SAVEPOINT supervisor_prepare');
          return jobs;
        } catch (error) {
          if (!(error instanceof ApiError && error.statusCode === 409)) throw error;
          await client.query('ROLLBACK TO SAVEPOINT supervisor_prepare');
          await refusePreparation(client, row, error.code);
          return [];
        }
      });
    },
    async ackOutbox(event) {
      const e = outboxEventSchema.parse(event);
      const result = await db.query(`UPDATE outbox o SET delivered_at=COALESCE(o.delivered_at,clock_timestamp()),acknowledged_token=$2,
        lease_token=NULL,lease_owner=NULL,claimed_until=NULL FROM learning_events l
        WHERE o.event_id=$1 AND l.id=o.event_id AND l.workspace_id=ANY($3::uuid[]) AND l.enrollment_id=$4
          AND o.kind='supervisor.event' AND o.quarantined_at IS NULL AND EXISTS (SELECT 1 FROM supervisor_preparations p WHERE p.event_id=o.event_id)
          AND ((o.delivered_at IS NULL AND o.lease_token=$2 AND o.claimed_until>clock_timestamp()) OR (o.delivered_at IS NOT NULL AND o.acknowledged_token=$2))`,
        [e.eventId, e.leaseToken, config.workspaces, e.payload.enrollmentId]);
      return result.rowCount === 1;
    },
    async nackOutbox(event, code, delayMs, quarantine) {
      const e = outboxEventSchema.parse(event);
      rpcRequestSchema.parse({ method: 'outbox.nack', eventId: e.eventId, leaseToken: e.leaseToken, code, delayMs, quarantine });
      const result = await db.query(`UPDATE outbox o SET available_at=clock_timestamp()+($4 * interval '1 millisecond'),last_error_code=$3,
        quarantined_at=CASE WHEN $5 OR o.attempts>=$8 THEN clock_timestamp() ELSE NULL END,lease_token=NULL,lease_owner=NULL,claimed_until=NULL
        FROM learning_events l WHERE o.event_id=$1 AND l.id=o.event_id AND l.workspace_id=ANY($6::uuid[]) AND l.enrollment_id=$7
          AND o.kind='supervisor.event' AND o.lease_token=$2 AND o.claimed_until>clock_timestamp() AND o.delivered_at IS NULL AND o.quarantined_at IS NULL`,
        [e.eventId, e.leaseToken, code, delayMs, quarantine, config.workspaces, e.payload.enrollmentId, config.maxOutboxAttempts]);
      return result.rowCount === 1;
    },
    claimControls(ownerId, limit, leaseMs) {
      rpcRequestSchema.parse({ method: 'control.claim', ownerId, limit, leaseMs });
      return claimControlDeliveries(db, config.workspaces, ownerId, limit, leaseMs);
    },
    ackControl(delivery, delivered) {
      return ackControlDelivery(db, config.workspaces, delivery.changeId, delivery.leaseToken, delivered);
    },
    claimCancellations(ownerId, limit, leaseMs) {
      rpcRequestSchema.parse({ method: 'cancel.claim', ownerId, limit, leaseMs });
      return claimCancellationDeliveries(db, config.workspaces, ownerId, limit, leaseMs);
    },
    ackCancellation(delivery, delivered) {
      return ackCancellationDelivery(db, config.workspaces, delivery.cancellationId, delivery.leaseToken, delivered);
    },
    async reconcile(limit) {
      rpcRequestSchema.parse({ method: 'reconcile', limit });
      // 1. Uncertain calls whose gateway receipt has since finished with a definite outcome. The
      //    receipt is the gateway's own record for this exact operation and owner; nothing is resent.
      const open = (await db.query<{ job_id: string; enrollment_id: string; workspace_id: string; generation: number; operation_id: string; owner_id: string; outcome: unknown }>(
        `SELECT j.id AS job_id,j.enrollment_id,j.workspace_id,(j.runtime_snapshot->>'generation')::integer AS generation,d.operation_id,d.owner_id,d.outcome
         FROM supervisor_jobs j JOIN provider_dispatches d ON d.job_id=j.id AND d.enrollment_id=j.enrollment_id AND d.workspace_id=j.workspace_id
         WHERE j.workspace_id=ANY($1::uuid[]) AND d.state IN ('completed','not_started') AND d.outcome IS NOT NULL AND d.finished_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.runtime_snapshot->'operations') o
             WHERE o->>'id'=d.operation_id AND o->>'status'='uncertain' AND o->>'ownerId'=d.owner_id::text)
         ORDER BY d.finished_at,d.operation_id LIMIT $2`, [config.workspaces, limit])).rows;
      let settled = 0;
      const candidates = new Map<string, RunRef>();
      for (const row of open) {
        const parsed = outcomeSchema.safeParse(row.outcome);
        if (!parsed.success || parsed.data.status === 'uncertain') continue;
        const ref = { jobId: row.job_id, workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: row.generation };
        try {
          await bridge.transition({ type: 'settle', ref, operationId: row.operation_id, ownerId: row.owner_id, outcome: parsed.data });
          await db.query(`INSERT INTO supervisor_reconciliations (operation_id,job_id,enrollment_id,workspace_id,owner_id,outcome_status)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (operation_id) DO NOTHING`, [row.operation_id, row.job_id, row.enrollment_id, row.workspace_id, row.owner_id, parsed.data.status]);
          settled++; candidates.set(row.job_id, ref);
        } catch { /* Fenced, conflicting or changed meanwhile: left for review, never guessed. */ }
      }
      // 2. Parked follow-ups now due, and resumed jobs whose new workflow has not loaded them yet.
      const due = (await db.query<{ id: string; enrollment_id: string; workspace_id: string; generation: number }>(
        `SELECT id,enrollment_id,workspace_id,(runtime_snapshot->>'generation')::integer AS generation FROM supervisor_jobs
         WHERE workspace_id=ANY($1::uuid[]) AND ((state='follow_up_due' AND (runtime_snapshot->>'dueAtMs')::bigint<=floor(extract(epoch FROM clock_timestamp())*1000))
           OR (resume_requested_at IS NOT NULL AND resume_requested_at<clock_timestamp()-interval '60 seconds'))
         ORDER BY updated_at,id LIMIT $2`, [config.workspaces, limit])).rows;
      for (const row of due) candidates.set(row.id, { jobId: row.id, workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: row.generation });
      const resume: RunRef[] = [];
      for (const ref of candidates.values()) {
        if (resume.length >= 100) break;
        const next = await afterCommitTransaction(db, client => resumeWithin(client, ref)).catch(() => null);
        if (next) resume.push(next);
      }
      // 3. Cancelled jobs (data erasure, provider change) with no call out. A parked, waiting or
      //    verifying job has no workflow to take its next step, so the host ends it here; any other
      //    such job would stop at its next step anyway. A job with a call out is left to its
      //    workflow (signalled), so the call is cancelled and settled there, never resent.
      const cancelled = (await db.query<{ id: string; enrollment_id: string; workspace_id: string; generation: number }>(
        `SELECT id,enrollment_id,workspace_id,(runtime_snapshot->>'generation')::integer AS generation FROM supervisor_jobs
         WHERE workspace_id=ANY($1::uuid[]) AND cancellation_requested AND state NOT IN ('applied','cancelled','failed')
           AND runtime_snapshot IS NOT NULL AND NOT (runtime_snapshot->'operations' @> '[{"status":"in_flight"}]')
         ORDER BY updated_at,id LIMIT $2`, [config.workspaces, limit])).rows;
      for (const row of cancelled) {
        const ref = { jobId: row.id, workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: row.generation };
        await bridge.transition({ type: 'halt', ref, reason: 'cancel_requested' }).catch(() => undefined);
      }
      return { settled, resume };
    },
  };
  return bridge;
}
/** Moves a non-terminal job with no open call to its next generation (or returns the generation
 * already waiting for its workflow). The previous generation's workflow has closed: it returned
 * when the job waited, parked or became uncertain. Terminal jobs never resume. */
async function resumeWithin(client: PoolClient, raw: RunRef): Promise<RunRef | null> {
  const row = (await client.query<{ generation: number; resume_requested_at: Date | null }>(
    "SELECT (runtime_snapshot->>'generation')::integer AS generation,resume_requested_at FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3",
    [raw.jobId, raw.enrollmentId, raw.workspaceId])).rows[0];
  if (!row) return null;
  const locked = await lockedJob(client, { ...raw, generation: row.generation }), old = locked.snapshot;
  const ref = { ...raw, generation: old.generation };
  if (row.resume_requested_at && old.state === 'queued') return ref; // Started before, never loaded: start again (idempotent by workflow id).
  if (!resumable(old) || locked.cancelled || !['waiting', 'running', 'needs_input', 'follow_up_due', 'budget_wait', 'verifying'].includes(old.state)) return null;
  if (old.state === 'follow_up_due' && (old.dueAtMs ?? Infinity) > locked.current.nowMs) return null;
  const next = nextGeneration(old), nextRef = { ...raw, generation: next.generation };
  await save(client, old, next);
  await client.query('UPDATE supervisor_jobs SET workflow_id=$2,resume_requested_at=clock_timestamp() WHERE id=$1', [raw.jobId, workflowId(nextRef)]);
  await client.query('UPDATE supervisor_reconciliations SET resumed_generation=$2 WHERE job_id=$1 AND resumed_generation IS NULL', [raw.jobId, next.generation]);
  return nextRef;
}
/** Trusted host hook: park a job between calls until a person answers (`needs_input`) or until a
 * scheduled follow-up is due (`follow_up_due`, resumed by the dispatcher's reconcile pass). */
export async function parkSupervisorJob(db: Database, ref: RunRef, reason: 'needs_input' | 'follow_up_due', dueAtMs?: number) {
  const bridge = createPostgresSupervisorBridge(db, { workspaceIds: [ref.workspaceId] });
  return bridge.transition({ type: 'park', ref, reason, ...(dueAtMs !== undefined ? { dueAtMs } : {}) });
}
/** Trusted host hook: a person answered; the parked job restarts in a new generation. */
export async function resumeSupervisorJob(db: Database, ref: RunRef) {
  return afterCommitTransaction(db, client => resumeWithin(client, ref));
}

/** Register only this internal service route; does not install cookie/learner auth or read env. */
export function registerSupervisorBridge(app: FastifyInstance, db: Database, options: SupervisorBridgeOptions) {
  const bridge = createPostgresSupervisorBridge(db, options);
  const expected = options.serviceToken ? createHash('sha256').update(options.serviceToken).digest() : null;
  app.post('/v1/supervisor/bridge', { bodyLimit: 262_144, logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      requireCondition(expected, 'SUPERVISOR_UNCONFIGURED', 503);
      const header = request.headers.authorization;
      const token = typeof header === 'string' && /^Bearer \S+$/.test(header) ? header.slice(7) : '';
      requireCondition(timingSafeEqual(expected, createHash('sha256').update(token).digest()), 'SUPERVISOR_UNAUTHENTICATED', 401);
      const parsed = rpcRequestSchema.safeParse(request.body);
      requireCondition(parsed.success, 'SUPERVISOR_INVALID_REQUEST');
      const body = parsed.data;
      if (body.method === 'load') return await bridge.load(body.ref);
      if (body.method === 'transition') {
        if (body.command.type === 'verify' && options.beforeVerify) {
          await bridge.load(body.command.ref);
          await options.beforeVerify(body.command.ref);
        }
        return await bridge.transition(body.command);
      }
      if (body.method === 'outbox.claim') return await bridge.claimOutbox(body.ownerId, body.limit, body.leaseMs);
      if (body.method === 'control.claim') return await bridge.claimControls(body.ownerId, body.limit, body.leaseMs);
      if (body.method === 'reconcile') return await bridge.reconcile(body.limit);
      if (body.method === 'control.ack') return { accepted: await ackControlDelivery(db, options.workspaceIds ?? [], body.changeId, body.leaseToken, body.delivered) };
      if (body.method === 'cancel.claim') return await bridge.claimCancellations(body.ownerId, body.limit, body.leaseMs);
      if (body.method === 'cancel.ack') return { accepted: await ackCancellationDelivery(db, options.workspaceIds ?? [], body.cancellationId, body.leaseToken, body.delivered) };
      // The wire carries event ID + token only. Resolve the immutable envelope in scope; never invent enrollment identity.
      const row = (await db.query<{ kind: string; payload: unknown; attempts: number }>(`SELECT o.kind,o.payload,o.attempts FROM outbox o
        JOIN learning_events e ON e.id=o.event_id WHERE o.event_id=$1 AND e.workspace_id=ANY($2::uuid[])`,
        [body.eventId, options.workspaceIds ?? []])).rows[0];
      requireCondition(row, 'SUPERVISOR_NOT_FOUND', 404);
      const event = outboxEventSchema.parse({ eventId: body.eventId, leaseToken: body.leaseToken, kind: row.kind, payload: row.payload, attempts: row.attempts });
      if (body.method === 'outbox.prepare') return { jobs: await bridge.prepareOutbox(event) };
      if (body.method === 'outbox.ack') return { accepted: await bridge.ackOutbox(event) };
      return { accepted: await bridge.nackOutbox(event, body.code, body.delayMs, body.quarantine) };
    } catch (error) {
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof ContractError) return reply.code(409).send({ error: 'SUPERVISOR_TRANSITION_REJECTED' });
      return reply.code(500).send({ error: 'SUPERVISOR_STORAGE_ERROR' });
    }
  });
  return bridge;
}

/** Trusted administrator hook: caller authorizes staff; the bridge exposes NO budget-write RPC. */
export async function configureSupervisorBudget(db: Database, scope: { workspaceId: string; enrollmentId?: string }, limits: { microUsd: number; tokens: number }) {
  const workspaceId = uuid.parse(scope.workspaceId), cap = allowanceSchema.parse(limits);
  return transaction(db, async client => {
    if (scope.enrollmentId) {
      const enrollmentId = uuid.parse(scope.enrollmentId);
      requireCondition((await client.query('SELECT 1 FROM enrollments WHERE id=$1 AND workspace_id=$2', [enrollmentId, workspaceId])).rowCount, 'SUPERVISOR_NOT_FOUND', 404);
      await client.query(`INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id,limit_micro_usd,limit_tokens) VALUES ($1,$2,$3,$4)
        ON CONFLICT (enrollment_id) DO UPDATE SET limit_micro_usd=EXCLUDED.limit_micro_usd,limit_tokens=EXCLUDED.limit_tokens`, [enrollmentId, workspaceId, cap.microUsd, cap.tokens]);
    } else await client.query(`INSERT INTO supervisor_workspace_budgets (workspace_id,limit_micro_usd,limit_tokens) VALUES ($1,$2,$3)
      ON CONFLICT (workspace_id) DO UPDATE SET limit_micro_usd=EXCLUDED.limit_micro_usd,limit_tokens=EXCLUDED.limit_tokens`, [workspaceId, cap.microUsd, cap.tokens]);
  });
}

/** Trusted administrator hook: per-UTC-day and per-artifact (one episode, one UTC day) ceilings
 * for one enrollment. `null` removes a ceiling. The bridge exposes no write RPC for these. */
export async function configureSupervisorPeriodBudget(db: Database, scope: { workspaceId: string; enrollmentId: string },
  limits: { daily?: { microUsd: number; tokens: number } | null; artifact?: { microUsd: number; tokens: number } | null }) {
  const workspaceId = uuid.parse(scope.workspaceId), enrollmentId = uuid.parse(scope.enrollmentId);
  const daily = limits.daily ? allowanceSchema.parse(limits.daily) : null, artifact = limits.artifact ? allowanceSchema.parse(limits.artifact) : null;
  return transaction(db, async client => {
    requireCondition((await client.query('SELECT 1 FROM enrollments WHERE id=$1 AND workspace_id=$2', [enrollmentId, workspaceId])).rowCount, 'SUPERVISOR_NOT_FOUND', 404);
    await client.query(`INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [enrollmentId, workspaceId]);
    await client.query(`UPDATE supervisor_enrollment_budgets SET daily_limit_micro_usd=$3,daily_limit_tokens=$4,artifact_limit_micro_usd=$5,artifact_limit_tokens=$6
      WHERE enrollment_id=$1 AND workspace_id=$2`, [enrollmentId, workspaceId, daily?.microUsd ?? null, daily?.tokens ?? null, artifact?.microUsd ?? null, artifact?.tokens ?? null]);
  });
}

/** Trusted gateway hook; parent must authenticate and scope its caller separately from the worker. */
export async function loadSupervisorInput(db: Database, ref: RunRef, inputRef: string) {
  uuid.parse(inputRef);
  return transaction(db, async client => {
    const { snapshot, current: c, cancelled } = await lockedJob(client, ref);
    requireCondition(!cancelled && sameFence(snapshot.specification.fence, c.fence) && c.nowMs < snapshot.specification.deadlineAtMs
      && enrollmentActive(c, snapshot.specification.role) && policyCheck(c, 'tool_call', snapshot.specification.role).allowed, 'SUPERVISOR_INPUT_STALE', 409);
    const row = (await client.query<{ fence: Fence; context: SupervisorInputContext }>(
      'SELECT fence,context FROM supervisor_inputs WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4', [inputRef, ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
    requireCondition(row && sameFence(row.fence, c.fence) && snapshot.specification.checkpoints.some(cp => cp.inputRef === inputRef), 'SUPERVISOR_INPUT_NOT_FOUND', 404);
    return row;
  });
}
/** Resolve the generation/owner absent from ProviderRequest against persisted scope and specification.
 * This lookup is NOT a new provider dispatch permit. Gateway submission must remain idempotent by operationId.
 */
export async function resolveSupervisorOperation(db: Database, raw: ProviderRequest) {
  return transaction(db,client=>resolveSupervisorOperationWithin(client,raw));
}
export async function resolveSupervisorOperationWithin(client:PoolClient,raw:ProviderRequest){
    const { ref, snapshot, current: c, operation: op, checkpoint: cp, live } = await lockedOperation(client, raw);
    requireCondition(live, 'SUPERVISOR_INPUT_STALE', 409);
    const input = (await client.query<{ fence: Fence; context: SupervisorInputContext }>(
      'SELECT fence,context FROM supervisor_inputs WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4',
      [cp.inputRef, ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
    requireCondition(input && sameFence(input.fence, c.fence), 'SUPERVISOR_INPUT_NOT_FOUND', 404);
    return { ref, ownerId: op.ownerId, operationStatus: op.status, outcome: op.outcome, input,remainingMs:snapshot.specification.deadlineAtMs-c.nowMs };

}
/** The same identity checks as resolveSupervisorOperationWithin, under the job row lock, for a job
 * that has ended: returns the operation's owner and status, or null while the job is still live.
 * Bookkeeping only; it never permits a dispatch. */
export async function endedSupervisorOperationWithin(client: PoolClient, raw: ProviderRequest) {
  const { operation, live } = await lockedOperation(client, raw);
  return live ? null : { ownerId: operation.ownerId, operationStatus: operation.status };
}
async function lockedOperation(client: PoolClient, raw: ProviderRequest) {
  const request=providerRequestSchema.parse(raw);
    const row = (await client.query<{ runtime_snapshot: Snapshot }>(
      'SELECT runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3',
      [request.job.jobId, request.job.enrollmentId, request.job.workspaceId])).rows[0];
    requireCondition(row?.runtime_snapshot, 'SUPERVISOR_NOT_FOUND', 404);
    const ref = runRefSchema.parse({ ...request.job, generation: row.runtime_snapshot.generation });
    const { snapshot, current: c, cancelled } = await lockedJob(client, ref);
    const cp = snapshot.specification.checkpoints.find(checkpoint => checkpoint.id === request.checkpoint.id);
    const op = snapshot.operations.find(operation => operation.id === request.operationId);
    requireCondition(cp && op && op.checkpointId === cp.id && snapshot.specification.role === request.role
      && sameFence(snapshot.specification.fence, request.fence) && digestJson(cp) === digestJson(request.checkpoint), 'SUPERVISOR_OPERATION_MISMATCH', 409);
    const live = !cancelled && !['cancelled', 'failed', 'applied'].includes(snapshot.state)
      && sameFence(snapshot.specification.fence, c.fence) && enrollmentActive(c, snapshot.specification.role)
      && c.nowMs < snapshot.specification.deadlineAtMs && policyCheck(c, 'tool_call', snapshot.specification.role).allowed;
    return { ref, snapshot, current: c, operation: op, checkpoint: cp, live };
}

/** Immutable reference staging, not verification or publication. No raw provider response/CoT field exists.
 * Original operation owners may stage a completed receipt after membership removal to settle its cost.
 */
export async function storeSupervisorArtifact(db: Database, ref: RunRef, operationId: string, ownerId: string, rawContent: SupervisorArtifactContent) {
  const value = content(rawContent); uuid.parse(ownerId);
  return transaction(db, async client => {
    const { snapshot } = await lockedJob(client, ref), op = snapshot.operations.find(o => o.id === operationId);
    requireCondition(op?.ownerId === ownerId && ['in_flight', 'uncertain', 'succeeded'].includes(op.status), 'SUPERVISOR_OPERATION_MISMATCH', 409);
    requireCondition((snapshot.specification.role === 'companion') === (value.kind === 'companion_message'), 'SUPERVISOR_ARTIFACT_KIND', 409);
    const digest = digestJson(value);
    const old = (await client.query<{ id: string; digest: string; job_id: string; owner_id: string }>('SELECT id,digest,job_id,owner_id FROM supervisor_artifacts WHERE operation_id=$1', [operationId])).rows[0];
    if (old) {
      requireCondition(old.job_id === ref.jobId && old.owner_id === ownerId && old.digest === digest, 'SUPERVISOR_ARTIFACT_CONFLICT', 409);
      return { artifactId: old.id, digest: old.digest };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO supervisor_artifacts (id,job_id,enrollment_id,workspace_id,operation_id,owner_id,digest,content)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, ref.jobId, ref.enrollmentId, ref.workspaceId, operationId, ownerId, digest, JSON.stringify(value)]);
    return { artifactId: id, digest };
  });
}
/** Trusted verifier hook only. Authentication of the verifier is the parent's responsibility; never route this through provider output. */
export async function recordSupervisorVerification(db: Database, ref: RunRef, verifierId: string, verdict: 'verified' | 'rejected') {
  uuid.parse(verifierId); requireCondition(['verified', 'rejected'].includes(verdict), 'SUPERVISOR_INVALID_VERDICT');
  return transaction(db, async client => {
    const { snapshot, current: c, cancelled } = await lockedJob(client, ref);
    requireCondition(!cancelled && sameFence(snapshot.specification.fence, c.fence) && enrollmentActive(c, snapshot.specification.role)
      && c.nowMs < snapshot.specification.deadlineAtMs && policyCheck(c, 'publish', snapshot.specification.role).allowed, 'SUPERVISOR_VERIFICATION_STALE', 409);
    const applicationKind = snapshot.specification.role === 'companion' ? 'companion_message' : snapshot.specification.role==='research'?'research_candidate':snapshot.specification.role==='reviewer'?'rubric_suggestion':'reviewed_adaptation';
    const authority = (await client.query<{ can_verify_companion: boolean; can_review_adaptation: boolean;can_collect_research:boolean;can_suggest_rubric:boolean }>(
      'SELECT * FROM supervisor_verifier_authorities WHERE id=$1 AND workspace_id=$2 AND enabled FOR SHARE', [verifierId, ref.workspaceId])).rows[0];
    requireCondition(authority && (applicationKind === 'companion_message' ? authority.can_verify_companion : applicationKind==='research_candidate'?authority.can_collect_research:applicationKind==='rubric_suggestion'?authority.can_suggest_rubric:authority.can_review_adaptation), 'SUPERVISOR_VERIFIER_FORBIDDEN', 403);
    const outputs = snapshot.specification.checkpoints.map(cp => snapshot.operations.find(o => o.checkpointId === cp.id)?.outcome);
    requireCondition(outputs.every(o => o?.status === 'succeeded'), 'SUPERVISOR_CHECKPOINTS_INCOMPLETE', 409);
    const artifacts = outputs.flatMap(o => o?.status === 'succeeded' ? [o.artifact] : []);
    for (const output of artifacts) await artifact(client, ref, output.artifactId, output.digest);
    const old = (await client.query<VerificationRow>('SELECT * FROM supervisor_verifications WHERE job_id=$1', [ref.jobId])).rows[0];
    if (old) {
      requireCondition(old.verifier_id === verifierId && old.verdict === verdict && sameFence(old.fence, c.fence) && digestJson(old.artifacts) === digestJson(artifacts), 'SUPERVISOR_VERIFICATION_CONFLICT', 409);
      return old.id;
    }
    const id = randomUUID();
    await client.query(`INSERT INTO supervisor_verifications (id,job_id,enrollment_id,workspace_id,verifier_id,fence,artifacts,verdict,application_kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, ref.jobId, ref.enrollmentId, ref.workspaceId, verifierId, JSON.stringify(c.fence), JSON.stringify(artifacts), verdict, applicationKind]);
    return id;
  });
}
