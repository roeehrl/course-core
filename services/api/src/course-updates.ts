/**
 * The course updater: a per-course update source (a public GitHub release URL or a folder inside
 * a configured host package directory), manual "check for updates" and optional automatic
 * updates. A check finds the newest package at the source; when its version is greater than the
 * newest version this workspace has of the course, the package is verified and staged exactly like
 * an inspected one and a preview plus a content diff against the live release is returned.
 * Installing it is the same install → review → registry → publish flow as a one-off install.
 *
 * Automatic levels (off by default): `check` records that an update is available; `install` also
 * installs it as a draft in review and stages its registry; `publish` also approves and publishes
 * it, only when the setting was saved by an actor holding release.review and release.publish with
 * an explicit acknowledgement, and never when the preview has a blocking problem, a host
 * requirement that is not identical, a failing runtime check, an unmet minimum Core version or an
 * SDK outside the supported range (it is then installed for a person to publish). Existing
 * enrollments stay pinned. A packaged registry is approved automatically only at `publish`, and
 * only when its digest equals the live release's approved registry or the acknowledgement
 * explicitly covers a changed registry. The saving actor's permissions are checked again on every
 * run. Runs are single-flight across processes (a Postgres advisory lock), every attempt is
 * recorded and audited, and failures back off (interval × 2^failures, at most 7 days).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from './auth.js';
import { transaction, type Database } from './database.js';
import { ApiError } from './errors.js';
import { appendEvent } from './events.js';
import { resolveRole, roleCan } from './course-access.js';
import type { AdminRuntimeOptions } from './admin-routes.js';
import { compareSemver, CoursePackageError, coreCoursePackageVerifier, isSemver } from './course-package.js';
import { fetchGitHubPackage } from './course-package-source.js';
import { installStagedPackage, packagePreview, stagePackage, type CoursePackageOptions } from './course-package-routes.js';
import { readPathPackage, type PackageDirectory } from './course-package-directory.js';
import { releaseDiff } from './release-safety.js';
import type { CourseManifest } from '@course-core/sdk';

type Sql = Database | PoolClient;
export type UpdateLevel = 'off' | 'check' | 'install' | 'publish';
export type UpdateResult = 'up_to_date' | 'update_available' | 'installed' | 'published' | 'failed';
export interface UpdaterOptions { directories: readonly PackageDirectory[]; packages: CoursePackageOptions; admin: AdminRuntimeOptions }
export interface SourceRow {
  workspace_id: string; course_key: string; kind: 'github' | 'path'; url: string | null; root_id: string | null; subpath: string | null;
  level: UpdateLevel; interval_hours: number; auto_approve_registry: boolean; acknowledged_by: string | null; acknowledged_at: Date | null; revision: number;
  updated_by: string; updated_at: Date; next_check_at: Date | null; last_checked_at: Date | null; last_trigger: string | null; last_result: UpdateResult | null;
  last_error_code: string | null; available_version: string | null; available_sha256: string | null; consecutive_failures: number;
}
const HOUR_MS = 3_600_000, MAX_BACKOFF_MS = 7 * 24 * HOUR_MS;
const LOCK = 'course-core:course-updates';
const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'INTERNAL_ERROR';
};

/** The newest version this workspace has of the course, across all its releases. */
export async function newestInstalled(client: Sql, workspaceId: string, courseKey: string) {
  const versions = (await client.query<{ version: string }>('SELECT version FROM course_releases WHERE workspace_id=$1 AND course_key=$2', [workspaceId, courseKey])).rows
    .map(row => row.version).filter(isSemver);
  return versions.sort((a, b) => compareSemver(b, a))[0] ?? null;
}
/** Back-off before the next automatic attempt after `failures` consecutive failures. */
export const backoffMs = (intervalHours: number, failures: number) => Math.min(intervalHours * HOUR_MS * 2 ** Math.min(failures, 16), MAX_BACKOFF_MS);

async function fetchSource(row: SourceRow, options: UpdaterOptions) {
  if (row.kind === 'github') {
    if ((options.packages.remoteFetch ?? 'github') !== 'github') throw new ApiError(403, 'COURSE_PACKAGE_REMOTE_FETCH_DISABLED');
    const fetched = await fetchGitHubPackage(row.url!, undefined, options.packages.remote);
    return { bytes: fetched.bytes, source: fetched.source as Record<string, unknown> };
  }
  const read = await readPathPackage(options.directories, row.root_id!, row.subpath!, row.course_key);
  return { bytes: read.bytes, source: read.source as Record<string, unknown> };
}

export type CheckOutcome =
  | { result: 'up_to_date'; version: string; newestInstalled: string | null }
  | { result: 'update_available'; version: string; sha256: string; newestInstalled: string | null; preview: Awaited<ReturnType<typeof packagePreview>> & { packageSource: Record<string, unknown>; expiresAt: string }; diff: ReturnType<typeof releaseDiff> | null }
  | { result: 'failed'; code: string };

/** One check of a course's source as `actor` (whose role decides the preview's permissions). */
export async function checkSource(db: Database, actor: Actor, row: SourceRow, options: UpdaterOptions): Promise<CheckOutcome> {
  try {
    const { bytes, source } = await fetchSource(row, options);
    let verified;
    try { verified = await (options.packages.verifier ?? coreCoursePackageVerifier).verify(bytes); }
    catch (error) { if (error instanceof CoursePackageError) return { result: 'failed', code: error.code }; throw error; }
    if (verified.descriptor.courseId !== row.course_key) return { result: 'failed', code: 'COURSE_UPDATE_WRONG_COURSE' };
    return await transaction(db, async client => {
      const newest = await newestInstalled(client, row.workspace_id, row.course_key);
      const version = verified.descriptor.courseVersion;
      if (newest && compareSemver(version, newest) <= 0) return { result: 'up_to_date' as const, version, newestInstalled: newest };
      const role = await resolveRole(client, actor, row.workspace_id, (await catalogId(client, row)) ?? null);
      const preview = await packagePreview(client, row.workspace_id, role ?? 'none', verified, options.packages);
      const expiresAt = await stagePackage(client, row.workspace_id, actor.id, verified.sha256, bytes, source, options.packages.stagingMinutes ?? 60);
      const live = (await client.query<{ id: string; version: string; status: string; digest: string; server_bundle: CourseManifest; created_at: Date }>(
        `SELECT r.id,r.version,r.status,r.digest,r.server_bundle,r.created_at FROM admin_course_catalog c JOIN course_releases r ON r.id=c.active_release_id
          WHERE c.workspace_id=$1 AND c.course_key=$2`, [row.workspace_id, row.course_key])).rows[0];
      const diff = live ? releaseDiff(live, { id: `package:${verified.sha256.slice(0, 12)}`, version, status: 'package', digest: verified.compiled.digest, server_bundle: verified.compiled.server, created_at: new Date() }) : null;
      return { result: 'update_available' as const, version, sha256: verified.sha256, newestInstalled: newest, preview: { ...preview, packageSource: source, expiresAt }, diff };
    });
  } catch (error) {
    if (error instanceof ApiError || error instanceof CoursePackageError) return { result: 'failed', code: error.code };
    throw error;
  }
}
async function catalogId(client: Sql, row: { workspace_id: string; course_key: string }) {
  return (await client.query<{ id: string }>('SELECT id FROM admin_course_catalog WHERE workspace_id=$1 AND course_key=$2', [row.workspace_id, row.course_key])).rows[0]?.id;
}

/** Records one attempt (row, attempt log and audit event). Automatic attempts also schedule the next. */
export async function recordAttempt(db: Database, row: SourceRow, attempt: { trigger: 'manual' | 'automatic'; result: UpdateResult; code?: string | null;
  version?: string | null; sha256?: string | null; releaseId?: string | null; actorId: string }, now: Date) {
  await transaction(db, async client => {
    const failed = attempt.result === 'failed';
    const failures = failed ? row.consecutive_failures + 1 : 0;
    const next = attempt.trigger === 'automatic' ? new Date(now.getTime() + (failed ? backoffMs(row.interval_hours, failures) : row.interval_hours * HOUR_MS)) : null;
    await client.query(`UPDATE course_update_sources SET last_checked_at=$3,last_trigger=$4,last_result=$5,last_error_code=$6,
        available_version=CASE WHEN $5='failed' THEN available_version WHEN $5='up_to_date' THEN NULL ELSE $7 END,
        available_sha256=CASE WHEN $5='failed' THEN available_sha256 WHEN $5='up_to_date' THEN NULL ELSE $8 END,
        consecutive_failures=CASE WHEN $4='automatic' OR $5<>'failed' THEN $9 ELSE consecutive_failures END,
        next_check_at=COALESCE($10,next_check_at)
      WHERE workspace_id=$1 AND course_key=$2`,
    [row.workspace_id, row.course_key, now, attempt.trigger, attempt.result, attempt.code ?? null, attempt.version ?? null, attempt.sha256 ?? null, failures, next]);
    await client.query(`INSERT INTO course_update_attempts(id,workspace_id,course_key,trigger,attempted_at,result,error_code,version,package_sha256,release_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), row.workspace_id, row.course_key, attempt.trigger, now, attempt.result, attempt.code ?? null,
      attempt.version ?? null, attempt.sha256 ?? null, attempt.releaseId ?? null]);
    await appendEvent(client, { workspaceId: row.workspace_id, actorId: attempt.actorId, actorKind: attempt.trigger === 'automatic' ? 'system' : 'staff', type: 'course_update.checked',
      payload: { courseKey: row.course_key, trigger: attempt.trigger, result: attempt.result, errorCode: attempt.code ?? null, version: attempt.version ?? null,
        packageSha256: attempt.sha256 ?? null, releaseId: attempt.releaseId ?? null, sourceKind: row.kind },
      idempotencyKey: `course-update:${row.workspace_id}:${row.course_key}:${randomUUID()}` });
  });
}

/** Why automatic publication is refused for this preview, or null when it may proceed. */
export function publishRefusal(preview: Awaited<ReturnType<typeof packagePreview>>): string | null {
  if (preview.problems.some(problem => problem.severity === 'blocking')) return 'AUTO_PUBLISH_REFUSED_BLOCKING_PROBLEM';
  if (!preview.runtime.runnable) return 'AUTO_PUBLISH_REFUSED_RUNTIME_CHECK';
  // New course-supplied code is approved by a person, never by an automatic update.
  if (preview.courseSupplied.approvalRequired.length) return 'AUTO_PUBLISH_REFUSED_COURSE_CODE';
  if (preview.hostRequirements.some(requirement => requirement.status !== 'identical' && requirement.status !== 'course_supplied')) return 'AUTO_PUBLISH_REFUSED_HOST_REQUIREMENT';
  if (!preview.core.satisfied) return 'AUTO_PUBLISH_REFUSED_CORE_VERSION';
  if (preview.sdk.status !== 'supported') return 'AUTO_PUBLISH_REFUSED_SDK_RANGE';
  return null;
}

/** The actor an automatic run acts as, if they may still do what the level needs. */
async function automaticActor(client: Sql, row: SourceRow): Promise<{ actor: Actor; level: UpdateLevel } | { code: string }> {
  const actorId = row.level === 'publish' ? row.acknowledged_by! : row.updated_by;
  const user = (await client.query<{ display_name: string }>('SELECT display_name FROM app_users WHERE id=$1', [actorId])).rows[0];
  const role = user ? await resolveRole(client, { id: actorId }, row.workspace_id, (await catalogId(client, row)) ?? null) : null;
  if (!roleCan(role, 'course.write')) return { code: 'AUTOMATIC_UPDATE_FORBIDDEN' };
  if (row.level !== 'check' && !['owner', 'admin'].includes(role!)) return { code: 'AUTOMATIC_UPDATE_FORBIDDEN' };
  if (row.level === 'publish' && !(roleCan(role, 'release.review') && roleCan(role, 'release.publish'))) return { code: 'AUTOMATIC_UPDATE_FORBIDDEN' };
  return { actor: { id: actorId, displayName: user!.display_name }, level: row.level };
}

/** One automatic attempt for one source row (already claimed). */
export async function automaticAttempt(db: Database, row: SourceRow, options: UpdaterOptions, now: Date) {
  const who = await automaticActor(db, row);
  if ('code' in who) return recordAttempt(db, row, { trigger: 'automatic', result: 'failed', code: who.code, actorId: row.updated_by }, now);
  const outcome = await checkSource(db, who.actor, row, options);
  if (outcome.result !== 'update_available' || who.level === 'check')
    return recordAttempt(db, row, { trigger: 'automatic', result: outcome.result, code: outcome.result === 'failed' ? outcome.code : null,
      version: 'version' in outcome ? outcome.version : null, sha256: outcome.result === 'update_available' ? outcome.sha256 : null, actorId: who.actor.id }, now);
  const { preview } = outcome;
  const refusal = who.level === 'publish' ? publishRefusal(preview) : null;
  const publish = who.level === 'publish' && refusal === null;
  let approveRegistry: { configurationDigest: string } | undefined;
  if (publish && preview.registry.present && preview.registry.approvable) {
    const liveDigest = (await db.query<{ configuration_digest: string }>(`SELECT v.configuration_digest FROM admin_course_catalog c
        JOIN adaptation_registries r ON r.course_release_id=c.active_release_id AND r.status='active'
        JOIN adaptation_registry_versions v ON v.course_release_id=r.course_release_id AND v.revision=r.revision
       WHERE c.workspace_id=$1 AND c.course_key=$2`, [row.workspace_id, row.course_key])).rows[0]?.configuration_digest;
    if (row.auto_approve_registry || liveDigest === preview.registry.digest) approveRegistry = { configurationDigest: preview.registry.digest };
  }
  try {
    const installed = await installStagedPackage(db, who.actor, outcome.sha256, {
      workspaceId: row.workspace_id, idempotencyKey: `auto-update-${outcome.sha256.slice(0, 32)}`,
      notes: `Automatic update to ${outcome.version} from the course's update source.`,
      ...(publish ? { approveAndPublish: { confirmVersion: outcome.version } } : {}),
      ...(approveRegistry ? { approveRegistry } : {}),
    }, options.packages, options.admin, { automatic: true, level: who.level });
    const registryCode = installed.registryApproval && !installed.registryApproval.approved ? `AUTO_REGISTRY_${installed.registryApproval.code}`.slice(0, 80) : null;
    const pendingRegistry = preview.registry.present && !approveRegistry && who.level === 'publish' ? 'AUTO_REGISTRY_AWAITS_APPROVAL' : null;
    return recordAttempt(db, row, { trigger: 'automatic', result: publish ? 'published' : 'installed', code: refusal ?? registryCode ?? pendingRegistry,
      version: outcome.version, sha256: outcome.sha256, releaseId: installed.releaseId, actorId: who.actor.id }, now);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return recordAttempt(db, row, { trigger: 'automatic', result: 'failed', code: error.code, version: outcome.version, sha256: outcome.sha256, actorId: who.actor.id }, now);
  }
}

/**
 * Runs every due automatic update once. Single-flight: when another process (or an earlier tick)
 * holds the lock it returns `{ ran: false }`. Each due row is claimed (its next check moved one
 * interval ahead) before any network access, so a crash cannot make it retry in a loop.
 */
export async function runAutomaticUpdates(db: Database, options: UpdaterOptions, now = new Date(), limit = 20) {
  const lock = await db.connect();
  try {
    const held = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK])).rows[0]!.locked;
    if (!held) return { ran: false, attempts: 0 };
    try {
      const due = (await db.query<SourceRow>(`UPDATE course_update_sources s SET next_check_at=$1::timestamptz + make_interval(hours => s.interval_hours)
          WHERE (s.workspace_id,s.course_key) IN (SELECT workspace_id,course_key FROM course_update_sources WHERE level<>'off' AND (next_check_at IS NULL OR next_check_at <= $1)
            ORDER BY next_check_at NULLS FIRST LIMIT $2)
          RETURNING s.*`, [now, limit])).rows;
      for (const row of due) {
        try { await automaticAttempt(db, row, options, now); }
        catch (error) { await recordAttempt(db, row, { trigger: 'automatic', result: 'failed', code: codeOf(error), actorId: row.updated_by }, now).catch(() => undefined); }
      }
      return { ran: true, attempts: due.length };
    } finally { await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK]); }
  } finally { lock.release(); }
}
