import {resolveResearchInputWithin} from './research-store.js';
import {researchCandidateSchema,type ResearchCandidate} from './research-contracts.js';
import { rubricRefusalSchema, rubricSuggestionSchema, type RubricRefusal, type RubricSuggestion } from './rubric-assist-contracts.js';
import { resolveRubricAssistWithin } from './rubric-assist-store.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { envelopeScopeId, checkAction, type PolicyState } from '@course-core/policy';
import {
  accounting, allowanceSchema, ContractError, createJob, fenceSchema, jobCommandSchema, jobSpecSchema,
  outboxEventSchema, preparedSchema, providerRequestSchema, rpcRequestSchema, runRefSchema, sameFence, snapshotSchema,
  transition as reduce, transitionSchema, uuid, verificationSchema, workflowId, nextGeneration, resumable, outcomeSchema, refence,
  MAX_PARK_MS, type JobObjective,
  type Command, type Fence, type HostBridge, type HostContext, type JobSpec, type OutboxEvent,
  type RunRef, type Snapshot, type Verification, type ProviderRequest, type SupervisionState,
} from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { digestJson, policyEpisodeIdFor, type Enrollment } from './repository.js';
import { canonicalJson } from '@course-core/sdk/compiler';
import { artifactStore, claimObject, releaseObject, stageObject, withArtifactContent, type StagedObject } from './artifact-store.js';
import {supervisedPlanSchema,type SupervisedPlan} from './supervisor-tool-loop.js';
import type {SupervisorJobPolicy} from './provider-setup.js';
import { pricingAt, recordSpendEvents, syncSupervisorSpend } from './provider-costs.js';
import { priceUsage, type UsageReceipt } from '@course-core/providers';
import { afterCommitTransaction, onCommit } from './after-commit.js';
import { telemetry } from '@course-core/supervisor/telemetry';
import { noteBridgeContact } from './platform-operations.js';
import { ackControlDelivery, claimControlDeliveries, supervisionStateWithin } from './supervision-control.js';
import { armOffersRole, studyArmWithin, type ActiveArm } from './study.js';
import { ackCancellationDelivery, claimCancellationDeliveries } from './supervisor-cancellation.js';
import { outputRefusalSchema, refusedAnswerReason, type OutputRefusal } from './output-refusal.js';
import { ackCrossCourseWakeup, claimCrossCourseWakeups, crossCourseConsentFor, observeCrossCourseEnrollment, planCrossCourse } from './cross-course.js';
import { ACTION_EVENT, ALTERNATIVE_ACTIONS, DEFAULT_ACTION_POLICY, actionForEvent, deliverActionsOfJob, endActionsOfJob, followUpsFor, insertFollowUp,
  resolveFollowUp, type ActionRow } from './teaching-actions.js';
import { supervisionSettingsWithin } from './supervision-settings.js';
import { automaticHypothesesEnabled } from './teaching-hypotheses.js';

/** A staff retry of one ended supervisor run (scoped-corrections.ts): prepared into its own new run. */
export const RETRY_EVENT = 'supervisor.run_retry_requested';

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
  /** Trusted server composition only: after a verified rubric proposal is stored, the gate's
   * installed deterministic evaluator may confirm it (conversation-confirmation.ts). */
  confirmRubricSuggestion?:(client:PoolClient,ref:RunRef,suggestion:RubricSuggestion,suggestionId:string)=>Promise<void>;
  /** `roleAllowances`: a role's reservation sized from its limits and price (role-reservation.ts), in place of the policy allowance. */
  providerBinding?:(client:PoolClient,workspaceId:string)=>Promise<{revision:number;jobPolicy:SupervisorJobPolicy;roleAllowances?:Partial<Record<string,{microUsd:number;tokens:number}>>}|null>;
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
  /** The study arm in force (a consented participant of a recruiting study), read after the
   * enrollment lock, which a consent change also holds. Null: no arm applies. */
  studyArm: ActiveArm | null;
}
/** Whether the enrollment's study arm withholds this role (study.ts). */
const armWithholds = (c: Current, role: string) => c.studyArm !== null && !armOffersRole(c.studyArm.behaviour, role);
async function clock(client: PoolClient) {
  return Number((await client.query<{ ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms")).rows[0]!.ms);
}
// All paths use enrollment -> membership -> release -> policy -> job -> workspace budget -> enrollment budget.
async function current(client: PoolClient, workspaceId: string, enrollmentId: string): Promise<Current> {
  const enrollment = (await client.query<EnrollmentRow>('SELECT * FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [enrollmentId, workspaceId])).rows[0];
  requireCondition(enrollment, 'SUPERVISOR_NOT_FOUND', 404);
  const supervision = await supervisionStateWithin(client, enrollmentId);
  const studyArm = await studyArmWithin(client, enrollmentId);
  // Existence is active membership in the current schema. Hold a share lock so removal and
  // authorization serialize. Do not throw here: receipts for already dispatched work must settle.
  const membership = await client.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, enrollment.user_id]);
  const release = (await client.query<{ digest: string; status: string }>('SELECT digest,status FROM course_releases WHERE id=$1 AND workspace_id=$2 FOR SHARE', [enrollment.course_release_id, workspaceId])).rows[0];
  const policy = (await client.query<{ policy_revision: number; ledger_revision: number; snapshot: PolicyState }>('SELECT policy_revision,ledger_revision,snapshot FROM policy_states WHERE enrollment_id=$1 FOR UPDATE', [enrollmentId])).rows[0];
  requireCondition(release && policy, 'SUPERVISOR_STATE_MISSING', 409);
  requireCondition(policy.policy_revision === enrollment.policy_revision && policy.snapshot.policyRevision === policy.policy_revision
    && policy.snapshot.ledgerRevision === policy.ledger_revision && policy.snapshot.enrollmentId === enrollmentId, 'SUPERVISOR_POLICY_INCONSISTENT', 409);
  // An archived release stays live for the learners pinned to it; only drafts are not.
  return { enrollment, supervision, studyArm, membershipActive: membership.rowCount === 1, releaseActive: release.status === 'published' || release.status === 'archived', policy: policy.snapshot, nowMs: await clock(client),
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
  return checkAction(c.policy, { scopeId: episodeId ? `episode:${episodeId}` : envelopeScopeId(c.policy),
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
interface BudgetRow { limit_micro_usd: string; limit_tokens: string; used_micro_usd: string; used_tokens: string; default_enrollment_limit_micro_usd?: string | null; default_enrollment_limit_tokens?: string | null }
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
  // Course-made media is personal supervision: only the full-supervisor study arm offers it.
  if (armWithholds(c, 'supervisor')) controlled.push('study_arm');
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
interface LimitRow extends BudgetRow { limit_source: 'default' | 'own'; daily_limit_micro_usd: string | null; daily_limit_tokens: string | null; artifact_limit_micro_usd: string | null; artifact_limit_tokens: string | null }
/** Workspace, enrollment, per-UTC-day and per-artifact (this episode, this UTC day) headroom.
 * Day and artifact use come from the job spend ledger (reservations and charges) under the same
 * enrollment budget lock, so concurrent jobs see each other's reservations. */
async function lockBudgetCeilings(client: PoolClient, ref: Pick<RunRef, 'workspaceId' | 'enrollmentId'>, episodeId?: string | null) {
  await client.query('INSERT INTO supervisor_workspace_budgets (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [ref.workspaceId]);
  const workspace = (await client.query<BudgetRow>('SELECT * FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE', [ref.workspaceId])).rows[0]!;
  await client.query('INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ref.enrollmentId, ref.workspaceId]);
  const enrollment = (await client.query<LimitRow>('SELECT * FROM supervisor_enrollment_budgets WHERE enrollment_id=$1 AND workspace_id=$2 FOR UPDATE', [ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(enrollment, 'SUPERVISOR_SCOPE_MISMATCH', 409);
  // A learner whose own limit was never set gets the workspace default limit for each learner
  // (none set: 0, so nothing paid runs until staff choose a default or a limit for the learner).
  const own = enrollment.limit_source === 'own';
  const enrollmentLimit = {
    microUsd: Number(own ? enrollment.limit_micro_usd : workspace.default_enrollment_limit_micro_usd ?? 0),
    tokens: Number(own ? enrollment.limit_tokens : workspace.default_enrollment_limit_tokens ?? 0),
  };
  const remaining: { ceiling: BudgetCeiling; microUsd: number; tokens: number }[] = [
    { ceiling: 'workspace', microUsd: Number(workspace.limit_micro_usd) - Number(workspace.used_micro_usd), tokens: Number(workspace.limit_tokens) - Number(workspace.used_tokens) },
    { ceiling: 'enrollment', microUsd: enrollmentLimit.microUsd - Number(enrollment.used_micro_usd), tokens: enrollmentLimit.tokens - Number(enrollment.used_tokens) },
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
  // A teaching action whose job stopped without delivering its change ends with the job's reason.
  if ((next.state === 'failed' || next.state === 'cancelled') && old.state !== next.state) await endActionsOfJob(client, key.jobId, next.reason ?? next.state);
}

export type SupervisorArtifactContent = { kind: 'companion_message'; text: string; cutShort?: true } | { kind: 'proposed_adaptation'; summary: string }|SupervisedPlan|ResearchCandidate|RubricSuggestion|OutputRefusal|RubricRefusal;
export interface SupervisorInputContext {
  kind: 'learning_event'; eventId: string; eventType: string; courseReleaseId: string;
  episodeId: string | null; messageId?: string; blockId?: string; researchRequestId?:string; rubricRequestId?: string;
  /** The logical role this checkpoint runs (design §4); absent for a single-writer job. */
  task?: { logicalRole: 'planner' | 'builder' | 'evaluator'; alternative?: string };
}
function content(input: unknown): SupervisorArtifactContent {
  requireCondition(input && typeof input === 'object' && !Array.isArray(input), 'SUPERVISOR_INVALID_ARTIFACT');
  const value = input as Record<string, unknown>, field = value.kind === 'companion_message' ? 'text' : value.kind === 'proposed_adaptation' ? 'summary' : '';
  if(value.kind==='research_candidate'){const parsed=researchCandidateSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  // Output Core refused after the model answered: stored so the job can end, never applied.
  if(value.kind==='output_refusal'){const parsed=outputRefusalSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  if(value.kind==='rubric_suggestion'){const parsed=rubricSuggestionSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  // A reviewer draft the strategy refused: stored so the job can end, never applied.
  if(value.kind==='rubric_refusal'){const parsed=rubricRefusalSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  if(value.kind==='supervised_plan'){const parsed=supervisedPlanSchema.safeParse(value);requireCondition(parsed.success,'SUPERVISOR_INVALID_ARTIFACT');return parsed.data;}
  // A companion reply cut short at the provider's output limit carries `cutShort: true`, nothing else.
  const marked = value.kind === 'companion_message' && value.cutShort === true ? 1 : 0;
  requireCondition(marked || value.cutShort === undefined, 'SUPERVISOR_INVALID_ARTIFACT');
  requireCondition(field && Object.keys(value).length === 2 + marked && typeof value[field] === 'string' && (value[field] as string).trim().length > 0
    && (value[field] as string).length <= 16_000, 'SUPERVISOR_INVALID_ARTIFACT');
  return value as SupervisorArtifactContent;
}
interface ArtifactRow { id: string; digest: string; content: unknown; content_object_id: string | null; operation_id: string; owner_id: string }
async function artifact(client: PoolClient, ref: RunRef, id: string, expectedDigest: string) {
  const stored = (await client.query<ArtifactRow>(`SELECT * FROM supervisor_artifacts
    WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4 FOR SHARE`, [id, ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(stored && stored.digest === expectedDigest, 'SUPERVISOR_ARTIFACT_MISMATCH', 409);
  // A large artifact may live in the object store; it is read back and checked like an inline one.
  // A changed or missing object is a mismatch; an unreachable store stays a retryable 503.
  const [row] = await withArtifactContent(client, [stored]).catch((error: unknown) => {
    if (error instanceof ApiError && error.statusCode !== 503) throw new ApiError(409, 'SUPERVISOR_ARTIFACT_MISMATCH');
    throw error;
  });
  requireCondition(row && digestJson(content(row.content)) === row.digest, 'SUPERVISOR_ARTIFACT_MISMATCH', 409);
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
    // A refusal is only ever recorded as rejected, under the verifier of its own role.
    if (a.content.kind === 'output_refusal') {
      requireCondition(row.verdict === 'rejected' && (a.content.role === 'companion') === (row.application_kind === 'companion_message'), 'SUPERVISOR_VERIFICATION_MISMATCH', 409);
      continue;
    }
    requireCondition((row.application_kind === 'research_candidate') === (a.content.kind === 'research_candidate'),'SUPERVISOR_VERIFICATION_MISMATCH',409);
    requireCondition((row.application_kind === 'rubric_suggestion') === (a.content.kind === 'rubric_suggestion' || a.content.kind === 'rubric_refusal'),'SUPERVISOR_VERIFICATION_MISMATCH',409);
    requireCondition(a.content.kind !== 'rubric_refusal' || row.verdict === 'rejected','SUPERVISOR_VERIFICATION_MISMATCH',409);
    requireCondition((row.application_kind === 'companion_message') === (a.content.kind === 'companion_message'), 'SUPERVISOR_VERIFICATION_MISMATCH', 409);
  }
  return { receipt, row };
}
async function applyVerified(client: PoolClient, ref: RunRef, snapshot: Snapshot, verified: { receipt: Verification; row: VerificationRow }, receiptId: string,options:Pick<SupervisorBridgeOptions,'applyPlan'|'confirmRubricSuggestion'>={}) {
  const applyPlan=options.applyPlan;
  requireCondition(verified.receipt.verdict === 'verified' && snapshot.verification?.receiptId === verified.receipt.receiptId, 'SUPERVISOR_VERIFICATION_REQUIRED', 409);
  // One writer commits (design §4): a multi-checkpoint job applies its last checkpoint's artifact
  // (the evaluator's choice); the planner's and builders' artifacts were its inputs.
  const last = snapshot.operations.find(o => o.checkpointId === snapshot.specification.checkpoints.at(-1)!.id)?.outcome;
  requireCondition(last?.status === 'succeeded' && (verified.receipt.artifacts.length === 1 || snapshot.specification.role === 'supervisor')
    && verified.receipt.artifacts.some(x => x.artifactId === last.artifact.artifactId && x.digest === last.artifact.digest), 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
  const a = await artifact(client, ref, last.artifact.artifactId, last.artifact.digest);
  const targetId = randomUUID();
  requireCondition(a.content.kind !== 'output_refusal', 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
  requireCondition(a.content.kind !== 'rubric_refusal', 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
  if (a.content.kind === 'companion_message') {
    requireCondition(snapshot.specification.role === 'companion', 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
    // The answer belongs to the lesson its question was asked in, wherever the learner is now.
    const question = (await client.query<{ episode_id: string | null; block_id: string | null; message_id: string }>(`SELECT id AS message_id,context->>'episodeId' AS episode_id,context->>'blockId' AS block_id
      FROM companion_messages WHERE job_id=$1 AND enrollment_id=$2 AND role='learner' LIMIT 1`, [ref.jobId, ref.enrollmentId])).rows[0];
    await client.query(`INSERT INTO companion_messages (id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,$4,$5)`,
      [targetId, ref.enrollmentId, a.content.text, JSON.stringify({ verificationReceiptId: verified.receipt.receiptId, artifactId: a.id,
        // The learner sees that the provider stopped this reply at its output limit.
        ...(a.content.cutShort ? { cutShort: true } : {}),
        ...(question?.episode_id ? { episodeId: question.episode_id, blockId: question.block_id, answersMessageId: question.message_id } : {}) }), ref.jobId]);
  } else if (a.content.kind === 'rubric_suggestion') {
    // A draft for a human reviewer: no evidence, grade or learner-visible change.
    requireCondition(snapshot.specification.role === 'reviewer' && verified.row.application_kind === 'rubric_suggestion', 'SUPERVISOR_APPLICATION_UNSUPPORTED', 409);
    await client.query('INSERT INTO rubric_suggestions(id,request_id,job_id,enrollment_id,workspace_id,artifact_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [targetId, a.content.requestId, ref.jobId, ref.enrollmentId, ref.workspaceId, a.id, a.digest]);
    const updated = await client.query("UPDATE rubric_assist_requests SET state='suggested' WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND job_id=$4 AND state='requested'",
      [a.content.requestId, ref.enrollmentId, ref.workspaceId, ref.jobId]);
    requireCondition(updated.rowCount === 1, 'RUBRIC_ASSIST_NOT_PENDING', 409);
    await options.confirmRubricSuggestion?.(client, ref, a.content, targetId);
  } else if(a.content.kind==='research_candidate') {
    requireCondition(snapshot.specification.role==='research'&&verified.row.application_kind==='research_candidate','SUPERVISOR_APPLICATION_UNSUPPORTED',409);
    await client.query('INSERT INTO research_candidates(id,request_id,job_id,enrollment_id,workspace_id,artifact_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7)',[targetId,a.content.requestId,ref.jobId,ref.enrollmentId,ref.workspaceId,a.id,a.digest]);
    const updated=await client.query("UPDATE research_requests SET state='collected' WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND research_job_id=$4 AND state='dispatched'",[a.content.requestId,ref.enrollmentId,ref.workspaceId,ref.jobId]);requireCondition(updated.rowCount===1,'RESEARCH_REQUEST_NOT_ACTIVATED',409);
  } else {
    if(a.content.kind==='supervised_plan'&&(a.content.selection||a.content.modelSuggestion||a.content.generatedTeaching||a.content.researchSelections?.length||a.content.resourceChoices?.length||a.content.suggestions?.length)){requireCondition(applyPlan,'SUPERVISOR_APPLICATION_UNSUPPORTED',409);await applyPlan(client,ref,a.content);}
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
  // Delivered: the teaching actions this job served are followed up later (design §4 loop).
  if (snapshot.specification.role === 'supervisor') await scheduleFollowUpsWithin(client, ref, snapshot, event.id);
}
/** How long a follow-up job may run once it is due. */
const FOLLOW_UP_RUN_MS = 10 * 60_000;
/** Creates each follow-up of the job's delivered teaching actions as a supervisor job parked until it
 * is due (follow_up_due). The dispatcher's reconcile pass resumes it then, re-based on the learner's
 * state at that time. A follow-up the course deadline would cut off is recorded as ended. */
async function scheduleFollowUpsWithin(client: PoolClient, ref: RunRef, snapshot: Snapshot, eventId: string) {
  const delivered = await deliverActionsOfJob(client, ref.jobId);
  if (!delivered.length) return;
  const c = await current(client, ref.workspaceId, ref.enrollmentId);
  const deadline = policyCheck(c, 'admit_job').snapshot.effectiveDeadline;
  const input = (await client.query<{ context: SupervisorInputContext }>('SELECT context FROM supervisor_inputs WHERE id=$1',
    [snapshot.specification.checkpoints[0]!.inputRef])).rows[0]!.context;
  const cp = snapshot.specification.checkpoints.at(-1)!;
  for (const parent of delivered) for (const plan of followUpsFor(parent)) {
    const dueAtMs = c.nowMs + plan.delayMs, deadlineAtMs = dueAtMs + FOLLOW_UP_RUN_MS;
    if (deadline && deadlineAtMs > Date.parse(deadline)) {
      await client.query(`INSERT INTO teaching_actions(id,enrollment_id,workspace_id,action,objective_ids,origin,parent_id,state,end_reason)
        VALUES($1,$2,$3,$4,$5,'follow_up',$6,'ended','course_deadline')`, [randomUUID(), ref.enrollmentId, ref.workspaceId, plan.action, JSON.stringify(parent.objective_ids), parent.id]);
      continue;
    }
    const job = { jobId: randomUUID(), workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, generation: 1 };
    const actionId = await insertFollowUp(client, parent, plan.action, new Date(dueAtMs), job.jobId);
    // Each follow-up's own input event (a job is unique per event and role); not itself supervised.
    const scheduled = await appendEvent(client, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, actorKind: 'system', type: 'teaching.follow_up_scheduled',
      payload: { actionId, parentActionId: parent.id, action: plan.action, jobId: job.jobId, dueAt: new Date(dueAtMs).toISOString() }, causationId: eventId,
      idempotencyKey: `teaching-follow-up:${actionId}`, supervise: false });
    const objective: JobObjective = { kind: plan.action, objectiveIds: parent.objective_ids.slice(0, 20), refs: [actionId] };
    const spec = jobSpecSchema.parse({ schemaVersion: 1, key: { jobId: job.jobId, workspaceId: job.workspaceId, enrollmentId: job.enrollmentId },
      inputEventId: scheduled.id, role: 'supervisor', fence: c.fence, objective, budget: cp.allowance, deadlineAtMs,
      checkpoints: [{ id: 'generate', capability: 'supervisor', inputRef: randomUUID(), allowance: cp.allowance, timeoutMs: cp.timeoutMs, maxAttempts: cp.maxAttempts, phase: 'analyze' }] });
    await client.query(`INSERT INTO supervisor_jobs (id,enrollment_id,workspace_id,workflow_id,role,state,input_event_id,expected_revision,specification,runtime_snapshot,trace_id,objective)
      VALUES ($1,$2,$3,$4,'supervisor','queued',$5,$6,$7,$8,$9,$10)`, [job.jobId, job.enrollmentId, job.workspaceId, workflowId(job), scheduled.id, c.fence.enrollmentRevision,
        JSON.stringify(spec), JSON.stringify(createJob(spec)), telemetry().traceId(), JSON.stringify(objective)]);
    const context: SupervisorInputContext = { kind: 'learning_event', eventId: scheduled.id, eventType: 'teaching.follow_up_scheduled', courseReleaseId: c.enrollment.course_release_id, episodeId: input.episodeId };
    await client.query(`INSERT INTO supervisor_inputs (id,job_id,enrollment_id,workspace_id,checkpoint_id,fence,context) VALUES ($1,$2,$3,$4,'generate',$5,$6)`,
      [spec.checkpoints[0]!.inputRef, job.jobId, job.enrollmentId, job.workspaceId, JSON.stringify(c.fence), JSON.stringify(context)]);
    await parkSupervisorJobWithin(client, job, 'follow_up_due', { dueAtMs });
  }
}

/** Statuses of a definite refusal while preparing an event: a state conflict (409), or a client
 * error that repeats on every retry (400/422 invalid, 404 not found, 410 gone). */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 410, 422]);
/** Configuration problems an operator can fix: retried, never consumed as a refusal. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['SUPERVISOR_INVALID_CONFIGURATION']);
function definiteRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && REFUSAL_STATUSES.has(error.statusCode) && !RETRYABLE_CODES.has(error.code);
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

interface PreparationOutcome { role?: string; disposition?: string; lagSeconds?: number }
/** Event lag (recorded to first preparation) and refusals, by role and fixed disposition only. */
function observePreparation(outcome: PreparationOutcome) {
  if (outcome.disposition === undefined || outcome.lagSeconds === undefined) return;
  const runtime = telemetry(), role = { 'course.supervisor.role': outcome.role };
  // Clocks of one database; a negative value can only come from a clock step and is not recorded.
  runtime.record('course.supervisor.event.lag', outcome.lagSeconds, { ...role, 'course.supervisor.disposition': outcome.disposition });
  if (outcome.disposition === 'policy_denied') runtime.count('course.supervisor.rejections', 1, { ...role, 'course.rejection.reason': 'policy_denied' });
  if (outcome.disposition === 'refused') runtime.count('course.supervisor.rejections', 1, { ...role, 'course.rejection.reason': 'preparation_refused' });
}

/** What a new job is for (design §4 job record): its teaching action, or the episode objectives of
 * the learning event that started it. Identifiers only. */
async function jobObjective(client: PoolClient, action: ActionRow | null, c: Current, eventId: string, episodeId: string | null): Promise<JobObjective> {
  if (action) return { kind: 'teaching_action', objectiveIds: action.objective_ids.slice(0, 20), refs: [action.id] };
  const objectiveIds = episodeId ? (await client.query<{ ids: unknown }>(`SELECT ep->'objectiveIds' AS ids FROM course_releases r,
      jsonb_array_elements(r.server_bundle->'chapters') ch, jsonb_array_elements(ch->'episodes') ep
    WHERE r.id=$1 AND r.workspace_id=$2 AND ep->>'id'=$3 LIMIT 1`, [c.enrollment.course_release_id, c.enrollment.workspace_id, episodeId])).rows[0]?.ids : [];
  const valid = Array.isArray(objectiveIds) ? objectiveIds.filter((id): id is string => typeof id === 'string' && /^[a-z][a-z0-9._:-]{0,127}$/.test(id)).slice(0, 20) : [];
  return { kind: 'learning_event', objectiveIds: valid, refs: [eventId] };
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
    const row = (await client.query<{ event_id: string; kind: string; payload: unknown; attempts: number; lease_token: string; workspace_id: string; enrollment_id: string; actor_kind: string; event_type: string; event_payload: unknown; lag_seconds: number }>(
      `SELECT o.*,e.workspace_id,e.enrollment_id,e.actor_kind,e.event_type,e.payload AS event_payload,
         EXTRACT(EPOCH FROM clock_timestamp()-e.created_at)::float8 AS lag_seconds FROM outbox o JOIN learning_events e ON e.id=o.event_id
       WHERE o.event_id=$1 AND o.lease_token=$2 AND o.claimed_until>clock_timestamp() AND o.delivered_at IS NULL AND o.quarantined_at IS NULL
         AND e.workspace_id=ANY($3::uuid[]) AND o.kind='supervisor.event' FOR UPDATE OF o`, [eventId, leaseToken, config.workspaces])).rows[0];
    requireCondition(row, 'SUPERVISOR_LEASE_LOST', 409); return row;
  }
  /** Prepares one leased, not yet prepared event inside the caller's transaction. `outcome`
   * receives the role and disposition, for metrics recorded only after commit. */
  async function prepareLeased(client: PoolClient, row: Awaited<ReturnType<typeof leased>>, outcome: PreparationOutcome): Promise<RunRef[]> {
    const c = await current(client, row.workspace_id, row.enrollment_id);
    // Event payload ceiling: an oversized event never reaches a job or a provider.
    if (Buffer.byteLength(JSON.stringify(row.event_payload ?? null), 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      outcome.disposition = 'oversized';
      await client.query("INSERT INTO supervisor_preparations (event_id,workspace_id,enrollment_id,jobs,disposition) VALUES ($1,$2,$3,'[]','oversized')",
        [row.event_id, row.workspace_id, row.enrollment_id]);
      return [];
    }
    const context: SupervisorInputContext = { kind: 'learning_event', eventId: row.event_id, eventType: row.event_type,
      courseReleaseId: c.enrollment.course_release_id, episodeId: c.enrollment.current_episode_id };
    const role = row.event_type === 'companion.requested' ? 'companion' : row.event_type==='research.requested'?'research':row.event_type==='rubric.assist_requested'?'reviewer':'supervisor';
    outcome.role = role;
    if (role === 'reviewer') {
      // Only a staff request, or the host's own proposal for a gate conversation, for a learner
      // who opted in; the answer stays unchanged since.
      const requestId = (row.event_payload as { requestId?: string } | null)?.requestId;
      requireCondition((row.actor_kind === 'staff' || row.actor_kind === 'system') && uuid.safeParse(requestId).success, 'RUBRIC_ASSIST_NOT_ACTIVATED', 409);
      const resolved = await resolveRubricAssistWithin(client, row.enrollment_id, row.workspace_id, requestId!);
      requireCondition((row.actor_kind === 'staff') === (resolved.origin === 'staff'), 'RUBRIC_ASSIST_NOT_ACTIVATED', 409);
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
    // A teaching action Core started from the trigger table (teaching-actions.ts): its own job.
    let action: ActionRow | null = null;
    if (row.event_type === ACTION_EVENT) {
      requireCondition(row.actor_kind === 'system', 'TEACHING_ACTION_NOT_STARTED', 409);
      action = await actionForEvent(client, row.enrollment_id, row.workspace_id, row.event_payload, row.event_id);
    }
    const binding=await options.providerBinding?.(client,row.workspace_id);
    // Configuration binding can wait for an operator transaction. Recheck
    // wall-clock deadlines after that serialization wait, before admission.
    c.nowMs=await clock(client);
    const check = policyCheck(c, 'admit_job', role);
    // A stop consumes the event for good; a pause that raced this claim admits a job that holds.
    let disposition = row.actor_kind === 'agent' ? 'agent_event' : c.supervision === 'stopped' ? 'supervision_stopped'
      : armWithholds(c, role) ? 'study_arm' : !enrollmentActive(c, role) ? 'inactive' : !check.allowed ? 'policy_denied' : 'prepared';
    const jobs: RunRef[] = [];
    // Noisy learning events coalesce into a supervisor job that has not started its call yet:
    // A staff retry of one run (scoped-corrections.ts) always gets its own new run.
    // it reads its context when the call starts, so it sees this event too. Explicit requests
    // (companion questions, research, written-answer assistance) are never coalesced.
    let coalescedInto: string | null = null;
    if (disposition === 'prepared' && role === 'supervisor' && row.event_type !== RETRY_EVENT && !action) {
      coalescedInto = (await client.query<{ id: string }>(`SELECT id FROM supervisor_jobs WHERE enrollment_id=$1 AND workspace_id=$2 AND role='supervisor'
        AND state='queued' AND NOT (runtime_snapshot->'operations' @> '[{"status":"succeeded"}]')
        ORDER BY created_at DESC,id LIMIT 1`, [row.enrollment_id, row.workspace_id])).rows[0]?.id ?? null;
      if (coalescedInto) disposition = 'coalesced';
    }
    if (disposition === 'prepared') {
      const policy=binding?.jobPolicy;
      const admission=policy?{allowance:binding?.roleAllowances?.[role]??policy.allowance,durationMs:policy.durationMs,timeoutMs:policy.timeoutMs,maxAttempts:policy.maxAttempts}:config;
      const ref = { jobId: randomUUID(), workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: 1 };
      // An action that builds new material gets a planner, concurrent alternative builders and an
      // evaluator that commits (design §4), when the workspace lets the supervisor apply changes.
      const team = action !== null && ALTERNATIVE_ACTIONS.has(action.action) && DEFAULT_ACTION_POLICY.alternativeBuilders >= 2
        && (await supervisionSettingsWithin(client, row.workspace_id)).autonomyLevel === 'apply_verified_personal';
      const base = { capability: role, allowance: admission.allowance, timeoutMs: admission.timeoutMs, maxAttempts: admission.maxAttempts };
      const checkpoints = team ? [
        { ...base, id: 'plan', inputRef: randomUUID(), phase: 'analyze' as const, logicalRole: 'planner' as const },
        ...Array.from({ length: Math.min(3, DEFAULT_ACTION_POLICY.alternativeBuilders) }, (_, i) => ({ ...base, id: `build-${String.fromCharCode(97 + i)}`,
          inputRef: randomUUID(), phase: 'build' as const, logicalRole: 'builder' as const, group: 'build' })),
        { ...base, id: 'evaluate', inputRef: randomUUID(), phase: 'evaluate' as const, logicalRole: 'evaluator' as const },
      ] : [{ ...base, id: 'generate', inputRef: randomUUID(), ...(PHASE[role] ? { phase: PHASE[role] } : {}) }];
      const objective = await jobObjective(client, action, c, row.event_id, context.episodeId);
      const spec = jobSpecSchema.parse({ schemaVersion: 1, key: { jobId: ref.jobId, workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId },
        inputEventId: row.event_id, role, fence: c.fence, checkpoints,
        // A closed-course answer is read-only: the course deadline that closed it (already
        // past for a capped course) governs work, not reading, so only the job duration bounds it.
        budget: { microUsd: admission.allowance.microUsd * checkpoints.length, tokens: admission.allowance.tokens * checkpoints.length },
        deadlineAtMs: Math.min(c.nowMs + admission.durationMs * (team ? 2 : 1),
          check.snapshot.effectiveDeadline && !closedCourseCompanion(c, role) ? Date.parse(check.snapshot.effectiveDeadline) : Infinity),
        objective });
      const snapshot = createJob(spec);
      await client.query(`INSERT INTO supervisor_jobs (id,enrollment_id,workspace_id,workflow_id,role,state,input_event_id,expected_revision,specification,runtime_snapshot,provider_revision,trace_id,objective)
        VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11,$12)`, [ref.jobId, ref.enrollmentId, ref.workspaceId, workflowId(ref), role, row.event_id, c.fence.enrollmentRevision, JSON.stringify(spec), JSON.stringify(snapshot),binding?.revision??null,telemetry().traceId(),
          JSON.stringify(objective)]);
      for (const cp of spec.checkpoints)
        await client.query(`INSERT INTO supervisor_inputs (id,job_id,enrollment_id,workspace_id,checkpoint_id,fence,context) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cp.inputRef, ref.jobId, ref.enrollmentId, ref.workspaceId, cp.id, JSON.stringify(c.fence),
            JSON.stringify(cp.logicalRole ? { ...context, task: { logicalRole: cp.logicalRole, ...(cp.logicalRole === 'builder' ? { alternative: cp.id } : {}) } } : context)]);
      if (action) await client.query('UPDATE teaching_actions SET job_id=$2,updated_at=clock_timestamp() WHERE id=$1', [action.id, ref.jobId]);
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
    outcome.disposition = disposition;
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
      const command = jobCommandSchema.parse(raw); authorize(command.ref.workspaceId);
      return afterCommitTransaction(db, client => transitionWithin(client, command, options));
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
      const outcome: PreparationOutcome = {};
      const jobs = await transaction(db, async client => {
        const row = await leased(client, parsed.eventId, parsed.leaseToken);
        requireCondition(row.enrollment_id === parsed.payload.enrollmentId, 'SUPERVISOR_SCOPE_MISMATCH', 409);
        const previous = (await client.query<{ jobs: RunRef[] }>('SELECT jobs FROM supervisor_preparations WHERE event_id=$1', [row.event_id])).rows[0];
        if (previous) return preparedSchema.parse(previous).jobs;
        outcome.lagSeconds = row.lag_seconds;
        // A permanent refusal (a state conflict: consent changed, request withdrawn or already
        // linked, invalid context; or a definite client error: not found, gone, invalid) can never
        // succeed on a retry: undo this attempt's writes, consume the event with the refusal's code
        // and record it. Anything else (storage, configuration) stays retryable.
        await client.query('SAVEPOINT supervisor_prepare');
        try {
          const jobs = await prepareLeased(client, row, outcome);
          await client.query('RELEASE SAVEPOINT supervisor_prepare');
          return jobs;
        } catch (error) {
          if (!definiteRefusal(error)) throw error;
          await client.query('ROLLBACK TO SAVEPOINT supervisor_prepare');
          await refusePreparation(client, row, error.code);
          outcome.disposition = 'refused';
          return [];
        }
      });
      // Committed: the first preparation of this event. A repeat delivery records nothing.
      observePreparation(outcome);
      return jobs;
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
    // Cross-course coordination (cross-course.ts): the host decides from stored opt-ins and mappings.
    claimCrossCourse(ownerId, limit, leaseMs) {
      rpcRequestSchema.parse({ method: 'crosscourse.claim', ownerId, limit, leaseMs });
      return claimCrossCourseWakeups(db, config.workspaces, ownerId, limit, leaseMs);
    },
    ackCrossCourse(delivery, delivered) {
      return ackCrossCourseWakeup(db, config.workspaces, delivery.wakeupId, delivery.leaseToken, delivered);
    },
    crossCourseConsent(learnerId) { return crossCourseConsentFor(db, config.workspaces, learnerId); },
    planCrossCourse(learnerId, consentRevision) { return planCrossCourse(db, config.workspaces, learnerId, consentRevision); },
    observeEnrollment(workspaceId, enrollmentId) { return observeCrossCourseEnrollment(db, config.workspaces, workspaceId, enrollmentId); },
    async reconcile(limit) {
      rpcRequestSchema.parse({ method: 'reconcile', limit });
      // 0. Receipts an older gateway left uncertain although the provider had answered in full with
      //    known usage and only the adapter's output checks refused the reply (for example a reply
      //    cut off at the output limit). They become the definite, priced refusal the gateway now
      //    records (output-refusal.ts), so step 1 settles them like any finished receipt.
      await repairRefusedAnswers(db, config.workspaces, limit);
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
/**
 * Rewrites gateway receipts that recorded a refused but completed reply as uncertain (Core before
 * 0.1.53) into the outcome the gateway records now: an output refusal artifact (reason code only),
 * charged at the reported usage times the price version in force when the call started, or at the
 * reservation when the call was unpriced. Only companion and supervisor jobs whose operation is
 * still uncertain under the same owner qualify. Each row changes at most once (guarded update);
 * a row that cannot be repaired is left for staff, never guessed.
 */
async function repairRefusedAnswers(db: Database, workspaces: readonly string[], limit: number) {
  const rows = (await db.query<{ operation_id: string; owner_id: string; job_id: string; enrollment_id: string; workspace_id: string; role: string; generation: number;
    failure_code: string | null; provider_usage: unknown; model_id: string | null; started_at: Date; reservation: { microUsd: number; tokens: number } | null }>(
    `SELECT d.operation_id,d.owner_id,d.job_id,d.enrollment_id,d.workspace_id,j.role,(j.runtime_snapshot->>'generation')::integer AS generation,
       d.failure_code,d.provider_usage,d.model_id,d.started_at,
       (SELECT o->'reservation' FROM jsonb_array_elements(j.runtime_snapshot->'operations') o WHERE o->>'id'=d.operation_id LIMIT 1) AS reservation
     FROM provider_dispatches d JOIN supervisor_jobs j ON j.id=d.job_id AND j.enrollment_id=d.enrollment_id AND j.workspace_id=d.workspace_id
     WHERE d.workspace_id=ANY($1::uuid[]) AND d.state='uncertain' AND d.outcome->>'status'='uncertain' AND d.finished_at IS NOT NULL
       AND d.failure_code IN ('INCOMPLETE_OUTPUT','INVALID_RESPONSE','BLOCKED') AND d.provider_usage IS NOT NULL AND j.role IN ('companion','supervisor')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.runtime_snapshot->'operations') o
         WHERE o->>'id'=d.operation_id AND o->>'status'='uncertain' AND o->>'ownerId'=d.owner_id::text)
     ORDER BY d.finished_at,d.operation_id LIMIT $2`, [workspaces, limit])).rows;
  let repaired = 0;
  for (const row of rows) {
    const reason = refusedAnswerReason(row.failure_code, row.provider_usage);
    if (!reason || !row.reservation) continue;
    try {
      const receipt = row.provider_usage as UsageReceipt;
      const tokens = receipt.attempts.reduce((sum, attempt) => sum + attempt.tokens.total!, 0);
      const pricing = row.model_id ? await pricingAt(db, row.workspace_id, row.model_id, row.started_at) : null;
      const priced = pricing ? priceUsage(receipt, pricing).cost : null;
      const charge = priced && priced.microUsd <= 1_000_000_000 ? priced : null;
      const ref = { jobId: row.job_id, workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: row.generation };
      const artifact = await storeSupervisorArtifact(db, ref, row.operation_id, row.owner_id, { kind: 'output_refusal', role: row.role === 'companion' ? 'companion' : 'supervisor', reason });
      const outcome = outcomeSchema.parse({ status: 'succeeded', artifact, usage: { microUsd: charge ? charge.microUsd : row.reservation.microUsd, tokens },
        usageBasis: { microUsd: charge ? 'reported' : 'reserved_ceiling', tokens: 'reported' } });
      const updated = await db.query(`UPDATE provider_dispatches SET state='completed',outcome=$3,provider_usage=$4,pricing_version_id=$5,cost_micro_usd=$6
        WHERE operation_id=$1 AND owner_id=$2 AND state='uncertain' AND outcome->>'status'='uncertain'`,
        [row.operation_id, row.owner_id, JSON.stringify(outcome), JSON.stringify({ ...receipt, cost: charge }), charge?.pricingVersionId ?? null, charge?.microUsd ?? null]);
      if (updated.rowCount === 1) repaired++;
    } catch { /* Fenced, erased or changed meanwhile: left for staff review, never guessed. */ }
  }
  return repaired;
}
/** One host transition inside the caller's transaction: every lock, fence and budget check of the
 * bridge's `transition`, for trusted host paths that already hold a transaction (follow-up and
 * authority parking, application of a delivered teaching action). */
export async function transitionWithin(client: PoolClient, raw: Command, options: Pick<SupervisorBridgeOptions, 'applyPlan' | 'confirmRubricSuggestion'> = {}) {
  const command = jobCommandSchema.parse(raw), ref = command.ref;
  const locked = await lockedJob(client, ref), old = locked.snapshot;
  const budgets = await lockBudgetCeilings(client, ref, locked.episodeId), availableBudget = budgets.available;
  // Read wall clock AFTER waiting for all serialization locks.
  locked.current.nowMs = await clock(client);
  const role = old.specification.role;
  const check = policyCheck(locked.current, command.type === 'apply' ? 'publish' : 'tool_call', role);
  const host: HostContext = { nowMs: locked.current.nowMs, currentFence: locked.current.fence,
    enrollmentActive: enrollmentActive(locked.current, role) && check.allowed,
    // A job whose role the enrollment's study arm withholds ends as cancelled at this transition.
    cancellationRequested: locked.cancelled || armWithholds(locked.current, role), availableBudget, supervision: locked.current.supervision };
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
    await applyVerified(client, ref, old, verified!, result.snapshot.applicationReceiptId!,options);
  }
  await save(client, old, result.snapshot, budgets.binding);
  if (result.effect === 'invoke' || result.snapshot.state === 'applied' && old.state !== 'applied') {
    // A slow database write must not commit an expired permit/application. Roll back all effects.
    requireCondition(await clock(client) < old.specification.deadlineAtMs, 'SUPERVISOR_DEADLINE_REACHED', 409);
  }
  return transitionSchema.parse(result);
}
/** Moves a non-terminal job with no open call to its next generation (or returns the generation
 * already waiting for its workflow). The previous generation's workflow has closed: it returned
 * when the job waited, parked or became uncertain. Terminal jobs never resume. */
async function resumeWithin(client: PoolClient, raw: RunRef, options: { rebase?: boolean } = {}): Promise<RunRef | null> {
  const row = (await client.query<{ generation: number; resume_requested_at: Date | null }>(
    "SELECT (runtime_snapshot->>'generation')::integer AS generation,resume_requested_at FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3",
    [raw.jobId, raw.enrollmentId, raw.workspaceId])).rows[0];
  if (!row) return null;
  const locked = await lockedJob(client, { ...raw, generation: row.generation }), old = locked.snapshot;
  const ref = { ...raw, generation: old.generation };
  if (row.resume_requested_at && old.state === 'queued') return ref; // Started before, never loaded: start again (idempotent by workflow id).
  if (!resumable(old) || locked.cancelled || !['waiting', 'running', 'needs_input', 'follow_up_due', 'budget_wait', 'verifying'].includes(old.state)) return null;
  if (old.state === 'follow_up_due' && (old.dueAtMs ?? Infinity) > locked.current.nowMs) return null;
  let base = old;
  if (old.state === 'follow_up_due') {
    const outcome = await followUpDue(client, ref, locked.current);
    if (outcome !== 'run') {
      await transitionWithin(client, { type: 'halt', ref, reason: 'cancel_requested' });
      return null;
    }
  }
  // A follow-up made no call under its old context, and a job whose only output waited for a
  // person's decision has had that decision applied by the person: both continue on today's state.
  if ((old.state === 'follow_up_due' && old.operations.length === 0) || (old.state === 'needs_input' && options.rebase))
  {
    base = refence(old, locked.current.fence, locked.current.nowMs + FOLLOW_UP_RUN_MS, locked.current.nowMs);
    // Its inputs are read under the same fence.
    await client.query('UPDATE supervisor_inputs SET fence=$2 WHERE job_id=$1', [raw.jobId, JSON.stringify(locked.current.fence)]);
  }
  const next = nextGeneration(base), nextRef = { ...raw, generation: next.generation };
  await save(client, old, next);
  await client.query('UPDATE supervisor_jobs SET workflow_id=$2,resume_requested_at=clock_timestamp() WHERE id=$1', [raw.jobId, workflowId(nextRef)]);
  await client.query('UPDATE supervisor_reconciliations SET resumed_generation=$2 WHERE job_id=$1 AND resumed_generation IS NULL', [raw.jobId, next.generation]);
  return nextRef;
}
/** A due follow-up job: whether it still has something to do. Its action's deterministic part
 * (evidence since the delivered change, a novel transfer item) is resolved and stored first. */
async function followUpDue(client: PoolClient, ref: RunRef, c: Current): Promise<'run' | 'ended'> {
  const action = (await client.query<ActionRow>("SELECT * FROM teaching_actions WHERE job_id=$1 AND state='scheduled' FOR UPDATE", [ref.jobId])).rows[0];
  if (!action) return 'run';
  const end = async (reason: string) => { await client.query("UPDATE teaching_actions SET state='ended',end_reason=$2,updated_at=clock_timestamp() WHERE id=$1", [action.id, reason]); return 'ended' as const; };
  // The learner may have turned personal support off, or staff lowered autonomy, since delivery.
  if (!(await automaticHypothesesEnabled(client, ref.enrollmentId, ref.workspaceId, false))) return end('opt_in_revoked');
  if ((await supervisionSettingsWithin(client, ref.workspaceId)).autonomyLevel === 'recommend_only') return end('autonomy_recommend_only');
  const bundle = (await client.query<{ server_bundle: unknown }>('SELECT server_bundle FROM course_releases WHERE id=$1', [c.enrollment.course_release_id])).rows[0]!.server_bundle;
  const resolved = await resolveFollowUp(client, action, bundle as Parameters<typeof resolveFollowUp>[2]);
  if (resolved.settled) return end('already_demonstrated');
  return 'run';
}
/** Parks a job between calls inside the caller's transaction (see parkSupervisorJob). */
export async function parkSupervisorJobWithin(client: PoolClient, ref: RunRef, reason: 'needs_input' | 'follow_up_due', options: { dueAtMs?: number; deadlineAtMs?: number } = {}) {
  return transitionWithin(client, { type: 'park', ref, reason, ...(options.dueAtMs !== undefined ? { dueAtMs: options.dueAtMs } : {}),
    ...(options.deadlineAtMs !== undefined ? { deadlineAtMs: options.deadlineAtMs } : {}) });
}
/** Trusted host hook: park a job between calls until a person answers (`needs_input`: an authority
 * request, supervisor-plan-verifier.ts) or until a scheduled follow-up is due (`follow_up_due`,
 * resumed by the dispatcher's reconcile pass). A wait for a person may extend the deadline. */
export async function parkSupervisorJob(db: Database, ref: RunRef, reason: 'needs_input' | 'follow_up_due', options: { dueAtMs?: number; deadlineAtMs?: number } = {}) {
  return afterCommitTransaction(db, client => parkSupervisorJobWithin(client, ref, reason, options));
}
/** The longest a parked job may wait for a person, bounded by the course's own deadline. */
export async function parkDeadlineWithin(client: PoolClient, ref: Pick<RunRef, 'workspaceId' | 'enrollmentId'>, waitMs: number) {
  const c = await current(client, ref.workspaceId, ref.enrollmentId);
  const deadline = policyCheck(c, 'admit_job').snapshot.effectiveDeadline;
  return Math.min(c.nowMs + Math.min(waitMs, MAX_PARK_MS - 60_000), deadline ? Date.parse(deadline) : Infinity);
}
/** Trusted host hook: a person answered; the parked job restarts in a new generation. With
 * `rebase`, a job waiting for a decision continues on the current revisions (the decision was
 * applied under the decider's own authority, which itself changes them). */
export async function resumeSupervisorJob(db: Database, ref: RunRef, options: { rebase?: boolean } = {}) {
  return afterCommitTransaction(db, client => resumeWithin(client, ref, options));
}
export async function resumeSupervisorJobWithin(client: PoolClient, ref: RunRef, options: { rebase?: boolean } = {}) {
  return resumeWithin(client, ref, options);
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
      noteBridgeContact();
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
      if (body.method === 'crosscourse.claim') return await bridge.claimCrossCourse(body.ownerId, body.limit, body.leaseMs);
      if (body.method === 'crosscourse.ack') return { accepted: await ackCrossCourseWakeup(db, options.workspaceIds ?? [], body.wakeupId, body.leaseToken, body.delivered) };
      if (body.method === 'crosscourse.consent') return await bridge.crossCourseConsent(body.learnerId);
      if (body.method === 'crosscourse.plan') return await bridge.planCrossCourse(body.learnerId, body.consentRevision);
      if (body.method === 'crosscourse.observe') return await bridge.observeEnrollment(body.workspaceId, body.enrollmentId);
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
      await client.query(`INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id,limit_micro_usd,limit_tokens,limit_source) VALUES ($1,$2,$3,$4,'own')
        ON CONFLICT (enrollment_id) DO UPDATE SET limit_micro_usd=EXCLUDED.limit_micro_usd,limit_tokens=EXCLUDED.limit_tokens,limit_source='own'`, [enrollmentId, workspaceId, cap.microUsd, cap.tokens]);
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
  return transaction(db, client => configureSupervisorPeriodBudgetWithin(client, { workspaceId, enrollmentId }, { daily, artifact }));
}
/** configureSupervisorPeriodBudget inside the caller's transaction (the admin route audits in the same one). */
export async function configureSupervisorPeriodBudgetWithin(client: PoolClient, scope: { workspaceId: string; enrollmentId: string },
  limits: { daily: { microUsd: number; tokens: number } | null; artifact: { microUsd: number; tokens: number } | null }) {
  const workspaceId = uuid.parse(scope.workspaceId), enrollmentId = uuid.parse(scope.enrollmentId);
  const daily = limits.daily ? allowanceSchema.parse(limits.daily) : null, artifact = limits.artifact ? allowanceSchema.parse(limits.artifact) : null;
  {
    requireCondition((await client.query('SELECT 1 FROM enrollments WHERE id=$1 AND workspace_id=$2', [enrollmentId, workspaceId])).rowCount, 'SUPERVISOR_NOT_FOUND', 404);
    await client.query(`INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [enrollmentId, workspaceId]);
    await client.query(`UPDATE supervisor_enrollment_budgets SET daily_limit_micro_usd=$3,daily_limit_tokens=$4,artifact_limit_micro_usd=$5,artifact_limit_tokens=$6
      WHERE enrollment_id=$1 AND workspace_id=$2`, [enrollmentId, workspaceId, daily?.microUsd ?? null, daily?.tokens ?? null, artifact?.microUsd ?? null, artifact?.tokens ?? null]);
  }
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
  const staged = await stageLargeArtifact(db, ref, operationId, value);
  try {
    const receipt = await storeArtifactRow(db, ref, operationId, ownerId, value, staged);
    if (staged && !receipt.claimed) await releaseObject(db, staged.id);
    return { artifactId: receipt.artifactId, digest: receipt.digest };
  } catch (error) {
    if (staged) await releaseObject(db, staged.id).catch(() => undefined);
    throw error;
  }
}
/** With an object store configured, an artifact whose canonical JSON exceeds the inline limit is
 * uploaded before the transaction that records it. A supervised plan (and an output refusal) always stays inline: its
 * selection and teaching are matched in SQL against the tool trace (supervision-routes.ts,
 * admin-routes.ts), and the same content is already kept in that trace. */
async function stageLargeArtifact(db: Database, ref: RunRef, operationId: string, value: SupervisorArtifactContent) {
  const store = artifactStore();
  // Refusal records stay inline too: they are small and their reason is read in SQL (companion and run views).
  if (!store || value.kind === 'supervised_plan' || value.kind === 'output_refusal') return null;
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  if (bytes.byteLength <= store.inlineLimitBytes) return null;
  // A replay of an operation already recorded uploads nothing.
  if ((await db.query('SELECT 1 FROM supervisor_artifacts WHERE operation_id=$1', [operationId])).rowCount) return null;
  return stageObject(db, store, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, purpose: 'supervisor_artifact', mediaType: 'application/json', bytes });
}
async function storeArtifactRow(db: Database, ref: RunRef, operationId: string, ownerId: string, value: SupervisorArtifactContent, staged: StagedObject | null) {
  return transaction(db, async client => {
    const { snapshot } = await lockedJob(client, ref), op = snapshot.operations.find(o => o.id === operationId);
    requireCondition(op?.ownerId === ownerId && ['in_flight', 'uncertain', 'succeeded'].includes(op.status), 'SUPERVISOR_OPERATION_MISMATCH', 409);
    requireCondition((snapshot.specification.role === 'companion') === (value.kind === 'companion_message' || (value.kind === 'output_refusal' && value.role === 'companion')), 'SUPERVISOR_ARTIFACT_KIND', 409);
    // A refusal names the role whose output Core refused; it is stored only for that role's job.
    requireCondition(value.kind !== 'output_refusal' || value.role === (snapshot.specification.role === 'companion' ? 'companion' : 'supervisor') && ['companion', 'supervisor'].includes(snapshot.specification.role), 'SUPERVISOR_ARTIFACT_KIND', 409);
    const digest = digestJson(value);
    const old = (await client.query<{ id: string; digest: string; job_id: string; owner_id: string }>('SELECT id,digest,job_id,owner_id FROM supervisor_artifacts WHERE operation_id=$1', [operationId])).rows[0];
    if (old) {
      requireCondition(old.job_id === ref.jobId && old.owner_id === ownerId && old.digest === digest, 'SUPERVISOR_ARTIFACT_CONFLICT', 409);
      return { artifactId: old.id, digest: old.digest, claimed: false };
    }
    const id = randomUUID();
    // The object's SHA-256 is the artifact digest: both hash the same canonical JSON.
    requireCondition(!staged || staged.sha256 === digest, 'SUPERVISOR_ARTIFACT_MISMATCH', 409);
    if (staged) await claimObject(client, staged, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, purpose: 'supervisor_artifact' });
    await client.query(`INSERT INTO supervisor_artifacts (id,job_id,enrollment_id,workspace_id,operation_id,owner_id,digest,content,content_object_id,content_kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, ref.jobId, ref.enrollmentId, ref.workspaceId, operationId, ownerId, digest,
      staged ? null : JSON.stringify(value), staged?.id ?? null, staged ? value.kind : null]);
    // The bridge request continues the worker's trace: the artifact digest joins it to the stored row.
    telemetry().annotate({ 'course.artifact.hash': digest });
    return { artifactId: id, digest, claimed: staged !== null };
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
