import {registerResearchRoutes} from './research-routes.js';
import {registerPeopleRoutes} from './people-routes.js';
import {registerDataLifecycleRoutes} from './data-lifecycle.js';
import {registerPlacementRoutes} from './placement.js';
import {RUBRIC_RESPONSE_LIMITS,rubricDigest} from './rubric-evaluator.js';
import {registerRubricReviewRoutes} from './rubric-review.js';
import {registerRetentionRoutes,recordRetentionOutcome} from './retention.js';
import { serverClock, type Clock } from './clock.js';
import {registerPersonalChangeRoutes,optionalPersonalBlocks} from './personal-changes.js';
import {registerResearchReviewRoutes,productionResearchInspector,type ResearchInspectorPort} from './research-review.js';
import {verifyResearchCollection} from './research-verifier.js';
import {createMediaJobService,registerMediaJobRoutes,workspaceMediaResolver,type MediaJobOptions,type MediaRuntimeResolver} from './media-jobs.js';
import {activateResearchWithin} from './research-store.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { compileCourse, CourseValidationError } from '@course-core/sdk/compiler';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { authService, membership, type AuthOptions } from './auth.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { enrollmentCommand, loadEnrollment, policyEpisodeId, type CommandInput, type Release } from './repository.js';
import { episodes, gateDecision, gradeDeterministic, publicQuestion, requireAvailable } from './learning.js';
import { activateWindows, assertPolicyAction, initialPolicy } from './policy-adapter.js';
import { registerPolicyRoutes } from './policy-routes.js';
import { PolicyError, checkAction } from '@course-core/policy';
import { assertCourseRunnable, prepareCourseRunnable, type RuntimeExtension } from './publication.js';
import { registerCompanionRoutes } from './companion-routes.js';
import { closeCompletedCourse } from './closure.js';
import { registerSupervisorBridge, type SupervisorBridgeOptions } from './supervisor-bridge.js';
import { registerProviderGateway } from './provider-gateway.js';
import type { ProviderRuntime } from './provider-runtime.js';
import { unconfiguredProviders } from './provider-composition.js';
import { verifyCompanionBoundary } from './companion-verifier.js';
import {registerSupervisionRoutes} from './supervision-routes.js';
import {verifySupervisorPlan} from './supervisor-plan-verifier.js';
import {applyReviewedSupervisorSupport,applyGeneratedSupervisorTeaching} from './adaptation-store.js';
import {applySupervisorModelSuggestion} from './supervisor-learner-model.js';
import { qualifiedCodeEvaluator } from './code-evaluator.js';
import { ensureCatalog, registerAdminRoutes, selectCatalogueReleaseWithin } from './admin-routes.js';
import { registerLearnerModelRoutes } from './learner-model.js';
import { registerAdaptationRoutes } from './adaptation-routes.js';
import {createAdaptationRuntime,type AdaptationRuntime} from './adaptation-store.js';
import {adaptationDescriptors} from './adaptation-composition.js';
import type {WorkspaceProviders} from './provider-setup.js';
import {registerProviderSetupRoutes} from './provider-setup-routes.js';
import { registerRubricAssistRoutes, verifyRubricSuggestion } from './rubric-assist.js';
import { registerRubricAppealRoutes } from './rubric-appeals.js';
import { declarationMatchesInstalled } from './extension-identity.js';
import { registerHttpTelemetry } from './telemetry.js';
import { enrollmentState, learnerSnapshot } from './learner-snapshot.js';
import { registerLearnerViewRoutes } from './learner-view.js';

const uuid = { type: 'string', format: 'uuid' };
const id = { type: 'string', minLength: 1, maxLength: 200 };
const commandProperties = { expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' } };
function commandSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', additionalProperties: false, properties: { ...commandProperties, ...properties }, required: ['expectedRevision', 'idempotencyKey', ...required] };
}
const enrollmentParams = { type: 'object', properties: { enrollmentId: uuid }, required: ['enrollmentId'] };
const commandPath = '/api/enrollments/:enrollmentId';
type Input = CommandInput & Record<string, unknown>;
const state = enrollmentState;

export async function createServer(db: Database, options: AuthOptions & { instanceId?: string; researchInspector?: ResearchInspectorPort; learnerDirectory?: string; adminDirectory?: string; installedExtensions?: RuntimeExtension[]; supervisor?: SupervisorBridgeOptions; providers?: ProviderRuntime; workspaceProviders?:WorkspaceProviders; adaptation?: AdaptationRuntime; media?: { resolver?: MediaRuntimeResolver; options?: MediaJobOptions };
  /** Test-only time source for retention due-ness; refused unless NODE_ENV=test (see clock.ts). */
  clock?: Clock }) {
  const clock = serverClock(options.clock);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  registerHttpTelemetry(app);
  await app.register(cookie);
  const auth = authService(db, options);
  const adaptation=options.adaptation??createAdaptationRuntime([]);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code, ...(error.details ? { details: error.details } : {}) });
    if (error instanceof PolicyError) return reply.code(409).send({ error: error.code });
    if (error instanceof CourseValidationError) return reply.code(400).send({ error: 'INVALID_COURSE', issues: error.issues });
    if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const clientStatus = (error as { statusCode?: number }).statusCode;
    if (clientStatus && clientStatus >= 400 && clientStatus < 500) return reply.code(clientStatus).send({ error: 'INVALID_REQUEST' });
    const pgCode = (error as { code?: string }).code;
    if (pgCode === '23505') return reply.code(409).send({ error: 'ALREADY_EXISTS' });
    // Do not emit queries, credentials, answers or provider response bodies.
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  auth.routes(app);
  if(options.workspaceProviders)registerProviderSetupRoutes(app,db,auth,options.workspaceProviders);
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok', application: 'course-core', instanceId: options.instanceId ?? null }; });
  app.get('/api/workspaces', async request => {
    const actor = await auth.authenticate(request);
    return (await db.query('SELECT w.id,w.slug,w.title,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.title', [actor.id])).rows;
  });
  app.get('/api/runtime/extensions', async request => {
    await auth.authenticate(request);
    // Each installed build, followed by the reviewed prior builds of it that Core still
    // accepts in course declarations (exact version and integrity, same runtime).
    return { extensions: (options.installedExtensions ?? []).flatMap(({ id, version, integrity, capabilities, platforms, codeReady, acceptedPriorBuilds }) => [
      { id, version, integrity, capabilities, platforms, codeReady: codeReady ?? null, acceptedPriorBuild: false },
      ...(acceptedPriorBuilds ?? []).map(prior => ({ id, version: prior.version, integrity: prior.integrity, capabilities, platforms, codeReady: codeReady ?? null,
        acceptedPriorBuild: true, installedVersion: version })),
    ]) };
  });
  app.get('/api/runtime/adaptation-adapters',async request=>{await auth.authenticate(request);return {adapters:adaptationDescriptors(adaptation)};});
  app.get('/api/admin/runtime/adaptation-adapters',async request=>{await auth.authenticate(request);return {adapters:adaptationDescriptors(adaptation)};});
  app.get('/api/workspaces/:workspaceId/courses', { schema: { params: { type: 'object', properties: { workspaceId: uuid }, required: ['workspaceId'] }, querystring: { type:'object',additionalProperties:false,properties:{includeHistorical:{type:'string',enum:['true','false']}} } } }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    const role = await membership(db, actor, workspaceId);
    const historical = (request.query as {includeHistorical?:string}).includeHistorical === 'true';
    if (historical) requireCondition(['owner','admin','author','reviewer','instructor','observer'].includes(role),'FORBIDDEN',403);
    return (await db.query(`SELECT r.id,r.course_key,r.version,r.digest,r.status,r.learner_bundle->>'title' AS title,r.learner_bundle->>'summary' AS summary,r.learner_bundle->'policy' AS policy
      FROM course_releases r LEFT JOIN admin_course_catalog c ON c.workspace_id=r.workspace_id AND c.course_key=r.course_key
      WHERE r.workspace_id=$1 AND (r.status='published' OR $3) AND ($2 OR (r.status='published' AND c.active_release_id=r.id)) ORDER BY r.created_at DESC,r.id`, [workspaceId, historical, ['owner','admin','author','reviewer'].includes(role)])).rows;
  });
  app.post('/api/workspaces/:workspaceId/releases', { bodyLimit: 16 * 1024 * 1024, schema: { params: { type: 'object', properties: { workspaceId: uuid }, required: ['workspaceId'] } } }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    await membership(db, actor, workspaceId, ['owner', 'admin', 'author']);
    const course = compileCourse(request.body), releaseId = randomUUID();
    return transaction(db, async client => {
      await client.query(`INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)`,
        [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), actor.id]);
      await ensureCatalog(client, releaseId);
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'course.imported', payload: { releaseId, digest: course.digest }, idempotencyKey: `release:${releaseId}:import` });
      return { id: releaseId, digest: course.digest, status: 'draft' };
    });
  });
  app.post('/api/releases/:releaseId/publish', { schema: { params: { type: 'object', properties: { releaseId: uuid }, required: ['releaseId'] } } }, async request => {
    const actor = await auth.authenticate(request), { releaseId } = request.params as { releaseId: string };
    return transaction(db, async client => {
      let release = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1', [releaseId])).rows[0];
      requireCondition(release, 'RELEASE_NOT_FOUND', 404);
      await membership(client, actor, release.workspace_id, ['owner', 'admin']);
      const catalogId = await ensureCatalog(client,release.id);
      await client.query('SELECT id FROM admin_course_catalog WHERE id=$1 FOR UPDATE',[catalogId]);
      release = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1 FOR UPDATE',[releaseId])).rows[0]!;
      requireCondition(release.status !== 'archived', 'RELEASE_ARCHIVED', 409);
      if (release.status === 'draft') {
        await prepareCourseRunnable(release.server_bundle, options.installedExtensions);
        assertCourseRunnable(release.server_bundle, options.installedExtensions);
        await client.query("UPDATE course_releases SET status='published' WHERE id=$1", [releaseId]);
        await selectCatalogueReleaseWithin(client,catalogId,releaseId);
        await client.query('UPDATE admin_course_catalog SET revision=revision+1 WHERE id=$1',[catalogId]);
        await appendEvent(client, { workspaceId: release.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'course.published', payload: { releaseId }, idempotencyKey: `release:${releaseId}:publish` });
      }
      return { id: releaseId, status: 'published' };
    });
  });
  app.post('/api/enrollments', { schema: { body: { type: 'object', additionalProperties: false, required: ['releaseId'], properties: { releaseId: uuid } } } }, async request => {
    const actor = await auth.authenticate(request), { releaseId } = request.body as { releaseId: string };
    return transaction(db, async client => {
      // Serialize enrollment creation for this learner/release without blocking unrelated users.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`enroll:${releaseId}:${actor.id}`]);
      const release = (await client.query<Release>("SELECT * FROM course_releases WHERE id=$1 AND status='published'", [releaseId])).rows[0];
      requireCondition(release, 'RELEASE_NOT_FOUND', 404);
      await membership(client, actor, release.workspace_id, ['owner', 'admin', 'instructor', 'learner']);
      const old = (await client.query<{ id: string; status: string }>('SELECT id,status FROM enrollments WHERE course_release_id=$1 AND user_id=$2', [releaseId, actor.id])).rows[0];
      requireCondition(!old || old.status !== 'erased', 'ENROLLMENT_ERASED', 409);
      if (old) return { id: old.id };
      const enrollmentId = randomUUID(), now = new Date().toISOString();
      const policy = initialPolicy(release.server_bundle, enrollmentId, actor.id, now);
      await client.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [enrollmentId, release.workspace_id, releaseId, actor.id, JSON.stringify(release.server_bundle.policy), JSON.stringify({ displayName: actor.displayName, goal: '', pace: 'steady' }), now]);
      await client.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(policy)]);
      const firstEpisode = episodes(release.server_bundle)[0];
      if (firstEpisode) {
        await activateWindows(client, release.server_bundle, enrollmentId, firstEpisode.id, now, 'scope_assigned');
        await assertPolicyAction(client, enrollmentId, firstEpisode.id, 'plan', now);
      }
      await appendEvent(client, { workspaceId: release.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'enrollment.started', payload: { releaseId }, idempotencyKey: `${enrollmentId}:started`, supervise: true });
      return { id: enrollmentId };
    });
  });
  app.get('/api/enrollments', async request => {
    const actor = await auth.authenticate(request);
    return (await db.query(`SELECT e.id,e.status,e.revision,e.course_release_id AS "releaseId",c.learner_bundle->>'title' AS title,c.version,c.course_key FROM enrollments e
      JOIN course_releases c ON c.id=e.course_release_id JOIN memberships m ON m.workspace_id=e.workspace_id AND m.user_id=e.user_id
      WHERE e.user_id=$1 ORDER BY e.started_at DESC`, [actor.id])).rows;
  });
  app.get(commandPath, { schema: { params: enrollmentParams } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async client => {
      return learnerSnapshot(client, await loadEnrollment(client, actor, enrollmentId));
    });
  });
  app.get(`${commandPath}/events`, { schema: { params: enrollmentParams, querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'string', pattern: '^[0-9]{1,18}$' } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, { after = '0' } = request.query as { after?: string };
    const context = await loadEnrollment(db, actor, enrollmentId, false, true);
    const events = (await db.query(`SELECT sequence,id,actor_kind,event_type,payload,correlation_id,created_at FROM learning_events
      WHERE enrollment_id=$1 AND workspace_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100`, [enrollmentId, context.enrollment.workspace_id, after])).rows;
    return { events, nextCursor: events.at(-1)?.sequence ?? after };
  });
  app.post(`${commandPath}/profile`, { schema: { params: enrollmentParams, body: commandSchema({ identityOnly: { type: 'boolean' }, profile: { type: 'object', additionalProperties: false, required: ['displayName', 'goal', 'pace'], properties: { displayName: { type: 'string', minLength: 1, maxLength: 100 }, goal: { type: 'string', maxLength: 2000 }, pace: { enum: ['gentle', 'steady', 'focused'] } } } }, ['profile']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input;
    return enrollmentCommand(db, actor, enrollmentId, 'profile', input, async (client, context) => {
      const requested = input.profile as { displayName: string; goal: string; pace: string };
      const profile = input.identityOnly ? { ...context.enrollment.profile, displayName: requested.displayName } : requested;
      await client.query('UPDATE enrollments SET profile=$2,profile_revision=profile_revision+1,revision=revision+1 WHERE id=$1', [enrollmentId, JSON.stringify(profile)]);
      if (!input.identityOnly) await client.query(`UPDATE learner_model_profiles SET profile=jsonb_set(profile,'{preferences}',COALESCE(profile->'preferences','{}'::jsonb)||$2::jsonb)
        WHERE enrollment_id=$1 AND manually_edited`, [enrollmentId, JSON.stringify({ goal: requested.goal, pace: requested.pace })]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'profile.updated', payload: { profileRevision: context.enrollment.profile_revision + 1 }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return state(await loadEnrollment(client, actor, enrollmentId));
    });
  });
  app.post(`${commandPath}/read`, { schema: { params: enrollmentParams, body: commandSchema({ episodeId: id, blockId: id }, ['episodeId', 'blockId']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { episodeId: string; blockId: string };
    return enrollmentCommand(db, actor, enrollmentId, 'read', input, async (client, context) => {
      const episode = requireAvailable(context.release.server_bundle, context.release.digest, context.progress, context.evidence, input.episodeId);
      requireCondition(episode.blocks.some(block => block.id === input.blockId && block.type !== 'assessment' && block.type !== 'activity'), 'BLOCK_NOT_READING');
      const now = new Date().toISOString();
      const scoped = policyEpisodeId(context.release, input.episodeId);
      await activateWindows(client, context.release.server_bundle, enrollmentId, scoped, now);
      await assertPolicyAction(client, enrollmentId, scoped, 'read', now);
      const old = context.progress.find(row => row.episode_id === input.episodeId), completed = [...new Set([...(old?.completed_block_ids ?? []), input.blockId])];
      await client.query(`INSERT INTO episode_progress (enrollment_id,episode_id,state,completed_block_ids) VALUES ($1,$2,'started',$3)
        ON CONFLICT (enrollment_id,episode_id) DO UPDATE SET completed_block_ids=EXCLUDED.completed_block_ids`, [enrollmentId, input.episodeId, JSON.stringify(completed)]);
      await client.query('UPDATE enrollments SET revision=revision+1,current_episode_id=$2 WHERE id=$1', [enrollmentId, scoped]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'block.read', payload: { episodeId: input.episodeId, blockId: input.blockId, grantsMastery: false }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return state(await loadEnrollment(client, actor, enrollmentId));
    });
  });
  registerAssessmentRoutes(app, db, auth, options.installedExtensions ?? [], clock);
  registerPolicyRoutes(app, db, auth);
  registerCompanionRoutes(app, db, auth, options.installedExtensions);
  const providers = options.providers ?? unconfiguredProviders();
  registerLearnerModelRoutes(app, db, auth);
  registerAdaptationRoutes(app, db, auth, adaptation);
  registerSupervisionRoutes(app,db,auth);
  registerResearchRoutes(app,db,auth);
  registerPeopleRoutes(app,db,auth,options.origin);
  registerDataLifecycleRoutes(app,db,auth);
  registerPlacementRoutes(app,db,auth);
  registerRubricReviewRoutes(app,db,auth);
  registerRubricAppealRoutes(app, db, auth);
  registerRubricAssistRoutes(app, db, auth, async (workspaceId) => (await options.workspaceProviders?.resolve(workspaceId) ?? providers).availability('reviewer').status === 'ready');
  registerRetentionRoutes(app,db,auth,clock);
  registerPersonalChangeRoutes(app,db,auth);
  registerLearnerViewRoutes(app,db,auth);
  registerResearchReviewRoutes(app,db,auth,options.researchInspector ?? productionResearchInspector());
  // Generated media: staff-reviewed, paid-work-admitted jobs. Without workspace providers every request is refused.
  registerMediaJobRoutes(app,db,auth,createMediaJobService(db,options.media?.resolver??(options.workspaceProviders?workspaceMediaResolver(options.workspaceProviders):undefined),options.media?.options));
  registerAdminRoutes(app, db, auth, { installedExtensions: options.installedExtensions ?? [], providerStatus: async (workspaceId,client) => {const runtime=await options.workspaceProviders?.resolve(workspaceId,client)??providers;return {models:runtime.describe(),roles:runtime.status()};} });
  if (options.supervisor) {
    registerSupervisorBridge(app, db, { ...options.supervisor,...(options.workspaceProviders?{providerBinding:(client,workspaceId)=>options.workspaceProviders!.bind(client,workspaceId)}:{}), beforeVerify: options.supervisor.beforeVerify ?? (async ref=>{await verifyCompanionBoundary(db,ref);await verifySupervisorPlan(db,ref,adaptation);await verifyResearchCollection(db,ref);await verifyRubricSuggestion(db,ref);}),applyPlan:async(client,ref,plan)=>{const effects=[];if(plan.selection)effects.push(await applyReviewedSupervisorSupport(client,ref,plan.selection,adaptation));if(plan.generatedTeaching)effects.push(await applyGeneratedSupervisorTeaching(client,ref,plan.generatedTeaching,adaptation));if(plan.researchSelections?.length)effects.push(await activateResearchWithin(client,ref,plan.researchSelections));if(plan.modelSuggestion)effects.push(await applySupervisorModelSuggestion(client,ref,plan.modelSuggestion));return effects;} });
    registerProviderGateway(app, db, providers, {...options.supervisor,adaptation,...(options.workspaceProviders?{workspaceProviders:options.workspaceProviders}:{})});
  }
  app.get(`${commandPath}/provider-status`, { schema: { params: enrollmentParams } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const loaded=await loadEnrollment(db, actor, enrollmentId);
    return { roles: (await options.workspaceProviders?.resolve(loaded.enrollment.workspace_id)??providers).status(), liveVerification: 'not_run' };
  });
  if (options.learnerDirectory) {
    await app.register(serveStatic, { root: options.learnerDirectory, wildcard: false, index: false, dotfiles: 'deny' });
    app.get('/', async (_request, reply) => reply.sendFile('index.html', options.learnerDirectory!));
    app.get('/demo', async (_request, reply) => reply.sendFile('index.html', options.learnerDirectory!));
  }
  if (options.adminDirectory) {
    await app.register(serveStatic, { root: options.adminDirectory, prefix: '/admin/', wildcard: false, index: false, dotfiles: 'deny', decorateReply: !options.learnerDirectory });
    app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
    app.get('/admin/', async (_request, reply) => reply.sendFile('index.html', options.adminDirectory!));
  }
  return app;
}

function registerAssessmentRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installed: RuntimeExtension[], clock: Clock) {
  app.post(`${commandPath}/challenges`, { schema: { params: enrollmentParams, body: commandSchema({ episodeId: id, assessmentId: id, mode: { enum: ['practice', 'independent', 'placement'] } }, ['episodeId', 'mode']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { episodeId: string; assessmentId?: string; mode: string };
    return enrollmentCommand(db, actor, enrollmentId, 'challenge', input, async (client, context) => {
      const course = context.release.server_bundle, episode = episodes(course).find(row => row.id === input.episodeId);
      requireCondition(episode, 'EPISODE_NOT_FOUND', 404);
      const gate = course.gates.find(row => row.id === episode.gateId);
      const exposed = (await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1', [enrollmentId])).rows.map(row => row.assessment_id);
      const assessmentId = input.assessmentId ?? gate?.assessmentIds.find(candidate => !exposed.includes(candidate));
      requireCondition(assessmentId, 'FRESH_EVIDENCE_ITEM_REQUIRED', 409);
      if (input.mode === 'placement') {
        requireCondition(course.placement?.enabled && !course.placement.protectedEpisodeIds.includes(episode.id) && course.placement.assessmentIds.includes(assessmentId), 'PLACEMENT_UNAVAILABLE', 409);
        requireCondition(episode.objectiveIds.every(obj => course.placement!.objectiveIds.includes(obj)), 'PLACEMENT_UNAVAILABLE', 409);
        // Placement items exist only inside the learner's in-progress placement run.
        const run = (await client.query<{ state: string }>('SELECT state FROM placement_runs WHERE enrollment_id=$1 FOR UPDATE', [enrollmentId])).rows[0];
        requireCondition(run?.state === 'in_progress', 'PLACEMENT_RUN_REQUIRED', 409);
        requireCondition(!(await client.query("SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND mode='placement' AND attempt_id IS NULL AND expires_at>clock_timestamp()", [enrollmentId])).rowCount, 'PLACEMENT_ITEM_PENDING', 409);
        const count = (await client.query<{ count: string }>("SELECT count(*) FROM assessment_challenges WHERE enrollment_id=$1 AND mode='placement'", [enrollmentId])).rows[0]!;
        requireCondition(Number(count.count) < course.placement.maxItems, 'PLACEMENT_ITEM_LIMIT', 409);
      } else requireAvailable(course, context.release.digest, context.progress, context.evidence, input.episodeId);
      requireCondition(gate?.assessmentIds.includes(assessmentId) || episode.blocks.some(block => block.type === 'assessment' && block.assessmentId === assessmentId), 'ASSESSMENT_OUT_OF_SCOPE', 403);
      const assessment = course.assessments.find(row => row.id === assessmentId)!;
      if (assessment.type === 'code') qualifiedCodeEvaluator(assessment, course.extensions, installed);
      else if (assessment.type === 'rubric') requireCondition(installed.some(e => e.rubricReady && e.id === assessment.grading.evaluatorId && course.extensions.some(d => d.id === e.id && declarationMatchesInstalled(d, e))), 'EVALUATOR_NOT_CONFIGURED', 409);
      else requireCondition(assessment.type === 'choice' || assessment.type === 'numeric', 'EVALUATOR_NOT_CONFIGURED', 409);
      const now = new Date().toISOString();
      // Placement probes later material without starting its study clocks.
      if (input.mode !== 'placement') await activateWindows(client, course, enrollmentId, policyEpisodeId(context.release, input.episodeId), now);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'plan', now);
      const exposures = exposed.filter(id => id === assessmentId).length;
      const independentEligible = input.mode !== 'practice' && exposures === 0;
      const challengeId = randomUUID();
      await client.query(`INSERT INTO assessment_challenges (id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '60 minutes')`, [challengeId, enrollmentId, input.episodeId, assessmentId, context.release.digest, input.mode, independentEligible]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'assessment.issued', payload: { challengeId, assessmentId, mode: input.mode, independentEligible }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { challengeId, question: publicQuestion(assessment), independentEligible, revision: context.enrollment.revision + 1 };
    });
  });
  app.post(`${commandPath}/solution`, { schema: { params: enrollmentParams, body: commandSchema({ challengeId: uuid }, ['challengeId']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { challengeId: string };
    return enrollmentCommand(db, actor, enrollmentId, 'solution', input, async (client, context) => {
      const challenge = (await client.query<{ assessment_id: string; attempt_id: string | null }>('SELECT assessment_id,attempt_id FROM assessment_challenges WHERE id=$1 AND enrollment_id=$2', [input.challengeId, enrollmentId])).rows[0];
      requireCondition(challenge, 'CHALLENGE_NOT_FOUND', 404);
      requireCondition(!challenge.attempt_id, 'CHALLENGE_ALREADY_SUBMITTED', 409);
      const assessment = context.release.server_bundle.assessments.find(row => row.id === challenge.assessment_id)!;
      requireCondition(assessment.type === 'choice' || assessment.type === 'numeric', 'EVALUATOR_NOT_CONFIGURED', 409);
      await client.query("UPDATE assessment_challenges SET assistance='solution',independent_eligible=false WHERE id=$1", [input.challengeId]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'assessment.assisted', payload: { challengeId: input.challengeId, assistance: 'solution', independentEligible: false }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { explanation: assessment.grading.explanation, independentEligible: false, revision: context.enrollment.revision + 1 };
    });
  });
  app.post(`${commandPath}/answers`, { schema: { params: enrollmentParams, body: commandSchema({ challengeId: uuid, answer: { anyOf: [{ type: 'string', maxLength: 64000 }, { type: 'number' }] } }, ['challengeId', 'answer']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { challengeId: string; answer: unknown };
    return enrollmentCommand(db, actor, enrollmentId, 'answer', input, async (client, context) => {
      const challenge = (await client.query<{ id: string; episode_id: string; assessment_id: string; mode: string; assistance: string; independent_eligible: boolean; attempt_id: string | null; course_digest: string; expires_at: Date }>('SELECT * FROM assessment_challenges WHERE id=$1 AND enrollment_id=$2 FOR UPDATE', [input.challengeId, enrollmentId])).rows[0];
      requireCondition(challenge, 'CHALLENGE_NOT_FOUND', 404);
      requireCondition(!challenge.attempt_id, 'CHALLENGE_ALREADY_SUBMITTED', 409);
      requireCondition(challenge.expires_at.getTime() > Date.now(), 'CHALLENGE_EXPIRED', 409);
      requireCondition(challenge.course_digest === context.release.digest, 'COURSE_VERSION_CHANGED', 409);
      const course = context.release.server_bundle;
      if (challenge.mode !== 'placement') requireAvailable(course, context.release.digest, context.progress, context.evidence, challenge.episode_id);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, challenge.episode_id), 'submit', new Date().toISOString());
      const assessment = course.assessments.find(row => row.id === challenge.assessment_id)!;
      const independent = challenge.independent_eligible && challenge.assistance === 'none', attemptId = randomUUID();
      if (assessment.type === 'rubric') {
        // A written explanation earns nothing until an authorized reviewer cites it.
        requireCondition(typeof input.answer === 'string' && input.answer.trim().length >= RUBRIC_RESPONSE_LIMITS.min && input.answer.length <= RUBRIC_RESPONSE_LIMITS.max, 'INVALID_ANSWER');
        const pending = { status: 'pending_review', passed: false, evaluator: 'reviewed-rubric@1', rubricDigest: rubricDigest(assessment), independentEligible: independent };
        await client.query(`INSERT INTO attempts (id,enrollment_id,assessment_id,course_digest,family_id,mode,assistance,response,result,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [attemptId, enrollmentId, assessment.id, context.release.digest, assessment.familyId, challenge.mode, challenge.assistance, JSON.stringify(input.answer), JSON.stringify(pending), input.idempotencyKey]);
        await client.query('UPDATE assessment_challenges SET attempt_id=$2 WHERE id=$1', [challenge.id, attemptId]);
        await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
        await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'assessment.submitted', payload: { attemptId, assessmentId: assessment.id, pendingReview: true, independent }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
        return { result: { passed: false, pendingReview: true, explanation: 'Submitted for review against the rubric. It counts only after a reviewer cites your answer for every required criterion.', independent }, state: state(await loadEnrollment(client, actor, enrollmentId)) };
      }
      const result = assessment.type === 'code' ? await qualifiedCodeEvaluator(assessment, course.extensions, installed)(assessment, input.answer) : gradeDeterministic(assessment, input.answer);
      await client.query(`INSERT INTO attempts (id,enrollment_id,assessment_id,course_digest,family_id,mode,assistance,response,result,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [attemptId, enrollmentId, assessment.id, context.release.digest, assessment.familyId, challenge.mode, challenge.assistance, JSON.stringify(input.answer), JSON.stringify(result), input.idempotencyKey]);
      await client.query('UPDATE assessment_challenges SET attempt_id=$2 WHERE id=$1', [challenge.id, attemptId]);
      for (const objectiveId of assessment.objectiveIds) await client.query(`INSERT INTO evidence (id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), enrollmentId, attemptId, objectiveId, result.evaluator, JSON.stringify({ passed: result.passed }), independent]);
      if (challenge.mode === 'retention') await recordRetentionOutcome(client, context, attemptId, assessment.objectiveIds, result.passed, independent, clock.now());
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'assessment.submitted', payload: { attemptId, assessmentId: assessment.id, passed: result.passed, independent }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { result: { ...result, independent }, state: state(await loadEnrollment(client, actor, enrollmentId)) };
    });
  });
  app.post(`${commandPath}/complete`, { schema: { params: enrollmentParams, body: commandSchema({ episodeId: id, placement: { type: 'boolean' } }, ['episodeId']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { episodeId: string; placement?: boolean };
    return enrollmentCommand(db, actor, enrollmentId, 'complete', input, async (client, context) => {
      const course = context.release.server_bundle, episode = requireAvailable(course, context.release.digest, context.progress, context.evidence, input.episodeId);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'submit', new Date().toISOString());
      const gate = course.gates.find(row => row.id === episode.gateId), decision = gate ? gateDecision(gate, input.placement ? context.evidence.filter(row => row.mode === 'placement') : context.evidence, context.release.digest) : null;
      // Say exactly which objectives still need independent evidence, as the lesson view does.
      if (gate && !decision?.passed) throw new ApiError(409, 'EVIDENCE_REQUIRED', 'EVIDENCE_REQUIRED', { missing: decision!.objectives.filter(o => !o.passed)
        .map(o => ({ objectiveId: o.id, independentFamilies: o.families.length, requiredFamilies: o.required })) });
      const progress = context.progress.find(row => row.episode_id === input.episodeId);
      // Exemptions are applied only by accepting a finished placement run.
      requireCondition(!input.placement, 'PLACEMENT_REQUIRES_RUN_ACCEPTANCE', 409);
      if (input.placement) {
        requireCondition(course.placement?.enabled && !course.placement.protectedEpisodeIds.includes(episode.id), 'PLACEMENT_UNAVAILABLE', 409);
        requireCondition(episode.objectiveIds.every(objective => course.placement!.objectiveIds.includes(objective)), 'PLACEMENT_UNAVAILABLE', 409);
        requireCondition(gate && decision?.passed, 'EVIDENCE_REQUIRED', 409);
      } else {
        // Optional personal additions never become required reading.
        const optional = optionalPersonalBlocks(context);
        const unread = episode.blocks.filter(block => block.type !== 'assessment' && block.type !== 'activity' && !optional.has(`${episode.id}/${block.id}`) && !progress?.completed_block_ids.includes(block.id)).map(block => block.id);
        if (unread.length) throw new ApiError(409, 'COVERAGE_REQUIRED', 'COVERAGE_REQUIRED', { unreadBlockIds: unread });
        requireCondition(!episode.blocks.some(block => block.type === 'activity'), 'ACTIVITY_EVIDENCE_REQUIRED', 409);
      }
      const refs = decision?.objectives.flatMap(row => row.evidenceIds) ?? [];
      await client.query(`INSERT INTO episode_progress (enrollment_id,episode_id,state,evidence_refs,completed_at) VALUES ($1,$2,$3,$4,now())
        ON CONFLICT (enrollment_id,episode_id) DO UPDATE SET state=EXCLUDED.state,evidence_refs=EXCLUDED.evidence_refs,completed_at=now()`, [enrollmentId, input.episodeId, input.placement ? 'placed' : 'completed', JSON.stringify(refs)]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: input.placement ? 'episode.placed' : 'episode.completed', payload: { episodeId: input.episodeId, evidenceIds: refs }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      let snapshot = state(await loadEnrollment(client, actor, enrollmentId));
      if (snapshot.nextEpisodeId) {
        await activateWindows(client, course, enrollmentId, policyEpisodeId(context.release, snapshot.nextEpisodeId), new Date().toISOString(), 'scope_assigned');
        snapshot = state(await loadEnrollment(client, actor, enrollmentId));
      }
      if (snapshot.complete) {
        await closeCompletedCourse(client, await loadEnrollment(client, actor, enrollmentId));
        snapshot = state(await loadEnrollment(client, actor, enrollmentId));
      }
      return snapshot;
    });
  });
}
