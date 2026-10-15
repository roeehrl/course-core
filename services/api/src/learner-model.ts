import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { CourseManifest, Episode } from '@course-core/sdk';
import { authService, membership, type Actor } from './auth.js';
import { transaction, type Database } from './database.js';
import { appendEvent } from './events.js';
import { ApiError, requireCondition } from './errors.js';
import { enrollmentCommand, type EnrollmentContext } from './repository.js';
import type { EvidenceRow } from './learning.js';
import { gateFamilies, gateItemIds, gateObjectives } from './gates.js';

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
 * and 403 on /changes and /history; see LEARNER_MODEL_STAFF_ROLES.
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
const profileSchema = z.strictObject({
  preferences: z.strictObject({ pace: pace.optional(), explanationStyle: style.optional(), goal: z.string().max(2000).optional() }),
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
const scopeSchema = z.strictObject({ episodeId: id.optional(), objectiveId: id.optional() });
const serviceScopeSchema = z.strictObject({ workspaceId: uuid, enrollmentId: uuid });
const serviceInputSchema = serviceScopeSchema.extend({ ...command, suggestion: suggestionSchema,
  sourceEventIds: z.array(uuid).min(1).max(8).refine(values => new Set(values).size === values.length) });
const cursor = z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const pageSchema = z.strictObject({ before: cursor.optional(), limit: z.string().regex(/^(?:[1-9]|1[0-9]|20)$/).optional() });
const historySchema = pageSchema.extend({ ...scopeSchema.shape, kind: z.enum(['all', 'questions', 'evidence']).optional(), q: z.string().trim().max(100).optional() });
const providerOptionsSchema = z.strictObject({ retrieval: z.strictObject({ q: z.string().trim().min(1).max(100), kind: z.enum(['all', 'questions', 'evidence']).optional(), limit: z.number().int().min(1).max(5).optional() }).optional() });
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
interface ReadContext { enrollment: EnrollmentHead; access: 'learner' | 'staff' | 'supervisor'; digest: string; objectives: CourseManifest['objectives']; gates: CourseManifest['gates']; episodes: Pick<Episode, 'id' | 'objectiveIds' | 'gateId'>[] }
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
 * chat/profile content; instructors view learners' permitted evidence. So:
 * - the learner: everything (own notes, proposals, history of own questions);
 * - owner/admin/instructor of the enrollment's workspace: the evidence-derived
 *   understanding projection only (GET); /changes and /history are 403 because
 *   they consist of personal profile edits, proposals and companion questions;
 * - other workspace roles: 403; peers (role learner) and non-members: 404;
 * - the supervisor/companion: readLearnerModelForSupervisorJob, authorized by an
 *   admitted, non-cancelled supervisor job for that exact enrollment, never by a
 *   staff role, and limited to the minimal provider projection.
 * There is no learner sharing control yet, so nothing grants staff more.
 */
export const LEARNER_MODEL_STAFF_ROLES = ['owner', 'admin', 'instructor'] as const;
export const LEARNER_MODEL_WITHHELD_FROM_STAFF = ['selfReport', 'suggestions', 'changes', 'history'] as const;
type Course = Omit<ReadContext, 'enrollment' | 'access'>;
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
  let access: ReadContext['access'] = 'learner';
  if (enrollment.user_id !== actor.id) {
    requireCondition(options.staff === true && (LEARNER_MODEL_STAFF_ROLES as readonly string[]).includes(role), 'LEARNER_MODEL_PRIVATE', 403);
    access = 'staff';
  }
  return { enrollment, access, ...await courseOf(client, enrollment) };
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
async function understanding(client: PoolClient, context: ReadContext, scope: ReturnType<typeof selectedScope>, maximumRefs: number) {
  const results = [];
  for (const objectiveId of scope.objectiveIds) {
    const gate = scope.gate;
    if (!gate || !gateObjectives(gate).includes(objectiveId)) {
      results.push({ objectiveId, status: 'not_assessed', gateId: null, evidenceRefs: [] }); continue;
    }
    // At most 101 distinct families per objective. Gates can require at most 100.
    // Omitted older families cannot turn an unmet threshold into a false pass.
    requireCondition(gateFamilies(gate) <= 100, 'UNSUPPORTED_GATE_LIMIT', 409);
    const rows = (await client.query<EvidenceRow & { attempt_id: string }>(`SELECT DISTINCT ON (a.family_id) e.id,e.objective_id,e.independent,e.result,a.id AS attempt_id,a.family_id,a.assessment_id,a.course_digest,a.mode
      FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
      WHERE e.enrollment_id=$1 AND e.objective_id=$2 AND e.independent AND e.invalidated_at IS NULL
        AND e.result->'passed'='true'::jsonb AND a.result->'passed'='true'::jsonb
        AND a.assistance='none' AND a.mode IN ('independent','placement') AND a.course_digest=$3 AND a.assessment_id=ANY($4::text[])
      ORDER BY a.family_id,e.created_at,e.id LIMIT 101`, [context.enrollment.id, objectiveId, context.digest, gateItemIds(gate)])).rows;
    // Per-objective family threshold; a versioned gate's transfer and misconception rules are in its decision.
    const decision = { passed: rows.length >= gateFamilies(gate) };
    results.push({ objectiveId, gateId: gate.id, status: decision.passed ? 'demonstrated' : 'needs_evidence',
      basis: 'current_course_independent_gate_evidence', retention: 'not_assessed',
      independentFamilies: Math.min(rows.length, 100), familiesTruncated: rows.length > 100, requiredFamilies: gateFamilies(gate),
      evidenceRefs: rows.slice(0, maximumRefs).map(row => ({ evidenceId: row.id, attemptId: row.attempt_id, courseDigest: row.course_digest })), evidenceRefsTruncated: rows.length > maximumRefs });
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
  const rows = (await client.query<ProposalRow>(`SELECT p.id,p.suggestion,COALESCE(corrected.correction,p.suggestion) AS effective_suggestion,p.course_digest,d.action,COALESCE(d.data,'{}') AS decision,d.id AS decision_id
    FROM learner_model_proposals p LEFT JOIN LATERAL
      (SELECT id,action,data,sequence FROM learner_model_changes WHERE proposal_id=p.id AND enrollment_id=p.enrollment_id AND workspace_id=p.workspace_id AND action<>'proposal.created' ORDER BY sequence DESC LIMIT 1) d ON true
    LEFT JOIN LATERAL (SELECT data->'correction' AS correction FROM learner_model_changes WHERE proposal_id=p.id AND enrollment_id=p.enrollment_id AND workspace_id=p.workspace_id AND action='proposal.corrected' ORDER BY sequence DESC LIMIT 1) corrected ON true
    WHERE p.enrollment_id=$1 AND p.workspace_id=$2 AND p.course_digest=$3
      AND (NOT $4::boolean OR d.action IN ('proposal.accepted','proposal.corrected'))
      AND (COALESCE(corrected.correction,p.suggestion)->>'kind'<>'review_objective' OR COALESCE(corrected.correction,p.suggestion)->>'objectiveId'=ANY($5::text[]))
    ORDER BY COALESCE(d.sequence,0) DESC,p.created_at DESC,p.id DESC LIMIT $6`,
  [context.enrollment.id, context.enrollment.workspace_id, context.digest, provider, objectiveIds, limit + 1])).rows;
  const items = [];
  for (const row of rows.slice(0, limit)) items.push({ proposalId: row.id, status: row.action?.replace('proposal.', '') ?? 'pending',
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
  if (context.access === 'staff') return { ...head, access: 'staff' as const, ...scoped, withheld: LEARNER_MODEL_WITHHELD_FROM_STAFF };
  const saved = await readProfile(client, context);
  const preferences = { ...saved.profile.preferences };
  if (provider && preferences.goal) preferences.goal = preferences.goal.slice(0, 256);
  return { ...head, access: context.access, modelRevision: saved.revision, ...scoped,
    selfReport: { trust: 'learner_statement_not_evidence', preferences,
      priorKnowledge: saved.profile.priorKnowledge.filter(row => !provider || scope.objectiveIds.includes(row.objectiveId)).map(row => ({ ...row, statement: provider ? row.statement.slice(0, 256) : row.statement })),
      ...(provider ? {} : { thoughts: saved.profile.thoughts }) },
    suggestions: await proposals(client, context, provider, scope.objectiveIds) };
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

async function recordChange(client: PoolClient, context: EnrollmentContext, actor: Actor, action: string, data: unknown, key: string,
  proposalId: string | null = null, event?: { id: string; cursor: string }) {
  await client.query(`INSERT INTO learner_model_profiles(enrollment_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [context.enrollment.id, context.enrollment.workspace_id]);
  const model = (await client.query<{ revision: number }>('UPDATE learner_model_profiles SET revision=revision+1 WHERE enrollment_id=$1 AND workspace_id=$2 RETURNING revision', [context.enrollment.id, context.enrollment.workspace_id])).rows[0]!;
  await client.query('UPDATE enrollments SET revision=revision+1,profile_revision=profile_revision+1 WHERE id=$1 AND workspace_id=$2', [context.enrollment.id, context.enrollment.workspace_id]);
  const changeId = randomUUID(), actorKind = action === 'proposal.created' ? 'agent' : 'learner';
  const recorded = event ?? await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id,
    actorId: actor.id, actorKind, type: action === 'profile.edited' ? 'learner_model.profile.edited' : 'learner_model.proposal.reviewed',
    payload: { changeId, proposalId, modelRevision: model.revision, action, grantsMastery: false }, idempotencyKey: `${context.enrollment.id}:${key}` });
  await client.query(`INSERT INTO learner_model_changes(id,enrollment_id,workspace_id,model_revision,enrollment_revision,actor_id,actor_kind,action,proposal_id,event_id,data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [changeId, context.enrollment.id, context.enrollment.workspace_id, model.revision, context.enrollment.revision + 1, actor.id, actorKind, action, proposalId, recorded.id, JSON.stringify(data)]);
  return { changeId, eventId: recorded.id, revision: context.enrollment.revision + 1, modelRevision: model.revision, proposalId, grantsMastery: false };
}

export interface LearnerModelServicePrincipal { actor: Actor; serviceId: string; workspaceId: string; enrollmentId: string }
const principalSchema = serviceScopeSchema.extend({ actor: z.strictObject({ id: uuid, displayName: z.string().max(200) }), serviceId: z.string().regex(/^[a-z][a-z0-9._:-]{0,99}$/) });
/** Server-composition capability, not an HTTP endpoint. The authorizer must verify
 * a trusted service credential/admitted run and resolve its scope, never simply
 * echo fields from rawInput. Its active staff service account is checked again.
 * Call outside transactions already holding this enrollment's command lock. */
export function createLearnerModelProposalPort<Credential>(db: Database,
  authorize: (credential: Credential, scope: { workspaceId: string; enrollmentId: string }) => Promise<LearnerModelServicePrincipal>) {
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
    await membership(db, principal.actor, input.workspaceId, ['owner', 'admin', 'instructor']);
    return enrollmentCommand(db, principal.actor, input.enrollmentId, 'learner_model.propose', { ...input, serviceId: principal.serviceId }, async (client, context) => {
      requireCondition(context.enrollment.workspace_id === input.workspaceId && context.enrollment.status === 'active', 'LEARNER_MODEL_SERVICE_FORBIDDEN', 403);
      const roles = (await client.query<{ user_id: string; role: string }>('SELECT user_id,role FROM memberships WHERE workspace_id=$1 AND user_id=ANY($2::uuid[]) FOR SHARE', [input.workspaceId, [principal.actor.id, context.enrollment.user_id]])).rows;
      requireCondition(roles.some(row => row.user_id === principal.actor.id && ['owner', 'admin', 'instructor'].includes(row.role)) && roles.some(row => row.user_id === context.enrollment.user_id), 'LEARNER_MODEL_SERVICE_FORBIDDEN', 403);
      assertSuggestion(commandCourse(context), input.suggestion);
      const sources = await sourceEvents(client, input.enrollmentId, input.workspaceId, input.sourceEventIds);
      const pending = await client.query(`SELECT 1 FROM learner_model_proposals p WHERE enrollment_id=$1 AND workspace_id=$2 AND NOT EXISTS
        (SELECT 1 FROM learner_model_changes c WHERE c.proposal_id=p.id AND c.action<>'proposal.created') LIMIT 20`, [input.enrollmentId, input.workspaceId]);
      requireCondition(pending.rows.length < 20, 'LEARNER_MODEL_PROPOSAL_LIMIT', 409);
      const proposalId = randomUUID();
      const event = await appendEvent(client, { workspaceId: input.workspaceId, enrollmentId: input.enrollmentId, actorId: principal.actor.id, actorKind: 'agent',
        type: 'learner_model.proposal.created', payload: { proposalId, grantsMastery: false }, idempotencyKey: `${input.enrollmentId}:${input.idempotencyKey}` });
      await client.query(`INSERT INTO learner_model_proposals(id,enrollment_id,workspace_id,actor_id,service_id,course_digest,suggestion,event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [proposalId, input.enrollmentId, input.workspaceId, principal.actor.id, principal.serviceId, context.release.digest, JSON.stringify(input.suggestion), event.id]);
      for (const source of sources) await client.query(`INSERT INTO learner_model_sources(proposal_id,enrollment_id,workspace_id,event_id,event_sequence,event_type,event_digest) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [proposalId, input.enrollmentId, input.workspaceId, source.eventId, source.cursor, source.eventType, source.digest]);
      return recordChange(client, context, principal.actor, 'proposal.created', { suggestion: input.suggestion, sourceEventRefs: sources }, input.idempotencyKey, proposalId, event);
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
  const messages = (await client.query<{ id: string; text: string }>(`SELECT id,left(content,4000) AS text FROM companion_messages
    WHERE enrollment_id=$1 AND role='learner' AND id=ANY($2::uuid[]) AND context->>'episodeId'=$3 AND context->>'courseDigest'=$4 LIMIT 200`,
  [context.enrollment.id, window.map(row => row.message_id).filter(validId), scope.episodeId, context.digest])).rows;
  const attempts = (await client.query<{ id: string; assessment_id: string; passed: boolean; mode: string; refs: { evidenceId: string; objectiveId: string; independent: boolean; invalidated: boolean }[] }>(`SELECT a.id,a.assessment_id,(a.result->'passed'='true'::jsonb) AS passed,a.mode,refs.items AS refs
    FROM attempts a JOIN assessment_challenges challenge ON challenge.attempt_id=a.id AND challenge.enrollment_id=a.enrollment_id
      AND challenge.course_digest=a.course_digest AND challenge.episode_id=$5
    CROSS JOIN LATERAL (SELECT COALESCE(jsonb_agg(item),'[]') AS items FROM
      (SELECT jsonb_build_object('evidenceId',e.id,'objectiveId',e.objective_id,'independent',e.independent,'invalidated',e.invalidated_at IS NOT NULL) AS item
       FROM evidence e WHERE e.attempt_id=a.id AND e.enrollment_id=a.enrollment_id AND e.objective_id=ANY($4::text[]) ORDER BY e.id LIMIT 21) bounded) refs
    WHERE a.enrollment_id=$1 AND a.course_digest=$2 AND a.id=ANY($3::uuid[]) LIMIT 200`,
  [context.enrollment.id, context.digest, window.map(row => row.attempt_id).filter(validId), scope.objectiveIds, scope.episodeId])).rows;
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
      const proposal = (await client.query<{ suggestion: Suggestion; course_digest: string }>('SELECT suggestion,course_digest FROM learner_model_proposals WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3', [proposalId, id, context.enrollment.workspace_id])).rows[0];
      requireCondition(proposal, 'PROPOSAL_NOT_FOUND', 404);
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
