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
  transition as reduce, transitionSchema, uuid, verificationSchema, workflowId,
  type Command, type Fence, type HostBridge, type HostContext, type JobSpec, type OutboxEvent,
  type RunRef, type Snapshot, type Verification, type ProviderRequest,
} from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { digestJson, policyEpisodeIdFor, type Enrollment } from './repository.js';
import {supervisedPlanSchema,type SupervisedPlan} from './supervisor-tool-loop.js';
import type {SupervisorJobPolicy} from './provider-setup.js';
import { recordSpendEvents, syncSupervisorSpend } from './provider-costs.js';
import { afterCommitTransaction, onCommit } from './after-commit.js';

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
  revision: number; profile_revision: number; policy_revision: number; status: string;
}
interface Current {
  enrollment: EnrollmentRow; fence: Fence; policy: PolicyState; nowMs: number; releaseActive: boolean;
  membershipActive: boolean; scopeEpisodeId?: string | null;
}
async function clock(client: PoolClient) {
  return Number((await client.query<{ ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms")).rows[0]!.ms);
}
// All paths use enrollment -> membership -> release -> policy -> job -> workspace budget -> enrollment budget.
async function current(client: PoolClient, workspaceId: string, enrollmentId: string): Promise<Current> {
  const enrollment = (await client.query<EnrollmentRow>('SELECT * FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [enrollmentId, workspaceId])).rows[0];
  requireCondition(enrollment, 'SUPERVISOR_NOT_FOUND', 404);
  // Existence is active membership in the current schema. Hold a share lock so removal and
  // authorization serialize. Do not throw here: receipts for already dispatched work must settle.
  const membership = await client.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, enrollment.user_id]);
  const release = (await client.query<{ digest: string; status: string }>('SELECT digest,status FROM course_releases WHERE id=$1 AND workspace_id=$2 FOR SHARE', [enrollment.course_release_id, workspaceId])).rows[0];
  const policy = (await client.query<{ policy_revision: number; ledger_revision: number; snapshot: PolicyState }>('SELECT policy_revision,ledger_revision,snapshot FROM policy_states WHERE enrollment_id=$1 FOR UPDATE', [enrollmentId])).rows[0];
  requireCondition(release && policy, 'SUPERVISOR_STATE_MISSING', 409);
  requireCondition(policy.policy_revision === enrollment.policy_revision && policy.snapshot.policyRevision === policy.policy_revision
    && policy.snapshot.ledgerRevision === policy.ledger_revision && policy.snapshot.enrollmentId === enrollmentId, 'SUPERVISOR_POLICY_INCONSISTENT', 409);
  return { enrollment, membershipActive: membership.rowCount === 1, releaseActive: release.status === 'published', policy: policy.snapshot, nowMs: await clock(client),
    fence: fenceSchema.parse({ enrollmentRevision: enrollment.revision, profileRevision: enrollment.profile_revision,
      policyRevision: policy.policy_revision, ledgerRevision: policy.ledger_revision, courseDigest: release.digest }) };
}
/** After completion only the companion may answer bounded explanatory questions,
 * and only while the course policy keeps existing material readable. Planning,
 * research and adaptation never resume on a completed enrollment. */
function closedCourseCompanion(c: Current, role?: string) {
  return role === 'companion' && c.enrollment.status === 'completed' && c.membershipActive && c.releaseActive;
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
interface Locked { snapshot: Snapshot; cancelled: boolean; current: Current }
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
  return { snapshot, cancelled: row.cancellation_requested, current: c };
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
  return { allowed: active && check.allowed, active, violations: check.violations.map(v => v.code), nowMs: c.nowMs,
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
  await client.query('INSERT INTO supervisor_workspace_budgets (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [ref.workspaceId]);
  const workspace = (await client.query<BudgetRow>('SELECT * FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE', [ref.workspaceId])).rows[0]!;
  await client.query('INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ref.enrollmentId, ref.workspaceId]);
  const enrollment = (await client.query<BudgetRow>('SELECT * FROM supervisor_enrollment_budgets WHERE enrollment_id=$1 AND workspace_id=$2 FOR UPDATE', [ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(enrollment, 'SUPERVISOR_SCOPE_MISMATCH', 409);
  return { microUsd: Math.max(0, Math.min(Number(workspace.limit_micro_usd) - Number(workspace.used_micro_usd), Number(enrollment.limit_micro_usd) - Number(enrollment.used_micro_usd))),
    tokens: Math.max(0, Math.min(Number(workspace.limit_tokens) - Number(workspace.used_tokens), Number(enrollment.limit_tokens) - Number(enrollment.used_tokens))) };
}
async function save(client: PoolClient, old: Snapshot, next: Snapshot) {
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
    [key.jobId, JSON.stringify(next), next.state, JSON.stringify({ reason: next.reason, applicationReceiptId: next.applicationReceiptId }), key.workspaceId, key.enrollmentId, old.version]);
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
    await client.query(`INSERT INTO companion_messages (id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,$4,$5)`,
      [targetId, ref.enrollmentId, a.content.text, JSON.stringify({ verificationReceiptId: verified.receipt.receiptId, artifactId: a.id }), ref.jobId]);
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
    if(a.content.kind==='supervised_plan'&&(a.content.selection||a.content.modelSuggestion||a.content.generatedTeaching||a.content.researchSelections?.length)){requireCondition(applyPlan,'SUPERVISOR_APPLICATION_UNSUPPORTED',409);await applyPlan(client,ref,a.content);}
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

export function createPostgresSupervisorBridge(db: Database, options: SupervisorBridgeOptions): HostBridge {
  const config = settings(options);
  const authorize = (workspaceId: string) => requireCondition(config.workspaces.includes(workspaceId), 'SUPERVISOR_FORBIDDEN', 403);
  async function leased(client: PoolClient, eventId: string, leaseToken: string) {
    const row = (await client.query<{ event_id: string; kind: string; payload: unknown; attempts: number; lease_token: string; workspace_id: string; enrollment_id: string; actor_kind: string; event_type: string; event_payload: unknown }>(
      `SELECT o.*,e.workspace_id,e.enrollment_id,e.actor_kind,e.event_type,e.payload AS event_payload FROM outbox o JOIN learning_events e ON e.id=o.event_id
       WHERE o.event_id=$1 AND o.lease_token=$2 AND o.claimed_until>clock_timestamp() AND o.delivered_at IS NULL AND o.quarantined_at IS NULL
         AND e.workspace_id=ANY($3::uuid[]) AND o.kind='supervisor.event' FOR UPDATE OF o`, [eventId, leaseToken, config.workspaces])).rows[0];
    requireCondition(row, 'SUPERVISOR_LEASE_LOST', 409); return row;
  }
  return {
    async load(raw) {
      const ref = runRefSchema.parse(raw); authorize(ref.workspaceId);
      return transaction(db, async client => (await lockedJob(client, ref)).snapshot);
    },
    async transition(raw) {
      const command = jobCommandSchema.parse(raw), ref = command.ref; authorize(ref.workspaceId);
      return afterCommitTransaction(db, async client => {
        const locked = await lockedJob(client, ref), old = locked.snapshot;
        const availableBudget = await lockBudgets(client, ref);
        // Read wall clock AFTER waiting for all serialization locks.
        locked.current.nowMs = await clock(client);
        const role = old.specification.role;
        const check = policyCheck(locked.current, command.type === 'apply' ? 'publish' : 'tool_call', role);
        const host: HostContext = { nowMs: locked.current.nowMs, currentFence: locked.current.fence,
          enrollmentActive: enrollmentActive(locked.current, role) && check.allowed,
          cancellationRequested: locked.cancelled, availableBudget };
        if (command.type === 'halt' && command.reason === 'cancel_requested') {
          await client.query('UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1', [ref.jobId]); host.cancellationRequested = true;
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
        await save(client, old, result.snapshot);
        if (result.effect === 'invoke' || result.snapshot.state === 'applied' && old.state !== 'applied') {
          // A slow database write must not commit an expired permit/application. Roll back all effects.
          requireCondition(await clock(client) < old.specification.deadlineAtMs, 'SUPERVISOR_DEADLINE_REACHED', 409);
        }
        return transitionSchema.parse(result);
      });
    },
    async claimOutbox(ownerId, limit, leaseMs) {
      rpcRequestSchema.parse({ method: 'outbox.claim', ownerId, limit, leaseMs });
      return transaction(db, async client => {
        const rows = (await client.query<{ event_id: string; payload: unknown; attempts: number; enrollment_id: string }>(
          `SELECT o.event_id,o.payload,o.attempts,e.enrollment_id FROM outbox o JOIN learning_events e ON e.id=o.event_id
           WHERE o.kind='supervisor.event' AND o.delivered_at IS NULL AND o.quarantined_at IS NULL AND o.available_at<=clock_timestamp()
             AND (o.claimed_until IS NULL OR o.claimed_until<=clock_timestamp()) AND e.workspace_id=ANY($1::uuid[])
           ORDER BY o.available_at,o.event_id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, [config.workspaces, limit])).rows;
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
    },
    async prepareOutbox(event) {
      const parsed = outboxEventSchema.parse(event);
      return transaction(db, async client => {
        const row = await leased(client, parsed.eventId, parsed.leaseToken);
        requireCondition(row.enrollment_id === parsed.payload.enrollmentId, 'SUPERVISOR_SCOPE_MISMATCH', 409);
        const previous = (await client.query<{ jobs: RunRef[] }>('SELECT jobs FROM supervisor_preparations WHERE event_id=$1', [row.event_id])).rows[0];
        if (previous) return preparedSchema.parse(previous).jobs;
        const c = await current(client, row.workspace_id, row.enrollment_id);
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
        const disposition = row.actor_kind === 'agent' ? 'agent_event'
          : !enrollmentActive(c, role) ? 'inactive' : !check.allowed ? 'policy_denied' : 'prepared';
        const jobs: RunRef[] = [];
        if (disposition === 'prepared') {
          const policy=binding?.jobPolicy;
          const admission=policy?{allowance:policy.allowance,durationMs:policy.durationMs,timeoutMs:policy.timeoutMs,maxAttempts:policy.maxAttempts}:config;
          const ref = { jobId: randomUUID(), workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: 1 };
          const inputRef = randomUUID();
          const spec = jobSpecSchema.parse({ schemaVersion: 1, key: { jobId: ref.jobId, workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId },
            inputEventId: row.event_id, role, fence: c.fence,
            checkpoints: [{ id: 'generate', capability: role, inputRef, allowance: admission.allowance, timeoutMs: admission.timeoutMs, maxAttempts: admission.maxAttempts }],
            budget: admission.allowance, deadlineAtMs: Math.min(c.nowMs + admission.durationMs, check.snapshot.effectiveDeadline ? Date.parse(check.snapshot.effectiveDeadline) : Infinity) });
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
        await client.query('INSERT INTO supervisor_preparations (event_id,workspace_id,enrollment_id,jobs,disposition) VALUES ($1,$2,$3,$4,$5)',
          [row.event_id, row.workspace_id, row.enrollment_id, JSON.stringify(jobs), disposition]);
        return jobs;
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
  };
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
