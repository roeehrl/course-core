/**
 * Course-supplied extensions (A05). A course package may carry the exact bytes of the two kinds of
 * extension Core can run without trusting a copy the host operator installed:
 *
 * - `code_fixtures`: a data-only code fixture registry (execution 'server'): hidden input and
 *   expected-output cases. Core's own code evaluator (code-evaluator.ts) runs the learner's code
 *   against them in the networkless grading sandbox. Nothing from the file is executed.
 * - `sandboxed_web`: an activity script, served only inside the opaque-origin, CSP-locked activity
 *   frame (activity-runtime.ts), where it acts only through the capability broker.
 *
 * A declaration in the course's `extensions` pins the bytes by its integrity: the package member
 * (listed as a host requirement or other file) whose SHA-256 is that integrity supplies them, so the
 * course digest pins the bytes. Nothing is
 * used until an owner/admin approves the exact integrities when installing the package. Approved
 * bytes are kept (migration 107) and become installed extensions host-wide: they are
 * content-addressed, so another course can only use them by declaring the same id, version and
 * bytes. An id already installed with different bytes is refused, never replaced.
 */
import type { CourseManifest } from '@course-core/sdk';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { BROKER_CAPABILITIES, frameScriptIntegrity } from './activity-runtime.js';
import { codeEvaluator, type CodeSandbox } from './code-evaluator.js';
import type { RuntimeExtension } from './publication.js';
import { ApiError } from './errors.js';

type Sql = Database | PoolClient;
export type CourseSuppliedKind = 'code_fixtures' | 'sandboxed_web';
/** Larger members are not considered; the migration bounds stored content to 1 MiB. */
export const COURSE_SUPPLIED_LIMITS = { codeFixtureBytes: 1024 * 1024, scriptBytes: 512 * 1024, perPackage: 20 } as const;
/** Package roles a supplied file may be listed under. */
const ROLES = new Set(['host-requirement', 'other']);

export interface CourseSuppliedCandidate {
  extensionId: string; version: string; integrity: string; kind: CourseSuppliedKind; member: string; bytes: Buffer;
}
export type CourseSuppliedStatus =
  /** This host already runs exactly these bytes (host-installed or approved before). */
  | 'installed'
  /** Core can run it once an owner/admin approves it at install. */
  | 'approvable'
  /** Core cannot use it here; `code` says why. */
  | 'unavailable';
export type CourseSuppliedRefusal = 'NO_SANDBOX' | 'INVALID_CODE_FIXTURE' | 'INVALID_SCRIPT' | 'EXTENSION_ID_CONFLICT';
export interface CourseSuppliedView {
  extensionId: string; version: string; integrity: string; kind: CourseSuppliedKind; member: string; bytes: number;
  status: CourseSuppliedStatus; code?: CourseSuppliedRefusal;
}

const packageIntegrity = (sha256Hex: string) => `sha256-${sha256Hex}`;

/**
 * The course's declarations whose entrypoint is a listed package member with the declared bytes.
 * `read` returns a member's verified bytes (course-package.ts already checked size and digest).
 */
export function courseSuppliedCandidates(course: CourseManifest, members: readonly { name: string; sha256: string; bytes: number; role: string }[],
  read: (name: string) => Buffer | undefined): CourseSuppliedCandidate[] {
  const found: CourseSuppliedCandidate[] = [];
  for (const declaration of course.extensions) {
    const kind: CourseSuppliedKind | null = declaration.execution === 'sandboxed_web' ? 'sandboxed_web' : declaration.execution === 'server' ? 'code_fixtures' : null;
    if (!kind) continue;
    // Members are top-level files; the declaration's integrity, not its entrypoint path, picks the bytes.
    const member = members.find(row => ROLES.has(row.role) && packageIntegrity(row.sha256) === declaration.integrity);
    if (!member) continue;
    if (member.bytes > (kind === 'code_fixtures' ? COURSE_SUPPLIED_LIMITS.codeFixtureBytes : COURSE_SUPPLIED_LIMITS.scriptBytes)) continue;
    const bytes = read(member.name);
    if (!bytes) continue;
    found.push({ extensionId: declaration.id, version: declaration.version, integrity: declaration.integrity, kind, member: member.name, bytes });
    if (found.length >= COURSE_SUPPLIED_LIMITS.perPackage) break;
  }
  return found;
}

/** A sandboxed_web script: UTF-8 text whose own hash is the declared integrity. */
function decodeScript(candidate: Pick<CourseSuppliedCandidate, 'bytes' | 'integrity'>): string | null {
  let script: string;
  try { script = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(candidate.bytes); } catch { return null; }
  return script.trim() && frameScriptIntegrity(script) === candidate.integrity ? script : null;
}

/** Builds the runtime extension for approved (or to-be-approved) bytes. Throws ApiError to refuse. */
export async function buildCourseSuppliedExtension(course: Pick<CourseManifest, 'extensions'> | null, candidate: Omit<CourseSuppliedCandidate, 'member'>,
  sandbox: CodeSandbox | undefined): Promise<RuntimeExtension> {
  if (candidate.kind === 'code_fixtures') {
    if (!sandbox) throw new ApiError(409, 'NO_SANDBOX');
    const extension = await codeEvaluator(candidate.bytes, sandbox).catch(() => { throw new ApiError(409, 'INVALID_CODE_FIXTURE'); });
    // The registry names itself; it must be exactly the declaration that pins its bytes.
    if (extension.id !== candidate.extensionId || extension.version !== candidate.version || extension.integrity !== candidate.integrity)
      throw new ApiError(409, 'INVALID_CODE_FIXTURE');
    return extension;
  }
  const script = decodeScript(candidate);
  if (script === null) throw new ApiError(409, 'INVALID_SCRIPT');
  const declaration = course?.extensions.find(row => row.id === candidate.extensionId && row.integrity === candidate.integrity);
  // Only what the broker implements is ever offered; the course's own activity declarations narrow it further.
  const capabilities = (declaration?.capabilities ?? [...BROKER_CAPABILITIES]).filter(capability => BROKER_CAPABILITIES.has(capability));
  return { id: candidate.extensionId, version: candidate.version, integrity: candidate.integrity, capabilities, platforms: ['web'],
    activityRuntime: { kind: 'sandboxed_web', frameScript: script, validateActivity: () => {}, initialState: () => ({}) } };
}

/** Where each candidate stands on this host. Builds nothing that runs. */
export async function courseSuppliedViews(course: CourseManifest, candidates: readonly CourseSuppliedCandidate[], installed: readonly RuntimeExtension[],
  sandbox: CodeSandbox | undefined): Promise<{ views: CourseSuppliedView[]; runnable: RuntimeExtension[] }> {
  const views: CourseSuppliedView[] = [], runnable: RuntimeExtension[] = [];
  for (const candidate of candidates) {
    const base = { extensionId: candidate.extensionId, version: candidate.version, integrity: candidate.integrity, kind: candidate.kind, member: candidate.member, bytes: candidate.bytes.length };
    const same = installed.find(row => row.id === candidate.extensionId);
    if (same && same.integrity === candidate.integrity && same.version === candidate.version) { views.push({ ...base, status: 'installed' }); continue; }
    if (same) { views.push({ ...base, status: 'unavailable', code: 'EXTENSION_ID_CONFLICT' }); continue; }
    try {
      runnable.push(await buildCourseSuppliedExtension(course, candidate, sandbox));
      views.push({ ...base, status: 'approvable' });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      views.push({ ...base, status: 'unavailable', code: error.code as CourseSuppliedRefusal });
    }
  }
  return { views, runnable };
}

/**
 * The host's live list of installed extensions, extended with approved course-supplied ones.
 * The list is shared with every route (server.ts), so an approval takes effect at once.
 */
export class CourseSuppliedRegistry {
  constructor(private readonly installed: RuntimeExtension[], readonly sandbox: CodeSandbox | undefined) {}
  /** Adds an extension unless the same bytes are already installed; refuses a conflicting id.
   * Returns how to take back this activation (an install that did not commit). */
  activate(extension: RuntimeExtension): () => void {
    const same = this.installed.find(row => row.id === extension.id);
    if (same) {
      if (same.integrity === extension.integrity && same.version === extension.version) return () => {};
      throw new ApiError(409, 'EXTENSION_ID_CONFLICT');
    }
    this.installed.push(extension);
    return () => { const index = this.installed.indexOf(extension); if (index >= 0) this.installed.splice(index, 1); };
  }
  /** Startup: every approved row, oldest first. A row this host can no longer run is reported, not fatal. */
  async load(db: Sql, report: (problem: { extensionId: string; integrity: string; code: string }) => void = () => {}) {
    const rows = (await db.query<{ extension_id: string; version: string; integrity: string; kind: CourseSuppliedKind; content: Buffer; server_bundle: CourseManifest }>(
      `SELECT DISTINCT ON (s.extension_id,s.integrity) s.extension_id,s.version,s.integrity,s.kind,s.content,r.server_bundle
         FROM course_supplied_extensions s JOIN course_releases r ON r.id=s.release_id ORDER BY s.extension_id,s.integrity,s.approved_at`)).rows;
    for (const row of rows) {
      try {
        this.activate(await buildCourseSuppliedExtension(row.server_bundle,
          { extensionId: row.extension_id, version: row.version, integrity: row.integrity, kind: row.kind, bytes: row.content }, this.sandbox));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        report({ extensionId: row.extension_id, integrity: row.integrity, code: error.code });
      }
    }
  }
}

/** Records approved bytes for a release (inside the install transaction). */
export async function recordCourseSupplied(client: PoolClient, input: { releaseId: string; workspaceId: string; actorId: string; candidates: readonly CourseSuppliedCandidate[] }) {
  for (const candidate of input.candidates)
    await client.query(`INSERT INTO course_supplied_extensions(release_id,workspace_id,extension_id,version,integrity,kind,member_name,content,approved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.releaseId, input.workspaceId, candidate.extensionId, candidate.version, candidate.integrity, candidate.kind,
      candidate.member, candidate.bytes, input.actorId]);
}
