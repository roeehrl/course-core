import { createHash } from 'node:crypto';
import { canonicalJson } from '@course-core/sdk/compiler';
import type { CourseManifest } from '@course-core/sdk';
import type { LearnerCourse } from '@course-core/sdk/compiler';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { Actor } from './auth.js';
import { enrollmentRole, memberRole } from './course-access.js';
import { STAFF_READ_ROLES } from './learner-privacy.js';
import { ApiError, requireCondition } from './errors.js';
import type { EvidenceRow, ProgressRow } from './learning.js';
import type { AttemptSignal } from './gates.js';
import { resolveEnrollmentCourse } from './adaptation-store.js';
import { readRelease } from './release-cache.js';

export interface Enrollment {
  id: string; workspace_id: string; user_id: string; status: string; revision: number;
  profile: Record<string, unknown>; profile_revision: number; policy_revision: number;
  policy: unknown; started_at: Date; course_release_id: string;
  current_episode_id?: string | null;
}
export interface Release { id: string; workspace_id: string; digest: string; server_bundle: CourseManifest; learner_bundle: LearnerCourse; status: string;
  planRevision?: number; planDigest?: string;
  adaptationRequirements?: { blockId: string; episodeId: string; classification: 'required' | 'optional'; artifactDigest: string; replacesBaseBlock: boolean; insertedEpisode?: boolean; anchorEpisodeId?: string }[];
}
/** Policy scopes exist only for base episodes. A personal inserted episode is
 * governed by the scope of the base episode it follows. */
export function policyEpisodeId(release: Release, episodeId: string) {
  return release.adaptationRequirements?.find(r => r.insertedEpisode && r.episodeId === episodeId)?.anchorEpisodeId ?? episodeId;
}
/** Policy scope for an episode id outside a request that already holds the
 * resolved release (background supervision). Base episodes map to themselves
 * without resolving the adaptation journal. */
export async function policyEpisodeIdFor(client: PoolClient, enrollment: Enrollment, episodeId: string) {
  const base = await readRelease(client, enrollment.course_release_id, enrollment.workspace_id);
  if (!base || base.server_bundle.chapters.some(chapter => chapter.episodes.some(episode => episode.id === episodeId))) return episodeId;
  return policyEpisodeId(await resolveEnrollmentCourse(client, enrollment, base), episodeId);
}
export interface EnrollmentContext { enrollment: Enrollment; release: Release; progress: ProgressRow[]; evidence: EvidenceRow[]; signals?: AttemptSignal[] }

export async function loadEnrollment(client: Database | PoolClient, actor: Actor, id: string, lock = false, staff = false): Promise<EnrollmentContext> {
  // Resolution may load the adaptive journal and proof registry. Keep those
  // queries on one connection rather than issuing transaction-scoped locks on
  // unrelated pooled connections.
  if (!('release' in client)) return transaction(client, connection => loadEnrollment(connection, actor, id, lock, staff));
  const result = await client.query<Enrollment>(`SELECT * FROM enrollments WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  const enrollment = result.rows[0];
  requireCondition(enrollment, 'ENROLLMENT_NOT_FOUND', 404);
  // Erased enrollments keep only redacted audit rows; nothing can be read or changed.
  requireCondition(enrollment.status !== 'erased', 'ENROLLMENT_ERASED', 410);
  // Authorizing the enrollment owner still requires active workspace membership. Staff access
  // follows the shared course-scoped rule: a course grant counts on its own course only.
  await memberRole(client, actor, enrollment.workspace_id);
  if (enrollment.user_id !== actor.id) requireCondition(staff && (STAFF_READ_ROLES as readonly string[]).includes(await enrollmentRole(client, actor, enrollment) ?? ''), 'ENROLLMENT_NOT_FOUND', 404);
  return loadEnrollmentRecords(client, enrollment);
}
/** Course, progress, evidence and attempt signals of an already authorized enrollment row. */
export async function loadEnrollmentRecords(client: PoolClient, enrollment: Enrollment): Promise<EnrollmentContext> {
  const id = enrollment.id;
  const base = (await readRelease(client, enrollment.course_release_id, enrollment.workspace_id))!;
  const release = await resolveEnrollmentCourse(client, enrollment, base);
  const progress = (await client.query<ProgressRow>('SELECT * FROM episode_progress WHERE enrollment_id=$1', [id])).rows;
  const evidence = (await client.query<EvidenceRow>(
    `SELECT e.id,e.attempt_id,e.objective_id,e.independent,e.result,e.created_at,a.family_id,a.assessment_id,a.course_digest,a.mode
     FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
     WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`, [id])).rows;
  return { enrollment, release, progress, evidence, signals: await attemptSignals(client, id) };
}
/** Attempt outcomes for readiness status (help, review, misconception signals). Confidence is never read. */
export async function attemptSignals(client: PoolClient, enrollmentId: string): Promise<AttemptSignal[]> {
  const rows = (await client.query<{ id: string; assessment_id: string; course_digest: string; mode: string; submitted_at: Date; result: Record<string, unknown> | null; decision: string | null; reviewed_at: Date | null; continued: boolean }>(
    `SELECT a.id,a.assessment_id,a.course_digest,a.mode,a.submitted_at,a.result,v.decision,v.created_at AS reviewed_at,
       EXISTS(SELECT 1 FROM attempts r WHERE r.continues_attempt_id=a.id) AS continued
     FROM attempts a LEFT JOIN rubric_reviews v ON v.attempt_id=a.id WHERE a.enrollment_id=$1 ORDER BY a.submitted_at,a.id`, [enrollmentId])).rows;
  return rows.map(row => {
    const result = row.result ?? {};
    // A clarification request keeps the conversation open until the learner replies; the reply then carries it.
    const outcome: AttemptSignal['outcome'] = result.abstained === true ? 'abstained'
      : result.status === 'pending_review' ? row.decision === 'met' ? 'correct' : row.decision === 'not_met' ? 'incorrect'
        : row.decision === 'needs_clarification' ? row.continued ? 'continued' : 'clarification' : 'pending_review'
        : result.passed === true ? 'correct' : 'incorrect';
    return { id: row.id, assessment_id: row.assessment_id, course_digest: row.course_digest, mode: row.mode, outcome, at: row.reviewed_at ?? row.submitted_at,
      misconception_ids: Array.isArray(result.misconceptionIds) ? (result.misconceptionIds as unknown[]).filter((v): v is string => typeof v === 'string') : [] };
  });
}

export const digestJson = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export interface CommandInput { expectedRevision: number; idempotencyKey: string }

/** All enrollment mutations serialize on the enrollment row, including idempotent retries. */
export async function enrollmentCommand<T, I extends CommandInput>(db: Database, actor: Actor, id: string, operation: string, input: I,
  execute: (client: PoolClient, context: EnrollmentContext) => Promise<T>, staff = false): Promise<T> {
  requireCondition(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, 'INVALID_REVISION');
  requireCondition(typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,200}$/.test(input.idempotencyKey), 'INVALID_IDEMPOTENCY_KEY');
  const { expectedRevision: _revision, idempotencyKey, ...semantic } = input;
  const digest = digestJson({ actorId: actor.id, operation, ...semantic });
  return transaction(db, async client => {
    const context = await loadEnrollment(client, actor, id, true, staff);
    const old = (await client.query<{ request_digest: string; response: T }>('SELECT request_digest,response FROM command_receipts WHERE enrollment_id=$1 AND idempotency_key=$2', [id, idempotencyKey])).rows[0];
    if (old) {
      requireCondition(old.request_digest === digest, 'IDEMPOTENCY_CONFLICT', 409);
      return old.response;
    }
    requireCondition(context.enrollment.revision === input.expectedRevision, 'STALE_REVISION', 409);
    const response = await execute(client, context);
    const saved = await client.query<{ response: T }>('INSERT INTO command_receipts (enrollment_id,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4) RETURNING response', [id, idempotencyKey, digest, JSON.stringify(response)]);
    // Return the persisted representation on both the first request and replays.
    return saved.rows[0]!.response;
  });
}
