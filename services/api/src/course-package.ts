/**
 * Core's strict verifier for course-package v1 (the shared SDK/Core spec; the SDK owns the
 * published schema). A package is a gzip-compressed tar of top-level regular files with one
 * `course-package.json` descriptor listing every other member by name, size, SHA-256 and role.
 *
 * Core verifies with its own pinned SDK compiler: the course manifest must compile, its id and
 * version must match the descriptor, and the descriptor's courseDigest must equal the digest
 * Core's compiler computes. A learner projection, when present, must equal the compiler's.
 * Nothing in a package is executed, and host-requirement files are only compared by digest.
 *
 * `CoursePackageVerifier` is the seam for the SDK's canonical verifier: once Core pins an SDK
 * release that ships one, `coreCoursePackageVerifier` can delegate archive and descriptor checks
 * to it while Core keeps the compile/digest comparison against its own pinned compiler.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, compileCourse, CourseValidationError, type CompiledCourse } from '@course-core/sdk/compiler';
import { readTarGz, TarError, MEMBER_NAME, type TarMember } from './ustar.js';

export const COURSE_PACKAGE_LIMITS = Object.freeze({
  maxMembers: 200,
  maxMemberBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxCompressedBytes: 64 * 1024 * 1024,
});
export const DESCRIPTOR = 'course-package.json';
export const PACKAGE_ROLES = ['course-manifest', 'learner-projection', 'adaptation-registry', 'host-requirement', 'licence', 'other'] as const;
export type PackageRole = typeof PACKAGE_ROLES[number];
const DESCRIPTOR_KEYS = ['format', 'formatVersion', 'courseId', 'courseVersion', 'courseDigest', 'sdkVersion', 'minimumCoreVersion', 'source', 'members'];
const MEMBER_KEYS = ['name', 'bytes', 'sha256', 'role'];
const SOURCE_KEYS = ['repository', 'commit'];

export class CoursePackageError extends Error {
  constructor(readonly code: string, readonly details?: Record<string, unknown>) { super(code); }
}
const refuse = (code: string, details?: Record<string, unknown>): never => { throw new CoursePackageError(code, details); };
function require_(condition: unknown, code: string): asserts condition { if (!condition) refuse(code); }

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

// ---- semantic versions -------------------------------------------------------------------
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const isSemver = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && SEMVER.test(value);
/** Semantic-version precedence (build metadata ignored). */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error('compareSemver: invalid version');
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return Math.sign(d); }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const x = pa[4].split('.'), y = pb[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]!), ny = /^\d+$/.test(y[i]!);
    if (nx && ny) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return 0;
}

// ---- descriptor -------------------------------------------------------------------------
export interface PackageMember { name: string; bytes: number; sha256: string; role: PackageRole }
export interface CoursePackageDescriptor {
  format: 'course-package'; formatVersion: 1; courseId: string; courseVersion: string; courseDigest: string;
  sdkVersion: string; minimumCoreVersion: string; source: { repository?: string; commit?: string }; members: PackageMember[];
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Strict UTF-8 JSON without a byte-order mark. The descriptor refuses as an invalid listing;
 * any other member as PACKAGE_MEMBER_NOT_JSON. */
function parseJson(bytes: Buffer, member: string): unknown {
  const code = member === DESCRIPTOR ? 'PACKAGE_LISTING_INVALID' : 'PACKAGE_MEMBER_NOT_JSON';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse(code, { member });
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return refuse(code, { member }); }
  try { return JSON.parse(value); } catch { return refuse(code, { member }); }
}
export function parseDescriptor(bytes: Buffer): CoursePackageDescriptor {
  const value = parseJson(bytes, DESCRIPTOR);
  require_(isObject(value), 'PACKAGE_LISTING_INVALID');
  const unknown = Object.keys(value).filter(key => !DESCRIPTOR_KEYS.includes(key));
  if (unknown.length) refuse('PACKAGE_UNKNOWN_KEY', { keys: unknown.slice(0, 10) });
  require_(value.format === 'course-package', 'PACKAGE_LISTING_INVALID');
  require_(value.formatVersion === 1, 'PACKAGE_UNSUPPORTED_FORMAT');
  require_(typeof value.courseId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value.courseId), 'PACKAGE_LISTING_INVALID');
  require_(isSemver(value.courseVersion) && isSemver(value.sdkVersion) && !value.sdkVersion.includes('+') && isSemver(value.minimumCoreVersion), 'PACKAGE_LISTING_INVALID');
  require_(typeof value.courseDigest === 'string' && /^[a-f0-9]{64}$/.test(value.courseDigest), 'PACKAGE_LISTING_INVALID');
  const source = value.source ?? {};
  require_(isObject(source), 'PACKAGE_LISTING_INVALID');
  const unknownSource = Object.keys(source).filter(key => !SOURCE_KEYS.includes(key));
  if (unknownSource.length) refuse('PACKAGE_UNKNOWN_KEY', { keys: unknownSource.slice(0, 10).map(key => `source.${key}`) });
  if (source.repository !== undefined) {
    let url: URL | undefined;
    try { url = new URL(String(source.repository)); } catch { /* refused below */ }
    require_(typeof source.repository === 'string' && source.repository.length <= 2048 && source.repository.startsWith('https://') && url?.protocol === 'https:' && !url.username && !url.password, 'PACKAGE_LISTING_INVALID');
  }
  require_(source.commit === undefined || (typeof source.commit === 'string' && /^[a-f0-9]{40}$/.test(source.commit)), 'PACKAGE_LISTING_INVALID');
  // The 200-member limit counts course-package.json itself.
  require_(Array.isArray(value.members) && value.members.length >= 1 && value.members.length < COURSE_PACKAGE_LIMITS.maxMembers, 'PACKAGE_LISTING_INVALID');
  const members = value.members.map((member): PackageMember => {
    require_(isObject(member), 'PACKAGE_LISTING_INVALID');
    const extra = Object.keys(member).filter(key => !MEMBER_KEYS.includes(key));
    if (extra.length) refuse('PACKAGE_UNKNOWN_KEY', { keys: extra.slice(0, 10).map(key => `members.${key}`) });
    require_(typeof member.name === 'string' && MEMBER_NAME.test(member.name), 'PACKAGE_LISTING_INVALID');
    require_(Number.isSafeInteger(member.bytes) && (member.bytes as number) >= 0, 'PACKAGE_LISTING_INVALID');
    require_(typeof member.sha256 === 'string' && /^[a-f0-9]{64}$/.test(member.sha256), 'PACKAGE_LISTING_INVALID');
    if (!PACKAGE_ROLES.includes(member.role as PackageRole)) refuse('PACKAGE_UNKNOWN_ROLE', { member: member.name });
    return { name: member.name, bytes: member.bytes as number, sha256: member.sha256, role: member.role as PackageRole };
  });
  return { format: 'course-package', formatVersion: 1, courseId: value.courseId, courseVersion: value.courseVersion, courseDigest: value.courseDigest,
    sdkVersion: value.sdkVersion, minimumCoreVersion: value.minimumCoreVersion,
    source: { ...(source.repository !== undefined ? { repository: source.repository as string } : {}), ...(source.commit !== undefined ? { commit: source.commit as string } : {}) },
    members };
}

// ---- verification -----------------------------------------------------------------------
export interface VerifiedCoursePackage {
  /** SHA-256 of the compressed package bytes. */
  sha256: string;
  compressedBytes: number;
  descriptor: CoursePackageDescriptor;
  compiled: CompiledCourse;
  /** Whether the package carries an adaptation (recovery) registry, and its JSON. */
  adaptationRegistryPresent: boolean;
  adaptationRegistry: unknown;
  hostRequirements: { name: string; sha256: string; bytes: number }[];
  members: { name: string; bytes: number; sha256: string; role: PackageRole }[];
}
export interface CoursePackageVerifier { verify(bytes: Buffer): Promise<VerifiedCoursePackage> }

/** Verifies already-read members (shared by archives and unpacked directories). */
export function verifyMembers(files: readonly TarMember[], packageSha256: string, compressedBytes: number): VerifiedCoursePackage {
  const descriptorFile = files.find(file => file.name === DESCRIPTOR);
  require_(descriptorFile, 'PACKAGE_LISTING_MISSING');
  const descriptor = parseDescriptor(descriptorFile.bytes);
  const listed = new Map<string, PackageMember>();
  for (const member of descriptor.members) {
    if (member.name === DESCRIPTOR) refuse('PACKAGE_LISTING_INVALID', { member: DESCRIPTOR });
    if (listed.has(member.name)) refuse('PACKAGE_DUPLICATE_LISTING', { member: member.name });
    listed.set(member.name, member);
  }
  const present = new Map(files.filter(file => file.name !== DESCRIPTOR).map(file => [file.name, file]));
  for (const name of present.keys()) if (!listed.has(name)) refuse('PACKAGE_UNLISTED_MEMBER', { member: name });
  for (const [name, member] of listed) {
    const file = present.get(name);
    if (!file) refuse('PACKAGE_MISSING_MEMBER', { member: name });
    if (file!.bytes.length !== member.bytes) refuse('PACKAGE_MEMBER_SIZE_MISMATCH', { member: name });
    if (sha256(file!.bytes) !== member.sha256) refuse('PACKAGE_MEMBER_DIGEST_MISMATCH', { member: name });
  }
  const byRole = (role: PackageRole) => descriptor.members.filter(member => member.role === role);
  if (byRole('course-manifest').length !== 1) refuse('PACKAGE_ROLE_COUNT', { role: 'course-manifest' });
  for (const role of ['learner-projection', 'adaptation-registry'] as const) if (byRole(role).length > 1) refuse('PACKAGE_ROLE_COUNT', { role });
  const read = (member: PackageMember) => present.get(member.name)!.bytes;
  const manifestMember = byRole('course-manifest')[0]!;
  const manifest = parseJson(read(manifestMember), manifestMember.name);
  // The SDK's compiled output (formatVersion/digest/server/learner) is not a course manifest.
  if (isObject(manifest) && ['formatVersion', 'server', 'learner', 'digest'].some(key => key in manifest)) refuse('PACKAGE_COMPILED_WRAPPER');
  let compiled: CompiledCourse;
  try { compiled = compileCourse(manifest); }
  catch (error) {
    if (error instanceof CourseValidationError) refuse('PACKAGE_COURSE_INVALID', { issues: error.issues.slice(0, 20) });
    throw error;
  }
  if (compiled.server.id !== descriptor.courseId) refuse('PACKAGE_COURSE_ID_MISMATCH');
  if (compiled.server.version !== descriptor.courseVersion) refuse('PACKAGE_COURSE_VERSION_MISMATCH');
  if (compiled.digest !== descriptor.courseDigest) refuse('PACKAGE_COURSE_DIGEST_MISMATCH');
  const projection = byRole('learner-projection')[0];
  if (projection) {
    const learner = parseJson(read(projection), projection.name);
    if (canonicalJson(learner) !== canonicalJson(compiled.learner)) refuse('PACKAGE_LEARNER_MISMATCH');
  }
  const registryMember = byRole('adaptation-registry')[0];
  let adaptationRegistry: unknown = null;
  if (registryMember) {
    // Valid JSON is all the package format requires; Core's registry checks apply at approval.
    adaptationRegistry = parseJson(read(registryMember), registryMember.name);
  }
  return {
    sha256: packageSha256, compressedBytes, descriptor, compiled, adaptationRegistryPresent: registryMember !== undefined, adaptationRegistry,
    hostRequirements: byRole('host-requirement').map(({ name, sha256: digest, bytes }) => ({ name, sha256: digest, bytes })),
    members: descriptor.members.map(({ name, bytes, sha256: digest, role }) => ({ name, bytes, sha256: digest, role })),
  };
}

export const coreCoursePackageVerifier: CoursePackageVerifier = {
  async verify(bytes) {
    let files: TarMember[];
    try { files = await readTarGz(bytes, COURSE_PACKAGE_LIMITS); }
    catch (error) { if (error instanceof TarError) refuse(error.code); throw error; }
    return verifyMembers(files, sha256(bytes), bytes.length);
  },
};
export const verifyCoursePackage = (bytes: Buffer, verifier: CoursePackageVerifier = coreCoursePackageVerifier) => verifier.verify(bytes);
