/**
 * Course updater routes (course-updates.ts). `:courseId` is the admin catalog id.
 *
 * GET  /api/admin/courses/:courseId/updates            course.read: source, settings, last check, choices.
 * PUT  /api/admin/courses/:courseId/updates/source     course.write: {expectedRevision, source:
 *        {kind:'github', url} | {kind:'path', directoryId, subpath} | {kind:'none'}}.
 * PUT  /api/admin/courses/:courseId/updates/settings   {expectedRevision, level, intervalHours,
 *        acknowledgePublish?, autoApproveRegistry?}. check: course.write; install: owner/admin;
 *        publish: owner/admin holding release.review and release.publish, acknowledgePublish=true.
 * POST /api/admin/courses/:courseId/updates/check      course.write: checks now; an available update
 *        is verified and staged and returned with the install preview and a diff against the live release.
 *
 * Host paths never cross this API: directories are named by id and basename, subpaths are relative.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { authService } from './auth.js';
import { transaction, type Database } from './database.js';
import { randomUUID } from 'node:crypto';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { roleCan } from './course-access.js';
import { catalogFor } from './admin-routes.js';
import { parseGitHubUrl } from './course-package-source.js';
import { directoryChoices, resolveInside } from './course-package-directory.js';
import { checkSource, newestInstalled, recordAttempt, type SourceRow, type UpdaterOptions } from './course-updates.js';

type Auth = ReturnType<typeof authService>;
const params = (request: FastifyRequest) => request.params as Record<string, string>;
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}
const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('github'), url: z.string().min(1).max(2048) }),
  z.strictObject({ kind: z.literal('path'), directoryId: z.string().regex(/^[a-f0-9]{16}$/), subpath: z.string().max(1024) }),
  z.strictObject({ kind: z.literal('none') }),
]);
const settingsSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  level: z.enum(['off', 'check', 'install', 'publish']),
  intervalHours: z.number().int().min(1).max(720),
  acknowledgePublish: z.boolean().optional(),
  autoApproveRegistry: z.boolean().optional(),
});

export function registerCourseUpdateRoutes(app: FastifyInstance, db: Database, auth: Auth, options: UpdaterOptions) {
  const base = '/api/admin/courses/:courseId/updates';
  const load = async (client: Database | import('pg').PoolClient, workspaceId: string, courseKey: string, lock = false) =>
    (await client.query<SourceRow>(`SELECT * FROM course_update_sources WHERE workspace_id=$1 AND course_key=$2 ${lock ? 'FOR UPDATE' : ''}`, [workspaceId, courseKey])).rows[0];
  async function view(client: Database | import('pg').PoolClient, catalog: { workspace_id: string; course_key: string }, role: string) {
    const row = await load(client, catalog.workspace_id, catalog.course_key);
    const directory = row?.kind === 'path' ? options.directories.find(item => item.id === row.root_id) : undefined;
    const acknowledgedBy = row?.acknowledged_by ? (await client.query<{ display_name: string }>('SELECT display_name FROM app_users WHERE id=$1', [row.acknowledged_by])).rows[0]?.display_name ?? null : null;
    return {
      revision: row?.revision ?? 0,
      source: !row ? null : row.kind === 'github' ? { kind: 'github' as const, url: row.url! }
        : { kind: 'path' as const, directoryId: row.root_id!, directory: directory?.name ?? null, subpath: row.subpath! },
      settings: { level: row?.level ?? 'off', intervalHours: row?.interval_hours ?? 24, autoApproveRegistry: row?.auto_approve_registry ?? false,
        acknowledgedBy, acknowledgedAt: row?.acknowledged_at?.toISOString() ?? null },
      status: row ? { lastCheckedAt: row.last_checked_at?.toISOString() ?? null, lastTrigger: row.last_trigger, lastResult: row.last_result, lastErrorCode: row.last_error_code,
        availableVersion: row.available_version, consecutiveFailures: row.consecutive_failures, nextCheckAt: row.level === 'off' ? null : row.next_check_at?.toISOString() ?? null } : null,
      newestInstalled: await newestInstalled(client, catalog.workspace_id, catalog.course_key),
      directories: directoryChoices(options.directories),
      remoteFetch: options.packages.remoteFetch ?? 'github',
      permissions: { configure: roleCan(role, 'course.write'), install: roleCan(role, 'course.write') && ['owner', 'admin'].includes(role),
        publish: ['owner', 'admin'].includes(role) && roleCan(role, 'release.review') && roleCan(role, 'release.publish') },
    };
  }
  app.get(base, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!, 'course.read');
      return view(client, catalog, role);
    });
  });
  app.put(`${base}/source`, async request => {
    const actor = await auth.authenticate(request);
    const input = parse(z.strictObject({ expectedRevision: z.number().int().min(0), source: sourceSchema }), request.body);
    // Validate before taking locks: a GitHub link must parse, a folder must resolve inside its directory.
    if (input.source.kind === 'github') {
      parseGitHubUrl(input.source.url);
      requireCondition((options.packages.remoteFetch ?? 'github') === 'github', 'COURSE_PACKAGE_REMOTE_FETCH_DISABLED', 403);
    }
    return transaction(db, async client => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!, 'course.write', true);
      if (input.source.kind === 'path') await resolveInside(options.directories, input.source.directoryId, input.source.subpath);
      const row = await load(client, catalog.workspace_id, catalog.course_key, true);
      requireCondition((row?.revision ?? 0) === input.expectedRevision, 'STALE_REVISION', 409);
      if (input.source.kind === 'none') await client.query('DELETE FROM course_update_sources WHERE workspace_id=$1 AND course_key=$2', [catalog.workspace_id, catalog.course_key]);
      else {
        const url = input.source.kind === 'github' ? input.source.url.trim() : null;
        const rootId = input.source.kind === 'path' ? input.source.directoryId : null, subpath = input.source.kind === 'path' ? input.source.subpath : null;
        // A new source starts with automatic updates off; its settings must be saved again on purpose.
        await client.query(`INSERT INTO course_update_sources(workspace_id,course_key,kind,url,root_id,subpath,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(workspace_id,course_key) DO UPDATE SET kind=EXCLUDED.kind,url=EXCLUDED.url,root_id=EXCLUDED.root_id,subpath=EXCLUDED.subpath,
            level='off',auto_approve_registry=false,acknowledged_by=NULL,acknowledged_at=NULL,next_check_at=NULL,last_result=NULL,last_error_code=NULL,
            available_version=NULL,available_sha256=NULL,consecutive_failures=0,revision=course_update_sources.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
        [catalog.workspace_id, catalog.course_key, input.source.kind, url, rootId, subpath, actor.id]);
      }
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'course_update.source_changed',
        payload: { catalogId: catalog.id, courseKey: catalog.course_key, kind: input.source.kind, ...(input.source.kind === 'github' ? { url: input.source.url.trim() } : {}),
          ...(input.source.kind === 'path' ? { directoryId: input.source.directoryId, subpath: input.source.subpath } : {}) },
        idempotencyKey: `course-update-source:${catalog.id}:${randomUUID()}` });
      return view(client, catalog, role);
    });
  });
  app.put(`${base}/settings`, async request => {
    const actor = await auth.authenticate(request);
    const input = parse(settingsSchema, request.body);
    return transaction(db, async client => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!, 'course.write', true);
      if (input.level === 'install' || input.level === 'publish') requireCondition(['owner', 'admin'].includes(role), 'FORBIDDEN', 403);
      if (input.level === 'publish') {
        requireCondition(roleCan(role, 'release.review') && roleCan(role, 'release.publish'), 'FORBIDDEN', 403);
        requireCondition(input.acknowledgePublish === true, 'AUTO_PUBLISH_ACKNOWLEDGEMENT_REQUIRED', 428);
      } else requireCondition(!input.autoApproveRegistry, 'INVALID_REQUEST');
      const row = await load(client, catalog.workspace_id, catalog.course_key, true);
      requireCondition(row, 'COURSE_UPDATE_SOURCE_REQUIRED', 409);
      requireCondition(row.revision === input.expectedRevision, 'STALE_REVISION', 409);
      const publish = input.level === 'publish';
      await client.query(`UPDATE course_update_sources SET level=$3,interval_hours=$4,auto_approve_registry=$5,acknowledged_by=$6,acknowledged_at=CASE WHEN $6::uuid IS NULL THEN NULL ELSE clock_timestamp() END,
          next_check_at=CASE WHEN $3='off' THEN NULL WHEN level='off' OR next_check_at IS NULL THEN clock_timestamp() ELSE LEAST(next_check_at,clock_timestamp()+make_interval(hours => $4)) END,
          revision=revision+1,updated_by=$7,updated_at=clock_timestamp() WHERE workspace_id=$1 AND course_key=$2`,
      [catalog.workspace_id, catalog.course_key, input.level, input.intervalHours, publish && input.autoApproveRegistry === true, publish ? actor.id : null, actor.id]);
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'course_update.settings_changed',
        payload: { catalogId: catalog.id, courseKey: catalog.course_key, level: input.level, intervalHours: input.intervalHours,
          autoApproveRegistry: publish && input.autoApproveRegistry === true, acknowledged: publish },
        idempotencyKey: `course-update-settings:${catalog.id}:${row.revision + 1}` });
      return view(client, catalog, role);
    });
  });
  app.post(`${base}/check`, async request => {
    const actor = await auth.authenticate(request);
    parse(z.strictObject({}), request.body ?? {});
    const { catalog, row } = await transaction(db, async client => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, 'course.write');
      const row = await load(client, catalog.workspace_id, catalog.course_key);
      requireCondition(row, 'COURSE_UPDATE_SOURCE_REQUIRED', 409);
      return { catalog, row };
    });
    const outcome = await checkSource(db, actor, row, options);
    const now = new Date();
    await recordAttempt(db, row, { trigger: 'manual', result: outcome.result, code: outcome.result === 'failed' ? outcome.code : null,
      version: 'version' in outcome ? outcome.version : null, sha256: outcome.result === 'update_available' ? outcome.sha256 : null, actorId: actor.id }, now);
    const current = await transaction(db, async client => { const { role } = await catalogFor(client, actor, catalog.id, 'course.write'); return view(client, catalog, role); });
    // A failed check is an answer, not an error: its code is recorded and shown.
    return { outcome, updates: current };
  });
}
