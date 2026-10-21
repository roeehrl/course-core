/**
 * Installing a course from a course-package v1 file (upload or public GitHub release).
 *
 * POST /api/admin/course-packages/inspect?workspaceId=<uuid>[&asset=<name>]
 *   Body: the package bytes (Content-Type application/gzip or application/octet-stream, at most
 *   64 MiB), or JSON {"url": "https://github.com/<owner>/<repo>[/releases/…]", "asset"?: name}.
 *   Owner/admin (course.write). Verifies the package, stages its bytes for 60 minutes keyed by
 *   their SHA-256 and returns a preview: identity, digest, SDK and Core compatibility, what this
 *   workspace already has, the adaptation registry, host requirements, the runtime check and
 *   blocking problems. Nothing is installed.
 * POST /api/admin/course-packages/:sha256/install
 *   {workspaceId, idempotencyKey, notes?, approveAndPublish?: {confirmVersion},
 *    approveRegistry?: {configurationDigest}}. Creates the release draft from the staged package's
 *   manifest (the same compile/validation as the draft editor), records the package digest and
 *   source on the release, submits it for review and stages its adaptation registry. With
 *   approveAndPublish (actor holds release.review and release.publish, confirmVersion is the exact
 *   version) it is also approved and published; with approveRegistry (the staged registry's
 *   digest) the registry is approved for the release. Repeating an install of the same package
 *   returns the existing installation.
 * GET  /api/admin/course-packages/installs/:releaseId  — the installation's state.
 * POST /api/admin/course-packages/installs/:releaseId/registry
 *   {configurationDigest, expectedRegistryRevision}: approves exactly the staged registry.
 *
 * A package is never executed in the API. Host-requirement files are compared with the host's
 * configured code-fixture and teaching-verifier files by SHA-256; only names and digests are
 * reported. Course-supplied extensions (a data-only code fixture registry or a sandboxed_web
 * activity script the course pins by digest, course-supplied-extensions.ts) are listed in the
 * preview; installing needs approveCourseSupplied with exactly their integrities.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { SDK_VERSION } from '@course-core/sdk';
import type { Actor, authService } from './auth.js';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { roleCan, workspaceRole } from './course-access.js';
import { ensureCatalog, transitionReleaseWithin, type AdminRuntimeOptions, type Catalog } from './admin-routes.js';
import { assertCourseRunnable, prepareCourseRunnable, type RuntimeExtension } from './publication.js';
import { approveAdaptationRegistry, checkAdaptationConfiguration, type AdaptationConfiguration, type AdaptationRuntime } from './adaptation-store.js';
import { digestJson } from './repository.js';
import { COURSE_PACKAGE_LIMITS, compareSemver, CoursePackageError, coreCoursePackageVerifier, sha256, type CoursePackageVerifier, type VerifiedCoursePackage } from './course-package.js';
import { fetchGitHubPackage, type RemoteFetchMode, type RemoteFetchOptions } from './course-package-source.js';
import { buildCourseSuppliedExtension, courseSuppliedViews, recordCourseSupplied, type CourseSuppliedRegistry } from './course-supplied-extensions.js';

type Auth = ReturnType<typeof authService>;
type Sql = Database | PoolClient;
export interface HostRequirementFile { name: string; sha256: string }
export interface CoursePackageOptions {
  installedExtensions?: readonly RuntimeExtension[];
  adaptation: AdaptationRuntime;
  /** The host's configured code-fixture and teaching-verifier files (basename + SHA-256 only). */
  hostFiles?: readonly HostRequirementFile[];
  /** This Core's version; defaults to the repository package version. */
  coreVersion?: string;
  remoteFetch?: RemoteFetchMode;
  remote?: RemoteFetchOptions;
  verifier?: CoursePackageVerifier;
  stagingMinutes?: number;
  /** Approved course-supplied extensions join the host's installed list through this registry. */
  courseSupplied?: CourseSuppliedRegistry;
}
const STAGED_PER_WORKSPACE = 4;
const uuid = z.uuid();
const hex = z.string().regex(/^[a-f0-9]{64}$/);

/** The repository version this Core was built from (root package.json). */
export function repositoryCoreVersion(): string {
  try {
    const value = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof value.version === 'string' ? value.version : '0.0.0';
  } catch { return '0.0.0'; }
}
/**
 * Core fully supports packages compiled by the SDK minor release it pins (0.x minors are
 * breaking): pinned to 0.5.x that is >=0.5.0 <0.6.0, and moving the pin to 0.6.x moves it to
 * >=0.6.0 <0.7.0 with no other change. A package from an older SDK of the same major installs
 * with a warning (Core validates it with its own SDK, and the schema only grew); one from a
 * newer SDK, or another major, is refused: its bundle may use contracts this Core cannot check.
 */
export function supportedSdkRange(version = SDK_VERSION) {
  const [major, minor] = version.split('.').map(Number) as [number, number];
  return { min: `${major}.${minor}.0`, maxExclusive: major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0` };
}
/** How a package compiled by `sdkVersion` is treated (scripts/release-compat.mjs packageAcceptance keeps the same rule). */
export function sdkPackageStatus(sdkVersion: string, coreSdk = SDK_VERSION): 'supported' | 'older' | 'unsupported' {
  const range = supportedSdkRange(coreSdk);
  if (compareSemver(sdkVersion, range.maxExclusive) >= 0) return 'unsupported';
  if (compareSemver(sdkVersion, range.min) >= 0) return 'supported';
  return sdkVersion.split('.')[0] === coreSdk.split('.')[0] ? 'older' : 'unsupported';
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}
const packageError = (error: unknown): never => {
  if (error instanceof CoursePackageError) {
    const status = ['PACKAGE_TOO_LARGE', 'PACKAGE_TOO_MANY_MEMBERS'].includes(error.code) ? 413 : 422;
    throw new ApiError(status, error.code, error.code, error.details);
  }
  throw error;
};

/** Install needs owner/admin with course.write; returns the workspace role. */
export async function permitInstall(client: Sql, actor: Actor, workspaceId: string) {
  const role = await workspaceRole(client, actor, workspaceId, ['owner', 'admin']);
  requireCondition(roleCan(role, 'course.write'), 'FORBIDDEN', 403);
  return role;
}

/** A finding the admin app words from its code and params (installCourse.problem.<code>). `check: 'runtime'` marks a runtime refusal code. */
type Problem = { code: string; severity: 'blocking' | 'warning'; params?: Record<string, string> };
export async function packagePreview(client: Sql, workspaceId: string, role: string, verified: VerifiedCoursePackage, options: CoursePackageOptions) {
  const { descriptor, compiled } = verified, problems: Problem[] = [];
  const coreVersion = options.coreVersion ?? repositoryCoreVersion();
  const range = supportedSdkRange();
  const sdkStatus = sdkPackageStatus(descriptor.sdkVersion);
  if (sdkStatus === 'unsupported') problems.push({ code: 'SDK_UNSUPPORTED', severity: 'blocking', params: { sdkVersion: descriptor.sdkVersion, min: range.min, maxExclusive: range.maxExclusive } });
  else if (sdkStatus === 'older') problems.push({ code: 'SDK_OLDER_THAN_CORE', severity: 'warning', params: { sdkVersion: descriptor.sdkVersion, coreSdkVersion: SDK_VERSION } });
  const coreSatisfied = compareSemver(coreVersion, descriptor.minimumCoreVersion) >= 0;
  if (!coreSatisfied) problems.push({ code: 'CORE_VERSION_TOO_OLD', severity: 'blocking', params: { required: descriptor.minimumCoreVersion, current: coreVersion } });
  // What this workspace already has of this course.
  const catalog = (await client.query<Catalog>('SELECT * FROM admin_course_catalog WHERE workspace_id=$1 AND course_key=$2', [workspaceId, descriptor.courseId])).rows[0] ?? null;
  const releases = (await client.query<{ id: string; version: string; digest: string; status: string }>(
    'SELECT id,version,digest,status FROM course_releases WHERE workspace_id=$1 AND course_key=$2', [workspaceId, descriptor.courseId])).rows;
  const sameVersion = releases.find(release => release.version === descriptor.courseVersion);
  const newest = releases.map(release => release.version).filter(version => /^\d+\.\d+\.\d+/.test(version)).sort((a, b) => { try { return compareSemver(b, a); } catch { return 0; } })[0] ?? null;
  const installation = sameVersion ? (await client.query<{ package_sha256: string }>('SELECT package_sha256 FROM course_release_packages WHERE release_id=$1', [sameVersion.id])).rows[0] : undefined;
  const existing = !catalog && !releases.length ? 'new-course'
    : sameVersion ? (sameVersion.digest === compiled.digest ? 'already-installed' : 'version-conflict') : 'new-version';
  if (existing === 'version-conflict') problems.push({ code: 'RELEASE_VERSION_CONFLICT', severity: 'blocking', params: { version: descriptor.courseVersion } });
  if (existing === 'new-version' && newest) { try { if (compareSemver(descriptor.courseVersion, newest) < 0) problems.push({ code: 'OLDER_THAN_INSTALLED', severity: 'warning', params: { newest } }); } catch { /* non-semver legacy versions are not compared */ } }
  // Course-supplied extensions count as installed for the check; installing then needs their approval.
  const supplied = await courseSuppliedViews(compiled.server, verified.courseSupplied, options.installedExtensions ?? [], options.courseSupplied?.sandbox);
  const approvalRequired = supplied.views.filter(view => view.status === 'approvable').map(view => view.integrity);
  for (const view of supplied.views) if (view.status === 'unavailable')
    problems.push({ code: 'COURSE_SUPPLIED_UNAVAILABLE', severity: 'warning', params: { member: view.member, reason: view.code } });
  if (approvalRequired.length) problems.push({ code: 'COURSE_SUPPLIED_APPROVAL_REQUIRED', severity: 'warning', params: { count: String(approvalRequired.length) } });
  // Runtime capability check: the same gate review and publication apply.
  const extensions = [...(options.installedExtensions ?? []), ...supplied.runnable];
  let runtime: { runnable: true } | { runnable: false; code: string; details?: Record<string, unknown> };
  try {
    await prepareCourseRunnable(compiled.server, extensions);
    assertCourseRunnable(compiled.server, extensions);
    runtime = { runnable: true };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    runtime = { runnable: false, code: error.code, ...(error.details ? { details: error.details } : {}) };
    problems.push({ code: error.code, severity: 'blocking', params: { check: 'runtime' } });
  }
  const hostFiles = options.hostFiles ?? [];
  const suppliedMembers = new Set(supplied.views.filter(view => view.status !== 'unavailable').map(view => view.member));
  const hostRequirements = verified.hostRequirements.map(requirement => ({
    name: requirement.name, sha256: requirement.sha256, bytes: requirement.bytes,
    status: hostFiles.some(file => file.sha256 === requirement.sha256) ? 'identical' as const
      : suppliedMembers.has(requirement.name) ? 'course_supplied' as const
        : hostFiles.some(file => file.name === requirement.name) ? 'different' as const : 'missing' as const,
  }));
  for (const requirement of hostRequirements) if (requirement.status !== 'identical' && requirement.status !== 'course_supplied')
    problems.push({ code: requirement.status === 'missing' ? 'HOST_REQUIREMENT_MISSING' : 'HOST_REQUIREMENT_DIFFERENT', severity: runtime.runnable ? 'warning' : 'blocking',
      params: { name: requirement.name, sha256: requirement.sha256.slice(0, 12) } });
  let registry: { present: false } | { present: true; digest: string; profileCount: number; approvable: boolean; code?: string };
  if (!verified.adaptationRegistryPresent) registry = { present: false };
  else {
    const check = checkAdaptationConfiguration(compiled.server, verified.adaptationRegistry, options.adaptation);
    const profiles = (verified.adaptationRegistry as { profiles?: unknown } | null)?.profiles;
    registry = { present: true, digest: digestJson(verified.adaptationRegistry), profileCount: Array.isArray(profiles) ? profiles.length : 0,
      approvable: check.valid, ...(check.valid ? {} : { code: check.code }) };
    if (!check.valid) problems.push({ code: 'ADAPTATION_REGISTRY_NOT_APPROVABLE', severity: 'warning', params: { reason: check.code } });
  }
  return {
    sha256: verified.sha256, compressedBytes: verified.compressedBytes,
    course: { id: descriptor.courseId, title: compiled.server.title, version: descriptor.courseVersion, digest: compiled.digest },
    source: descriptor.source,
    sdk: { packageVersion: descriptor.sdkVersion, coreVersion: SDK_VERSION, supported: range, status: sdkStatus },
    core: { minimumVersion: descriptor.minimumCoreVersion, version: coreVersion, satisfied: coreSatisfied },
    existing: { status: existing, catalogId: catalog?.id ?? null, newestVersion: newest,
      ...(sameVersion ? { releaseId: sameVersion.id, releaseStatus: sameVersion.status, installedFromPackage: installation?.package_sha256 ?? null } : {}) },
    registry, hostRequirements, runtime,
    courseSupplied: { files: supplied.views, approvalRequired },
    members: verified.members.map(({ name, role: memberRole, bytes }) => ({ name, role: memberRole, bytes })),
    problems, installable: !problems.some(problem => problem.severity === 'blocking'),
    permissions: { install: roleCan(role, 'course.write'), approveAndPublish: roleCan(role, 'release.review') && roleCan(role, 'release.publish'), approveRegistry: ['owner', 'admin'].includes(role) },
  };
}

export async function installView(client: Sql, actor: Actor, releaseId: string) {
  const row = (await client.query<{ workspace_id: string; course_key: string; version: string; digest: string; status: string; title: string; package_sha256: string; source: unknown;
    installed_at: Date; registry_digest: string | null; registry_configuration: { profiles?: unknown[] } | null; sdk_version: string; minimum_core_version: string }>(
    `SELECT r.workspace_id,r.course_key,r.version,r.digest,r.status,r.server_bundle->>'title' AS title,p.package_sha256,p.source,p.installed_at,p.registry_digest,
       p.registry_configuration,p.sdk_version,p.minimum_core_version
       FROM course_release_packages p JOIN course_releases r ON r.id=p.release_id WHERE p.release_id=$1`, [releaseId])).rows[0];
  requireCondition(row, 'COURSE_PACKAGE_INSTALL_NOT_FOUND', 404);
  const role = await permitInstall(client, actor, row.workspace_id);
  const catalog = (await client.query<Catalog>('SELECT * FROM admin_course_catalog WHERE workspace_id=$1 AND course_key=$2', [row.workspace_id, row.course_key])).rows[0]!;
  const review = (await client.query<{ state: string }>('SELECT state FROM admin_release_reviews WHERE release_id=$1', [releaseId])).rows[0];
  const active = (await client.query<{ revision: number; status: string; configuration_digest: string }>(
    `SELECT r.revision,r.status,v.configuration_digest FROM adaptation_registries r JOIN adaptation_registry_versions v ON v.course_release_id=r.course_release_id AND v.revision=r.revision
      WHERE r.course_release_id=$1`, [releaseId])).rows[0];
  return {
    releaseId, catalogId: catalog.id, catalogRevision: String(catalog.revision), workspaceId: row.workspace_id,
    course: { id: row.course_key, title: row.title, version: row.version, digest: row.digest },
    state: row.status === 'draft' ? review?.state ?? 'draft' : row.status,
    availableForNewLearners: catalog.active_release_id === releaseId,
    package: { sha256: row.package_sha256, source: row.source, sdkVersion: row.sdk_version, minimumCoreVersion: row.minimum_core_version, installedAt: row.installed_at.toISOString() },
    registry: row.registry_digest === null ? { present: false as const } : {
      present: true as const, digest: row.registry_digest, profileCount: row.registry_configuration?.profiles?.length ?? 0,
      registryRevision: active?.revision ?? 0, approved: active?.status === 'active' && active.configuration_digest === row.registry_digest },
    permissions: { approve: roleCan(role, 'release.review'), publish: roleCan(role, 'release.publish'), approveRegistry: ['owner', 'admin'].includes(role) },
  };
}

export async function approveStagedRegistry(db: Database, actor: Actor, releaseId: string, input: { configurationDigest: string; expectedRegistryRevision?: number }, runtime: AdaptationRuntime) {
  const staged = await transaction(db, async client => {
    const row = (await client.query<{ workspace_id: string; registry_configuration: AdaptationConfiguration | null; registry_digest: string | null }>(
      'SELECT workspace_id,registry_configuration,registry_digest FROM course_release_packages WHERE release_id=$1', [releaseId])).rows[0];
    requireCondition(row, 'COURSE_PACKAGE_INSTALL_NOT_FOUND', 404);
    await workspaceRole(client, actor, row.workspace_id, ['owner', 'admin']);
    requireCondition(row.registry_configuration && row.registry_digest, 'ADAPTATION_REGISTRY_NOT_STAGED', 404);
    requireCondition(row.registry_digest === input.configurationDigest, 'ADAPTATION_REGISTRY_DIGEST_MISMATCH', 409);
    const current = (await client.query<{ revision: number }>('SELECT revision FROM adaptation_registries WHERE course_release_id=$1', [releaseId])).rows[0]?.revision ?? 0;
    return { configuration: row.registry_configuration, current };
  });
  return approveAdaptationRegistry(db, actor, { releaseId, expectedRegistryRevision: input.expectedRegistryRevision ?? staged.current, configuration: staged.configuration }, runtime);
}

async function readUpload(request: FastifyRequest, payload: NodeJS.ReadableStream): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > COURSE_PACKAGE_LIMITS.maxCompressedBytes) throw new ApiError(413, 'PACKAGE_TOO_LARGE');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of payload as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > COURSE_PACKAGE_LIMITS.maxCompressedBytes) throw new ApiError(413, 'PACKAGE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}


/** Keeps verified package bytes for `minutes` (at most a few per workspace) so install needs no refetch. */
export async function stagePackage(client: Sql, workspaceId: string, actorId: string, packageSha: string, bytes: Buffer, source: Record<string, unknown>, minutes: number) {
  await client.query('DELETE FROM course_package_staging WHERE expires_at < clock_timestamp()');
  const staged = await client.query<{ expires_at: Date }>(`INSERT INTO course_package_staging(workspace_id,sha256,bytes,source,staged_by,expires_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()+($6 * interval '1 minute'))
    ON CONFLICT(workspace_id,sha256) DO UPDATE SET source=EXCLUDED.source,staged_by=EXCLUDED.staged_by,staged_at=clock_timestamp(),expires_at=EXCLUDED.expires_at
    RETURNING expires_at`, [workspaceId, packageSha, bytes, JSON.stringify(source), actorId, minutes]);
  // Bounded: keep only the most recent few staged packages per workspace.
  await client.query(`DELETE FROM course_package_staging WHERE workspace_id=$1 AND sha256 NOT IN
    (SELECT sha256 FROM course_package_staging WHERE workspace_id=$1 ORDER BY staged_at DESC LIMIT $2)`, [workspaceId, STAGED_PER_WORKSPACE]);
  return staged.rows[0]!.expires_at.toISOString();
}
export const installSchema = z.strictObject({
  workspaceId: uuid, idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/), notes: z.string().trim().max(1200).optional(),
  approveAndPublish: z.strictObject({ confirmVersion: z.string().min(1).max(128) }).optional(),
  approveRegistry: z.strictObject({ configurationDigest: hex }).optional(),
  /** Required to install (and publish) a version lower than the newest one installed (course-versions.ts). */
  confirmOlderVersion: z.literal(true).optional(),
  /** Approves exactly these course-supplied files (their declared integrities) for this install. */
  approveCourseSupplied: z.strictObject({ integrities: z.array(z.string().regex(/^sha256-[a-f0-9]{64}$/)).max(20) }).optional(),
});
/** Installs a staged, re-verified package as a release draft in review (see the module comment).
 * Shared by the install route and the course updater. */
export async function installStagedPackage(db: Database, actor: Actor, packageSha: string, input: z.output<typeof installSchema>,
  options: CoursePackageOptions, admin: AdminRuntimeOptions, extraEventPayload: Record<string, unknown> = {}) {
    // Course-supplied extensions activated in this install, removed again if it does not commit.
    const activated: (() => void)[] = [];
    const installed = await transaction(db, async client => {
      const role = await permitInstall(client, actor, input.workspaceId);
      if (input.approveAndPublish) requireCondition(roleCan(role, 'release.review') && roleCan(role, 'release.publish'), 'FORBIDDEN', 403);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`course-package:${input.workspaceId}:${packageSha}`]);
      const previous = (await client.query<{ release_id: string }>('SELECT release_id FROM course_release_packages WHERE workspace_id=$1 AND package_sha256=$2', [input.workspaceId, packageSha])).rows[0];
      if (previous) return { releaseId: previous.release_id, alreadyInstalled: true };
      const staged = (await client.query<{ bytes: Buffer; source: Record<string, unknown> }>(
        'SELECT bytes,source FROM course_package_staging WHERE workspace_id=$1 AND sha256=$2 AND expires_at > clock_timestamp()', [input.workspaceId, packageSha])).rows[0];
      requireCondition(staged, 'COURSE_PACKAGE_NOT_STAGED', 404);
      requireCondition(sha256(staged.bytes) === packageSha, 'COURSE_PACKAGE_DIGEST_MISMATCH', 409);
      const verified = await (options.verifier ?? coreCoursePackageVerifier).verify(staged.bytes).catch(packageError);
      const { descriptor, compiled } = verified;
      if (input.approveAndPublish) requireCondition(input.approveAndPublish.confirmVersion === descriptor.courseVersion, 'PUBLISH_CONFIRMATION_REQUIRED', 428);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`course-package:${input.workspaceId}:${descriptor.courseId}`]);
      const preview = await packagePreview(client, input.workspaceId, role, verified, options);
      const same = preview.existing.status === 'already-installed' ? preview.existing.releaseId! : null;
      if (same) return { releaseId: same, alreadyInstalled: true, unrecorded: true };
      const blocking = preview.problems.filter(problem => problem.severity === 'blocking');
      if (blocking.length) throw new ApiError(409, blocking[0]!.code, blocking[0]!.code, { problems: blocking.map(problem => problem.code) });
      // A course moves forward: going back to an older version is an explicit, recorded choice.
      const older = preview.problems.some(problem => problem.code === 'OLDER_THAN_INSTALLED');
      if (older && !input.confirmOlderVersion) throw new ApiError(409, 'OLDER_VERSION_CONFIRMATION_REQUIRED', 'OLDER_VERSION_CONFIRMATION_REQUIRED',
        { version: descriptor.courseVersion, newestVersion: preview.existing.newestVersion });
      // Course-supplied files run only after an owner/admin approves exactly these bytes.
      const required = preview.courseSupplied.approvalRequired, approved = input.approveCourseSupplied?.integrities ?? [];
      if (required.length && (approved.length !== required.length || required.some(integrity => !approved.includes(integrity))))
        throw new ApiError(409, 'COURSE_SUPPLIED_APPROVAL_REQUIRED', 'COURSE_SUPPLIED_APPROVAL_REQUIRED', { integrities: required });
      const releaseId = randomUUID();
      await client.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8)`,
        [releaseId, input.workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), actor.id]);
      const catalogId = await ensureCatalog(client, releaseId);
      const catalog = (await client.query<Catalog>('SELECT * FROM admin_course_catalog WHERE id=$1 FOR UPDATE', [catalogId])).rows[0]!;
      const notes = input.notes || `Installed from course package ${packageSha.slice(0, 12)} (${staged.source.kind === 'github' ? `${staged.source.owner}/${staged.source.repo} ${staged.source.tag}` : staged.source.kind === 'path' ? `host folder ${[staged.source.directory, staged.source.subpath, staged.source.file].filter(Boolean).join('/')}` : 'uploaded file'}).`;
      await client.query('UPDATE admin_release_reviews SET notes=$2 WHERE release_id=$1', [releaseId, notes.slice(0, 1200)]);
      await client.query(`INSERT INTO course_release_packages(release_id,workspace_id,package_sha256,source,sdk_version,minimum_core_version,registry_configuration,registry_digest,installed_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [releaseId, input.workspaceId, packageSha, JSON.stringify(staged.source), descriptor.sdkVersion, descriptor.minimumCoreVersion,
        !verified.adaptationRegistryPresent ? null : JSON.stringify(verified.adaptationRegistry), !verified.adaptationRegistryPresent ? null : digestJson(verified.adaptationRegistry), actor.id]);
      const approvedFiles = verified.courseSupplied.filter(candidate => required.includes(candidate.integrity));
      if (approvedFiles.length) {
        requireCondition(options.courseSupplied, 'COURSE_SUPPLIED_UNAVAILABLE', 409);
        await recordCourseSupplied(client, { releaseId, workspaceId: input.workspaceId, actorId: actor.id, candidates: approvedFiles });
        for (const candidate of approvedFiles)
          activated.push(options.courseSupplied.activate(await buildCourseSuppliedExtension(compiled.server, candidate, options.courseSupplied.sandbox)));
      }
      await transitionReleaseWithin(client, actor, catalog, releaseId, { action: 'submit-review' }, admin);
      let published = false;
      if (input.approveAndPublish) {
        await transitionReleaseWithin(client, actor, catalog, releaseId, { action: 'approve' }, admin);
        await transitionReleaseWithin(client, actor, catalog, releaseId, { action: 'publish', ...(older ? { confirmOlderVersion: true as const } : {}) }, admin);
        published = true;
      }
      await client.query('UPDATE admin_course_catalog SET revision=revision+1 WHERE id=$1', [catalogId]);
      await client.query('DELETE FROM course_package_staging WHERE workspace_id=$1 AND sha256=$2', [input.workspaceId, packageSha]);
      await appendEvent(client, { workspaceId: input.workspaceId, actorId: actor.id, actorKind: 'staff', type: 'course_package.installed',
        payload: { catalogId, releaseId, courseKey: descriptor.courseId, version: descriptor.courseVersion, courseDigest: compiled.digest, packageSha256: packageSha,
          sourceKind: staged.source.kind, ...(staged.source.kind === 'github' ? { repository: `${staged.source.owner}/${staged.source.repo}`, tag: staged.source.tag } : {}),
          registryStaged: verified.adaptationRegistryPresent, published,
          ...(approvedFiles.length ? { courseSupplied: approvedFiles.map(({ extensionId, version, integrity, kind }) => ({ extensionId, version, integrity, kind })) } : {}), ...(older ? { olderVersionConfirmed: true, newestVersion: preview.existing.newestVersion } : {}), ...extraEventPayload },
        idempotencyKey: `course-package:${input.workspaceId}:${packageSha}` });
      return { releaseId, alreadyInstalled: false };
    }).catch(error => { for (const undo of activated.reverse()) undo(); throw error; });
    let registry: { approved: true; registryRevision: number } | { approved: false; code: string } | undefined;
    if (input.approveRegistry) {
      try { registry = { approved: true, ...await approveStagedRegistry(db, actor, installed.releaseId, input.approveRegistry, options.adaptation) }; }
      catch (error) { if (!(error instanceof ApiError)) throw error; registry = { approved: false, code: error.code }; }
    }
    const view = await transaction(db, client => installView(client, actor, installed.releaseId).catch(error => {
      // A release installed by hand (not from a package) has no installation record.
      if (error instanceof ApiError && error.code === 'COURSE_PACKAGE_INSTALL_NOT_FOUND') return null;
      throw error;
    }));
    return { alreadyInstalled: installed.alreadyInstalled, releaseId: installed.releaseId, installation: view, ...(registry ? { registryApproval: registry } : {}) };
}

export function registerCoursePackageRoutes(app: FastifyInstance, db: Database, auth: Auth, options: CoursePackageOptions, admin: AdminRuntimeOptions) {
  const verifier = options.verifier ?? coreCoursePackageVerifier;
  const stagingMinutes = options.stagingMinutes ?? 60;
  const actors = new WeakMap<FastifyRequest, Actor>();
  void app.register(async scope => {
    // Package bytes are read only after the caller is known to be an owner/admin (onRequest).
    scope.addContentTypeParser(['application/gzip', 'application/x-gzip', 'application/octet-stream'], (request, payload, done) => {
      readUpload(request, payload).then(bytes => done(null, bytes), error => done(error as Error));
    });
    scope.post('/api/admin/course-packages/inspect', {
      onRequest: async request => {
        const actor = await auth.authenticate(request);
        const workspaceId = parse(uuid, (request.query as Record<string, unknown>).workspaceId);
        await permitInstall(db, actor, workspaceId);
        actors.set(request, actor);
      },
    }, async request => {
      const actor = actors.get(request)!;
      const query = parse(z.strictObject({ workspaceId: uuid, asset: z.string().max(200).optional() }), request.query);
      let bytes: Buffer, source: Record<string, unknown>;
      if (Buffer.isBuffer(request.body)) { bytes = request.body; source = { kind: 'upload' }; }
      else {
        const body = parse(z.strictObject({ url: z.string().min(1).max(2048), asset: z.string().max(200).optional() }), request.body);
        requireCondition((options.remoteFetch ?? 'github') === 'github', 'COURSE_PACKAGE_REMOTE_FETCH_DISABLED', 403);
        const fetched = await fetchGitHubPackage(body.url, body.asset ?? query.asset, options.remote);
        bytes = fetched.bytes; source = fetched.source;
      }
      requireCondition(bytes.length > 0, 'PACKAGE_NOT_GZIP', 422);
      const verified = await verifier.verify(bytes).catch(packageError);
      return transaction(db, async client => {
        const role = await permitInstall(client, actor, query.workspaceId);
        const preview = await packagePreview(client, query.workspaceId, role, verified, options);
        const expiresAt = await stagePackage(client, query.workspaceId, actor.id, verified.sha256, bytes, source, stagingMinutes);
        await appendEvent(client, { workspaceId: query.workspaceId, actorId: actor.id, actorKind: 'staff', type: 'course_package.inspected',
          payload: { packageSha256: verified.sha256, courseKey: preview.course.id, version: preview.course.version, sourceKind: source.kind,
            blocking: preview.problems.filter(problem => problem.severity === 'blocking').map(problem => problem.code) },
          idempotencyKey: `course-package:inspect:${randomUUID()}` });
        return { ...preview, packageSource: source, expiresAt };
      });
    });
  });
  app.post('/api/admin/course-packages/:sha256/install', async request => {
    const actor = await auth.authenticate(request);
    const packageSha = parse(hex, (request.params as Record<string, string>).sha256);
    const input = parse(installSchema, request.body);
    return installStagedPackage(db, actor, packageSha, input, options, admin);
  });
  app.get('/api/admin/course-packages/installs/:releaseId', async request => {
    const actor = await auth.authenticate(request);
    const releaseId = parse(uuid, (request.params as Record<string, string>).releaseId);
    return transaction(db, client => installView(client, actor, releaseId));
  });
  app.post('/api/admin/course-packages/installs/:releaseId/registry', async request => {
    const actor = await auth.authenticate(request);
    const releaseId = parse(uuid, (request.params as Record<string, string>).releaseId);
    const input = parse(z.strictObject({ configurationDigest: hex, expectedRegistryRevision: z.number().int().min(0) }), request.body);
    await approveStagedRegistry(db, actor, releaseId, input, options.adaptation);
    return transaction(db, client => installView(client, actor, releaseId));
  });
}
