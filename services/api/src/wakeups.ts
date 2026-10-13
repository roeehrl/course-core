import type { PolicyState } from '@course-core/policy';
import { resolveConstraints } from '@course-core/policy';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { appendEvent } from './events.js';
import { loadEnrollment } from './repository.js';
import { closeCappedCourse } from './closure.js';

export interface WakeupOptions { now?: Date; deadlineLeadMs?: number; limit?: number }
/** Emits at most one supervised event per boundary: a retention check that came
 * due, or a binding course deadline entering its lead window. Idempotent and
 * safe to run from several processes; it never changes policy or progress. */
export async function scanWakeups(db: Database, options: WakeupOptions = {}) {
  const now = options.now ?? new Date(), lead = options.deadlineLeadMs ?? 48 * 3_600_000, limit = options.limit ?? 200;
  let emitted = 0, closed = 0;
  const signal = async (enrollmentId: string, workspaceId: string, kind: 'retention_due' | 'deadline_approaching', key: string, payload: Record<string, unknown>) =>
    transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wakeup:${enrollmentId}:${kind}:${key}`]);
      if ((await client.query('SELECT 1 FROM wakeup_signals WHERE enrollment_id=$1 AND kind=$2 AND boundary_key=$3', [enrollmentId, kind, key])).rowCount) return;
      const event = await appendEvent(client, { workspaceId, enrollmentId, actorKind: 'system', type: kind === 'retention_due' ? 'retention.due' : 'deadline.approaching',
        payload, idempotencyKey: `wakeup:${kind}:${key}`, supervise: true });
      await client.query('INSERT INTO wakeup_signals(enrollment_id,kind,boundary_key,event_id) VALUES($1,$2,$3,$4)', [enrollmentId, kind, key, event.id]);
      emitted++;
    });
  const due = (await db.query<{ enrollment_id: string; workspace_id: string; objective_id: string; step: number; due_at: Date }>(
    `SELECT r.enrollment_id,e.workspace_id,r.objective_id,r.step,r.due_at FROM retention_schedules r JOIN enrollments e ON e.id=r.enrollment_id
     WHERE r.due_at<=$1 AND e.status IN ('active','completed') AND NOT EXISTS (SELECT 1 FROM wakeup_signals w WHERE w.enrollment_id=r.enrollment_id
       AND w.kind='retention_due' AND w.boundary_key=r.objective_id||':'||r.step||':'||to_char(r.due_at AT TIME ZONE 'UTC','YYYYMMDDHH24MISS'))
     ORDER BY r.due_at LIMIT $2`, [now, limit])).rows;
  for (const row of due)
    await signal(row.enrollment_id, row.workspace_id, 'retention_due',
      `${row.objective_id}:${row.step}:${row.due_at.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`, { objectiveId: row.objective_id, dueAt: row.due_at.toISOString() });
  const active = (await db.query<{ id: string; workspace_id: string; snapshot: PolicyState }>(
    "SELECT e.id,e.workspace_id,p.snapshot FROM enrollments e JOIN policy_states p ON p.enrollment_id=e.id WHERE e.status='active' ORDER BY e.id LIMIT $1", [limit])).rows;
  for (const row of active) {
    let deadline: string | null = null;
    try { deadline = resolveConstraints(row.snapshot, 'course').effectiveDeadline; } catch { continue; }
    if (!deadline) continue;
    const at = Date.parse(deadline);
    if (at > now.getTime() && at - now.getTime() <= lead) await signal(row.id, row.workspace_id, 'deadline_approaching', deadline, { scopeId: 'course', deadline });
    // The binding course deadline has passed: close with a gaps report, once.
    if (at <= now.getTime()) closed += await closeReached(db, row.id).catch(() => 0);
  }
  return { emitted, closed };
}

/** Closes one active enrollment whose course cap was reached. The policy itself
 * refuses if the cap was not reached; concurrent scans serialize on the row. */
export async function closeReached(db: Database, enrollmentId: string) {
  return transaction(db, async client => {
    const row = (await client.query<{ user_id: string; status: string; workspace_id: string }>('SELECT user_id,status,workspace_id FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId])).rows[0];
    if (row?.status !== 'active') return 0;
    const context = await loadEnrollment(client, { id: row.user_id, displayName: 'Learner' }, enrollmentId, true);
    const report = await closeCappedCourse(client, context);
    await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId, actorKind: 'system', type: 'enrollment.closed',
      payload: { reason: 'cap', coverage: report?.coverage ?? null }, idempotencyKey: `closure:cap:${enrollmentId}`, supervise: false });
    return 1;
  });
}
