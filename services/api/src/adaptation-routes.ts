/**
 * Parent composition: registerAdaptationRoutes(app, db, auth, runtime).
 * No adapter is implicitly trusted: build runtime with createAdaptationRuntime and
 * explicitly installed boundedNumericalAdapter()/authoredVariantBankAdapter()/plugins.
 * Owner/admin approves matching release registry via the server-only store hook.
 *
 * GET  /api/enrollments/:enrollmentId/adaptation
 *   Authenticated enrollment owner or scoped staff; metadata/family IDs only.
 * POST /api/enrollments/:enrollmentId/adaptation/fresh-question
 *   Owner only; {expectedRevision,expectedPlanRevision,idempotencyKey,episodeId,
 *   objectiveId,familyId,mode:'independent'|'practice',allowAssessmentAssistance?}.
 *   Uses approved server recipe/variables or authored bank, verifies, applies and
 *   issues a normal challenge atomically. Existing answers/solution routes consume
 *   it after the parent wires resolveEnrollmentCourse into repository/learning.
 * POST /api/enrollments/:enrollmentId/adaptation/:proposalId/apply
 *   Scoped owner/admin/instructor; {expectedRevision,expectedPlanRevision,idempotencyKey}.
 *   Applies only a server-staged, actually verified proposal, never browser proofs.
 * POST /api/admin/enrollments/:enrollmentId/adaptation/reviewed-episode
 *   Scoped owner/admin/instructor; {expectedRevision,expectedPlanRevision,idempotencyKey,
 *   profileId,entryId,stageOnly?}. Inserts (or with stageOnly only verifies and stages, for
 *   the apply route) one exact entry of an approved insert_episode teaching-bank profile.
 *   No model is involved; the supervisor's validated path, caps and audit apply.
 *
 * 400 unknown/input fields; 403/404 auth/scope; 409 stale/limit/proof/verification;
 * 503 installed adapter missing. Same-key retries replay the exact stored response.
 * No request may set a grading key, variables, cost, classification, credit or proof.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { loadEnrollment, type Release } from './repository.js';
import { workspaceRole } from './course-access.js';
import {requireCondition} from './errors.js';
import { readRelease } from './release-cache.js';
import { adaptationSummary, applyVerifiedAdaptation, createAdaptationRuntime, insertReviewedEpisode, requestFreshQuestion, type AdaptationRuntime,
  type FreshQuestionInput, type ReviewedEpisodeInput } from './adaptation-store.js';
import {approveAdaptationRegistry,type AdaptationConfiguration} from './adaptation-store.js';

const uuid = { type: 'string', format: 'uuid' };
const id = { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,127}$' };
const fields = { expectedRevision: { type: 'integer', minimum: 1 }, expectedPlanRevision: { type: 'integer', minimum: 0 },
  idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9:_-]{8,200}$' } };
const path = '/api/enrollments/:enrollmentId/adaptation';
const params = { type: 'object', additionalProperties: false, properties: { enrollmentId: uuid }, required: ['enrollmentId'] };
export function registerAdaptationRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, runtime: AdaptationRuntime = createAdaptationRuntime([])) {
  app.get('/api/admin/releases/:releaseId/adaptation-registry',{schema:{params:{type:'object',additionalProperties:false,required:['releaseId'],properties:{releaseId:uuid}}}},async request=>{
    const actor=await auth.authenticate(request),{releaseId}=request.params as {releaseId:string};
    const release=(await db.query<Release>('SELECT * FROM course_releases WHERE id=$1',[releaseId])).rows[0];requireCondition(release,'RELEASE_NOT_FOUND',404);
    await workspaceRole(db,actor,release.workspace_id,['owner','admin']);
    const row=(await db.query('SELECT r.revision,r.status,v.configuration_digest FROM adaptation_registries r JOIN adaptation_registry_versions v ON v.course_release_id=r.course_release_id AND v.revision=r.revision WHERE r.course_release_id=$1',[releaseId])).rows[0];
    return {registryRevision:row?.revision??0,configured:row?.status==='active',configurationDigest:row?.configuration_digest??null};
  });
  app.post('/api/admin/releases/:releaseId/adaptation-registry',{bodyLimit:2*1024*1024,schema:{params:{type:'object',additionalProperties:false,required:['releaseId'],properties:{releaseId:uuid}},body:{type:'object',additionalProperties:false,required:['expectedRegistryRevision','configuration'],properties:{expectedRegistryRevision:{type:'integer',minimum:0},configuration:{type:'object'}}}}},async request=>{
    const actor=await auth.authenticate(request),{releaseId}=request.params as {releaseId:string},input=request.body as {expectedRegistryRevision:number;configuration:AdaptationConfiguration};
    return approveAdaptationRegistry(db,actor,{releaseId,...input},runtime);
  });
  app.get(path, { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async client => {
      const loaded = await loadEnrollment(client, actor, enrollmentId, true, true);
      // The verified release and the course loadEnrollment already resolved; no second resolution.
      const base = (await readRelease(client, loaded.enrollment.course_release_id, loaded.enrollment.workspace_id))!;
      return adaptationSummary(client, loaded.enrollment, base, loaded.release.server_bundle);
    });
  });
  app.post(`${path}/fresh-question`, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: [...Object.keys(fields), 'episodeId','objectiveId','familyId','mode'], properties: { ...fields, episodeId: id, objectiveId: id, familyId: id,
      mode: { enum: ['independent','practice'] }, allowAssessmentAssistance: { type: 'boolean' } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return requestFreshQuestion(db, actor, { ...(request.body as Omit<FreshQuestionInput,'enrollmentId'>), enrollmentId }, runtime);
  });
  app.post('/api/admin/enrollments/:enrollmentId/adaptation/reviewed-episode', { schema: { params, body: { type: 'object', additionalProperties: false,
    required: [...Object.keys(fields), 'profileId', 'entryId'], properties: { ...fields, profileId: id, entryId: id, stageOnly: { type: 'boolean' } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return insertReviewedEpisode(db, actor, { ...(request.body as Omit<ReviewedEpisodeInput, 'enrollmentId'>), enrollmentId }, runtime);
  });
  app.post(`${path}/:proposalId/apply`, { schema: { params: { ...params, properties: { enrollmentId: uuid, proposalId: uuid }, required: ['enrollmentId','proposalId'] },
    body: { type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, proposalId } = request.params as { enrollmentId: string; proposalId: string };
    return applyVerifiedAdaptation(db, actor, { ...(request.body as { expectedRevision: number; expectedPlanRevision: number; idempotencyKey: string }), enrollmentId, proposalId });
  });
}
