import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { gateAssessmentIds } from '@course-core/sdk';
import { appendEvent } from './events.js';
import { requireCondition } from './errors.js';
import { supervisionSettingsWithin } from './supervision-settings.js';
import { supervisionStateWithin } from './supervision-control.js';
import type { Recommendation, TeachingActionKind } from './teaching-triggers.js';
import type { LearnerSuggestion } from './supervisor-tool-loop.js';

/**
 * Teaching actions (design §4 loop and trigger table; requirements B02, B03). The trigger table's
 * reactions become supervisor work that Core itself starts: a contrast case, a change of
 * representation, a prerequisite visit, a transfer check, a worked example, compressing toward
 * advanced material, re-evaluation, or preparing the next review. Each is a durable row plus a
 * supervised learning event that the bridge prepares into a supervisor job naming the action as its
 * objective. When that job's change is delivered, Core schedules a follow-up and a transfer probe as
 * parked jobs (follow_up_due) that the dispatcher's reconcile pass resumes when due.
 *
 * Restraints: only after the learner's course-scoped opt-in (the caller checks it), only when the
 * workspace autonomy level is above recommend_only, never while the enrollment's supervision is
 * stopped or an independent check is open, and within the caps below. Nothing here is evidence.
 */
export const FOLLOW_UP_ACTIONS = ['follow_up', 'transfer_probe'] as const;
export type FollowUpAction = (typeof FOLLOW_UP_ACTIONS)[number];
export type ActionKind = TeachingActionKind | FollowUpAction;
export interface TeachingActionPolicy {
  /** Trigger-started actions per enrollment per UTC day. */
  maxStartedPerDay: number;
  /** Actions whose job has not ended yet. */
  maxOpen: number;
  /** Concurrent alternative builders for actions that build new material (0 or 1 = a single writer). */
  alternativeBuilders: number;
  followUpDelayHours: number;
  transferProbeDelayHours: number;
}
export const DEFAULT_ACTION_POLICY: Readonly<TeachingActionPolicy> = Object.freeze({
  maxStartedPerDay: 4, maxOpen: 2, alternativeBuilders: 2, followUpDelayHours: 24, transferProbeDelayHours: 72,
});
/** Actions that build new material, where alternatives are worth comparing (design §4: concurrent builders). */
export const ALTERNATIVE_ACTIONS: ReadonlySet<string> = new Set(['contrast_case', 'change_representation', 'worked_example']);
/** Actions after whose delivery a transfer probe is worth scheduling: they taught something new. */
const TEACHING_ACTIONS: ReadonlySet<string> = new Set(['contrast_case', 'change_representation', 'visit_prerequisite', 'worked_example']);
export const ACTION_EVENT = 'teaching.action_started';

export interface ActionSkip { action: string; reason: string }
export interface StartedAction { actionId: string; action: TeachingActionKind; objectiveIds: string[]; ruleId: string; eventId: string }

/** Starts the reactions the trigger table recommended, inside the caller's transaction (which holds
 * the hypothesis lock and has checked the learner's opt-in). Returns what started and what was held back. */
export async function startTeachingActions(client: PoolClient, scope: { enrollmentId: string; workspaceId: string },
  recommendations: readonly Recommendation[], state: { independentAssessmentActive: boolean }, policy: TeachingActionPolicy = DEFAULT_ACTION_POLICY) {
  const started: StartedAction[] = [], skipped: ActionSkip[] = [];
  if (!recommendations.length) return { started, skipped };
  const settings = await supervisionSettingsWithin(client, scope.workspaceId);
  const control = await supervisionStateWithin(client, scope.enrollmentId);
  const hold = settings.autonomyLevel === 'recommend_only' ? 'autonomy_recommend_only'
    : control === 'stopped' ? 'supervision_stopped' : state.independentAssessmentActive ? 'independent_assessment_active' : null;
  if (hold) return { started, skipped: recommendations.map(r => ({ action: r.action, reason: hold })) };
  const counts = (await client.query<{ open: number; today: number }>(
    `SELECT count(*) FILTER (WHERE state='started')::int AS open,
       count(*) FILTER (WHERE origin='trigger' AND created_at>=date_trunc('day',clock_timestamp(),'UTC'))::int AS today
     FROM teaching_actions WHERE enrollment_id=$1`, [scope.enrollmentId])).rows[0]!;
  const open = (await client.query<{ action: string; objective_ids: string[] }>(
    "SELECT action,objective_ids FROM teaching_actions WHERE enrollment_id=$1 AND state='started'", [scope.enrollmentId])).rows;
  let openCount = counts.open, today = counts.today;
  for (const recommendation of recommendations) {
    const objectiveIds = [...new Set(recommendation.objectiveIds)].slice(0, 20);
    if (open.some(o => o.action === recommendation.action && o.objective_ids.some(id => objectiveIds.includes(id)))) { skipped.push({ action: recommendation.action, reason: 'already_open' }); continue; }
    if (openCount >= policy.maxOpen) { skipped.push({ action: recommendation.action, reason: 'open_action_cap' }); continue; }
    if (today >= policy.maxStartedPerDay) { skipped.push({ action: recommendation.action, reason: 'daily_action_cap' }); continue; }
    const actionId = randomUUID();
    await client.query(`INSERT INTO teaching_actions(id,enrollment_id,workspace_id,action,objective_ids,rule_id,origin,state)
      VALUES($1,$2,$3,$4,$5,$6,'trigger','started')`, [actionId, scope.enrollmentId, scope.workspaceId, recommendation.action, JSON.stringify(objectiveIds), recommendation.ruleId]);
    // A system event the supervisor bridge prepares into this action's own job.
    const event = await appendEvent(client, { workspaceId: scope.workspaceId, enrollmentId: scope.enrollmentId, actorKind: 'system', type: ACTION_EVENT,
      payload: { actionId, action: recommendation.action, objectiveIds, ruleId: recommendation.ruleId }, idempotencyKey: `teaching-action:${actionId}`, supervise: true });
    await client.query('UPDATE teaching_actions SET event_id=$2 WHERE id=$1', [actionId, event.id]);
    open.push({ action: recommendation.action, objective_ids: objectiveIds });
    openCount++; today++;
    started.push({ actionId, action: recommendation.action, objectiveIds, ruleId: recommendation.ruleId, eventId: event.id });
  }
  return { started, skipped };
}

export interface ActionRow {
  id: string; enrollment_id: string; workspace_id: string; action: ActionKind; objective_ids: string[]; rule_id: string | null;
  origin: 'trigger' | 'follow_up' | 'supervisor'; parent_id: string | null; state: 'started' | 'scheduled' | 'delivered' | 'checked' | 'ended';
  end_reason: string | null; job_id: string | null; event_id: string | null; due_at: Date | null; outcome: Record<string, unknown> | null;
  created_at: Date; updated_at: Date;
}
/** The started action an `teaching.action_started` event names, locked for linking to its job. */
export async function actionForEvent(client: PoolClient, enrollmentId: string, workspaceId: string, payload: unknown, eventId: string) {
  const actionId = (payload as { actionId?: unknown } | null)?.actionId;
  requireCondition(typeof actionId === 'string' && /^[0-9a-f-]{36}$/.test(actionId), 'TEACHING_ACTION_NOT_STARTED', 409);
  const row = (await client.query<ActionRow>(
    "SELECT * FROM teaching_actions WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND event_id=$4 FOR UPDATE", [actionId, enrollmentId, workspaceId, eventId])).rows[0];
  requireCondition(row && row.state === 'started' && row.job_id === null, 'TEACHING_ACTION_NOT_STARTED', 409);
  return row;
}

/** Ends every unfinished action of a job that stopped without delivering its change. */
export async function endActionsOfJob(client: PoolClient, jobId: string, reason: string) {
  await client.query(`UPDATE teaching_actions SET state='ended',end_reason=$2,updated_at=clock_timestamp()
    WHERE job_id=$1 AND state IN ('started','scheduled','checked')`, [jobId, /^[a-z_]{1,60}$/.test(reason) ? reason : 'ended']);
}

/** Marks a job's actions delivered (inside the application transaction) and returns those whose
 * delivery should be followed up: trigger actions only, so follow-ups never chain. */
export async function deliverActionsOfJob(client: PoolClient, jobId: string) {
  return (await client.query<ActionRow>(`UPDATE teaching_actions SET state='delivered',updated_at=clock_timestamp()
    WHERE job_id=$1 AND state IN ('started','checked') RETURNING *`, [jobId])).rows.filter(row => row.origin === 'trigger');
}

/** The follow-ups a delivered action gets: a later check of the same objectives, and for new
 * teaching a transfer probe on a different problem family (design §2 "check independently"). */
export function followUpsFor(row: Pick<ActionRow, 'action'>, policy: TeachingActionPolicy = DEFAULT_ACTION_POLICY) {
  const plans: { action: FollowUpAction; delayMs: number }[] = [{ action: 'follow_up', delayMs: policy.followUpDelayHours * 3_600_000 }];
  if (TEACHING_ACTIONS.has(row.action)) plans.push({ action: 'transfer_probe', delayMs: policy.transferProbeDelayHours * 3_600_000 });
  return plans;
}
export async function insertFollowUp(client: PoolClient, parent: ActionRow, action: FollowUpAction, dueAt: Date, jobId: string) {
  const id = randomUUID();
  await client.query(`INSERT INTO teaching_actions(id,enrollment_id,workspace_id,action,objective_ids,origin,parent_id,state,job_id,due_at)
    VALUES($1,$2,$3,$4,$5,'follow_up',$6,'scheduled',$7,$8)`, [id, parent.enrollment_id, parent.workspace_id, action, JSON.stringify(parent.objective_ids), parent.id, jobId, dueAt]);
  return id;
}

interface BundleAssessment { id: string; type: string; objectiveIds: string[]; familyId?: string; role?: string }
interface Bundle { assessments?: BundleAssessment[]; gates?: unknown[]; placement?: { assessmentIds?: string[] }; retention?: { assessmentIds?: string[] };
  chapters?: { episodes: { id: string; objectiveIds: string[]; blocks?: { type: string; assessmentId?: string }[] }[] }[] }
/** Items whose answers count toward a gate, placement or retention, and their families: a follow-up
 * never sends the learner to one (that would pre-expose evidence items). */
export function protectedItems(bundle: Bundle) {
  const ids = new Set<string>([...(bundle.gates ?? []).flatMap(g => { try { return gateAssessmentIds(g as Parameters<typeof gateAssessmentIds>[0]); } catch { return (g as { assessmentIds?: string[] }).assessmentIds ?? []; } }),
    ...(bundle.placement?.assessmentIds ?? []), ...(bundle.retention?.assessmentIds ?? [])]);
  const families = new Set((bundle.assessments ?? []).filter(a => ids.has(a.id) && a.familyId).map(a => a.familyId!));
  return { ids, families };
}
/** Chooses a novel practice item for a transfer probe: an item of the objective whose problem family
 * the learner has not attempted for it, never an evidence item or its family. Deterministic. */
export function chooseTransferItem(bundle: Bundle, objectiveIds: readonly string[], attemptedFamilies: ReadonlySet<string>, attemptedItems: ReadonlySet<string>) {
  const guarded = protectedItems(bundle);
  const candidates = (bundle.assessments ?? []).filter(a => a.objectiveIds.some(o => objectiveIds.includes(o))
    && !guarded.ids.has(a.id) && !(a.familyId && guarded.families.has(a.familyId)) && ['choice', 'numeric', 'code', 'text'].includes(a.type)
    && !attemptedItems.has(a.id) && !(a.familyId && attemptedFamilies.has(a.familyId)))
    // Items the author marked as transfer items come first (SDK 0.5 assessment role).
    .sort((a, b) => Number(b.role === 'transfer') - Number(a.role === 'transfer') || a.id.localeCompare(b.id));
  const item = candidates[0];
  if (!item) return null;
  const episode = (bundle.chapters ?? []).flatMap(c => c.episodes).find(e => e.blocks?.some(b => b.type === 'assessment' && b.assessmentId === item.id));
  return { assessmentId: item.id, episodeId: episode?.id ?? null, familyId: item.familyId ?? null };
}

/** The deterministic part of a follow-up, read when its job resumes: did independent evidence on the
 * objectives follow the delivered change, and (for a transfer probe) which new problem to offer.
 * Stored on the action; the supervisor sees it as its task, the learner sees the offered problem. */
export async function resolveFollowUp(client: PoolClient, action: ActionRow, bundle: Bundle) {
  const parent = action.parent_id ? (await client.query<ActionRow>('SELECT * FROM teaching_actions WHERE id=$1', [action.parent_id])).rows[0] : undefined;
  const since = parent?.updated_at ?? action.created_at;
  const evidence = (await client.query<{ objective_id: string; passed: boolean; family_id: string | null; assessment_id: string }>(
    `SELECT e.objective_id,(e.result->>'passed')='true' AS passed,a.family_id,a.assessment_id FROM evidence e
     JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
     WHERE e.enrollment_id=$1 AND e.objective_id=ANY($2::text[]) AND e.invalidated_at IS NULL AND e.independent AND e.created_at>$3`,
    [action.enrollment_id, action.objective_ids, since])).rows;
  const objectives = action.objective_ids.map(objectiveId => {
    const rows = evidence.filter(r => r.objective_id === objectiveId);
    return { objectiveId, result: rows.some(r => r.passed) ? 'demonstrated' : rows.length ? 'not_yet' : 'no_attempt' };
  });
  const outcome: Record<string, unknown> = { objectives, since: since.toISOString() };
  if (action.action === 'transfer_probe') {
    const attempted = (await client.query<{ family_id: string | null; assessment_id: string }>(
      'SELECT DISTINCT family_id,assessment_id FROM attempts WHERE enrollment_id=$1', [action.enrollment_id])).rows;
    const item = chooseTransferItem(bundle, action.objective_ids, new Set(attempted.flatMap(a => a.family_id ? [a.family_id] : [])), new Set(attempted.map(a => a.assessment_id)));
    outcome.transferItem = item ?? { unavailable: 'no_novel_item' };
  }
  // Nothing left to do: every objective was demonstrated independently after the change.
  const settled = action.action === 'follow_up' && objectives.every(o => o.result === 'demonstrated');
  await client.query("UPDATE teaching_actions SET state='checked',outcome=$2,updated_at=clock_timestamp() WHERE id=$1", [action.id, JSON.stringify(outcome)]);
  return { outcome, settled };
}

/** Applies a verified plan's learner suggestions (N01): each becomes a delivered action the learner
 * sees, naming the practice problem or course visual and where to find it. Never evidence. */
export async function applySuggestionsWithin(client: PoolClient, ref: { jobId: string; enrollmentId: string; workspaceId: string }, suggestions: readonly LearnerSuggestion[]) {
  const ids: string[] = [];
  for (const s of suggestions) {
    const id = randomUUID();
    const outcome = s.kind === 'practice_check' ? { transferItem: { assessmentId: s.assessmentId, episodeId: s.episodeId } } : { visual: { visualId: s.visualId, episodeId: s.episodeId } };
    await client.query(`INSERT INTO teaching_actions(id,enrollment_id,workspace_id,action,objective_ids,origin,state,job_id,outcome) VALUES($1,$2,$3,$4,$5,'supervisor','delivered',$6,$7)`,
      [id, ref.enrollmentId, ref.workspaceId, s.kind === 'practice_check' ? 'transfer_check' : 'change_representation', JSON.stringify([s.objectiveId]), ref.jobId, JSON.stringify(outcome)]);
    ids.push(id);
  }
  return { kind: 'learner_suggestions', actionIds: ids };
}
/** Plain projection for the learner and staff: codes and identifiers only. */
export function actionView(row: ActionRow) {
  const transfer = (row.outcome as { transferItem?: { assessmentId?: string; episodeId?: string | null } } | null)?.transferItem;
  const visual = (row.outcome as { visual?: { visualId: string; episodeId: string | null } } | null)?.visual;
  return { actionId: row.id, action: row.action, objectiveIds: row.objective_ids, ruleId: row.rule_id, origin: row.origin, parentId: row.parent_id,
    state: row.state, endReason: row.end_reason, jobId: row.job_id, dueAt: row.due_at?.toISOString() ?? null,
    followUp: row.outcome ? { objectives: (row.outcome as { objectives?: unknown }).objectives ?? [],
      ...(transfer?.assessmentId ? { transferItem: { assessmentId: transfer.assessmentId, episodeId: transfer.episodeId ?? null } } : {}),
      ...(visual ? { visual } : {}) } : null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), countsAsEvidence: false as const };
}
export async function listTeachingActions(client: Pick<PoolClient, 'query'>, enrollmentId: string, limit = 50) {
  return (await client.query<ActionRow>('SELECT * FROM teaching_actions WHERE enrollment_id=$1 ORDER BY created_at DESC,id LIMIT $2', [enrollmentId, Math.min(100, limit)])).rows.map(actionView);
}
export async function eraseTeachingActions(run: (label: string, sql: string) => Promise<void>) {
  // Codes and identifiers only; the outcome names items and objectives, which erasure keeps like other ids.
  await run('teachingActions', "UPDATE teaching_actions SET state=CASE WHEN state IN ('started','scheduled','checked') THEN 'ended' ELSE state END,end_reason=CASE WHEN state IN ('started','scheduled','checked') THEN 'data_erasure' ELSE end_reason END WHERE enrollment_id=$1");
  await run('supervisorAuthorityRequests', "UPDATE supervisor_authority_requests SET proposal='{\"erased\":true}'::jsonb,previous=CASE WHEN previous IS NULL THEN NULL ELSE '{\"erased\":true}'::jsonb END,state=CASE WHEN state='pending' THEN 'expired' ELSE state END,decided_at=COALESCE(decided_at,clock_timestamp()) WHERE enrollment_id=$1");
}
