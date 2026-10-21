import { randomUUID } from 'node:crypto';
import { armOffersRole, studyArmWithin } from './study.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { CourseManifest, GateDecision, NextAction } from '@course-core/sdk';
import { checkActions, type PolicyState } from '@course-core/policy';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { ApiError, requireCondition } from './errors.js';
import { digestJson, loadEnrollment, loadEnrollmentRecords, policyEpisodeId, type Enrollment, type EnrollmentContext } from './repository.js';
import { episodes, gateDecision, learningSnapshot } from './learning.js';
import { loadPolicy } from './policy-adapter.js';
import { gateItemIds, withoutMessages, type ComputedDecision, type DecisionMessages, type Gate } from './gates.js';

/** The persisted record in the SDK GateDecision record shape. */
export type DecisionRecord = GateDecision;
export interface DecisionRow {
  id: string; enrollment_id: string; gate_id: string; gate_version: string; course_digest: string; policy_revision: number; status: GateDecision['status'];
  criterion_results: GateDecision['criterionResults']; missing_objective_ids: string[]; unresolved_misconception_ids: string[]; evidence_refs: string[];
  evaluator: GateDecision['evaluator']; learner_visible_reason: string; messages: DecisionMessages | null; next_actions: NextAction[]; next_activity_id: string | null;
  inputs_digest: string; supersedes: string | null; superseded_at: Date | null; decided_at: Date;
}
export function decisionRecord(row: DecisionRow): DecisionRecord {
  return { decisionId: row.id, enrollmentId: row.enrollment_id, gateId: row.gate_id, gateVersion: row.gate_version, courseDigest: row.course_digest,
    policyRevision: row.policy_revision, status: row.status, criterionResults: row.criterion_results, missingObjectiveIds: row.missing_objective_ids,
    unresolvedMisconceptionIds: row.unresolved_misconception_ids, evidenceRefs: row.evidence_refs, evaluator: row.evaluator,
    learnerVisibleReason: row.learner_visible_reason, nextActions: row.next_actions, nextActivityId: row.next_activity_id,
    decidedAt: row.decided_at.toISOString(), supersedes: row.supersedes };
}
/** What the decision binds: everything Core computed from evidence, versions and policy. The
 * translation codes restate the English text, so they are left out and never supersede a record. */
export const decisionInputsDigest = (computed: ComputedDecision) => digestJson(withoutMessages(computed));
const criterionRecords = (computed: ComputedDecision) => computed.criterionResults.map(({ criterionId, met, evidenceRefs, reason }) => ({ criterionId, met, evidenceRefs, reason }));

/** True when the applicable cap or deadline denies further submissions for the episode. */
export function capChecker(policy: PolicyState, context: EnrollmentContext, now = new Date().toISOString()) {
  const course = context.release.server_bundle, gated = episodes(course).filter(e => e.gateId);
  const results = checkActions(policy, gated.map(e => ({ scopeId: `episode:${policyEpisodeId(context.release, e.id)}`, kind: 'submit' as const, now, expectedPolicyRevision: policy.policyRevision })));
  const capped = new Map(gated.map((e, i) => [e.id, policy.status === 'closed' || results[i]!.violations.some(v => v.code === 'DEADLINE_REACHED')]));
  return (episodeId: string) => capped.get(episodeId) ?? false;
}
export async function decisionContext(client: PoolClient, context: EnrollmentContext) {
  const policy = await loadPolicy(client, context.enrollment.id);
  // A study arm without the companion: decisions must not offer help through it.
  const arm = await studyArmWithin(client, context.enrollment.id);
  return { ...(context.signals ? { signals: context.signals } : {}), policyRevision: policy.policyRevision, capReached: capChecker(policy, context),
    ...(arm && !armOffersRole(arm.behaviour, 'companion') ? { companionAvailable: false } : {}) };
}
/** The learner snapshot with every gate's current status and next actions, and the ID of the
 * persisted decision when it still matches what Core computes now. */
export async function gateLearningSnapshot(client: PoolClient, context: EnrollmentContext) {
  const options = await decisionContext(client, context);
  const snapshot = learningSnapshot(context.release.server_bundle, context.release.digest, context.progress, context.evidence, options);
  const current = new Map((await client.query<{ gate_id: string; id: string; inputs_digest: string }>(
    'SELECT gate_id,id,inputs_digest FROM gate_decisions WHERE enrollment_id=$1 AND superseded_at IS NULL', [context.enrollment.id])).rows.map(r => [r.gate_id, r]));
  const reviews = await latestReviews(client, context.enrollment.id);
  return { ...snapshot, lessons: snapshot.lessons.map(lesson => {
    if (!lesson.gate) return { ...lesson, gate: null };
    const persisted = current.get(lesson.gate.gateId), review = reviews.get(lesson.gate.gateId) ?? null;
    // A granted exception is shown beside the decision; it never changes the decision's status.
    const exception = review?.state === 'exception_granted' && review.exceptionCourseDigest === lesson.gate.courseDigest && review.exceptionGateVersion === lesson.gate.gateVersion
      ? { requestId: review.requestId, grantedAt: review.decidedAt } : null;
    return { ...lesson, gate: { ...lesson.gate, decisionId: persisted?.inputs_digest === decisionInputsDigest(lesson.gate) ? persisted.id : null,
      review: review && { requestId: review.requestId, state: review.state, reviewerNote: review.reviewerNote, requestedAt: review.requestedAt, decidedAt: review.decidedAt }, exception } };
  }) };
}

/** The learner's latest review request per gate, as the lesson shows it. */
export interface GateReviewView { requestId: string; state: 'open' | 'upheld' | 'exception_granted'; reviewerNote: string | null; requestedAt: string; decidedAt: string | null;
  exceptionCourseDigest: string | null; exceptionGateVersion: string | null }
export async function latestReviews(client: PoolClient, enrollmentId: string) {
  const rows = (await client.query<{ gate_id: string; id: string; state: GateReviewView['state']; reviewer_note: string | null; created_at: Date; decided_at: Date | null; exception_course_digest: string | null; exception_gate_version: string | null }>(
    `SELECT DISTINCT ON (gate_id) gate_id,id,state,reviewer_note,created_at,decided_at,exception_course_digest,exception_gate_version
       FROM gate_review_requests WHERE enrollment_id=$1 ORDER BY gate_id,created_at DESC,id`, [enrollmentId])).rows;
  return new Map<string, GateReviewView>(rows.map(r => [r.gate_id, { requestId: r.id, state: r.state, reviewerNote: r.reviewer_note, requestedAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null, exceptionCourseDigest: r.exception_course_digest, exceptionGateVersion: r.exception_gate_version }]));
}
/** The staff exception that still lets the learner advance past this gate: granted for the course
 * version and gate version the current decision was made on. */
export async function standingException(client: PoolClient, enrollmentId: string, record: Pick<DecisionRecord, 'gateId' | 'courseDigest' | 'gateVersion'>) {
  return (await client.query<{ id: string }>(`SELECT id FROM gate_review_requests WHERE enrollment_id=$1 AND gate_id=$2 AND state='exception_granted'
    AND exception_course_digest=$3 AND exception_gate_version=$4 ORDER BY decided_at DESC,id LIMIT 1`, [enrollmentId, record.gateId, record.courseDigest, record.gateVersion])).rows[0]?.id ?? null;
}

function gateFor(course: CourseManifest, episodeId: string) {
  const episode = episodes(course).find(e => e.id === episodeId);
  const gate = episode?.gateId ? course.gates.find(g => g.id === episode.gateId) : undefined;
  return { episode, gate };
}
/** Computes the gate decision for an episode now, persisting it when it differs from the current
 * record (which it supersedes). Runs inside the caller's transaction. */
export async function refreshGateDecision(client: PoolClient, context: EnrollmentContext, episodeId: string, options?: { placementOnly?: boolean }) {
  const { gate } = gateFor(context.release.server_bundle, episodeId);
  if (!gate) return null;
  const base = await decisionContext(client, context);
  const computed = gateDecision(context.release.server_bundle, gate, context.evidence, context.release.digest,
    { ...base, capReached: base.capReached(episodeId), ...(options?.placementOnly ? { placementOnly: true } : {}) });
  return { computed, record: await persistDecision(client, context.enrollment, gate, episodeId, computed) };
}
async function persistDecision(client: PoolClient, enrollment: Enrollment, gate: Gate, episodeId: string, computed: ComputedDecision) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gate-decision:${enrollment.id}:${gate.id}`]);
  const digest = decisionInputsDigest(computed);
  const current = (await client.query<DecisionRow>('SELECT * FROM gate_decisions WHERE enrollment_id=$1 AND gate_id=$2 AND superseded_at IS NULL FOR UPDATE', [enrollment.id, gate.id])).rows[0];
  if (current?.inputs_digest === digest) return decisionRecord(current);
  return insertDecision(client, enrollment, gate.id, episodeId, current?.id ?? null, {
    gateVersion: computed.gateVersion, courseDigest: computed.courseDigest, policyRevision: computed.policyRevision, status: computed.status,
    criterionResults: criterionRecords(computed), missingObjectiveIds: computed.missingObjectiveIds, unresolvedMisconceptionIds: computed.unresolvedMisconceptionIds,
    evidenceRefs: computed.evidenceRefs, evaluator: computed.evaluator, learnerVisibleReason: computed.learnerVisibleReason, messages: computed.messages, nextActions: computed.nextActions,
    nextActivityId: computed.nextActivityId, inputsDigest: digest });
}
type DecisionFields = Omit<DecisionRecord, 'decisionId' | 'enrollmentId' | 'gateId' | 'decidedAt' | 'supersedes'> & { inputsDigest: string; messages: DecisionMessages };
/** Supersedes the current record (if any) and inserts the new current decision. */
async function insertDecision(client: PoolClient, enrollment: Enrollment, gateId: string, episodeId: string, supersedes: string | null, d: DecisionFields) {
  if (supersedes) await client.query('UPDATE gate_decisions SET superseded_at=clock_timestamp() WHERE id=$1', [supersedes]);
  const row = (await client.query<DecisionRow>(
    `INSERT INTO gate_decisions(id,enrollment_id,workspace_id,gate_id,gate_version,episode_id,course_digest,policy_revision,status,criterion_results,missing_objective_ids,
       unresolved_misconception_ids,evidence_refs,evaluator,learner_visible_reason,next_actions,next_activity_id,inputs_digest,supersedes,messages)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [randomUUID(), enrollment.id, enrollment.workspace_id, gateId, d.gateVersion, episodeId, d.courseDigest, d.policyRevision, d.status,
      JSON.stringify(d.criterionResults), JSON.stringify(d.missingObjectiveIds), JSON.stringify(d.unresolvedMisconceptionIds),
      JSON.stringify(d.evidenceRefs), JSON.stringify(d.evaluator), d.learnerVisibleReason, JSON.stringify(d.nextActions),
      d.nextActivityId, d.inputsDigest, supersedes, JSON.stringify(d.messages)])).rows[0]!;
  return decisionRecord(row);
}
/** Refreshes the decisions of every gate an item contributes to, after evidence changed. */
export async function refreshDecisionsForItem(client: PoolClient, context: EnrollmentContext, assessmentId: string) {
  const course = context.release.server_bundle;
  for (const episode of episodes(course)) {
    const gate = episode.gateId ? course.gates.find(g => g.id === episode.gateId) : undefined;
    if (gate && gateItemIds(gate).includes(assessmentId)) await refreshGateDecision(client, context, episode.id);
  }
}
/** Same, for an enrollment changed by staff (a review), without a learner actor. */
export async function refreshDecisionsForEnrollment(client: PoolClient, enrollmentId: string, assessmentId: string) {
  const enrollment = (await client.query<Enrollment>('SELECT * FROM enrollments WHERE id=$1', [enrollmentId])).rows[0];
  if (!enrollment || enrollment.status === 'erased') return;
  await refreshDecisionsForItem(client, await loadEnrollmentRecords(client, enrollment), assessmentId);
}

/**
 * The advance check, run inside the complete command. The decision is recomputed from current
 * evidence, gate version and policy revision; a decision the client names must be that current
 * record, so a decision from another tab, revision or enrollment grants nothing.
 */
export async function requireReadyDecision(client: PoolClient, context: EnrollmentContext, episodeId: string, claimedDecisionId: string | undefined) {
  const refreshed = await refreshGateDecision(client, context, episodeId);
  if (!refreshed) return null;
  const { record } = refreshed;
  if (claimedDecisionId && claimedDecisionId !== record.decisionId) {
    const claimed = (await client.query<{ gate_id: string }>('SELECT gate_id FROM gate_decisions WHERE id=$1 AND enrollment_id=$2', [claimedDecisionId, context.enrollment.id])).rows[0];
    if (!claimed || claimed.gate_id !== record.gateId) throw new ApiError(409, 'GATE_DECISION_UNLINKED', 'GATE_DECISION_UNLINKED', { decision: record });
    throw new ApiError(409, 'GATE_DECISION_STALE', 'GATE_DECISION_STALE', { decision: record });
  }
  if (record.status !== 'ready') {
    // An authorized staff exception lets the learner advance; the decision itself stays as computed.
    const exceptionId = await standingException(client, context.enrollment.id, record);
    if (exceptionId) return { ...refreshed, exceptionId };
    const legacy = refreshed.computed.gateVersion.startsWith('legacy');
    // Legacy gates keep their 0.4 error code and missing-objective details.
    throw new ApiError(409, legacy ? 'EVIDENCE_REQUIRED' : 'GATE_NOT_READY', legacy ? 'EVIDENCE_REQUIRED' : 'GATE_NOT_READY', {
      ...(legacy ? { missing: refreshed.computed.objectives.filter(o => !o.passed).map(o => ({ objectiveId: o.id, independentFamilies: o.families.length, requiredFamilies: o.required })) } : {}),
      status: record.status, reason: record.learnerVisibleReason, messages: refreshed.computed.messages, nextActions: record.nextActions, decision: record });
  }
  return { ...refreshed, exceptionId: null as string | null };
}

export function registerGateDecisionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const params = { type: 'object', additionalProperties: false, required: ['enrollmentId', 'gateId'],
    properties: { enrollmentId: { type: 'string', format: 'uuid' }, gateId: { type: 'string', minLength: 1, maxLength: 200 } } };
  /** The current decision for a gate, recomputed and persisted if anything it binds changed. */
  app.get('/api/enrollments/:enrollmentId/gates/:gateId/decision', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, gateId } = request.params as { enrollmentId: string; gateId: string };
    return transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, false, true);
      const episode = episodes(context.release.server_bundle).find(e => e.gateId === gateId);
      requireCondition(episode, 'GATE_NOT_FOUND', 404);
      const refreshed = (await refreshGateDecision(client, context, episode.id))!;
      return { decision: refreshed.record, episodeId: episode.id, messages: refreshed.computed.messages };
    });
  });
  /** Decision history, newest first: what was decided, under which versions, and what replaced it. */
  app.get('/api/enrollments/:enrollmentId/gates/:gateId/decisions', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, gateId } = request.params as { enrollmentId: string; gateId: string };
    return transaction(db, async client => {
      await loadEnrollment(client, actor, enrollmentId, false, true);
      const rows = (await client.query<DecisionRow>('SELECT * FROM gate_decisions WHERE enrollment_id=$1 AND gate_id=$2 ORDER BY decided_at DESC,id LIMIT 50', [enrollmentId, gateId])).rows;
      return { decisions: rows.map(row => ({ ...decisionRecord(row), current: row.superseded_at === null, supersededAt: row.superseded_at?.toISOString() ?? null, messages: row.messages ?? null })) };
    });
  });
}
