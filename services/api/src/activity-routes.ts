import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { ActivityDefinition, Episode, Json, PlatformTarget } from '@course-core/sdk';
import { FORBIDDEN_CAPABILITIES, KNOWN_CAPABILITIES } from '@course-core/sdk';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { digestJson, loadEnrollment, policyEpisodeId, type EnrollmentContext } from './repository.js';
import { episodes, requireAvailable } from './learning.js';
import { assertPolicyAction } from './policy-adapter.js';
import type { RuntimeExtension } from './publication.js';
import { activityEvaluator, activityOf, assertInstalledActivityRuntimes, blockConfiguration, boundedJson, courseTargets, frameContentSecurityPolicy,
  frameDocument, isContractBlock, isJsonObject, jsonBytes, matchesSchema, resolveActivity, type ActivityBlock, type ActivityEvaluation, type ResolvedActivity } from './activity-runtime.js';

const uuid = { type: 'string', format: 'uuid' };
const id = { type: 'string', minLength: 1, maxLength: 200 };
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' };
const TARGETS = ['web_desktop', 'web_mobile', 'ios_phone', 'ipados_tablet', 'android_phone', 'android_tablet'];
/** Per-instance, per-minute budgets for calls the declared observation budget does not cover. A
 * denied call records a small fixed event (never its payload) until its budget is spent; after
 * that, and for state saves over budget, the answer is 429 and nothing is written. */
export const DENIED_CALLS_PER_MINUTE = 10;
export const STATE_SAVES_PER_MINUTE = 60;
async function takeBudget(client: PoolClient, instanceId: string, kind: 'patch' | 'denial', limit: number) {
  const start = `${kind}_window_start`, count = `${kind}_window_count`, expired = `${start} <= clock_timestamp() - interval '1 minute'`;
  const taken = await client.query(`UPDATE activity_instances SET ${start}=CASE WHEN ${expired} THEN clock_timestamp() ELSE ${start} END,
    ${count}=CASE WHEN ${expired} THEN 1 ELSE ${count}+1 END WHERE id=$1 AND (${expired} OR ${count} < $2) RETURNING id`, [instanceId, limit]);
  if (!taken.rowCount) throw new ApiError(429, 'ACTIVITY_RATE_LIMITED');
}
/** Evaluators are trusted installed code, but one never holds the enrollment lock for long. */
const EVALUATOR_TIMEOUT_CAP_MS = 10_000;
type JsonObject = { [key: string]: Json };

interface InstanceRow {
  id: string; enrollment_id: string; course_digest: string; episode_id: string; block_id: string; activity_id: string; activity_version: string;
  target: PlatformTarget; renderer_id: string; execution: string; state_version: number; state: JsonObject; state_revision: number; satisfied_at: Date | null;
}
interface Located { episode: Episode; block: ActivityBlock; activity: ActivityDefinition }
function locate(context: EnrollmentContext, episodeId: string, blockId: string): Located {
  const course = context.release.server_bundle, episode = episodes(course).find(row => row.id === episodeId);
  requireCondition(episode, 'EPISODE_NOT_FOUND', 404);
  const block = episode.blocks.find(row => row.id === blockId);
  requireCondition(block && block.type === 'activity', 'ACTIVITY_NOT_FOUND', 404);
  requireCondition(isContractBlock(block), 'ACTIVITY_RUNTIME_UNAVAILABLE', 409);
  const activity = activityOf(course, block);
  requireCondition(activity, 'ACTIVITY_RUNTIME_UNAVAILABLE', 409);
  return { episode, block, activity };
}
const frameUrl = (extension: RuntimeExtension) => `/api/activity-frames/${encodeURIComponent(extension.id)}/${encodeURIComponent(extension.version)}`;
/** The learner-facing view of an instance. Server-only fields (evaluator) are never included;
 * state is returned only when the activity was granted state.read. */
function instanceView(row: InstanceRow, located: Located, resolved: Extract<ResolvedActivity, { mode: 'run' }>) {
  const { activity, block } = located;
  return { mode: 'run' as const, instanceId: row.id, activityId: activity.id, activityVersion: activity.version, title: activity.title,
    execution: resolved.runtime.kind, target: row.target, rendererId: resolved.rendererId, grantedCapabilities: resolved.granted,
    state: resolved.granted.includes('state.read') ? row.state : null, stateRevision: row.state_revision, stateVersion: row.state_version,
    configuration: blockConfiguration(block), layouts: activity.layouts, budget: activity.resourceBudget,
    accessibility: activity.accessibleSemantics, evaluated: activity.evaluatorRef !== undefined, satisfied: row.satisfied_at !== null,
    ...(resolved.runtime.kind === 'sandboxed_web' ? { frameUrl: frameUrl(resolved.extension) } : {}) };
}
/** Re-resolves the runtime on every call: an uninstalled or changed runtime stops granting. */
function runtimeFor(context: EnrollmentContext, located: Located, target: PlatformTarget, installed: readonly RuntimeExtension[]) {
  const resolved = resolveActivity(context.release.server_bundle, located.activity, target, installed);
  requireCondition(resolved?.mode === 'run', 'ACTIVITY_RUNTIME_UNAVAILABLE', 409);
  return resolved as Extract<ResolvedActivity, { mode: 'run' }>;
}
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
/** Marks the block's completion requirement met (once) and records it as coverage. */
async function satisfy(client: PoolClient, context: EnrollmentContext, row: InstanceRow, actorId: string, cause: { observationId: string; evaluated: boolean }) {
  const updated = await client.query("UPDATE activity_instances SET satisfied_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND satisfied_at IS NULL", [row.id]);
  if (!updated.rowCount) return false;
  const enrollmentId = context.enrollment.id, old = context.progress.find(p => p.episode_id === row.episode_id);
  const completed = [...new Set([...(old?.completed_block_ids ?? []), row.block_id])];
  await client.query(`INSERT INTO episode_progress (enrollment_id,episode_id,state,completed_block_ids) VALUES ($1,$2,'started',$3)
    ON CONFLICT (enrollment_id,episode_id) DO UPDATE SET completed_block_ids=EXCLUDED.completed_block_ids`, [enrollmentId, row.episode_id, JSON.stringify(completed)]);
  await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
  await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId, actorKind: 'learner', type: 'activity.completed',
    payload: { episodeId: row.episode_id, blockId: row.block_id, activityId: row.activity_id, observationId: cause.observationId, evaluated: cause.evaluated,
      // Coverage of a practice activity never grants mastery; an evaluator's result is activity evidence.
      grantsMastery: false }, idempotencyKey: `${enrollmentId}:activity:${row.id}:completed`, activityInstanceId: row.id });
  return true;
}

/** Completion requirement of the episode's activity blocks on the current course version: an
 * evaluator pass when the activity declares an evaluator, otherwise an accepted observation. */
export async function unsatisfiedActivityBlocks(client: PoolClient, context: EnrollmentContext, episode: Episode) {
  const blocks = episode.blocks.filter(block => block.type === 'activity');
  if (!blocks.length) return [];
  const rows = (await client.query<{ block_id: string; satisfied: boolean; evidence: boolean }>(`SELECT i.block_id,i.satisfied_at IS NOT NULL AS satisfied,
      EXISTS(SELECT 1 FROM activity_evidence v WHERE v.instance_id=i.id AND v.enrollment_id=i.enrollment_id AND v.invalidated_at IS NULL AND v.result->>'passed'='true') AS evidence
    FROM activity_instances i WHERE i.enrollment_id=$1 AND i.course_digest=$2 AND i.episode_id=$3`, [context.enrollment.id, context.release.digest, episode.id])).rows;
  const course = context.release.server_bundle;
  return blocks.filter(block => {
    const row = rows.find(r => r.block_id === block.id);
    if (!row?.satisfied || !isContractBlock(block)) return true;
    return activityOf(course, block)?.evaluatorRef !== undefined && !row.evidence;
  }).map(block => block.id);
}

export function registerActivityRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installed: RuntimeExtension[]) {
  assertInstalledActivityRuntimes(installed);
  const enrollmentParams = { type: 'object', properties: { enrollmentId: uuid }, required: ['enrollmentId'] };

  // The sandboxed frame: the installed script, Core's bootstrap and a CSP that forbids network,
  // forms, nested frames and same-origin access. Public code, no learner data, no credentials.
  app.get('/api/activity-frames/:extensionId/:version', { schema: { params: { type: 'object', properties: { extensionId: id, version: id }, required: ['extensionId', 'version'] } } }, async (request, reply) => {
    const { extensionId, version } = request.params as { extensionId: string; version: string };
    const extension = installed.find(row => row.id === extensionId && row.version === version && row.activityRuntime?.kind === 'sandboxed_web');
    requireCondition(extension?.activityRuntime?.frameScript, 'ACTIVITY_FRAME_NOT_FOUND', 404);
    const script = extension.activityRuntime.frameScript;
    return reply.header('Content-Security-Policy', frameContentSecurityPolicy(script)).header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Cross-Origin-Opener-Policy', 'same-origin').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-write=(), clipboard-read=(), usb=(), serial=(), bluetooth=(), payment=()')
      .type('text/html; charset=utf-8').send(frameDocument(script, 'Course activity'));
  });

  // Launch: the instance for one activity block on the learner's target, or the author's
  // objective-equivalent fallback when the activity does not support that target.
  app.post('/api/enrollments/:enrollmentId/activities', { schema: { params: enrollmentParams, body: { type: 'object', additionalProperties: false,
    required: ['episodeId', 'blockId', 'target'], properties: { episodeId: id, blockId: id, target: { enum: TARGETS } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as { episodeId: string; blockId: string; target: PlatformTarget };
    return transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, true);
      requireCondition(context.enrollment.status === 'active', 'ENROLLMENT_NOT_ACTIVE', 409);
      const course = context.release.server_bundle;
      requireAvailable(course, context.release.digest, context.progress, context.evidence, input.episodeId);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'read', new Date().toISOString());
      const located = locate(context, input.episodeId, input.blockId);
      requireCondition(courseTargets(course).includes(input.target), 'ACTIVITY_TARGET_NOT_DECLARED', 409);
      const resolved = resolveActivity(course, located.activity, input.target, installed);
      requireCondition(resolved, 'ACTIVITY_RUNTIME_UNAVAILABLE', 409);
      if (resolved.mode === 'fallback') return { mode: 'fallback' as const, activityId: located.activity.id, target: input.target, fallback: resolved.fallback };
      let row = (await client.query<InstanceRow>('SELECT * FROM activity_instances WHERE enrollment_id=$1 AND course_digest=$2 AND episode_id=$3 AND block_id=$4 FOR UPDATE',
        [enrollmentId, context.release.digest, input.episodeId, input.blockId])).rows[0];
      if (!row) {
        const state = resolved.runtime.initialState(located.activity, blockConfiguration(located.block));
        requireCondition(boundedJson(state) && jsonBytes(state) <= located.activity.resourceBudget.maxStateBytes, 'ACTIVITY_STATE_INVALID', 409);
        row = (await client.query<InstanceRow>(`INSERT INTO activity_instances (id,enrollment_id,workspace_id,course_digest,episode_id,block_id,activity_id,activity_version,target,renderer_id,execution,state_version,state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [randomUUID(), enrollmentId, context.enrollment.workspace_id, context.release.digest, input.episodeId, input.blockId,
          located.activity.id, located.activity.version, input.target, resolved.rendererId, resolved.runtime.kind, located.activity.stateMigration.stateVersion, JSON.stringify(state)])).rows[0]!;
        await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'activity.started',
          payload: { episodeId: input.episodeId, blockId: input.blockId, activityId: located.activity.id, target: input.target, execution: resolved.runtime.kind, grantsMastery: false },
          idempotencyKey: `${enrollmentId}:activity:${row.id}:started`, activityInstanceId: row.id });
      } else if (row.target !== input.target || row.renderer_id !== resolved.rendererId) {
        // The same learner on another device class: same state, that target's renderer.
        row = (await client.query<InstanceRow>('UPDATE activity_instances SET target=$2,renderer_id=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id, input.target, resolved.rendererId])).rows[0]!;
      }
      return instanceView(row, located, resolved);
    });
  });

  // The capability broker. Every request names a capability; only granted ones run.
  app.post('/api/enrollments/:enrollmentId/activity-instances/:instanceId/calls', { bodyLimit: 96 * 1024, schema: {
    params: { type: 'object', properties: { enrollmentId: uuid, instanceId: uuid }, required: ['enrollmentId', 'instanceId'] },
    body: { type: 'object', additionalProperties: false, required: ['capability', 'idempotencyKey'], properties: {
      capability: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9._-]*$' }, idempotencyKey, payload: {}, expectedStateRevision: { type: 'integer', minimum: 1 } } } } }, async (request, reply) => {
    const actor = await auth.authenticate(request), { enrollmentId, instanceId } = request.params as { enrollmentId: string; instanceId: string };
    const input = request.body as { capability: string; idempotencyKey: string; payload?: unknown; expectedStateRevision?: number };
    const outcome = await transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, true);
      requireCondition(context.enrollment.status === 'active', 'ENROLLMENT_NOT_ACTIVE', 409);
      const row = (await client.query<InstanceRow>('SELECT * FROM activity_instances WHERE id=$1 AND enrollment_id=$2 FOR UPDATE', [instanceId, enrollmentId])).rows[0];
      requireCondition(row, 'ACTIVITY_INSTANCE_NOT_FOUND', 404);
      requireCondition(row.course_digest === context.release.digest, 'COURSE_VERSION_CHANGED', 409);
      const course = context.release.server_bundle, located = locate(context, row.episode_id, row.block_id);
      requireAvailable(course, context.release.digest, context.progress, context.evidence, row.episode_id);
      const resolved = runtimeFor(context, located, row.target, installed);
      if (!resolved.granted.includes(input.capability)) {
        // Denied, declared or not. The denial is recorded (it commits), the request does nothing.
        await takeBudget(client, row.id, 'denial', DENIED_CALLS_PER_MINUTE);
        const named = KNOWN_CAPABILITIES.has(input.capability) || FORBIDDEN_CAPABILITIES.has(input.capability) ? input.capability : 'unknown';
        await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'activity.capability_denied',
          payload: { activityId: row.activity_id, capability: named, declared: located.activity.capabilityRequirements.some(c => c.capability === input.capability) },
          idempotencyKey: `${enrollmentId}:activity:${row.id}:denied:${randomUUID()}`, activityInstanceId: row.id });
        return { denied: named };
      }
      const scope = policyEpisodeId(context.release, row.episode_id), configuration = blockConfiguration(located.block), activity = located.activity;
      if (input.capability === 'state.read') return { state: row.state, stateRevision: row.state_revision };
      if (input.capability === 'state.patch') {
        await assertPolicyAction(client, enrollmentId, scope, 'plan', new Date().toISOString());
        requireCondition(input.expectedStateRevision !== undefined, 'ACTIVITY_STATE_REVISION_REQUIRED', 400);
        requireCondition(input.expectedStateRevision === row.state_revision, 'ACTIVITY_STATE_STALE', 409);
        const state = isJsonObject(input.payload) ? input.payload.state : undefined;
        requireCondition(isJsonObject(state) && boundedJson(state), 'ACTIVITY_STATE_INVALID', 400);
        requireCondition(jsonBytes(state) <= activity.resourceBudget.maxStateBytes, 'ACTIVITY_STATE_TOO_LARGE', 413);
        requireCondition((!activity.stateSchema || matchesSchema(activity.stateSchema, state)) && (resolved.runtime.acceptsState?.(activity, configuration, state) ?? true), 'ACTIVITY_STATE_INVALID', 400);
        await takeBudget(client, row.id, 'patch', STATE_SAVES_PER_MINUTE);
        const saved = await client.query<{ state_revision: number }>('UPDATE activity_instances SET state=$2,state_revision=state_revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING state_revision',
          [row.id, JSON.stringify(state)]);
        return { stateRevision: saved.rows[0]!.state_revision };
      }
      // observation.emit
      const observation = isJsonObject(input.payload) ? input.payload.observation : undefined;
      const digest = digestJson({ instanceId, observation: observation ?? null });
      const prior = (await client.query<{ request_digest: string; evaluation: Record<string, unknown> }>('SELECT request_digest,evaluation FROM activity_observations WHERE instance_id=$1 AND idempotency_key=$2',
        [row.id, input.idempotencyKey])).rows[0];
      if (prior) {
        requireCondition(prior.request_digest === digest, 'IDEMPOTENCY_CONFLICT', 409);
        const { status: _status, ...stored } = prior.evaluation;
        return { ...stored, replayed: true };
      }
      await assertPolicyAction(client, enrollmentId, scope, 'submit', new Date().toISOString());
      requireCondition(isJsonObject(observation) && boundedJson(observation), 'ACTIVITY_OBSERVATION_INVALID', 400);
      const bytes = jsonBytes(observation);
      requireCondition(bytes <= activity.resourceBudget.maxEventBytes, 'ACTIVITY_OBSERVATION_TOO_LARGE', 413);
      requireCondition((!activity.observationSchema || matchesSchema(activity.observationSchema, observation))
        && (resolved.runtime.acceptsObservation?.(activity, configuration, observation) ?? true), 'ACTIVITY_OBSERVATION_INVALID', 400);
      const recent = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_observations WHERE instance_id=$1 AND created_at > clock_timestamp() - interval '1 minute'", [row.id])).rows[0]!.n;
      if (recent >= activity.resourceBudget.maxEventsPerMinute) throw new ApiError(429, 'ACTIVITY_RATE_LIMITED');
      const observationId = randomUUID();
      // The observation itself is never evidence. Only a registered evaluator's result is.
      const registered = activityEvaluator(course, activity, installed);
      let evaluation: Record<string, unknown>, result: ActivityEvaluation | null = null;
      if (activity.evaluatorRef === undefined) evaluation = { status: 'not_evaluated' };
      else if (!registered) evaluation = { status: 'unavailable' };
      else {
        try {
          const raw = await withTimeout(registered.evaluator.evaluate({ activity, configuration, observation, state: row.state }), Math.min(activity.resourceBudget.timeoutMs, EVALUATOR_TIMEOUT_CAP_MS));
          const objectives = Array.isArray(raw?.objectiveIds) ? [...new Set(raw.objectiveIds)] : [];
          // A result must stay inside the activity's and the episode's declared objectives.
          const valid = typeof raw?.passed === 'boolean' && objectives.length > 0
            && objectives.every(o => typeof o === 'string' && activity.objectiveIds.includes(o) && located.episode.objectiveIds.includes(o));
          if (valid) result = { passed: raw.passed, objectiveIds: objectives, ...(typeof raw.explanation === 'string' ? { explanation: raw.explanation.slice(0, 2000) } : {}) };
        } catch { result = null; }
        evaluation = result ? { status: result.passed ? 'passed' : 'not_passed', evaluator: registered.ref, ...(result.explanation ? { explanation: result.explanation } : {}) } : { status: 'unavailable' };
      }
      await client.query('INSERT INTO activity_observations (id,instance_id,enrollment_id,idempotency_key,request_digest,observation,byte_length,evaluation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [observationId, row.id, enrollmentId, input.idempotencyKey, digest, JSON.stringify(observation), bytes, JSON.stringify(evaluation)]);
      if (result && registered) for (const objectiveId of result.objectiveIds)
        await client.query('INSERT INTO activity_evidence (id,enrollment_id,instance_id,observation_id,objective_id,evaluator_ref,result) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), enrollmentId, row.id, observationId, objectiveId, registered.ref, JSON.stringify({ passed: result.passed })]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'activity.observed',
        payload: { activityId: row.activity_id, blockId: row.block_id, observationId, status: evaluation.status }, idempotencyKey: `${enrollmentId}:activity:${row.id}:observed:${input.idempotencyKey}`,
        activityInstanceId: row.id });
      const satisfies = activity.evaluatorRef === undefined ? true : evaluation.status === 'passed';
      const satisfied = satisfies ? (await satisfy(client, context, row, actor.id, { observationId, evaluated: activity.evaluatorRef !== undefined }), true) : row.satisfied_at !== null;
      const response = { observationId, evaluation, satisfied };
      // Stored with the response, so a retry of the same request returns exactly this.
      await client.query('UPDATE activity_observations SET evaluation=$2 WHERE id=$1', [observationId, JSON.stringify({ status: evaluation.status, ...response })]);
      return response;
    });
    if ('denied' in outcome) return reply.code(403).send({ error: 'ACTIVITY_CAPABILITY_DENIED', details: { capability: outcome.denied } });
    return outcome;
  });
}
