import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { CourseManifest, Episode } from '@course-core/sdk';
import { authService, type Actor } from './auth.js';
import { enrollmentRole, workspaceRole } from './course-access.js';
import { transaction, type Database } from './database.js';
import { appendEvent } from './events.js';
import { audienceOf, enrollmentProfileFor, LEARNER_MODEL_WITHHELD_FROM_STAFF, STAFF_READ_ROLES } from './learner-privacy.js';
import { ApiError, requireCondition } from './errors.js';
import { enrollmentCommand, type EnrollmentContext } from './repository.js';
import type { EvidenceRow } from './learning.js';
import { gateFamilies, gateItemIds, gateObjectives } from './gates.js';
import { providerHypotheses } from './teaching-hypotheses.js';
import { USABLE_MESSAGE } from './context-capsule.js';

/**
 * Integration contract (parent registers this module before app.ready()):
 *   registerLearnerModelRoutes(app, db, auth)
 *   GET  /api/enrollments/:enrollmentId/learner-model?episodeId=...&objectiveId=...
 *   POST /.../learner-model/profile {expectedRevision,idempotencyKey,profile}
 *   POST /.../learner-model/proposals/:proposalId/decision
 *        {expectedRevision,idempotencyKey,action:accept|correct|dispute,correction?,reason?}
 *   GET  /.../learner-model/changes?before=<sequence>&limit=1..20
 *   GET  /.../learner-model/history?episodeId=...&objectiveId=...&kind=questions|evidence|all&q=...&before=...&limit=1..20
 * Commands return immutable receipts with the new enrollment/model revision. Reuse
 * a key only for the same intent; replay returns the original receipt. Refresh GET
 * after success or STALE_REVISION. Accept/correct records a reviewed suggestion;
 * it does not silently overwrite manually edited preferences or earned evidence.
 * Dispute excludes that proposal from provider context, retaining all earlier acts.
 * Only the learner reads, edits and reviews their own notes. Workspace owners,
 * admins and instructors get a redacted GET (evidence-based understanding only)
 * and 403 on /changes and /history; see learner-privacy.ts.
 *
 * Provider integration: readLearnerModelForSupervisorJob(db, {jobId,workspaceId,
 * enrollmentId}, {episodeId,objectiveId?}, {retrieval:{q,kind?,limit?}}?) (or
 * readLearnerModel(db, learnerActor, ...) for the learner themselves) returns one
 * bounded scope, not a question bank. Retrieval is opt-in (max five snippets).
 * Manual preferences take precedence over reviewed suggestions. Learner text is
 * untrusted data, never instructions or credit; delimit it in provider prompts.
 * There is no HTTP proposal-creation route. createLearnerModelProposalPort must
 * be constructed in trusted server composition with an authorizer that resolves
 * an admitted service run and binds its actor/workspace/enrollment. Never derive
 * that principal from a browser body or model output. No model is called here.
 */
const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/);
const uuid = z.uuid();
const pace = z.enum(['gentle', 'steady', 'focused']);
const style = z.enum(['concise', 'step_by_step', 'worked_example']);
/** Accessibility needs the learner declares (the same vocabulary research requests use). A
 * preference or need they state, never a diagnosis inferred from behaviour (design §5). */
export const ACCESSIBILITY_NEEDS = ['captions', 'transcript', 'screen_reader', 'reduced_motion', 'keyboard_only', 'audio_description', 'plain_language'] as const;
const unique = <T>(rows: readonly T[]) => new Set(rows).size === rows.length;
/** Declared facts and preferences (design §5, requirement C01): what the learner says about
 * themselves. Direct edits take effect at once and override inferred preferences. */
const profileSchema = z.strictObject({
  preferences: z.strictObject({ pace: pace.optional(), explanationStyle: style.optional(), goal: z.string().max(2000).optional(),
    /** Languages the learner is comfortable learning in, most preferred first (BCP 47 tags). */
    languages: z.array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/)).max(5).refine(unique).optional(),
    experience: z.enum(['new', 'some', 'experienced']).optional(),
    depth: z.enum(['overview', 'standard', 'deep']).optional(),
    /** Time the learner plans to spend each week, in minutes. */
    weeklyMinutes: z.number().int().min(15).max(1200).optional(),
    accessibility: z.array(z.enum(ACCESSIBILITY_NEEDS)).max(ACCESSIBILITY_NEEDS.length).refine(unique).optional() }),
  priorKnowledge: z.array(z.strictObject({ objectiveId: id, statement: z.string().trim().min(1).max(500) })).max(20)
    .refine(rows => new Set(rows.map(row => row.objectiveId)).size === rows.length),
  thoughts: z.string().max(1000),
});
export const learnerModelSuggestionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pace'), value: pace }),
  z.strictObject({ kind: z.literal('explanation_style'), value: style }),
  z.strictObject({ kind: z.literal('review_objective'), objectiveId: id }),
]);
const suggestionSchema = learnerModelSuggestionSchema;
const command = { expectedRevision: z.number().int().positive().max(2147483646), idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/) };
const editSchema = z.strictObject({ ...command, profile: profileSchema });
const decisionSchema = z.strictObject({ ...command, action: z.enum(['accept', 'correct', 'dispute']), correction: suggestionSchema.optional(), reason: z.string().max(500).optional() })
  .refine(value => (value.action === 'correct') === (value.correction !== undefined));
const evidenceControlSchema = z.strictObject({ ...command, action: z.enum(['dispute', 'withdraw_dispute', 'exclude', 'include']), reason: z.string().trim().min(1).max(500).optional() })
  .refine(value => (value.action === 'dispute') === (value.reason !== undefined));
/** Open learner disputes per enrollment; each one asks staff for a review. */
const MAX_OPEN_DISPUTES = 20;
const scopeSchema = z.strictObject({ episodeId: id.optional(), objectiveId: id.optional() });
const serviceScopeSchema = z.strictObject({ workspaceId: uuid, enrollmentId: uuid });
const serviceInputSchema = serviceScopeSchema.extend({ ...command, suggestion: suggestionSchema,
  sourceEventIds: z.array(uuid).min(1).max(8).refine(values => new Set(values).size === values.length) });
const cursor = z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const pageSchema = z.strictObject({ before: cursor.optional(), limit: z.string().regex(/^(?:[1-9]|1[0-9]|20)$/).optional() });
const historySchema = pageSchema.extend({ ...scopeSchema.shape, kind: z.enum(['all', 'questions', 'evidence']).optional(), q: z.string().trim().max(100).optional() });
const providerOptionsSchema = z.strictObject({ retrieval: z.strictObject({ q: z.string().trim().min(1).max(100), kind: z.enum(['all', 'questions', 'evidence']).optional(), limit: z.number().int().min(1).max(5).optional() }).optional() });
/** How long a suggestion is offered for review before it lapses (C06). Its sources may no longer
 * describe the learner after that; the course AI can suggest again from newer activity. */
export const SUGGESTION_OFFER_DAYS = 30;
/**
 * How uncertain a suggestion is, stated by Core from how much of the learner's own activity it
 * rests on (C06), never by the model that wrote it: one source event is high, two or three
 * medium, four or more low. It describes the basis, not the learner.
 */
export function suggestionUncertainty(sourceCount: number): 'low' | 'medium' | 'high' {
  return sourceCount >= 4 ? 'low' : sourceCount >= 2 ? 'medium' : 'high';
}
export const learnerModelSourceTypes = ['companion.requested', 'assessment.submitted', 'block.read', 'episode.completed', 'episode.placed', 'profile.updated', 'learner_model.profile.edited', 'learner_model.proposal.reviewed'];
const sourceTypes = learnerModelSourceTypes;
export type LearnerModelProfile = z.infer<typeof profileSchema>;
export type LearnerModelSuggestion = z.infer<typeof suggestionSchema>;
type Profile = LearnerModelProfile;
type Suggestion = LearnerModelSuggestion;
type Scope = z.infer<typeof scopeSchema>;
type QueryScope = { workspaceId: string; enrollmentId: string } & Scope;
export interface SupervisorJobRef { jobId: string; workspaceId: string; enrollmentId: string }
interface EnrollmentHead { id: string; workspace_id: string; user_id: string; status: string; revision: number; profile_revision: number; current_episode_id: string | null; course_release_id: string }
interface ReadContext { enrollment: EnrollmentHead; access: 'learner' | 'staff' | 'supervisor' | 'agent'; staffRole?: string; digest: string; objectives: CourseManifest['objectives']; gates: CourseManifest['gates']; episodes: Pick<Episode, 'id' | 'objectiveIds' | 'gateId'>[] }
interface SourceRef { eventId: string; cursor: string; eventType: string; digest: string }
interface ProposalRow { id: string; suggestion: Suggestion; effective_suggestion: Suggestion; action: string | null; decision: { correction?: Suggestion }; decision_id: string | null; course_digest: string }
const emptyProfile = (): Profile => ({ preferences: {}, priorKnowledge: [], thoughts: '' });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input); requireCondition(result.success, 'INVALID_REQUEST'); return result.data;
}
function commandCourse(context: EnrollmentContext) {
  return context.release.server_bundle;
}
function assertObjectives(course: Pick<CourseManifest, 'objectives'>, ids: string[]) {
  requireCondition(ids.every(value => course.objectives.some(objective => objective.id === value)), 'OBJECTIVE_OUT_OF_SCOPE', 404);
}
function assertSuggestion(course: Pick<CourseManifest, 'objectives'>, suggestion: Suggestion) {
  if (suggestion.kind === 'review_objective') assertObjectives(course, [suggestion.objectiveId]);
}

/**
 * Who may read which part of a learner model. The approved design's role
 * boundary: course administration alone does not grant access to personal
 * chat or the learner's own notes; instructors view learners' permitted
 * evidence. So:
 * - the learner: everything (own notes, proposals, history of own questions);
 * - owner/admin/instructor of the enrollment's workspace: the evidence-derived
 *   understanding projection (GET) plus the enrollment profile (name, learning
 *   goal, pace), which is not the learner model; /changes and /history are 403 because
 *   they consist of personal profile edits, proposals and companion questions;
 * - other workspace roles: 403; peers (role learner) and non-members: 404;
 * - the supervisor/companion: readLearnerModelForSupervisorJob, authorized by an
 *   admitted, non-cancelled supervisor job for that exact enrollment, never by a
 *   staff role, and limited to the minimal provider projection.
 * What staff may see is the shared rule in learner-privacy.ts, also applied by
 * the read-only learner view and staff data exports.
 */
type Course = Omit<ReadContext, 'enrollment' | 'access' | 'staffRole'>;
async function courseOf(client: PoolClient, enrollment: EnrollmentHead): Promise<Course> {
  const course = (await client.query<Course>(`SELECT digest,server_bundle->'objectives' AS objectives,server_bundle->'gates' AS gates,
    (SELECT jsonb_agg(jsonb_build_object('id',ep->'id','objectiveIds',ep->'objectiveIds','gateId',ep->'gateId'))
     FROM jsonb_array_elements(server_bundle->'chapters') ch CROSS JOIN LATERAL jsonb_array_elements(ch->'episodes') ep) AS episodes
    FROM course_releases WHERE id=$1 AND workspace_id=$2`, [enrollment.course_release_id, enrollment.workspace_id])).rows[0];
  requireCondition(course, 'ENROLLMENT_NOT_FOUND', 404);
  return course;
}
const headColumns = ['id', 'workspace_id', 'user_id', 'status', 'revision', 'profile_revision', 'current_episode_id', 'course_release_id'];
// This read projection intentionally avoids loadEnrollment's unbounded
// progress/evidence loads and private bank data.
async function readContext(client: PoolClient, actor: Actor, enrollmentId: string, options: { workspaceId?: string; staff?: boolean } = {}): Promise<ReadContext> {
  const enrollment = (await client.query<EnrollmentHead>(`SELECT ${headColumns.join(',')} FROM enrollments WHERE id=$1`, [enrollmentId])).rows[0];
  requireCondition(enrollment && (!options.workspaceId || enrollment.workspace_id === options.workspaceId), 'ENROLLMENT_NOT_FOUND', 404);
  const role = (await client.query<{ role: string }>('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [enrollment.workspace_id, actor.id])).rows[0]?.role;
  // Outside the workspace, or for a peer learner, the enrollment does not exist.
  requireCondition(role && (enrollment.user_id === actor.id || role !== 'learner'), 'ENROLLMENT_NOT_FOUND', 404);
  const access = audienceOf(actor.id, enrollment);
  // Staff read roles follow the shared course-scoped rule (course-access.ts).
  const staffRole = access === 'staff' ? await enrollmentRole(client, actor, enrollment) ?? '' : undefined;
  if (access === 'staff') requireCondition(options.staff === true && (STAFF_READ_ROLES as readonly string[]).includes(staffRole!), 'LEARNER_MODEL_PRIVATE', 403);
  return { enrollment, access, ...(staffRole === undefined ? {} : { staffRole }), ...await courseOf(client, enrollment) };
}
/** The supervisor's read path: an existing, non-terminal, non-cancelled job of
 * this exact enrollment and workspace, on an enrollment that is not erased. */
async function supervisorContext(client: PoolClient, job: SupervisorJobRef): Promise<ReadContext> {
  const enrollment = (await client.query<EnrollmentHead>(`SELECT ${headColumns.map(column => 'e.' + column).join(',')} FROM supervisor_jobs j
    JOIN enrollments e ON e.id=j.enrollment_id AND e.workspace_id=j.workspace_id
    WHERE j.id=$1 AND j.enrollment_id=$2 AND j.workspace_id=$3 AND j.state NOT IN ('applied','cancelled','failed') AND NOT j.cancellation_requested
      AND e.status<>'erased'`, [job.jobId, job.enrollmentId, job.workspaceId])).rows[0];
  requireCondition(enrollment, 'SUPERVISOR_JOB_NOT_AUTHORIZED', 403);
  return { enrollment, access: 'supervisor', ...await courseOf(client, enrollment) };
}
/** Reads made for an AI on the learner's behalf: the supervisor/companion, or an external
 * agent the learner granted (agent-tools-routes.ts). Both leave out what the learner excluded. */
const forModel = (context: ReadContext) => context.access === 'supervisor' || context.access === 'agent';
/** A learner-granted external agent's read path (agent-tools-routes.ts): an unrevoked, unexpired
 * grant for this exact enrollment, held by its own learner, who is still a workspace member, on
 * an enrollment that is not erased. Checked again on every read. */
export interface AgentGrantRef { grantId: string; workspaceId: string; enrollmentId: string; userId: string }
async function agentContext(client: PoolClient, grant: AgentGrantRef): Promise<ReadContext> {
  const enrollment = (await client.query<EnrollmentHead>(`SELECT ${headColumns.map(column => 'e.' + column).join(',')} FROM agent_tool_grants g
    JOIN enrollments e ON e.id=g.enrollment_id AND e.workspace_id=g.workspace_id AND e.user_id=g.user_id
    JOIN memberships m ON m.workspace_id=e.workspace_id AND m.user_id=e.user_id
    WHERE g.id=$1 AND g.enrollment_id=$2 AND g.workspace_id=$3 AND g.user_id=$4 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
      AND e.status<>'erased'`, [grant.grantId, grant.enrollmentId, grant.workspaceId, grant.userId])).rows[0];
  requireCondition(enrollment, 'AGENT_TOKEN_INVALID', 401);
  return { enrollment, access: 'agent', ...await courseOf(client, enrollment) };
}
function selectedScope(context: ReadContext, input: Scope, maximumObjectives = 20) {
  const episode = context.episodes.find(row => row.id === (input.episodeId ?? context.enrollment.current_episode_id ?? context.episodes[0]?.id));
  requireCondition(episode, 'EPISODE_NOT_FOUND', 404);
  if (input.objectiveId) requireCondition(episode.objectiveIds.includes(input.objectiveId), 'OBJECTIVE_OUT_OF_SCOPE', 404);
  const objectiveIds = input.objectiveId ? [input.objectiveId] : episode.objectiveIds.slice(0, maximumObjectives);
  const gate = context.gates.find(row => row.id === episode.gateId);
  return { episodeId: episode.id, objectiveIds, objectivesTruncated: !input.objectiveId && episode.objectiveIds.length > maximumObjectives, gate };
}
async function readProfile(client: PoolClient, context: ReadContext | EnrollmentContext) {
  const row = (await client.query<{ revision: number; profile: unknown; manually_edited: boolean }>('SELECT revision,profile,manually_edited FROM learner_model_profiles WHERE enrollment_id=$1 AND workspace_id=$2', [context.enrollment.id, context.enrollment.workspace_id])).rows[0];
  const profile = row ? parse(profileSchema, row.profile) : emptyProfile();
  if (!row?.manually_edited) {
    const basic = (await client.query<{ profile: { goal?: string; pace?: string } }>('SELECT profile FROM enrollments WHERE id=$1 AND workspace_id=$2', [context.enrollment.id, context.enrollment.workspace_id])).rows[0]?.profile;
    if (typeof basic?.goal === 'string') profile.preferences.goal = basic.goal;
    if (pace.safeParse(basic?.pace).success) profile.preferences.pace = basic!.pace as Profile['preferences']['pace'];
  }
  return { revision: row?.revision ?? 0, profile };
}
/** Why each projection state was given, in the learner's terms. Shown with the
 * state wherever it appears (learner, staff and provider projections). */
export const SKILL_STATE_EXPLANATIONS = {
  not_assessed: 'No gate assesses this objective, and nothing has been recorded for it yet.',
  needs_evidence: 'The gate needs independent answers from more question families before this counts as demonstrated.',
  practicing: 'Answers are recorded, but they do not yet meet the gate: this is practice, not a demonstration.',
  demonstrated: 'Independent answers from enough question families met the gate in this course version.',
  retained: 'Demonstrated, and a later independent check confirmed it was kept.',
  needs_review: 'Demonstrated earlier, but a later check suggests reviewing it again.',
  disputed: 'A review the learner asked for is open. Until it is decided the result is shown as disputed.',
} as const;
/** A learner's dispute is open until withdrawn, until staff review the evidence
 * after it was raised, or until the evidence is invalidated. Alias `c` is the
 * control row; it joins `evidence` itself. */
export const OPEN_DISPUTE = `c.kind='dispute' AND c.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM evidence x WHERE x.id=c.evidence_id AND x.invalidated_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM admin_evidence_reviews r WHERE r.evidence_id=c.evidence_id AND r.created_at>=c.created_at)`;
/** Per-evidence flags for a query whose evidence alias is `e`. */
const CONTROL_FLAGS = `EXISTS (SELECT 1 FROM learner_evidence_controls c WHERE c.evidence_id=e.id AND c.enrollment_id=e.enrollment_id AND ${OPEN_DISPUTE}) AS disputed,
        EXISTS (SELECT 1 FROM learner_evidence_controls c WHERE c.evidence_id=e.id AND c.enrollment_id=e.enrollment_id AND c.kind='exclude' AND c.ended_at IS NULL) AS excluded`;
/** Evidence the learner excluded from what the companion and supervisor receive. */
export async function excludedAttemptIds(client: PoolClient, enrollmentId: string, attemptIds: string[]) {
  if (!attemptIds.length) return new Set<string>();
  return new Set((await client.query<{ attempt_id: string }>(`SELECT DISTINCT e.attempt_id FROM learner_evidence_controls c JOIN evidence e ON e.id=c.evidence_id AND e.enrollment_id=c.enrollment_id
    WHERE c.enrollment_id=$1 AND c.kind='exclude' AND c.ended_at IS NULL AND e.attempt_id=ANY($2::uuid[])`, [enrollmentId, attemptIds])).rows.map(row => row.attempt_id));
}

/** Who decided a piece of evidence, from its evaluator and result (codes only, never a staff identity). */
export function evidenceAuthor(evaluatorRef: string, result: unknown): 'automatic_check' | 'staff_review' | 'second_opinion' | 'staff_regrade' {
  if (evaluatorRef.startsWith('reviewed-rubric-appeal')) return 'second_opinion';
  if (evaluatorRef.startsWith('reviewed-rubric-regrade')) return 'staff_regrade';
  const reviewed = result as { reviewed?: unknown; confirmation?: unknown } | null;
  return evaluatorRef.startsWith('reviewed-rubric') && reviewed?.reviewed === true && reviewed.confirmation !== 'deterministic' ? 'staff_review' : 'automatic_check';
}
/** Skill projection per objective: not_assessed / needs_evidence / practicing /
 * demonstrated / retained / needs_review / disputed. Each state names its basis.
 * Retention comes from delayed-check schedules; practicing from recorded
 * attempts that do not (yet) meet the gate; disputed from an open appeal on an
 * answer that is evidence for the objective. Self-report never changes it. */
async function understanding(client: PoolClient, context: ReadContext, scope: ReturnType<typeof selectedScope>, maximumRefs: number) {
  const results = [];
  const ids = scope.objectiveIds;
  const retention = new Map((await client.query<{ objective_id: string; due_at: Date | null; retained_at: Date | null; needs_review: boolean }>(
    'SELECT objective_id,due_at,retained_at,needs_review FROM retention_schedules WHERE enrollment_id=$1 AND objective_id=ANY($2::text[])', [context.enrollment.id, ids])).rows.map(r => [r.objective_id, r]));
  const practice = new Map((await client.query<{ objective_id: string; n: string }>(`SELECT e.objective_id,count(DISTINCT e.attempt_id) AS n FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
    WHERE e.enrollment_id=$1 AND e.objective_id=ANY($2::text[]) AND e.invalidated_at IS NULL AND a.course_digest=$3 GROUP BY e.objective_id`, [context.enrollment.id, ids, context.digest])).rows.map(r => [r.objective_id, Number(r.n)]));
  // Open second-opinion appeals on a written answer, and the learner's own open evidence disputes.
  const disputes = new Map((await client.query<{ objective_id: string; n: string }>(`SELECT objective_id,count(*) AS n FROM (
      SELECT e.objective_id,p.id FROM rubric_appeals p JOIN evidence e ON e.attempt_id=p.attempt_id AND e.enrollment_id=p.enrollment_id
       WHERE p.enrollment_id=$1 AND p.state='open' AND e.objective_id=ANY($2::text[])
      UNION SELECT e.objective_id,c.id FROM learner_evidence_controls c JOIN evidence e ON e.id=c.evidence_id AND e.enrollment_id=c.enrollment_id
       WHERE c.enrollment_id=$1 AND e.objective_id=ANY($2::text[]) AND ${OPEN_DISPUTE}) open GROUP BY objective_id`, [context.enrollment.id, ids])).rows.map(r => [r.objective_id, Number(r.n)]));
  const supervisor = forModel(context);
  for (const objectiveId of ids) {
    const gate = scope.gate, schedule = retention.get(objectiveId), practiceAttempts = practice.get(objectiveId) ?? 0, openDisputes = disputes.get(objectiveId) ?? 0;
    const retentionState = !schedule ? 'not_scheduled' as const : schedule.needs_review ? 'needs_review' as const : schedule.retained_at ? 'retained' as const : 'scheduled' as const;
    const common = { retention: retentionState, retentionDueAt: schedule?.due_at?.toISOString() ?? null, practiceAttempts, openDisputes };
    if (!gate || !gateObjectives(gate).includes(objectiveId)) {
      const status = openDisputes ? 'disputed' as const : practiceAttempts ? 'practicing' as const : 'not_assessed' as const;
      results.push({ objectiveId, status, explanation: SKILL_STATE_EXPLANATIONS[status], gateId: null, demonstrated: false, evidenceRefs: [], ...common }); continue;
    }
    // At most 101 distinct families per objective. Gates can require at most 100.
    // Omitted older families cannot turn an unmet threshold into a false pass.
    requireCondition(gateFamilies(gate) <= 100, 'UNSUPPORTED_GATE_LIMIT', 409);
    const rows = (await client.query<EvidenceRow & { attempt_id: string; disputed: boolean; excluded: boolean; evaluator_ref: string; recorded_at: Date }>(`SELECT DISTINCT ON (a.family_id) e.id,e.objective_id,e.independent,e.result,a.id AS attempt_id,a.family_id,a.assessment_id,a.course_digest,a.mode,
        e.evaluator_ref,e.created_at AS recorded_at,
        ${CONTROL_FLAGS}
      FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
      WHERE e.enrollment_id=$1 AND e.objective_id=$2 AND e.independent AND e.invalidated_at IS NULL
        AND e.result->'passed'='true'::jsonb AND a.result->'passed'='true'::jsonb
        AND a.assistance='none' AND a.mode IN ('independent','placement') AND a.course_digest=$3 AND a.assessment_id=ANY($4::text[])
      ORDER BY a.family_id,e.created_at,e.id LIMIT 101`, [context.enrollment.id, objectiveId, context.digest, gateItemIds(gate)])).rows;
    // Per-objective family threshold; a versioned gate's transfer and misconception rules are in its decision.
    const demonstrated = rows.length >= gateFamilies(gate);
    const status = openDisputes ? 'disputed' as const : demonstrated && retentionState === 'needs_review' ? 'needs_review' as const : demonstrated && retentionState === 'retained' ? 'retained' as const
      : demonstrated ? 'demonstrated' as const : practiceAttempts ? 'practicing' as const : 'needs_evidence' as const;
    // The companion and supervisor never receive references the learner excluded; the count still follows credit.
    const refs = supervisor ? rows.filter(row => !row.excluded) : rows;
    results.push({ objectiveId, gateId: gate.id, status, explanation: SKILL_STATE_EXPLANATIONS[status], demonstrated, basis: 'current_course_independent_gate_evidence', ...common,
      independentFamilies: Math.min(rows.length, 100), familiesTruncated: rows.length > 100, requiredFamilies: gateFamilies(gate),
      // Provenance (design §5, requirement C06): which evaluator issued the evidence, whether a
      // person or an automatic check decided it, and when it was recorded.
      evidenceRefs: refs.slice(0, maximumRefs).map(row => ({ evidenceId: row.id, attemptId: row.attempt_id, courseDigest: row.course_digest,
        evaluator: row.evaluator_ref, decidedBy: evidenceAuthor(row.evaluator_ref, row.result), recordedAt: row.recorded_at.toISOString(),
        ...(supervisor ? {} : { disputed: row.disputed }), ...(context.access === 'learner' ? { excluded: row.excluded } : {}) })),
      evidenceRefsTruncated: refs.length > maximumRefs });
  }
  return results;
}

const sourceHash = `encode(sha256(convert_to(jsonb_build_object('id',id,'workspace',workspace_id,'enrollment',enrollment_id,
  'sequence',sequence,'actor',actor_id,'kind',actor_kind,'type',event_type,'payload',payload)::text,'UTF8')),'hex')`;
export async function learnerModelSourceEvents(client: PoolClient, enrollmentId: string, workspaceId: string, ids: string[]): Promise<SourceRef[]> {
  const rows = (await client.query<SourceRef>(`SELECT id AS "eventId",sequence::text AS cursor,event_type AS "eventType",${sourceHash} AS digest
    FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[]) AND event_type=ANY($4::text[]) ORDER BY sequence LIMIT 8 FOR SHARE`,
  [enrollmentId, workspaceId, ids, sourceTypes])).rows;
  requireCondition(rows.length === ids.length, 'SOURCE_EVENT_OUT_OF_SCOPE', 404);
  return rows;
}
const sourceEvents = learnerModelSourceEvents;
async function proposalSources(client: PoolClient, context: ReadContext | EnrollmentContext, proposalId: string) {
  return (await client.query<SourceRef>(`SELECT event_id AS "eventId",event_sequence::text AS cursor,event_type AS "eventType",event_digest AS digest
    FROM learner_model_sources WHERE proposal_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY event_sequence LIMIT 8`,
  [proposalId, context.enrollment.id, context.enrollment.workspace_id])).rows;
}
async function proposals(client: PoolClient, context: ReadContext, provider: boolean, objectiveIds: string[]) {
  const limit = provider ? 3 : 20;
  const rows = (await client.query<ProposalRow & { agent_grant_id: string | null; agent_label: string | null; uncertainty: string | null; expires_at: Date | null; expired: boolean }>(`SELECT p.id,p.suggestion,COALESCE(corrected.correction,p.suggestion) AS effective_suggestion,p.course_digest,d.action,COALESCE(d.data,'{}') AS decision,d.id AS decision_id,
      g.id AS agent_grant_id,g.label AS agent_label,p.uncertainty,p.expires_at,COALESCE(p.expires_at<=clock_timestamp(),false) AS expired
    FROM learner_model_proposals p LEFT JOIN agent_tool_grants g ON p.service_id='agent-grant:'||g.id::text AND g.enrollment_id=p.enrollment_id
    LEFT JOIN LATERAL
      (SELECT id,action,data,sequence FROM learner_model_changes WHERE proposal_id=p.id AND enrollment_id=p.enrollment_id AND workspace_id=p.workspace_id AND action<>'proposal.created' ORDER BY sequence DESC LIMIT 1) d ON true
    LEFT JOIN LATERAL (SELECT data->'correction' AS correction FROM learner_model_changes WHERE proposal_id=p.id AND enrollment_id=p.enrollment_id AND workspace_id=p.workspace_id AND action='proposal.corrected' ORDER BY sequence DESC LIMIT 1) corrected ON true
    WHERE p.enrollment_id=$1 AND p.workspace_id=$2 AND p.course_digest=$3
      AND (NOT $4::boolean OR d.action IN ('proposal.accepted','proposal.corrected'))
      AND (COALESCE(corrected.correction,p.suggestion)->>'kind'<>'review_objective' OR COALESCE(corrected.correction,p.suggestion)->>'objectiveId'=ANY($5::text[]))
    ORDER BY COALESCE(d.sequence,0) DESC,p.created_at DESC,p.id DESC LIMIT $6`,
  [context.enrollment.id, context.enrollment.workspace_id, context.digest, provider, objectiveIds, limit + 1])).rows;
  const items = [];
  // Where each suggestion came from: the course's own AI, or a connected agent the learner granted
  // (named by the learner's label for that grant; models see only the kind, never the label).
  const origin = (row: (typeof rows)[number]) => row.agent_grant_id
    ? (provider ? { kind: 'connected_agent' as const } : { kind: 'connected_agent' as const, grantId: row.agent_grant_id, label: row.agent_label })
    : { kind: 'course_ai' as const };
  // Provenance (C06): how uncertain Core is of each suggestion and until when it is offered. A
  // suggestion still pending at its expiry is listed as expired and can no longer be accepted.
  for (const row of rows.slice(0, limit)) items.push({ proposalId: row.id, origin: origin(row),
    status: row.action?.replace('proposal.', '') ?? (row.expired ? 'expired' : 'pending'),
    uncertainty: row.uncertainty, expiresAt: row.expires_at?.toISOString() ?? null,
    suggestion: row.effective_suggestion, ...(provider ? {} : { originalSuggestion: row.suggestion }),
    decisionId: row.decision_id, grantsMastery: false, sourceEventRefs: await proposalSources(client, context, row.id) });
  return { items, truncated: rows.length > limit };
}
async function modelSnapshot(client: PoolClient, context: ReadContext, input: Scope, provider: boolean) {
  const scope = selectedScope(context, input, provider ? 8 : 20);
  const head = { enrollmentId: context.enrollment.id, workspaceId: context.enrollment.workspace_id, courseDigest: context.digest,
    revision: context.enrollment.revision, profileRevision: context.enrollment.profile_revision };
  const scoped = { scope: { episodeId: scope.episodeId, objectiveIds: scope.objectiveIds, objectivesTruncated: scope.objectivesTruncated },
    understanding: await understanding(client, context, scope, provider ? 3 : 20) };
  // Staff never load the learner's own notes or proposals, not even to drop them.
  // The enrollment profile (name, learning goal, pace) is not the learner model: the shared rule
  // shows it to staff who may read the enrollment. The learner model's own copy stays withheld.
  if (context.access === 'staff') {
    const stored = (await client.query<{ profile: unknown }>('SELECT profile FROM enrollments WHERE id=$1 AND workspace_id=$2', [context.enrollment.id, context.enrollment.workspace_id])).rows[0]?.profile;
    return { ...head, access: 'staff' as const, profile: enrollmentProfileFor('staff', context.staffRole, stored), ...scoped, withheld: LEARNER_MODEL_WITHHELD_FROM_STAFF };
  }
  const saved = await readProfile(client, context);
  const preferences = { ...saved.profile.preferences };
  if (provider && preferences.goal) preferences.goal = preferences.goal.slice(0, 256);
  return { ...head, access: context.access, modelRevision: saved.revision, ...scoped,
    selfReport: { trust: 'learner_statement_not_evidence', preferences,
      priorKnowledge: saved.profile.priorKnowledge.filter(row => !provider || scope.objectiveIds.includes(row.objectiveId)).map(row => ({ ...row, statement: provider ? row.statement.slice(0, 256) : row.statement })),
      ...(provider ? {} : { thoughts: saved.profile.thoughts }) },
    suggestions: await proposals(client, context, provider, scope.objectiveIds),
    // Provider context carries active, learner-respected teaching hypotheses only.
    ...(provider ? { teaching: await providerHypotheses(client, context.enrollment.id, context.enrollment.workspace_id, scope.objectiveIds) } : {}) };
}
type ProviderModel = Exclude<Awaited<ReturnType<typeof modelSnapshot>>, { access: 'staff' }>;
async function readTransaction<T>(db: Database, body: (client: PoolClient) => Promise<T>) {
  return transaction(db, async client => { await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); return body(client); });
}

/** Minimal provider projection. No raw answers, answer keys, hidden prompts,
 * assistant messages, profile thoughts or pending/disputed proposals. Question
 * snippets require explicit retrieval. workspaceId prevents mixed scope refs.
 * The caller must still fence dispatch against revision changes/revoked access. */
export async function readLearnerModel(db: Database, actor: Actor, rawScope: QueryScope, rawOptions: z.infer<typeof providerOptionsSchema> = {}) {
  const scope = parse(serviceScopeSchema.extend(scopeSchema.shape), rawScope);
  return providerRead(db, client => readContext(client, actor, scope.enrollmentId, { workspaceId: scope.workspaceId }), scope, rawOptions);
}
/** The same minimal projection for an admitted supervisor/companion job. The job
 * reference must come from trusted server state (a resolved supervisor
 * operation), never from a browser body or model output. */
export async function readLearnerModelForSupervisorJob(db: Database, job: SupervisorJobRef, rawScope: Scope = {}, rawOptions: z.infer<typeof providerOptionsSchema> = {}) {
  const ref = parse(z.strictObject({ jobId: uuid, workspaceId: uuid, enrollmentId: uuid }), job);
  return providerRead(db, client => supervisorContext(client, ref), { ...parse(scopeSchema, rawScope), workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId }, rawOptions);
}
/** What a learner-granted external agent reads (agent-tools-routes.ts): the same minimal
 * projection the supervisor gets, split by grant scope. 'profile' is the learner's stated
 * preferences, reviewed suggestions and active teaching hypotheses; 'evidence' is the
 * server-derived understanding with its evidence references. Excluded evidence never appears. */
export async function readLearnerModelForAgentGrant(db: Database, grant: AgentGrantRef, part: 'profile' | 'evidence', rawScope: Scope = {}) {
  const scope = parse(scopeSchema, rawScope);
  return readTransaction(db, async client => {
    const context = await agentContext(client, grant);
    const { understanding: understood, ...model } = await modelSnapshot(client, context, scope, true) as ProviderModel;
    const { selfReport, suggestions, teaching, ...head } = model;
    return part === 'evidence' ? { ...head, understanding: understood, grantsMastery: false as const }
      : { ...head, selfReport, suggestions, teaching };
  });
}
/** The learner's own bounded question/evidence history for a learner-granted external agent.
 * Same window and literal search as the learner's /history, minus excluded evidence and
 * messages the learner asked the companion not to use again. */
export async function readLearnerHistoryForAgentGrant(db: Database, grant: AgentGrantRef, rawInput: unknown) {
  const input = parse(historySchema, rawInput);
  return readTransaction(db, async client => history(client, await agentContext(client, grant), input));
}
async function providerRead(db: Database, load: (client: PoolClient) => Promise<ReadContext>, scope: QueryScope, rawOptions: unknown) {
  const options = parse(providerOptionsSchema, rawOptions);
  return readTransaction(db, async client => {
    const context = await load(client);
    const model = await modelSnapshot(client, context, scope, true) as ProviderModel;
    if (!options.retrieval) return model;
    const query = options.retrieval;
    return { ...model, history: await history(client, context, { ...scope,
      q: query.q, kind: query.kind ?? 'all', limit: String(query.limit ?? 3) }) };
  });
}

/** `bumpEnrollment: false` records a change that alters nothing a learner command or a supervisor
 * fence depends on (a pending suggestion from a learner's connected agent): only the learner-model
 * revision moves, so the learner's open commands and in-flight companion answers stay current. */
async function recordChange(client: PoolClient, context: EnrollmentContext, actor: Actor, action: string, data: unknown, key: string,
  proposalId: string | null = null, event?: { id: string; cursor: string }, bumpEnrollment = true) {
  await client.query(`INSERT INTO learner_model_profiles(enrollment_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [context.enrollment.id, context.enrollment.workspace_id]);
  const model = (await client.query<{ revision: number }>('UPDATE learner_model_profiles SET revision=revision+1 WHERE enrollment_id=$1 AND workspace_id=$2 RETURNING revision', [context.enrollment.id, context.enrollment.workspace_id])).rows[0]!;
  const enrollmentRevision = context.enrollment.revision + (bumpEnrollment ? 1 : 0);
  if (bumpEnrollment) await client.query('UPDATE enrollments SET revision=revision+1,profile_revision=profile_revision+1 WHERE id=$1 AND workspace_id=$2', [context.enrollment.id, context.enrollment.workspace_id]);
  const changeId = randomUUID(), actorKind = action === 'proposal.created' ? 'agent' : 'learner';
  const recorded = event ?? await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id,
    actorId: actor.id, actorKind, type: action === 'profile.edited' ? 'learner_model.profile.edited' : 'learner_model.proposal.reviewed',
    payload: { changeId, proposalId, modelRevision: model.revision, action, grantsMastery: false }, idempotencyKey: `${context.enrollment.id}:${key}` });
  await client.query(`INSERT INTO learner_model_changes(id,enrollment_id,workspace_id,model_revision,enrollment_revision,actor_id,actor_kind,action,proposal_id,event_id,data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [changeId, context.enrollment.id, context.enrollment.workspace_id, model.revision, enrollmentRevision, actor.id, actorKind, action, proposalId, recorded.id, JSON.stringify(data)]);
  return { changeId, eventId: recorded.id, revision: enrollmentRevision, modelRevision: model.revision, proposalId, grantsMastery: false };
}

/** Revokes every suggestion that cites one of these events (a companion question the
 * learner deleted). Each gets a 'proposal.source_revoked' change, which takes it out of
 * provider context; its other history is kept. Runs in the caller's enrollment command. */
export async function revokeProposalsCitingEvents(client: PoolClient, context: EnrollmentContext, actor: Actor, eventIds: string[], key: string) {
  if (!eventIds.length) return [];
  const proposals = (await client.query<{ proposal_id: string; suggestion: Suggestion }>(`SELECT DISTINCT s.proposal_id,p.suggestion FROM learner_model_sources s
    JOIN learner_model_proposals p ON p.id=s.proposal_id AND p.enrollment_id=s.enrollment_id
    WHERE s.enrollment_id=$1 AND s.event_id=ANY($2::uuid[]) AND NOT EXISTS (SELECT 1 FROM learner_model_changes c WHERE c.proposal_id=s.proposal_id AND c.action='proposal.source_revoked')
    ORDER BY s.proposal_id LIMIT 20`, [context.enrollment.id, eventIds])).rows;
  const revoked = [];
  for (const row of proposals) {
    // recordChange bumps the revision; keep the context in step for the next change.
    const receipt = await recordChange(client, context, actor, 'proposal.source_revoked', { originalSuggestion: row.suggestion, reason: 'source_deleted', revokedSourceEventIds: eventIds }, `${key}:revoke:${row.proposal_id}`, row.proposal_id);
    context.enrollment.revision = receipt.revision;
    revoked.push(row.proposal_id);
  }
  return revoked;
}

export interface LearnerModelServicePrincipal { actor: Actor; serviceId: string; workspaceId: string; enrollmentId: string }
/** An external agent acting under a learner's own grant (agent-tools-routes.ts). The actor is
 * the enrollment's learner; the grant is checked again inside the proposal's transaction. */
/** Pending suggestions a learner's connected agents may hold (agent-tools-routes.ts). */
export const AGENT_PROPOSAL_LIMITS = { pendingPerGrant: 3, pendingPerEnrollment: 5 } as const;
export interface LearnerAgentPrincipal { kind: 'learner_agent'; actor: Actor; grantId: string; workspaceId: string; enrollmentId: string }
const actorSchema = z.strictObject({ id: uuid, displayName: z.string().max(200) });
const principalSchema = z.union([
  serviceScopeSchema.extend({ actor: actorSchema, serviceId: z.string().regex(/^[a-z][a-z0-9._:-]{0,99}$/) }),
  serviceScopeSchema.extend({ kind: z.literal('learner_agent'), actor: actorSchema, grantId: uuid }),
]);
/** Server-composition capability, not an HTTP endpoint. The authorizer must verify
 * a trusted service credential/admitted run and resolve its scope, never simply
 * echo fields from rawInput. Its active staff service account is checked again.
 * Call outside transactions already holding this enrollment's command lock. */
export function createLearnerModelProposalPort<Credential>(db: Database,
  authorize: (credential: Credential, scope: { workspaceId: string; enrollmentId: string }) => Promise<LearnerModelServicePrincipal | LearnerAgentPrincipal>) {
  requireCondition(typeof authorize === 'function', 'LEARNER_MODEL_SERVICE_UNCONFIGURED', 503);
  return { async propose(credential: Credential, rawInput: unknown) {
    const input = parse(serviceInputSchema, rawInput);
    let authorized: unknown;
    try { authorized = await authorize(credential, { workspaceId: input.workspaceId, enrollmentId: input.enrollmentId }); }
    catch { throw new ApiError(403, 'LEARNER_MODEL_SERVICE_FORBIDDEN'); }
    const checked = principalSchema.safeParse(authorized);
    requireCondition(checked.success, 'LEARNER_MODEL_SERVICE_FORBIDDEN', 403);
    const principal = checked.data;
    requireCondition(principal.workspaceId === input.workspaceId && principal.enrollmentId === input.enrollmentId,
      'LEARNER_MODEL_SERVICE_FORBIDDEN', 403);
    const agent = 'kind' in principal ? principal : null;
    // A learner agent's id names its grant; it can never pose as a configured staff service.
    const serviceId = agent ? `agent-grant:${agent.grantId}` : (principal as LearnerModelServicePrincipal).serviceId;
    // Workspace-wide only: a course grant never authorizes a service principal.
    if (!agent) await workspaceRole(db, principal.actor, input.workspaceId, ['owner', 'admin', 'instructor']);
    return enrollmentCommand(db, principal.actor, input.enrollmentId, 'learner_model.propose', { ...input, serviceId }, async (client, context) => {
      requireCondition(context.enrollment.workspace_id === input.workspaceId && context.enrollment.status === 'active', 'LEARNER_MODEL_SERVICE_FORBIDDEN', 403);
      const roles = (await client.query<{ user_id: string; role: string }>('SELECT user_id,role FROM memberships WHERE workspace_id=$1 AND user_id=ANY($2::uuid[]) FOR SHARE', [input.workspaceId, [principal.actor.id, context.enrollment.user_id]])).rows;
      if (agent) {
        // The learner's own grant, still unrevoked and unexpired, held under the row lock that
        // revocation takes: a revoked grant can never create a proposal after its revocation.
        requireCondition(context.enrollment.user_id === agent.actor.id && roles.some(row => row.user_id === agent.actor.id), 'LEARNER_MODEL_SERVICE_FORBIDDEN', 403);
        const grant = await client.query(`SELECT 1 FROM agent_tool_grants WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND user_id=$4
          AND revoked_at IS NULL AND expires_at>clock_timestamp() AND 'propose_intervention'=ANY(scopes) FOR SHARE`, [agent.grantId, input.enrollmentId, input.workspaceId, agent.actor.id]);
        requireCondition(grant.rowCount, 'AGENT_TOKEN_INVALID', 401);
      } else requireCondition(roles.some(row => row.user_id === principal.actor.id && ['owner', 'admin', 'instructor'].includes(row.role)) && roles.some(row => row.user_id === context.enrollment.user_id), 'LEARNER_MODEL_SERVICE_FORBIDDEN', 403);
      assertSuggestion(commandCourse(context), input.suggestion);
      const sources = await sourceEvents(client, input.enrollmentId, input.workspaceId, input.sourceEventIds);
      // A connected agent may not cite a question the learner asked the companion not to use again.
      if (agent) requireCondition(!(await client.query(`SELECT 1 FROM learning_events e JOIN companion_context_exclusions x ON x.message_id::text=e.payload->>'messageId'
          AND x.enrollment_id=e.enrollment_id AND x.ended_at IS NULL WHERE e.enrollment_id=$1 AND e.id=ANY($2::uuid[]) AND e.event_type='companion.requested' LIMIT 1`,
        [input.enrollmentId, input.sourceEventIds])).rowCount, 'SOURCE_EVENT_OUT_OF_SCOPE', 404);
      // Pending suggestions are capped per source. Connected agents have their own small share
      // (per grant and per enrollment) and never count against, or fill, the course services' 20.
      const pendingOf = async (where: string, values: unknown[], limit: number) => (await client.query(`SELECT 1 FROM learner_model_proposals p WHERE enrollment_id=$1 AND workspace_id=$2 AND ${where}
        AND NOT EXISTS (SELECT 1 FROM learner_model_changes c WHERE c.proposal_id=p.id AND c.action<>'proposal.created') LIMIT ${limit}`, [input.enrollmentId, input.workspaceId, ...values])).rows.length;
      if (agent) {
        requireCondition(await pendingOf('p.service_id=$3', [serviceId], AGENT_PROPOSAL_LIMITS.pendingPerGrant) < AGENT_PROPOSAL_LIMITS.pendingPerGrant, 'AGENT_PROPOSAL_LIMIT', 409);
        requireCondition(await pendingOf("p.service_id LIKE 'agent-grant:%'", [], AGENT_PROPOSAL_LIMITS.pendingPerEnrollment) < AGENT_PROPOSAL_LIMITS.pendingPerEnrollment, 'AGENT_PROPOSAL_LIMIT', 409);
      } else requireCondition(await pendingOf("p.service_id NOT LIKE 'agent-grant:%'", [], 20) < 20, 'LEARNER_MODEL_PROPOSAL_LIMIT', 409);
      const proposalId = randomUUID();
      const event = await appendEvent(client, { workspaceId: input.workspaceId, enrollmentId: input.enrollmentId, actorId: principal.actor.id, actorKind: 'agent',
        type: 'learner_model.proposal.created', payload: { proposalId, grantsMastery: false }, idempotencyKey: `${input.enrollmentId}:${input.idempotencyKey}` });
      await client.query(`INSERT INTO learner_model_proposals(id,enrollment_id,workspace_id,actor_id,service_id,course_digest,suggestion,event_id,uncertainty,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+make_interval(hours=>$10*24))`,
        [proposalId, input.enrollmentId, input.workspaceId, principal.actor.id, serviceId, context.release.digest, JSON.stringify(input.suggestion), event.id,
          suggestionUncertainty(sources.length), SUGGESTION_OFFER_DAYS]);
      for (const source of sources) await client.query(`INSERT INTO learner_model_sources(proposal_id,enrollment_id,workspace_id,event_id,event_sequence,event_type,event_digest) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [proposalId, input.enrollmentId, input.workspaceId, source.eventId, source.cursor, source.eventType, source.digest]);
      // An agent's pending suggestion changes no learner state, provider context (which carries
      // only reviewed suggestions) or fence, so the enrollment revision stays; see recordChange.
      return recordChange(client, context, principal.actor, 'proposal.created', { suggestion: input.suggestion, sourceEventRefs: sources }, input.idempotencyKey, proposalId, event, !agent);
    }, true);
  } };
}

/** Search covers a maximum 200-event window per request. A cursor moves through
 * unreturned/nonmatching events too; clients must not interpret an empty page as
 * a complete-history search when nextCursor is non-null. q is a literal substring,
 * not SQL, wildcard syntax or a regular expression. Only the learner's questions
 * and submitted-question/evidence metadata are returned, never assistant text. */
async function history(client: PoolClient, context: ReadContext, input: z.infer<typeof historySchema>) {
  const scope = selectedScope(context, input), limit = Number(input.limit ?? 10);
  const events = (await client.query<{ id: string; sequence: string; event_type: string; message_id: string | null; attempt_id: string | null }>(`SELECT id,sequence::text,event_type,payload->>'messageId' AS message_id,payload->>'attemptId' AS attempt_id
    FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint)
      AND event_type IN ('companion.requested','assessment.submitted') ORDER BY learning_events.sequence DESC LIMIT 201`, [context.enrollment.id, context.enrollment.workspace_id, input.before ?? null])).rows;
  const window = events.slice(0, 200), validId = (value: string | null): value is string => typeof value === 'string' && uuid.safeParse(value).success;
  // A model's read also leaves out questions the learner excluded from AI context (the same filter as
  // the provider context); the learner's own history still lists them.
  const messages = (await client.query<{ id: string; text: string }>(`SELECT m.id,left(m.content,4000) AS text FROM companion_messages m
    WHERE m.enrollment_id=$1 AND m.role='learner' AND m.id=ANY($2::uuid[]) AND m.context->>'episodeId'=$3 AND m.context->>'courseDigest'=$4 AND m.content NOT IN ('[deleted]','[erased]')
      AND (NOT $5::boolean OR (${USABLE_MESSAGE})) LIMIT 200`,
  [context.enrollment.id, window.map(row => row.message_id).filter(validId), scope.episodeId, context.digest, forModel(context)])).rows;
  type Ref = { evidenceId: string; objectiveId: string; independent: boolean; invalidated: boolean; disputed: boolean; excluded: boolean };
  const loaded = (await client.query<{ id: string; assessment_id: string; passed: boolean; mode: string; refs: Ref[] }>(`SELECT a.id,a.assessment_id,(a.result->'passed'='true'::jsonb) AS passed,a.mode,refs.items AS refs
    FROM attempts a JOIN assessment_challenges challenge ON challenge.attempt_id=a.id AND challenge.enrollment_id=a.enrollment_id
      AND challenge.course_digest=a.course_digest AND challenge.episode_id=$5
    CROSS JOIN LATERAL (SELECT COALESCE(jsonb_agg(item),'[]') AS items FROM
      (SELECT jsonb_build_object('evidenceId',e.id,'objectiveId',e.objective_id,'independent',e.independent,'invalidated',e.invalidated_at IS NOT NULL,
          'disputed',flags.disputed,'excluded',flags.excluded) AS item
       FROM evidence e CROSS JOIN LATERAL (SELECT ${CONTROL_FLAGS}) flags
       WHERE e.attempt_id=a.id AND e.enrollment_id=a.enrollment_id AND e.objective_id=ANY($4::text[]) ORDER BY e.id LIMIT 21) bounded) refs
    WHERE a.enrollment_id=$1 AND a.course_digest=$2 AND a.id=ANY($3::uuid[]) LIMIT 200`,
  [context.enrollment.id, context.digest, window.map(row => row.attempt_id).filter(validId), scope.objectiveIds, scope.episodeId])).rows;
  // The companion and supervisor never retrieve evidence the learner excluded, nor an attempt left with none.
  const attempts: (Omit<(typeof loaded)[number], 'refs'> & { refs: (Omit<Ref, 'excluded'> & { excluded?: boolean })[] })[] = forModel(context)
    ? loaded.map(row => ({ ...row, refs: row.refs.filter(ref => !ref.excluded).map(({ excluded: _excluded, ...ref }) => ref) }))
    : loaded;
  // Only prompts for this learner's submitted attempts, not the rest of the bank.
  const prompts = (await client.query<{ id: string; text: string }>(`SELECT item->>'id' AS id,left(item->>'prompt',4000) AS text FROM course_releases c,
    LATERAL jsonb_array_elements(c.server_bundle->'assessments') item WHERE c.id=$1 AND c.workspace_id=$2 AND item->>'id'=ANY($3::text[]) LIMIT 200`,
  [context.enrollment.course_release_id, context.enrollment.workspace_id, attempts.filter(row => row.refs.length).map(row => row.assessment_id)])).rows;
  const items = [];
  let nextCursor: string | null = null;
  for (const event of window) {
    const message = messages.find(row => row.id === event.message_id), attempt = attempts.find(row => row.id === event.attempt_id && row.refs.length);
    const kind = message ? 'questions' : attempt ? 'evidence' : null;
    const text = message?.text ?? prompts.find(row => row.id === attempt?.assessment_id)?.text ?? '';
    if (!kind || (input.kind && input.kind !== 'all' && input.kind !== kind) || (input.q && !text.toLocaleLowerCase('en').includes(input.q.toLocaleLowerCase('en')))) continue;
    if (items.length === limit) { nextCursor = items.at(-1)!.cursor; break; }
    const matchAt = input.q ? text.toLocaleLowerCase('en').indexOf(input.q.toLocaleLowerCase('en')) : 0;
    const start = Math.max(0, matchAt - 160);
    items.push({ kind, cursor: event.sequence, eventId: event.id, text: text.slice(start, start + 1000),
      ...(message ? { messageId: message.id } : { attemptId: attempt!.id, assessmentId: attempt!.assessment_id, passed: attempt!.passed,
        mode: attempt!.mode, evidenceRefs: attempt!.refs.slice(0, 20), evidenceRefsTruncated: attempt!.refs.length > 20 }) });
  }
  if (!nextCursor && events.length > 200) nextCursor = window.at(-1)!.sequence;
  return { scope: { episodeId: scope.episodeId, objectiveIds: scope.objectiveIds, objectivesTruncated: scope.objectivesTruncated }, items, nextCursor, scannedEvents: window.length,
    maxScannedEvents: 200, maxSearchedTextCharacters: 4000, maxSnippetCharacters: 1000 };
}

export function registerLearnerModelRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = '/api/enrollments/:enrollmentId/learner-model';
  const enrollmentId = (params: unknown) => parse(z.object({ enrollmentId: uuid }), params).enrollmentId;
  app.get(base, async request => {
    const actor = await auth.authenticate(request), id = enrollmentId(request.params), scope = parse(scopeSchema, request.query);
    return readTransaction(db, async client => modelSnapshot(client, await readContext(client, actor, id, { staff: true }), scope, false));
  });
  app.post(`${base}/profile`, { bodyLimit: 65536 }, async request => {
    const actor = await auth.authenticate(request), id = enrollmentId(request.params), input = parse(editSchema, request.body);
    return enrollmentCommand(db, actor, id, 'learner_model.profile', input, async (client, context) => {
      assertObjectives(commandCourse(context), input.profile.priorKnowledge.map(row => row.objectiveId));
      await client.query(`INSERT INTO learner_model_profiles(enrollment_id,workspace_id,profile,manually_edited) VALUES ($1,$2,$3,true)
        ON CONFLICT(enrollment_id) DO UPDATE SET profile=EXCLUDED.profile,manually_edited=true`, [id, context.enrollment.workspace_id, JSON.stringify(input.profile)]);
      return recordChange(client, context, actor, 'profile.edited', { profile: input.profile, trust: 'learner_statement_not_evidence' }, input.idempotencyKey);
    });
  });
  app.post(`${base}/proposals/:proposalId/decision`, { bodyLimit: 8192 }, async request => {
    const actor = await auth.authenticate(request), id = enrollmentId(request.params), { proposalId } = parse(z.object({ proposalId: uuid }), request.params), input = parse(decisionSchema, request.body);
    return enrollmentCommand(db, actor, id, 'learner_model.decision', { ...input, proposalId }, async (client, context) => {
      const proposal = (await client.query<{ suggestion: Suggestion; course_digest: string; expired: boolean }>(`SELECT suggestion,course_digest,
          COALESCE(expires_at<=clock_timestamp(),false) AND NOT EXISTS(SELECT 1 FROM learner_model_changes c WHERE c.proposal_id=p.id AND c.action<>'proposal.created') AS expired
        FROM learner_model_proposals p WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3`, [proposalId, id, context.enrollment.workspace_id])).rows[0];
      requireCondition(proposal, 'PROPOSAL_NOT_FOUND', 404);
      // A suggestion left undecided until its expiry can still be disputed, never accepted or
      // corrected into the model. A decision made in time keeps the learner's later choices open.
      requireCondition(input.action === 'dispute' || !proposal.expired, 'PROPOSAL_EXPIRED', 409);
      // A suggestion whose source the learner deleted stays revoked.
      requireCondition(!(await client.query("SELECT 1 FROM learner_model_changes WHERE proposal_id=$1 AND enrollment_id=$2 AND action='proposal.source_revoked'", [proposalId, id])).rowCount, 'PROPOSAL_SOURCE_REVOKED', 409);
      if (input.action !== 'dispute') {
        requireCondition(proposal.course_digest === context.release.digest, 'PROPOSAL_SOURCE_CHANGED', 409);
        const sources = await proposalSources(client, context, proposalId);
        const current = await sourceEvents(client, id, context.enrollment.workspace_id, sources.map(row => row.eventId));
        requireCondition(sources.length && sources.every(row => current.some(now => now.eventId === row.eventId && now.digest === row.digest)), 'PROPOSAL_SOURCE_CHANGED', 409);
      }
      if (input.correction) {
        requireCondition(input.correction.kind === proposal.suggestion.kind, 'INVALID_CORRECTION');
        assertSuggestion(commandCourse(context), input.correction);
      }
      return recordChange(client, context, actor, `proposal.${{ accept: 'accepted', correct: 'corrected', dispute: 'disputed' }[input.action]}`,
        { originalSuggestion: proposal.suggestion, ...(input.correction ? { correction: input.correction } : {}), reason: input.reason ?? '' }, input.idempotencyKey, proposalId);
    });
  });
  /** The learner's own controls over one piece of their evidence. Learner only:
   * staff get 404 like any other learner command. Neither control changes credit. */
  app.post(`${base}/evidence/:evidenceId/control`, { bodyLimit: 8192 }, async request => {
    const actor = await auth.authenticate(request), id = enrollmentId(request.params), { evidenceId } = parse(z.object({ evidenceId: uuid }), request.params);
    const input = parse(evidenceControlSchema, request.body);
    return enrollmentCommand(db, actor, id, 'learner_model.evidence_control', { ...input, evidenceId }, async (client, context) => {
      const evidence = (await client.query<{ invalidated: boolean; disputed: boolean; excluded: boolean }>(`SELECT e.invalidated_at IS NOT NULL AS invalidated,${CONTROL_FLAGS}
        FROM evidence e WHERE e.id=$1 AND e.enrollment_id=$2 FOR UPDATE`, [evidenceId, id])).rows[0];
      requireCondition(evidence, 'EVIDENCE_NOT_FOUND', 404);
      const kind = input.action === 'dispute' || input.action === 'withdraw_dispute' ? 'dispute' : 'exclude';
      const starting = input.action === 'dispute' || input.action === 'exclude';
      requireCondition(starting !== (kind === 'dispute' ? evidence.disputed : evidence.excluded), 'EVIDENCE_CONTROL_UNCHANGED', 409);
      if (input.action === 'dispute') {
        requireCondition(!evidence.invalidated, 'EVIDENCE_INVALIDATED', 409);
        const open = await client.query(`SELECT 1 FROM learner_evidence_controls c WHERE c.enrollment_id=$1 AND ${OPEN_DISPUTE} LIMIT ${MAX_OPEN_DISPUTES}`, [id]);
        requireCondition((open.rowCount ?? 0) < MAX_OPEN_DISPUTES, 'EVIDENCE_DISPUTE_LIMIT', 409);
      }
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [id]);
      const type = { dispute: 'learner_model.evidence.disputed', withdraw_dispute: 'learner_model.evidence.dispute_withdrawn', exclude: 'learner_model.evidence.excluded', include: 'learner_model.evidence.included' }[input.action];
      const controlId = starting ? randomUUID() : null;
      const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: id, actorId: actor.id, actorKind: 'learner', type,
        payload: { evidenceId, ...(controlId ? { controlId } : {}), grantsMastery: false, changesCredit: false }, idempotencyKey: `${id}:${input.idempotencyKey}` });
      // Starting ends any earlier row that is no longer open (a dispute staff reviewed); stopping ends the open one.
      await client.query(`UPDATE learner_evidence_controls SET ended_at=clock_timestamp(),ended_event_id=$3 WHERE evidence_id=$1 AND enrollment_id=$2 AND kind=$4 AND ended_at IS NULL`,
        [evidenceId, id, event.id, kind]);
      if (starting) await client.query(`INSERT INTO learner_evidence_controls(id,enrollment_id,workspace_id,evidence_id,kind,reason,event_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [controlId, id, context.enrollment.workspace_id, evidenceId, kind, kind === 'dispute' ? input.reason ?? '' : '', event.id]);
      return { evidenceId, action: input.action, eventId: event.id, revision: context.enrollment.revision + 1, grantsMastery: false, changesCredit: false,
        disputed: kind === 'dispute' ? starting : evidence.disputed, excluded: kind === 'exclude' ? starting : evidence.excluded };
    });
  });
  app.get(`${base}/changes`, async request => {
    const actor = await auth.authenticate(request), id = enrollmentId(request.params), input = parse(pageSchema, request.query), limit = Number(input.limit ?? 10);
    return readTransaction(db, async client => {
      const context = await readContext(client, actor, id);
      const rows = (await client.query(`SELECT sequence::text AS cursor,id,model_revision AS "modelRevision",actor_kind AS "actorKind",action,proposal_id AS "proposalId",event_id AS "eventId",data,created_at AS "createdAt"
        FROM learner_model_changes WHERE enrollment_id=$1 AND workspace_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint) ORDER BY sequence DESC LIMIT $4`, [id, context.enrollment.workspace_id, input.before ?? null, limit + 1])).rows;
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.cursor : null };
    });
  });
  app.get(`${base}/history`, async request => {
    const actor = await auth.authenticate(request), id = enrollmentId(request.params), input = parse(historySchema, request.query);
    return readTransaction(db, async client => history(client, await readContext(client, actor, id), input));
  });
}
