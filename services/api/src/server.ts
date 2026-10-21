import {registerResearchRoutes} from './research-routes.js';
import {registerPeopleRoutes} from './people-routes.js';
import {registerDataLifecycleRoutes} from './data-lifecycle.js';
import {registerAccountErasureRoutes} from './account-erasure.js';
import {registerPlacementRoutes} from './placement.js';
import {registerRubricReviewRoutes} from './rubric-review.js';
import {registerRetentionRoutes} from './retention.js';
import { serverClock, type Clock } from './clock.js';
import {registerPersonalChangeRoutes} from './personal-changes.js';
import {registerResearchReviewRoutes,productionResearchInspector,type ResearchInspectorPort} from './research-review.js';
import {verifyResearchCollection} from './research-verifier.js';
import {createMediaJobService,registerMediaJobRoutes,workspaceMediaResolver,type MediaJobOptions,type MediaRuntimeResolver} from './media-jobs.js';
import {activateResearchWithin} from './research-store.js';
import {applyResourceChoicesWithin,registerResearchMediaRoutes,workspaceYouTubeSearch,type YouTubeSearchPort} from './research-media.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { compileCourse, CourseValidationError } from '@course-core/sdk/compiler';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { authService, type AuthOptions } from './auth.js';
import { COURSE_SCOPED, memberRole, permitCourse, workspaceRole } from './course-access.js';
import { ApiError, requireCondition } from './errors.js';
import type { PoolClient } from 'pg';
import { appendEvent } from './events.js';
import { registerClientEnvelope } from './event-envelope.js';
import { EVENT_COLUMNS, registerEventStream, type EventStreamOptions } from './event-stream.js';
import { enrollmentCommand, loadEnrollment, policyEpisodeId, type CommandInput, type Release } from './repository.js';
import { audienceOf, eventPayloadFor, STAFF_EVENT_PAYLOAD_RULE } from './learner-privacy.js';
import { episodes, requireAvailable } from './learning.js';
import { registerGateReviewRoutes } from './gate-reviews.js';
import { registerEvidenceDisputeRoutes } from './evidence-disputes.js';
import { registerScopedCorrectionRoutes } from './scoped-corrections.js';
import { activateWindows, assertPolicyAction, assertPublishable, enrollmentPolicy } from './policy-adapter.js';
import { registerPolicyRoutes } from './policy-routes.js';
import { PolicyError } from '@course-core/policy';
import { assertCourseRunnable, prepareCourseRunnable, type RuntimeExtension } from './publication.js';
import { registerCompanionRoutes } from './companion-routes.js';
import { registerCompanionContextRoutes } from './context-capsule.js';
import { registerSupervisorBridge, type SupervisorBridgeOptions } from './supervisor-bridge.js';
import { registerProviderGateway } from './provider-gateway.js';
import type { ProviderRuntime } from './provider-runtime.js';
import { unconfiguredProviders } from './provider-composition.js';
import { verifyCompanionBoundary } from './companion-verifier.js';
import {registerSupervisionRoutes} from './supervision-routes.js';
import { registerStudyRoutes } from './study-routes.js';
import {verifySupervisorPlan} from './supervisor-plan-verifier.js';
import {applyReviewedSupervisorSupport,applyGeneratedSupervisorTeaching} from './adaptation-store.js';
import {applySupervisorModelSuggestion} from './supervisor-learner-model.js';
import { ensureCatalog, registerAdminRoutes, selectCatalogueReleaseWithin, type AdminRuntimeOptions } from './admin-routes.js';
import { registerAdminSectionRoutes } from './admin-sections.js';
import { registerPolicyAdminRoutes } from './policy-admin-routes.js';
import { registerLearnerModelRoutes } from './learner-model.js';
import { registerConceptMappingRoutes } from './concept-mappings.js';
import { registerCrossCourseRoutes } from './cross-course.js';
import { registerAgentToolRoutes } from './agent-tools-routes.js';
import { registerTeachingHypothesisRoutes } from './teaching-hypotheses.js';
import { registerAdaptationRoutes } from './adaptation-routes.js';
import {createAdaptationRuntime,type AdaptationRuntime} from './adaptation-store.js';
import {adaptationDescriptors} from './adaptation-composition.js';
import type {WorkspaceProviders} from './provider-setup.js';
import {registerProviderSetupRoutes} from './provider-setup-routes.js';
import {registerProviderEvalRoutes} from './agent-evals/routes.js';
import {ProviderEvaluations} from './agent-evals/gate.js';
import {registerProviderCostRoutes} from './provider-costs.js';
import {ProviderConnections,registerProviderConnectionRoutes} from './provider-connections.js';
import {ProviderDrafts,registerProviderDraftRoutes} from './provider-drafts.js';
import { registerRubricAssistRoutes, verifyRubricSuggestion } from './rubric-assist.js';
import { deterministicConversationConfirmer } from './conversation-confirmation.js';
import { registerRubricAppealRoutes } from './rubric-appeals.js';
import { registerHttpTelemetry } from './telemetry.js';
import { enrollmentState, learnerSnapshot } from './learner-snapshot.js';
import { registerAssessmentRoutes } from './assessment-routes.js';
import { registerGateDecisionRoutes } from './gate-decisions.js';
import { registerLearnerViewRoutes } from './learner-view.js';
import { configureArtifactStore, type ArtifactStore } from './artifact-store.js';
import { registerVisualObservationRoutes } from './visual-observations.js';
import { registerActivityRoutes } from './activity-routes.js';
import { IMMUTABLE_ASSET, registerPythonRunnerRoutes, type PythonRunnerOptions } from './python-runner.js';
import { registerCoursePackageRoutes, type CoursePackageOptions } from './course-package-routes.js';
import { registerCourseUpdateRoutes } from './course-update-routes.js';
import { registerLocaleRoutes } from './locale.js';
import { runAutomaticUpdates } from './course-updates.js';
import type { PackageDirectory } from './course-package-directory.js';

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

/** The page policy. Only the debug inspector page (framed by the learner app) relaxes frame-ancestors, to this origin. */
const contentSecurityPolicy = (frameAncestors: "'none'" | "'self'") => `default-src 'self'; script-src 'self' https://www.youtube.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src 'self' https://www.youtube-nocookie.com; frame-ancestors ${frameAncestors}; object-src 'none'; base-uri 'none'; form-action 'self'`;
export async function createServer(db: Database, options: AuthOptions & { instanceId?: string; researchInspector?: ResearchInspectorPort; youtubeSearch?: YouTubeSearchPort; learnerDirectory?: string; adminDirectory?: string; installedExtensions?: RuntimeExtension[]; supervisor?: SupervisorBridgeOptions; providers?: ProviderRuntime; workspaceProviders?:WorkspaceProviders; adaptation?: AdaptationRuntime; media?: { resolver?: MediaRuntimeResolver; options?: MediaJobOptions };
  /** Bounds of the resumable event stream (event-stream.ts); tests shorten them. */
  eventStream?: EventStreamOptions;
  /** Test-only time source for retention due-ness; refused unless NODE_ENV=test (see clock.ts). */
  clock?: Clock;
  /** Optional S3-compatible store for large artifacts (artifact-store.ts). Omitted: unchanged; null: inline Postgres only. */
  artifactStore?: ArtifactStore | null;
  /** Course-package installation (course-package-routes.ts): host files, remote-fetch switch and test seams. */
  coursePackages?: Omit<CoursePackageOptions, 'adaptation' | 'installedExtensions'>;
  /** Host directories course updates may read packages from (course-package-directory.ts). */
  coursePackageDirectories?: readonly PackageDirectory[];
  /** Runs due automatic course updates this often (ms, at least 60 000); omitted: never. */
  courseUpdateTickMs?: number;
  /** Browser practice runs of Python (python-runner.ts). Omitted: enabled with default limits. */
  pythonRunner?: PythonRunnerOptions }) {
  const clock = serverClock(options.clock);
  if (options.artifactStore !== undefined) configureArtifactStore(options.artifactStore);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  registerHttpTelemetry(app);
  registerClientEnvelope(app);
  await app.register(cookie);
  const auth = authService(db, options);
  const adaptation=options.adaptation??createAdaptationRuntime([]);
  app.addHook('onSend', async (request, reply) => {
    // Only the content-addressed Pyodide files (versioned path, pinned SHA-256) may be cached.
    const immutable = (request.routeOptions.config as { immutableAsset?: boolean } | undefined)?.immutableAsset === true && reply.statusCode === 200;
    reply.header('Cache-Control', immutable ? IMMUTABLE_ASSET : 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    // A sandboxed activity or Python runner frame sets its own, stricter policy (activity-routes.ts,
    // python-runner.ts), and the debug inspector page allows only this origin to frame it (below).
    // Every other response keeps frame-ancestors 'none'.
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', contentSecurityPolicy("'none'"));
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
  registerLocaleRoutes(app, db, auth);
  if(options.workspaceProviders)registerProviderSetupRoutes(app,db,auth,options.workspaceProviders);
  if(options.workspaceProviders)registerProviderEvalRoutes(app,auth,new ProviderEvaluations(db,options.workspaceProviders));
  if(options.workspaceProviders){
    const connections=new ProviderConnections(db,options.workspaceProviders);
    registerProviderConnectionRoutes(app,auth,connections);
    registerProviderDraftRoutes(app,auth,new ProviderDrafts(db,options.workspaceProviders,connections));
  }
  // Pricing and spend views read the workspace's own bound models; they never contact a provider.
  registerProviderCostRoutes(app,db,auth,async(workspaceId,client)=>await options.workspaceProviders?.resolve(workspaceId,client)??providers);
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok', application: 'course-core', instanceId: options.instanceId ?? null }; });
  app.get('/api/workspaces', async request => {
    const actor = await auth.authenticate(request);
    return (await db.query('SELECT w.id,w.slug,w.title,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.title', [actor.id])).rows;
  });
  app.get('/api/runtime/extensions', async request => {
    await auth.authenticate(request);
    // Each installed build, followed by the reviewed prior builds of it that Core still
    // accepts in course declarations (exact version and integrity, same runtime).
    // Visual renderers also advertise the render features each accepted build supports.
    return { extensions: (options.installedExtensions ?? []).flatMap(({ id, version, integrity, capabilities, platforms, codeReady, acceptedPriorBuilds, renderFeatures }) => [
      { id, version, integrity, capabilities, platforms, codeReady: codeReady ?? null, acceptedPriorBuild: false,
        ...(renderFeatures ? { renderFeatures: renderFeatures({ version, integrity }) } : {}) },
      ...(acceptedPriorBuilds ?? []).map(prior => ({ id, version: prior.version, integrity: prior.integrity, capabilities, platforms, codeReady: codeReady ?? null,
        acceptedPriorBuild: true, installedVersion: version, ...(renderFeatures ? { renderFeatures: renderFeatures(prior) } : {}) })),
    ]) };
  });
  app.get('/api/runtime/adaptation-adapters',async request=>{await auth.authenticate(request);return {adapters:adaptationDescriptors(adaptation)};});
  app.get('/api/admin/runtime/adaptation-adapters',async request=>{await auth.authenticate(request);return {adapters:adaptationDescriptors(adaptation)};});
  app.get('/api/workspaces/:workspaceId/courses', { schema: { params: { type: 'object', properties: { workspaceId: uuid }, required: ['workspaceId'] }, querystring: { type:'object',additionalProperties:false,properties:{includeHistorical:{type:'string',enum:['true','false']}} } } }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    const role = await memberRole(db, actor, workspaceId);
    const historical = (request.query as {includeHistorical?:string}).includeHistorical === 'true';
    if (historical) requireCondition(['owner','admin','author','reviewer','instructor','observer'].includes(role),'FORBIDDEN',403);
    return (await db.query(`SELECT r.id,r.course_key,r.version,r.digest,r.status,r.learner_bundle->>'title' AS title,r.learner_bundle->>'summary' AS summary,r.learner_bundle->'policy' AS policy
      FROM course_releases r LEFT JOIN admin_course_catalog c ON c.workspace_id=r.workspace_id AND c.course_key=r.course_key
      WHERE r.workspace_id=$1 AND (r.status='published' OR $3) AND ($2 OR (r.status='published' AND c.active_release_id=r.id)) ORDER BY r.created_at DESC,r.id`, [workspaceId, historical, ['owner','admin','author','reviewer'].includes(role)])).rows;
  });
  app.post('/api/workspaces/:workspaceId/releases', { bodyLimit: 16 * 1024 * 1024, schema: { params: { type: 'object', properties: { workspaceId: uuid }, required: ['workspaceId'] } } }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    // Workspace authors import any course; a course-scoped author only a new version of the
    // course their active grant names (course-access.ts).
    const scoped = await memberRole(db, actor, workspaceId) === COURSE_SCOPED;
    if (!scoped) await workspaceRole(db, actor, workspaceId, ['owner', 'admin', 'author']);
    // Refuse before compiling when no active grant could allow an import at all.
    else requireCondition((await db.query(`SELECT 1 FROM course_access_grants WHERE workspace_id=$1 AND user_id=$2 AND role='author'
      AND revoked_at IS NULL AND expires_at > clock_timestamp() LIMIT 1`, [workspaceId, actor.id])).rowCount, 'FORBIDDEN', 403);
    const course = compileCourse(request.body), releaseId = randomUUID();
    if (scoped) {
      const catalogId = (await db.query<{ id: string }>('SELECT id FROM admin_course_catalog WHERE workspace_id=$1 AND course_key=$2', [workspaceId, course.server.id])).rows[0]?.id ?? null;
      await permitCourse(db, actor, workspaceId, catalogId, 'course.write');
    }
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
      await workspaceRole(client, actor, release.workspace_id, ['owner', 'admin']);
      const catalogId = await ensureCatalog(client,release.id);
      await client.query('SELECT id FROM admin_course_catalog WHERE id=$1 FOR UPDATE',[catalogId]);
      release = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1 FOR UPDATE',[releaseId])).rows[0]!;
      requireCondition(release.status !== 'archived', 'RELEASE_ARCHIVED', 409);
      if (release.status === 'draft') {
        await prepareCourseRunnable(release.server_bundle, options.installedExtensions);
        assertCourseRunnable(release.server_bundle, options.installedExtensions);
        await assertPublishable(client, releaseId, release.server_bundle);
        await client.query("UPDATE course_releases SET status='published' WHERE id=$1", [releaseId]);
        await selectCatalogueReleaseWithin(client,catalogId,releaseId);
        await client.query('UPDATE admin_course_catalog SET revision=revision+1 WHERE id=$1',[catalogId]);
        await appendEvent(client, { workspaceId: release.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'course.published', payload: { releaseId }, idempotencyKey: `release:${releaseId}:publish` });
      }
      return { id: releaseId, status: 'published' };
    });
  });
  app.post('/api/enrollments', { schema: { body: { type: 'object', additionalProperties: false, required: ['releaseId'], properties: { releaseId: uuid, acceptDocumentedGaps: { type: 'boolean' } } } } }, async request => {
    const actor = await auth.authenticate(request), { releaseId, acceptDocumentedGaps } = request.body as { releaseId: string; acceptDocumentedGaps?: boolean };
    return transaction(db, async client => {
      // Serialize enrollment creation for this learner/release without blocking unrelated users.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`enroll:${releaseId}:${actor.id}`]);
      const release = (await client.query<Release>("SELECT * FROM course_releases WHERE id=$1 AND status='published'", [releaseId])).rows[0];
      requireCondition(release, 'RELEASE_NOT_FOUND', 404);
      await memberRole(client, actor, release.workspace_id, ['owner', 'admin', 'instructor', 'learner']);
      const old = (await client.query<{ id: string; status: string }>('SELECT id,status FROM enrollments WHERE course_release_id=$1 AND user_id=$2', [releaseId, actor.id])).rows[0];
      requireCondition(!old || old.status !== 'erased', 'ENROLLMENT_ERASED', 409);
      if (old) return { id: old.id };
      const enrollmentId = randomUUID(), now = new Date().toISOString();
      // Refused with disclosed issues and alternatives when the core path cannot fit (P18).
      const { policy, feasibility } = await enrollmentPolicy(client, releaseId, release.server_bundle, enrollmentId, actor.id, now, { acceptDocumentedGaps: acceptDocumentedGaps === true });
      await client.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [enrollmentId, release.workspace_id, releaseId, actor.id, JSON.stringify(release.server_bundle.policy), JSON.stringify({ displayName: actor.displayName, goal: '', pace: 'steady' }), now]);
      await client.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(policy)]);
      const firstEpisode = episodes(release.server_bundle)[0];
      if (firstEpisode) {
        await activateWindows(client, release.server_bundle, enrollmentId, firstEpisode.id, now, 'scope_assigned');
        await assertPolicyAction(client, enrollmentId, firstEpisode.id, 'plan', now);
      }
      await appendEvent(client, { workspaceId: release.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'enrollment.started', payload: { releaseId, feasible: feasibility.feasible, issueCodes: feasibility.issues.map(i => i.code) }, idempotencyKey: `${enrollmentId}:started`, supervise: true });
      return { id: enrollmentId, feasibility };
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
    const audience = audienceOf(actor.id, context.enrollment);
    const rows = (await db.query<{ sequence: string; actor_kind: string; event_type: string; payload: unknown }>(`SELECT ${EVENT_COLUMNS} FROM learning_events
      WHERE enrollment_id=$1 AND workspace_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100`, [enrollmentId, context.enrollment.workspace_id, after])).rows;
    // The shared privacy rule (learner-privacy.ts): the learner reads every payload of their own
    // record; staff read only allowlisted staff/system payloads, as the workspace audit log does.
    const events = rows.map(row => ({ ...row, ...eventPayloadFor(audience, row.actor_kind, row.event_type, row.payload) }));
    return { events, nextCursor: rows.at(-1)?.sequence ?? after, ...(audience === 'staff' ? { withheld: [STAFF_EVENT_PAYLOAD_RULE] } : {}) };
  });
  registerEventStream(app, db, auth, options.eventStream);
  app.post(`${commandPath}/profile`, { schema: { params: enrollmentParams, body: commandSchema({ identityOnly: { type: 'boolean' }, profile: { type: 'object', additionalProperties: false, required: ['displayName', 'goal', 'pace'], properties: { displayName: { type: 'string', minLength: 1, maxLength: 100 }, goal: { type: 'string', maxLength: 2000 }, pace: { enum: ['gentle', 'steady', 'focused'] } } } }, ['profile']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input;
    return enrollmentCommand(db, actor, enrollmentId, 'profile', input, async (client, context) => {
      const requested = input.profile as { displayName: string; goal: string; pace: string };
      const profile = input.identityOnly ? { ...context.enrollment.profile, displayName: requested.displayName } : requested;
      await client.query('UPDATE enrollments SET profile=$2,profile_revision=profile_revision+1,revision=revision+1 WHERE id=$1', [enrollmentId, JSON.stringify(profile)]);
      if (!input.identityOnly) await client.query(`UPDATE learner_model_profiles SET profile=jsonb_set(profile,'{preferences}',COALESCE(profile->'preferences','{}'::jsonb)||$2::jsonb)
        WHERE enrollment_id=$1 AND manually_edited`, [enrollmentId, JSON.stringify({ goal: requested.goal, pace: requested.pace })]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'profile.updated', payload: { profileRevision: context.enrollment.profile_revision + 1 }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return await state(client, await loadEnrollment(client, actor, enrollmentId));
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
      // Reading (and switching episode) is navigation: it never fences a companion answer in preparation (migration 053).
      await client.query('UPDATE enrollments SET revision=revision+1,navigation_revision=navigation_revision+1,current_episode_id=$2 WHERE id=$1', [enrollmentId, scoped]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'block.read', payload: { episodeId: input.episodeId, blockId: input.blockId, grantsMastery: false }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return await state(client, await loadEnrollment(client, actor, enrollmentId));
    });
  });
  const providers = options.providers ?? unconfiguredProviders();
  const reviewerAvailable = async (workspaceId: string) => (await options.workspaceProviders?.resolve(workspaceId) ?? providers).availability('reviewer').status === 'ready';
  // The supervisor proposes quoted findings for gate conversations only where its bridge runs and a reviewer model is ready.
  const proposalsAvailable = async (workspaceId: string) => Boolean(options.supervisor) && await reviewerAvailable(workspaceId);
  registerAssessmentRoutes(app, db, auth, options.installedExtensions ?? [], clock, proposalsAvailable);
  registerActivityRoutes(app, db, auth, options.installedExtensions ?? []);
  registerVisualObservationRoutes(app, db, auth);
  await registerPythonRunnerRoutes(app, options.pythonRunner);
  registerGateDecisionRoutes(app, db, auth);
  registerGateReviewRoutes(app, db, auth);
  registerEvidenceDisputeRoutes(app, db, auth);
  registerScopedCorrectionRoutes(app, db, auth, () => options.installedExtensions ?? []);
  registerPolicyRoutes(app, db, auth);
  registerCompanionRoutes(app, db, auth, options.installedExtensions);
  registerCompanionContextRoutes(app, db, auth);
  registerLearnerModelRoutes(app, db, auth);
  registerConceptMappingRoutes(app, db, auth);
  registerCrossCourseRoutes(app, db, auth);
  registerAgentToolRoutes(app, db, auth);
  registerTeachingHypothesisRoutes(app, db, auth);
  registerAdaptationRoutes(app, db, auth, adaptation);
  registerSupervisionRoutes(app,db,auth);
  registerStudyRoutes(app, db, auth);
  registerResearchRoutes(app,db,auth);
  registerPeopleRoutes(app,db,auth);
  registerDataLifecycleRoutes(app,db,auth);
  registerAccountErasureRoutes(app,db,auth);
  registerPlacementRoutes(app,db,auth);
  registerRubricReviewRoutes(app,db,auth,proposalsAvailable);
  registerRubricAppealRoutes(app, db, auth);
  registerRubricAssistRoutes(app, db, auth, reviewerAvailable);
  registerRetentionRoutes(app,db,auth,clock);
  registerPersonalChangeRoutes(app,db,auth);
  registerLearnerViewRoutes(app,db,auth,{ inspector: Boolean(options.adminDirectory) });
  registerResearchReviewRoutes(app,db,auth,options.researchInspector ?? productionResearchInspector());
  // YouTube search uses only an admin-configured workspace key; without one it is unavailable.
  registerResearchMediaRoutes(app,db,auth,options.youtubeSearch ?? (options.workspaceProviders?workspaceYouTubeSearch((workspaceId,name)=>options.workspaceProviders!.credential(workspaceId,name)):undefined));
  // Generated media: staff-reviewed, paid-work-admitted jobs. Without workspace providers every request is refused.
  registerMediaJobRoutes(app,db,auth,createMediaJobService(db,options.media?.resolver??(options.workspaceProviders?workspaceMediaResolver(options.workspaceProviders):undefined),options.media?.options));
  registerPolicyAdminRoutes(app, db, auth);
  registerAdminSectionRoutes(app, db, auth);
  const adminRuntime: AdminRuntimeOptions = { installedExtensions: options.installedExtensions ?? [], insecureOriginsAllowed: options.allowInsecureOrigins === true, providerStatus: async (workspaceId,client) => {const runtime=await options.workspaceProviders?.resolve(workspaceId,client)??providers;return {models:runtime.describe(),roles:runtime.status()};} };
  registerAdminRoutes(app, db, auth, adminRuntime);
  const coursePackages: CoursePackageOptions = { ...options.coursePackages, adaptation, installedExtensions: options.installedExtensions ?? [] };
  registerCoursePackageRoutes(app, db, auth, coursePackages, adminRuntime);
  const updater = { directories: options.coursePackageDirectories ?? [], packages: coursePackages, admin: adminRuntime };
  registerCourseUpdateRoutes(app, db, auth, updater);
  if (options.courseUpdateTickMs !== undefined) {
    if (!Number.isInteger(options.courseUpdateTickMs) || options.courseUpdateTickMs < 60_000) throw new Error('courseUpdateTickMs must be at least 60000.');
    // Single-flight across processes (advisory lock); failures are recorded per course and logged as codes only.
    const timer = setInterval(() => {
      void runAutomaticUpdates(db, updater).catch(error => {
        const code = (error as { code?: unknown })?.code;
        process.stderr.write(`${JSON.stringify({ event: 'course_update.failure', code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'INTERNAL_ERROR' })}\n`);
      });
    }, options.courseUpdateTickMs);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  if (options.supervisor) {
    registerSupervisorBridge(app, db, { ...options.supervisor,...(options.workspaceProviders?{providerBinding:(client,workspaceId)=>options.workspaceProviders!.bind(client,workspaceId)}:{}), confirmRubricSuggestion: options.supervisor.confirmRubricSuggestion ?? deterministicConversationConfirmer(options.installedExtensions ?? []), beforeVerify: options.supervisor.beforeVerify ?? (async ref=>{await verifyCompanionBoundary(db,ref);await verifySupervisorPlan(db,ref,adaptation);await verifyResearchCollection(db,ref);await verifyRubricSuggestion(db,ref);}),applyPlan:async(client,ref,plan)=>{const effects=[];if(plan.selection)effects.push(await applyReviewedSupervisorSupport(client,ref,plan.selection,adaptation));if(plan.generatedTeaching)effects.push(await applyGeneratedSupervisorTeaching(client,ref,plan.generatedTeaching,adaptation));if(plan.researchSelections?.length)effects.push(await activateResearchWithin(client,ref,plan.researchSelections));if(plan.resourceChoices?.length)effects.push(await applyResourceChoicesWithin(client,ref,plan.resourceChoices));if(plan.modelSuggestion)effects.push(await applySupervisorModelSuggestion(client,ref,plan.modelSuggestion));return effects;} });
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
    // The debug inspector the learner app opens beside an activity for authorized staff. The page is
    // the admin app; every read and reveal it makes goes through the admin routes' own checks.
    app.get('/admin/inspector', async (_request, reply) => reply.header('Content-Security-Policy', contentSecurityPolicy("'self'")).sendFile('index.html', options.adminDirectory!));
  }
  return app;
}
