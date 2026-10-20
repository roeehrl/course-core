import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { CourseManifest } from '@course-core/sdk';
import type { authService } from './auth.js';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { catalogOfRelease, permitCourse, roleCan, type AdminPermission } from './course-access.js';
import { catalogFor } from './admin-routes.js';
import { enrollmentCommand, loadEnrollment, type CommandInput } from './repository.js';
import { effectivePlacement, placementSettingsRow } from './placement-settings.js';
import {
  buildExport, consentWithin, definitionSchema, exportCsv, learnerStudyView, newStudySecrets, studySummary, validateDefinition,
  verifyAllocation, withdrawWithin, type StudyDefinition, type StudyRow,
} from './study.js';

type Auth = ReturnType<typeof authService>;
const uuid = z.uuid();
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}
const params = (request: FastifyRequest) => request.params as Record<string, string>;
interface ReleaseRow { id: string; workspace_id: string; course_key: string; version: string; status: string; server_bundle: CourseManifest }

function refuseInvalid(course: CourseManifest, definition: StudyDefinition, opening = false) {
  const checked = validateDefinition(course, definition, opening);
  if (checked.errors.length) throw new ApiError(422, 'STUDY_DEFINITION_INVALID', 'STUDY_DEFINITION_INVALID', { problems: checked.errors });
  return checked.warnings;
}
const definitionOf = (study: StudyRow): StudyDefinition =>
  ({ title: study.title, purpose: study.purpose, arms: study.arms, instruments: study.instruments, minCellSize: study.min_cell_size });

/** One study, authorized on its release's course for `permission`. */
async function studyFor(client: PoolClient, actor: { id: string }, studyId: string, permission: AdminPermission, lock = false) {
  parse(uuid, studyId);
  const study = (await client.query<StudyRow>(`SELECT * FROM studies WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [studyId])).rows[0];
  requireCondition(study, 'STUDY_NOT_FOUND', 404);
  const release = (await client.query<ReleaseRow>('SELECT * FROM course_releases WHERE id=$1 AND workspace_id=$2', [study.course_release_id, study.workspace_id])).rows[0]!;
  const role = await permitCourse(client, actor, study.workspace_id, await catalogOfRelease(client, release), permission);
  return { study, release, role };
}

/**
 * Study administration (course-scoped staff permissions study.read / study.manage / study.export)
 * and the learner's own consent. Every change and every export is recorded as a staff or learner
 * event; exports also get an append-only study_exports row with the file's digest.
 */
export function registerStudyRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  const admin = '/api/admin';
  /** Studies of a course's live releases, their arm balance and consent counts, and the items a
   * study may use. Aggregates only: no participant is listed. */
  app.get(`${admin}/courses/:courseId/studies`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!, 'study.read');
      const releases = (await client.query<ReleaseRow>(
        `SELECT * FROM course_releases WHERE workspace_id=$1 AND course_key=$2 AND status IN ('published','archived') ORDER BY created_at DESC,id`,
        [catalog.workspace_id, catalog.course_key])).rows;
      const studies = (await client.query<StudyRow>('SELECT * FROM studies WHERE course_release_id=ANY($1::uuid[]) ORDER BY created_at DESC,id',
        [releases.map((r) => r.id)])).rows;
      const placement = await placementSettingsRow(client, catalog.workspace_id, catalog.course_key);
      return {
        canManage: roleCan(role, 'study.manage'), canExport: roleCan(role, 'study.export'),
        releases: releases.map((r) => {
          const retention = new Set(r.server_bundle.retention?.assessmentIds ?? []);
          return { id: r.id, version: r.version, status: r.status,
            // Placement is a course-level setting, so it is the same in every arm.
            placementEnabled: effectivePlacement(r.server_bundle, placement).enabled,
            items: r.server_bundle.assessments.map((a) => ({ id: a.id, type: a.type, role: a.role ?? null, objectiveIds: a.objectiveIds, retention: retention.has(a.id) })) };
        }),
        studies: await Promise.all(studies.map(async (s) => ({ ...(await studySummary(client, s)),
          warnings: validateDefinition(releases.find((r) => r.id === s.course_release_id)!.server_bundle, definitionOf(s)).warnings }))),
      };
    });
  });
  const createSchema = definitionSchema.extend({ releaseId: uuid });
  app.post(`${admin}/courses/:courseId/studies`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(createSchema, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, 'study.manage', true);
      const release = (await client.query<ReleaseRow>(
        "SELECT * FROM course_releases WHERE id=$1 AND workspace_id=$2 AND course_key=$3 AND status IN ('published','archived')",
        [input.releaseId, catalog.workspace_id, catalog.course_key])).rows[0];
      requireCondition(release, 'RELEASE_NOT_FOUND', 404);
      const { releaseId: _r, ...definition } = input;
      const warnings = refuseInvalid(release.server_bundle, definition);
      const open = await client.query("SELECT 1 FROM studies WHERE course_release_id=$1 AND state<>'closed'", [release.id]);
      requireCondition(!open.rowCount, 'STUDY_ALREADY_OPEN', 409);
      const id = randomUUID(), secrets = newStudySecrets();
      await client.query(`INSERT INTO studies(id,workspace_id,course_release_id,title,purpose,arms,instruments,min_cell_size,allocation_seed,seed_digest,pseudonym_salt,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, catalog.workspace_id, release.id, definition.title, definition.purpose, JSON.stringify(definition.arms),
        JSON.stringify(definition.instruments), definition.minCellSize, secrets.seed, secrets.seedDigest, secrets.salt, actor.id]);
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'study.created',
        payload: { studyId: id, releaseId: release.id, arms: definition.arms.map((a) => ({ id: a.id, behaviour: a.behaviour })), instruments: definition.instruments,
          minCellSize: definition.minCellSize, seedDigest: secrets.seedDigest }, idempotencyKey: `study:${id}:created` });
      const study = (await client.query<StudyRow>('SELECT * FROM studies WHERE id=$1', [id])).rows[0]!;
      return { study: await studySummary(client, study), warnings };
    });
  });
  app.put(`${admin}/studies/:studyId`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(definitionSchema.extend({ expectedRevision: z.number().int().min(1) }), request.body);
    return transaction(db, async (client) => {
      const { study, release } = await studyFor(client, actor, params(request).studyId!, 'study.manage', true);
      requireCondition(study.revision === input.expectedRevision, 'STALE_REVISION', 409);
      // Arms, instruments and the consent text are fixed once anyone could have consented.
      requireCondition(study.state === 'draft', 'STUDY_DEFINITION_LOCKED', 409);
      const { expectedRevision: _e, ...definition } = input;
      const warnings = refuseInvalid(release.server_bundle, definition);
      await client.query(`UPDATE studies SET title=$2,purpose=$3,arms=$4,instruments=$5,min_cell_size=$6,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
        [study.id, definition.title, definition.purpose, JSON.stringify(definition.arms), JSON.stringify(definition.instruments), definition.minCellSize]);
      await appendEvent(client, { workspaceId: study.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'study.updated',
        payload: { studyId: study.id, revision: study.revision + 1, arms: definition.arms.map((a) => ({ id: a.id, behaviour: a.behaviour })), instruments: definition.instruments,
          minCellSize: definition.minCellSize }, idempotencyKey: `study:${study.id}:revision:${study.revision + 1}` });
      const saved = (await client.query<StudyRow>('SELECT * FROM studies WHERE id=$1', [study.id])).rows[0]!;
      return { study: await studySummary(client, saved), warnings };
    });
  });
  for (const action of ['open', 'close'] as const)
    app.post(`${admin}/studies/:studyId/${action}`, async (request) => {
      const actor = await auth.authenticate(request), input = parse(z.strictObject({ expectedRevision: z.number().int().min(1) }), request.body);
      return transaction(db, async (client) => {
        const { study, release } = await studyFor(client, actor, params(request).studyId!, 'study.manage', true);
        requireCondition(study.revision === input.expectedRevision, 'STALE_REVISION', 409);
        if (action === 'open') {
          requireCondition(study.state === 'draft', 'STUDY_NOT_DRAFT', 409);
          refuseInvalid(release.server_bundle, definitionOf(study), true);
          await client.query("UPDATE studies SET state='recruiting',opened_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [study.id]);
        } else {
          // Closing ends recruitment and lifts every arm's restrictions; the data stays exportable.
          requireCondition(study.state !== 'closed', 'STUDY_CLOSED', 409);
          await client.query("UPDATE studies SET state='closed',opened_at=coalesce(opened_at,clock_timestamp()),closed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [study.id]);
        }
        await appendEvent(client, { workspaceId: study.workspace_id, actorId: actor.id, actorKind: 'staff', type: action === 'open' ? 'study.opened' : 'study.closed',
          payload: { studyId: study.id, revision: study.revision + 1 }, idempotencyKey: `study:${study.id}:${action}` });
        const saved = (await client.query<StudyRow>('SELECT * FROM studies WHERE id=$1', [study.id])).rows[0]!;
        return { study: await studySummary(client, saved) };
      });
    });
  /** Recomputes every assignment from the secret seed (owner/admin). */
  app.get(`${admin}/studies/:studyId/allocation-check`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { study } = await studyFor(client, actor, params(request).studyId!, 'study.manage');
      return verifyAllocation(client, study);
    });
  });
  /** The pseudonymous research export. Recorded (digest, row count, format, who) before the file
   * is returned; the payload is never logged. */
  app.get(`${admin}/studies/:studyId/export`, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await auth.authenticate(request);
    const { format } = parse(z.strictObject({ format: z.enum(['csv', 'json']).default('json') }), request.query ?? {});
    const built = await transaction(db, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY').catch(() => undefined);
      const { study, release, role } = await studyFor(client, actor, params(request).studyId!, 'study.export');
      requireCondition(study.state !== 'draft', 'STUDY_NOT_STARTED', 409);
      return { study, role, document: await buildExport(client, study, release.server_bundle) };
    });
    const body = format === 'csv' ? exportCsv(built.document) : JSON.stringify(built.document, null, 2) + '\n';
    const digest = createHash('sha256').update(body).digest('hex'), exportId = randomUUID();
    const suppressed = built.document.arms.filter((a) => a.suppressed).length;
    await transaction(db, async (client) => {
      await client.query(`INSERT INTO study_exports(id,study_id,workspace_id,requested_by,requester_role,format,included,suppressed_arms,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [exportId, built.study.id, built.study.workspace_id, actor.id, built.role, format, built.document.participants.length, suppressed, digest]);
      await appendEvent(client, { workspaceId: built.study.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'study.exported',
        payload: { studyId: built.study.id, exportId, format, rows: built.document.participants.length, suppressedArms: suppressed, digest, requesterRole: built.role },
        idempotencyKey: `study-export:${exportId}` });
    });
    reply.header('Cache-Control', 'no-store')
      .header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="study-${built.study.id.slice(0, 8)}.${format}"`)
      .header('X-Export-Digest', digest);
    return body;
  });

  // ------------------------------------------------------------------ learner consent
  const enrollmentParams = { type: 'object', additionalProperties: false, required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
  const base = '/api/enrollments/:enrollmentId/study';
  app.get(base, { schema: { params: enrollmentParams } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => {
      const { enrollment } = await loadEnrollment(client, actor, enrollmentId);
      // Consent is the learner's own: staff viewing an enrollment never see or act on it here.
      requireCondition(enrollment.user_id === actor.id, 'ENROLLMENT_NOT_FOUND', 404);
      return { revision: enrollment.revision, ...(await learnerStudyView(client, enrollment)) };
    });
  });
  const command = (required: string[], properties: Record<string, unknown>) => ({ schema: { params: enrollmentParams, body: { type: 'object', additionalProperties: false,
    required: ['expectedRevision', 'idempotencyKey', 'studyId', ...required], properties: { expectedRevision: { type: 'integer', minimum: 1 },
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 }, studyId: { type: 'string', format: 'uuid' }, ...properties } } } });
  app.post(`${base}/consent`, command(['consentDigest'], { consentDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } }), async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string },
      input = request.body as CommandInput & { studyId: string; consentDigest: string };
    return enrollmentCommand(db, actor, enrollmentId, 'study.consent', input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, 'LEARNER_CONSENT_REQUIRED', 403);
      const joined = await consentWithin(client, { enrollment: context.enrollment, actorId: actor.id, studyId: input.studyId, consentDigest: input.consentDigest, idempotencyKey: input.idempotencyKey });
      const enrollment = { ...context.enrollment, revision: context.enrollment.revision + (joined.changed ? 1 : 0) };
      return { revision: enrollment.revision, ...(await learnerStudyView(client, enrollment)) };
    });
  });
  app.post(`${base}/withdraw`, command([], {}), async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string },
      input = request.body as CommandInput & { studyId: string };
    return enrollmentCommand(db, actor, enrollmentId, 'study.withdraw', input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, 'LEARNER_CONSENT_REQUIRED', 403);
      const left = await withdrawWithin(client, { enrollment: context.enrollment, actorId: actor.id, studyId: input.studyId, idempotencyKey: input.idempotencyKey });
      const enrollment = { ...context.enrollment, revision: context.enrollment.revision + (left.changed ? 1 : 0) };
      return { revision: enrollment.revision, ...(await learnerStudyView(client, enrollment)) };
    });
  });
}
