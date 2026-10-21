import type { ConstraintSnapshot, PolicyState } from '@course-core/policy';
import { compareInstants, resolveConstraints } from '@course-core/policy';
import { gateAssessmentIds } from '@course-core/sdk';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { appendEvent } from './events.js';
import { loadEnrollment } from './repository.js';
import { closeCappedCourse } from './closure.js';
import { episodes, learningSnapshot } from './learning.js';
import { systemClock, type Clock } from './clock.js';
import { recordReviewDue } from './teaching-hypotheses.js';

export type WakeupStage = 'retention' | 'deadline' | 'closure';
/** A failed step for one enrollment: only the stable error code, never a message or payload. */
export interface WakeupFailure { enrollmentId: string; stage: WakeupStage; code: string }
export interface WakeupOptions {
  /** Time for this scan. Defaults to the clock's now. */
  now?: Date;
  clock?: Clock;
  deadlineLeadMs?: number;
  /** Maximum retention boundaries signalled per scan. */
  limit?: number;
  /** Maximum active enrollments examined per scan. The keyset cursor continues
   * from the last examined enrollment on the next scan and wraps around. */
  batchSize?: number;
  /** Called for every recorded failure, e.g. to log it. Must not throw. */
  onFailure?: (failure: WakeupFailure) => void;
}
type Kind = 'retention_due' | 'deadline_approaching' | 'deadline_reached';
interface ActiveRow { id: string; workspace_id: string; snapshot: PolicyState }

const statistics = { scans: 0, examined: 0, emitted: 0, closed: 0, failed: 0, passes: 0 };
/** In-process counters since start, for health/metrics endpoints. */
export const wakeupStatistics = () => ({ ...statistics });

const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR';
};

/** Emits at most one supervised event per boundary: a retention check that came
 * due, a binding course, chapter or episode deadline entering its lead window,
 * or a chapter/episode deadline that passed with its work unfinished. When the
 * course cap is reached (binding course deadline, or an exhausted course work
 * quota that leaves the learner no way forward) the enrollment is closed with a
 * gaps report. Idempotent and safe to run from several processes; it never
 * changes progress or grants anything. Every failure is recorded per enrollment
 * and step, and never stops the rest of the scan. */
export async function scanWakeups(db: Database, options: WakeupOptions = {}) {
  const now = options.now ?? (options.clock ?? systemClock).now(), lead = options.deadlineLeadMs ?? 48 * 3_600_000;
  const limit = options.limit ?? 200, batchSize = options.batchSize ?? 500;
  let emitted = 0, closed = 0;
  const failures: WakeupFailure[] = [];
  const fail = async (enrollmentId: string, stage: WakeupStage, error: unknown) => {
    const failure = { enrollmentId, stage, code: errorCode(error) };
    failures.push(failure);
    statistics.failed++;
    try {
      await db.query(`INSERT INTO wakeup_failures(enrollment_id,stage,code) VALUES($1,$2,$3) ON CONFLICT (enrollment_id,stage)
        DO UPDATE SET code=EXCLUDED.code,failures=wakeup_failures.failures+1,last_failed_at=clock_timestamp()`, [enrollmentId, stage, failure.code]);
    } catch { /* the in-process report below still carries it */ }
    try { options.onFailure?.(failure); } catch { /* a reporter cannot stop the scan */ }
  };
  const signal = async (enrollmentId: string, workspaceId: string, kind: Kind, key: string, payload: Record<string, unknown>) =>
    transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wakeup:${enrollmentId}:${kind}:${key}`]);
      if ((await client.query('SELECT 1 FROM wakeup_signals WHERE enrollment_id=$1 AND kind=$2 AND boundary_key=$3', [enrollmentId, kind, key])).rowCount) return;
      // Event idempotency keys are unique per workspace, so they name the enrollment:
      // two learners sharing one absolute deadline each get their own wake-up.
      const event = await appendEvent(client, { workspaceId, enrollmentId, actorKind: 'system',
        type: kind === 'retention_due' ? 'retention.due' : kind === 'deadline_approaching' ? 'deadline.approaching' : 'deadline.reached',
        payload, idempotencyKey: `wakeup:${enrollmentId}:${kind}:${key}`, supervise: true });
      await client.query('INSERT INTO wakeup_signals(enrollment_id,kind,boundary_key,event_id) VALUES($1,$2,$3,$4)', [enrollmentId, kind, key, event.id]);
      // A review that came due is trigger T10's review_due signal: with the learner's opt-in, Core
      // starts preparing the next review within budget (teaching-actions.ts). Same transaction.
      if (kind === 'retention_due' && typeof payload.objectiveId === 'string') {
        const release = (await client.query<{ digest: string; server_bundle: unknown }>(`SELECT r.digest,r.server_bundle FROM enrollments e
          JOIN course_releases r ON r.id=e.course_release_id AND r.workspace_id=e.workspace_id WHERE e.id=$1 AND e.status='active'`, [enrollmentId])).rows[0];
        if (release) await recordReviewDue(client, { enrollmentId, workspaceId, courseDigest: release.digest, bundle: release.server_bundle,
          objectiveIds: [payload.objectiveId], boundary: key });
      }
      emitted++;
    });

  const due = (await db.query<{ enrollment_id: string; workspace_id: string; objective_id: string; step: number; due_at: Date }>(
    `SELECT r.enrollment_id,e.workspace_id,r.objective_id,r.step,r.due_at FROM retention_schedules r JOIN enrollments e ON e.id=r.enrollment_id
     WHERE r.due_at<=$1 AND e.status IN ('active','completed') AND NOT EXISTS (SELECT 1 FROM wakeup_signals w WHERE w.enrollment_id=r.enrollment_id
       AND w.kind='retention_due' AND w.boundary_key=r.objective_id||':'||r.step||':'||to_char(r.due_at AT TIME ZONE 'UTC','YYYYMMDDHH24MISS'))
     ORDER BY r.due_at,r.enrollment_id,r.objective_id LIMIT $2`, [now, limit])).rows;
  for (const row of due) {
    try {
      await signal(row.enrollment_id, row.workspace_id, 'retention_due',
        `${row.objective_id}:${row.step}:${row.due_at.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`, { objectiveId: row.objective_id, dueAt: row.due_at.toISOString() });
    } catch (error) { await fail(row.enrollment_id, 'retention', error); }
  }

  const batch = await claimBatch(db, batchSize);
  for (const row of batch.rows) {
    const state = row.snapshot;
    let course: ConstraintSnapshot;
    // An unreadable policy is recorded; nothing else can be decided for this enrollment.
    try { course = resolveConstraints(state, 'course'); } catch (error) { await fail(row.id, 'deadline', error); continue; }
    try {
      let completed: Set<string> | undefined;
      for (const scope of state.scopes) {
        if (!scope.hardDeadline && !scope.window && !scope.ultimateDeadline) continue;
        const constraints = scope.scopeId === 'course' ? course : resolveConstraints(state, scope.scopeId);
        // Signal only a deadline that binds: an ancestor's earlier cap is signalled by the ancestor.
        const own = constraints.bindingDeadlines.find(d => d.scopeId === scope.scopeId);
        if (!own) continue;
        const at = Date.parse(own.at), level = scope.kind;
        if (scope.scopeId !== 'course') {
          completed ??= new Set((await db.query<{ episode_id: string }>("SELECT episode_id FROM episode_progress WHERE enrollment_id=$1 AND state IN ('completed','placed')", [row.id])).rows.map(r => r.episode_id));
          if (finished(state, scope.scopeId, completed)) continue;
        }
        const key = scope.scopeId === 'course' ? own.at : `${scope.scopeId}@${own.at}`;
        if (at > now.getTime() && at - now.getTime() <= lead)
          await signal(row.id, row.workspace_id, 'deadline_approaching', key, { scopeId: scope.scopeId, level, deadline: own.at });
        // A passed course deadline closes below; a passed chapter/episode deadline with
        // unfinished work is reported once so the supervisor can offer the policy's options.
        if (at <= now.getTime() && scope.scopeId !== 'course')
          await signal(row.id, row.workspace_id, 'deadline_reached', key, { scopeId: scope.scopeId, level, deadline: own.at });
      }
    } catch (error) { await fail(row.id, 'deadline', error); }
    // A failed signal never prevents closure at the cap.
    try {
      if (course.effectiveDeadline && compareInstants(now.toISOString(), course.effectiveDeadline) >= 0) closed += await closeReached(db, row.id, { now, cap: 'deadline' });
      else if (course.quotas.some(q => q.limit > 0 && q.consumed >= q.limit)) closed += await closeReached(db, row.id, { now, cap: 'work_quota' });
    } catch (error) {
      // Another process or the learner may have closed or changed it in between.
      const code = errorCode(error);
      if (code !== 'CAP_NOT_REACHED' && code !== 'ENROLLMENT_CLOSED') await fail(row.id, 'closure', error);
    }
  }
  statistics.scans++; statistics.examined += batch.rows.length; statistics.emitted += emitted; statistics.closed += closed;
  if (batch.wrapped) statistics.passes++;
  return { emitted, closed, examined: batch.rows.length, wrapped: batch.wrapped, failed: failures.length, failures };
}

/** True when every episode under this chapter/episode scope is completed or placed. */
function finished(state: PolicyState, scopeId: string, completed: Set<string>) {
  const leaves = state.scopes.filter(s => s.kind === 'episode' && (s.scopeId === scopeId || s.parentScopeId === scopeId));
  return leaves.length > 0 && leaves.every(s => completed.has(s.scopeId.slice('episode:'.length)));
}

/** Claims the next bounded batch of active enrollments after the shared cursor,
 * wrapping to the start when the end is reached, and advances the cursor in the
 * same transaction so concurrent scans take different batches. */
async function claimBatch(db: Database, size: number): Promise<{ rows: ActiveRow[]; wrapped: boolean }> {
  return transaction(db, async client => {
    await client.query("INSERT INTO wakeup_scan_cursors(scan) VALUES('enrollments') ON CONFLICT DO NOTHING");
    const cursor = (await client.query<{ last_enrollment_id: string | null }>("SELECT last_enrollment_id FROM wakeup_scan_cursors WHERE scan='enrollments' FOR UPDATE")).rows[0]!.last_enrollment_id;
    const page = async (after: string | null, upTo: string | null, count: number) => (await client.query<ActiveRow>(
      `SELECT e.id,e.workspace_id,p.snapshot FROM enrollments e JOIN policy_states p ON p.enrollment_id=e.id
       WHERE e.status='active' AND ($1::uuid IS NULL OR e.id>$1) AND ($2::uuid IS NULL OR e.id<=$2) ORDER BY e.id LIMIT $3`, [after, upTo, count])).rows;
    const tail = await page(cursor, null, size), wrapped = tail.length < size;
    let rows = tail, next: string | null = wrapped ? null : tail.at(-1)!.id;
    if (wrapped && cursor !== null) {
      // Continue from the start, never past where this batch began.
      const room = size - tail.length, head = await page(null, cursor, room);
      rows = [...tail, ...head];
      next = head.length === room ? head.at(-1)!.id : null;
    }
    await client.query("UPDATE wakeup_scan_cursors SET last_enrollment_id=$1,passes=passes+$2,updated_at=clock_timestamp() WHERE scan='enrollments'", [next, wrapped ? 1 : 0]);
    return { rows, wrapped };
  });
}

/** True when the learner cannot move forward without more added work: the next
 * required lesson's gate is unmet, every one of its items has been used, nothing
 * awaits review and no admitted work is still being prepared. */
function stuckWithoutAddedWork(policy: PolicyState, context: Awaited<ReturnType<typeof loadEnrollment>>, exposed: Set<string>, pendingReview: boolean) {
  if (pendingReview || policy.reservations.some(r => r.state === 'reserved')) return false;
  const course = context.release.server_bundle;
  const snapshot = learningSnapshot(course, context.release.digest, context.progress, context.evidence);
  if (!snapshot.nextEpisodeId) return false;
  const lesson = snapshot.lessons.find(l => l.id === snapshot.nextEpisodeId)!;
  if (!lesson.gate || lesson.gate.passed) return false;
  const episode = episodes(course).find(e => e.id === lesson.id)!, gate = course.gates.find(g => g.id === episode.gateId)!;
  return gateAssessmentIds(gate).every(id => exposed.has(id));
}

/** Closes one active enrollment whose course cap was reached. The policy itself
 * refuses if the cap was not reached; concurrent scans serialize on the row.
 * A work-quota cap closes only a learner who has no way forward without the
 * added work the exhausted quota no longer permits. */
export async function closeReached(db: Database, enrollmentId: string, options: { now?: Date; cap?: 'deadline' | 'work_quota' } = {}) {
  const now = options.now ?? new Date(), cap = options.cap ?? 'deadline';
  return transaction(db, async client => {
    const row = (await client.query<{ user_id: string; status: string; workspace_id: string }>('SELECT user_id,status,workspace_id FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId])).rows[0];
    if (row?.status !== 'active') return 0;
    const context = await loadEnrollment(client, { id: row.user_id, displayName: 'Learner' }, enrollmentId, true);
    if (cap === 'work_quota') {
      const policy = (await client.query<{ snapshot: PolicyState }>('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [enrollmentId])).rows[0]!.snapshot;
      const exposed = new Set((await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1', [enrollmentId])).rows.map(r => r.assessment_id));
      // A written answer awaiting review, an open appeal or an open gate review may still let the learner advance.
      const pendingReview = Boolean((await client.query(
        `SELECT 1 FROM attempts a WHERE a.enrollment_id=$1 AND a.result->>'status'='pending_review'
           AND NOT EXISTS (SELECT 1 FROM rubric_reviews v WHERE v.attempt_id=a.id AND v.decision<>'needs_clarification')
           AND NOT EXISTS (SELECT 1 FROM attempts r WHERE r.continues_attempt_id=a.id)
         UNION ALL SELECT 1 FROM rubric_appeals p WHERE p.enrollment_id=$1 AND p.state='open'
         UNION ALL SELECT 1 FROM gate_review_requests g WHERE g.enrollment_id=$1 AND g.state='open' LIMIT 1`, [enrollmentId])).rowCount);
      if (!stuckWithoutAddedWork(policy, context, exposed, pendingReview)) return 0;
    }
    const report = await closeCappedCourse(client, context, now);
    await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId, actorKind: 'system', type: 'enrollment.closed',
      payload: { reason: 'cap', cap, coverage: report?.coverage ?? null }, idempotencyKey: `closure:cap:${enrollmentId}`, supervise: false });
    return 1;
  });
}
