import { createHash } from 'node:crypto';
import { canonicalJson } from '@course-core/sdk/compiler';
import type { CourseManifest } from '@course-core/sdk';
import type { LearnerCourse } from '@course-core/sdk/compiler';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { Actor } from './auth.js';
import { membership } from './auth.js';
import { ApiError, requireCondition } from './errors.js';
import type { EvidenceRow, ProgressRow } from './learning.js';

export interface Enrollment {
  id: string; workspace_id: string; user_id: string; status: string; revision: number;
  profile: Record<string, unknown>; profile_revision: number; policy_revision: number;
  policy: unknown; started_at: Date; course_release_id: string;
}
export interface Release { id: string; workspace_id: string; digest: string; server_bundle: CourseManifest; learner_bundle: LearnerCourse; status: string }
export interface EnrollmentContext { enrollment: Enrollment; release: Release; progress: ProgressRow[]; evidence: EvidenceRow[] }

export async function loadEnrollment(client: Database | PoolClient, actor: Actor, id: string, lock = false, staff = false): Promise<EnrollmentContext> {
  const result = await client.query<Enrollment>(`SELECT * FROM enrollments WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  const enrollment = result.rows[0];
  requireCondition(enrollment, 'ENROLLMENT_NOT_FOUND', 404);
  // Authorizing the enrollment owner still requires active workspace membership.
  const role = await membership(client, actor, enrollment.workspace_id);
  requireCondition(enrollment.user_id === actor.id || (staff && ['owner', 'admin', 'instructor'].includes(role)), 'ENROLLMENT_NOT_FOUND', 404);
  const release = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1 AND workspace_id=$2', [enrollment.course_release_id, enrollment.workspace_id])).rows[0]!;
  const progress = (await client.query<ProgressRow>('SELECT * FROM episode_progress WHERE enrollment_id=$1', [id])).rows;
  const evidence = (await client.query<EvidenceRow>(
    `SELECT e.id,e.objective_id,e.independent,e.result,a.family_id,a.assessment_id,a.course_digest,a.mode
     FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
     WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`, [id])).rows;
  return { enrollment, release, progress, evidence };
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
