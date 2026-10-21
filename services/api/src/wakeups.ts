import type { PoolClient } from 'pg';
import type { ConstraintSnapshot, PolicyState } from '@course-core/policy';
import { envelopeScopeId, resolveAllConstraints } from '@course-core/policy';
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
  /** Maximum enrollments planned, and maximum due timers fired, per scan. */
  batchSize?: number;
  /** Called for every recorded failure, e.g. to log it. Must not throw. */
  onFailure?: (failure: WakeupFailure) => void;
}
type Kind = 'retention_due' | 'deadline_approaching' | 'deadline_reached';
type Phase = 'approaching' | 'reached' | 'cap' | 'quota_cap';
interface TimerRow { enrollment_id: string; scope_id: string; phase: Phase; deadline_at: Date; level: string; policy_revision: number; ledger_revision: number }
/** How long a failed plan or timer waits before it is tried again, and how often an exhausted
 * work quota is re-checked while the learner still has a way forward. */
export const WAKEUP_RETRY_MS = 60_000;
/** Levels whose deadlines are the enrollment's own end: reaching them closes, never reports. */
const ENVELOPE_LEVELS = new Set(['organization', 'course', 'enrollment']);

const statistics = { scans: 0, examined: 0, planned: 0, fired: 0, emitted: 0, closed: 0, failed: 0, passes: 0 };
/** In-process counters since start, for health/metrics endpoints. */
export const wakeupStatistics = () => ({ ...statistics });

const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR';
};

/**
 * Supervisor wake-ups from durable per-deadline timers (migration 096). Each scan:
 *
 * 1. signals retention checks that came due (an indexed query over due schedules);
 * 2. plans timers for every enrollment whose policy or status changed since it was last
 *    planned (a trigger queues it in the same transaction as the change);
 * 3. fires the timers that are due: a binding deadline entering its warning window, a
 *    chapter or episode deadline passing with its work unfinished (reported once), the
 *    enrollment's own end (closed with a gaps report), or an exhausted work quota that
 *    leaves the learner no way forward (closed; re-checked while it still has one).
 *
 * The work per scan is bounded by what is due, not by the number of active enrollments.
 * Firing is fenced at commit: a timer planned from an older policy revision is re-planned
 * instead of acted on, and closure itself is re-checked by the policy. Idempotent and safe
 * to run from several processes; it never changes progress or grants anything. Every
 * failure is recorded per enrollment and step, retried later, and never stops the rest.
 */
export async function scanWakeups(db: Database, options: WakeupOptions = {}) {
  const now = options.now ?? (options.clock ?? systemClock).now(), lead = options.deadlineLeadMs ?? 48 * 3_600_000;
  const limit = options.limit ?? 200, batchSize = options.batchSize ?? 500;
  const result = { emitted: 0, closed: 0, planned: 0, fired: 0 };
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

  // Retention checks continue for completed enrollments and for any closed one whose learner
  // opted into the continuation track (migration 094).
  const due = (await db.query<{ enrollment_id: string; workspace_id: string; objective_id: string; step: number; due_at: Date }>(
    `SELECT r.enrollment_id,e.workspace_id,r.objective_id,r.step,r.due_at FROM retention_schedules r JOIN enrollments e ON e.id=r.enrollment_id
     WHERE r.due_at<=$1 AND (e.status IN ('active','completed') OR (e.status='closed' AND EXISTS (SELECT 1 FROM continuation_tracks t WHERE t.enrollment_id=e.id AND t.state='active')))
       AND NOT EXISTS (SELECT 1 FROM wakeup_signals w WHERE w.enrollment_id=r.enrollment_id
       AND w.kind='retention_due' AND w.boundary_key=r.objective_id||':'||r.step||':'||to_char(r.due_at AT TIME ZONE 'UTC','YYYYMMDDHH24MISS'))
     ORDER BY r.due_at,r.enrollment_id,r.objective_id LIMIT $2`, [now, limit])).rows;
  for (const row of due) {
    try {
      await transaction(db, client => signal(client, row.enrollment_id, row.workspace_id, 'retention_due',
        `${row.objective_id}:${row.step}:${row.due_at.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`, { objectiveId: row.objective_id, dueAt: row.due_at.toISOString() }))
        .then(emitted => { result.emitted += emitted; });
    } catch (error) { await fail(row.enrollment_id, 'retention', error); }
  }

  // Plan: enrollments whose policy document or status changed, oldest first.
  // queued_at is compared as text: a JavaScript Date would drop its microseconds.
  const queued = (await db.query<{ enrollment_id: string; queued_at: string }>(
    'SELECT enrollment_id,queued_at::text AS queued_at FROM policy_timer_plans WHERE retry_at IS NULL OR retry_at<=$1 ORDER BY policy_timer_plans.queued_at,enrollment_id LIMIT $2', [now, batchSize])).rows;
  for (const row of queued) {
    try {
      const planned = await transaction(db, async client => {
        if (!await lockPolicy(client, row.enrollment_id)) return false;
        await planTimers(client, row.enrollment_id, now);
        await client.query('DELETE FROM policy_timer_plans WHERE enrollment_id=$1 AND queued_at=$2::timestamptz', [row.enrollment_id, row.queued_at]);
        return true;
      });
      if (planned) result.planned++;
    } catch (error) {
      await db.query('UPDATE policy_timer_plans SET retry_at=$2 WHERE enrollment_id=$1 AND queued_at=$3::timestamptz',
        [row.enrollment_id, new Date(now.getTime() + WAKEUP_RETRY_MS), row.queued_at]).catch(() => undefined);
      await fail(row.enrollment_id, 'deadline', error);
    }
  }

  // Fire: warnings are due `lead` before their deadline, everything else at it.
  const timers = (await db.query<TimerRow>(
    `SELECT enrollment_id,scope_id,phase,deadline_at,level,policy_revision,ledger_revision FROM policy_deadline_timers
     WHERE state='pending' AND deadline_at<=$1::timestamptz+make_interval(secs=>$2::double precision/1000)
       AND (phase='approaching' OR deadline_at<=$1) AND (retry_at IS NULL OR retry_at<=$1)
     ORDER BY deadline_at,enrollment_id,scope_id,phase LIMIT $3`, [now, lead, batchSize])).rows;
  for (const timer of timers) {
    const stage: WakeupStage = timer.phase === 'cap' || timer.phase === 'quota_cap' ? 'closure' : 'deadline';
    try {
      const outcome = await fireTimer(db, timer, now, lead);
      result.emitted += outcome.emitted; result.closed += outcome.closed;
      if (outcome.fired) result.fired++;
    } catch (error) {
      // Another process or the learner may have closed or changed it in between.
      const code = errorCode(error);
      if (code === 'ENROLLMENT_CLOSED') continue;
      if (code === 'CAP_NOT_REACHED') {
        // The policy says there is time left: this timer is wrong for the current policy. Drop it and plan again.
        await db.query("UPDATE policy_deadline_timers SET state='superseded' WHERE enrollment_id=$1 AND scope_id=$2 AND phase=$3 AND deadline_at=$4 AND state='pending'",
          [timer.enrollment_id, timer.scope_id, timer.phase, timer.deadline_at]).catch(() => undefined);
        await db.query('INSERT INTO policy_timer_plans(enrollment_id) VALUES($1) ON CONFLICT(enrollment_id) DO UPDATE SET queued_at=clock_timestamp(),retry_at=NULL', [timer.enrollment_id]).catch(() => undefined);
        continue;
      }
      await db.query(`UPDATE policy_deadline_timers SET attempts=attempts+1,retry_at=$5 WHERE enrollment_id=$1 AND scope_id=$2 AND phase=$3 AND deadline_at=$4 AND state='pending'`,
        [timer.enrollment_id, timer.scope_id, timer.phase, timer.deadline_at, new Date(now.getTime() + WAKEUP_RETRY_MS)]).catch(() => undefined);
      await fail(timer.enrollment_id, stage, error);
    }
  }
  const examined = queued.length + timers.length, wrapped = queued.length < batchSize && timers.length < batchSize;
  statistics.scans++; statistics.examined += examined; statistics.planned += result.planned; statistics.fired += result.fired;
  statistics.emitted += result.emitted; statistics.closed += result.closed;
  if (wrapped) statistics.passes++;
  return { ...result, examined, wrapped, failed: failures.length, failures };
}

/** Milliseconds until the next timer, plan or retry can be due (at least `minMs`, at most
 * `maxMs`), so the worker sleeps until there is work instead of scanning on a fixed beat. */
export async function nextWakeupDelay(db: Database, options: { now?: Date; deadlineLeadMs?: number; minMs?: number; maxMs?: number } = {}) {
  const now = options.now ?? new Date(), lead = options.deadlineLeadMs ?? 48 * 3_600_000;
  const minMs = options.minMs ?? 1_000, maxMs = options.maxMs ?? 60_000;
  const row = (await db.query<{ next: Date | null }>(
    `SELECT least(
       (SELECT min(coalesce(retry_at,queued_at)) FROM policy_timer_plans),
       (SELECT min(greatest(coalesce(retry_at,'-infinity'),CASE WHEN phase='approaching' THEN deadline_at-make_interval(secs=>$1::double precision/1000) ELSE deadline_at END))
          FROM policy_deadline_timers WHERE state='pending'),
       (SELECT min(r.due_at) FROM retention_schedules r JOIN enrollments e ON e.id=r.enrollment_id WHERE e.status IN ('active','completed') AND r.due_at>$2)) AS next`,
    [lead, now])).rows[0]!;
  if (!row.next) return maxMs;
  return Math.min(maxMs, Math.max(minMs, row.next.getTime() - now.getTime()));
}

/** Takes the enrollment's policy row lock (the one every policy change takes), so planning
 * and firing serialize with grants, accommodations, migrations and closure. False when the
 * enrollment has no policy document. */
async function lockPolicy(client: PoolClient, enrollmentId: string) {
  return Boolean((await client.query('SELECT 1 FROM policy_states WHERE enrollment_id=$1 FOR UPDATE', [enrollmentId])).rowCount);
}

/** Replaces one enrollment's pending timers with those of its current policy revision, and
 * records the resolved constraints of every scope (policy_constraint_snapshots). A timer
 * already fired stays fired; one no longer wanted is superseded. Call with the policy row locked. */
async function planTimers(client: PoolClient, enrollmentId: string, now: Date) {
  const row = (await client.query<{ status: string; snapshot: PolicyState; policy_revision: number; ledger_revision: number }>(
    'SELECT e.status,p.snapshot,p.policy_revision,p.ledger_revision FROM enrollments e JOIN policy_states p ON p.enrollment_id=e.id WHERE e.id=$1', [enrollmentId])).rows[0];
  if (!row || row.status !== 'active') {
    await client.query("UPDATE policy_deadline_timers SET state='superseded' WHERE enrollment_id=$1 AND state='pending'", [enrollmentId]);
    return;
  }
  const state = row.snapshot;
  // Validates the whole document once: an unreadable policy fails here and is retried.
  const snapshots = new Map<string, ConstraintSnapshot>(resolveAllConstraints(state).map(snapshot => [snapshot.scopeId, snapshot]));
  const envelope = envelopeScopeId(state);
  const wanted: { scopeId: string; phase: Phase; at: string; level: string }[] = [];
  for (const scope of state.scopes) {
    if (!scope.hardDeadline && !scope.window && !scope.ultimateDeadline) continue;
    // Only a deadline that binds: an ancestor's earlier cap is signalled by the ancestor.
    const own = snapshots.get(scope.scopeId)!.bindingDeadlines.find(d => d.scopeId === scope.scopeId);
    if (!own) continue;
    wanted.push({ scopeId: scope.scopeId, phase: 'approaching', at: own.at, level: scope.kind });
    if (!ENVELOPE_LEVELS.has(scope.kind)) wanted.push({ scopeId: scope.scopeId, phase: 'reached', at: own.at, level: scope.kind });
  }
  const end = snapshots.get(envelope)!, envelopeLevel = state.scopes.find(s => s.scopeId === envelope)!.kind;
  if (end.effectiveDeadline) wanted.push({ scopeId: envelope, phase: 'cap', at: end.effectiveDeadline, level: envelopeLevel });
  if (end.quotas.some(q => q.limit > 0 && q.consumed >= q.limit)) {
    // Keep the time of a quota check already waiting, so re-planning does not re-run it early.
    const waiting = (await client.query<{ deadline_at: Date }>("SELECT deadline_at FROM policy_deadline_timers WHERE enrollment_id=$1 AND phase='quota_cap' AND state='pending' ORDER BY deadline_at LIMIT 1", [enrollmentId])).rows[0];
    wanted.push({ scopeId: envelope, phase: 'quota_cap', at: (waiting?.deadline_at ?? now).toISOString(), level: envelopeLevel });
  }
  const rows = wanted.map(w => ({ scope_id: w.scopeId, phase: w.phase, deadline_at: w.at, level: w.level }));
  await client.query(`UPDATE policy_deadline_timers t SET state='superseded' WHERE t.enrollment_id=$1 AND t.state='pending'
    AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS w(scope_id text,phase text,deadline_at timestamptz,level text)
      WHERE w.scope_id=t.scope_id AND w.phase=t.phase AND w.deadline_at=t.deadline_at)`, [enrollmentId, JSON.stringify(rows)]);
  await client.query(`INSERT INTO policy_deadline_timers(enrollment_id,scope_id,phase,deadline_at,level,policy_revision,ledger_revision)
    SELECT $1,w.scope_id,w.phase,w.deadline_at,w.level,$3,$4 FROM jsonb_to_recordset($2::jsonb) AS w(scope_id text,phase text,deadline_at timestamptz,level text)
    ON CONFLICT(enrollment_id,scope_id,phase,deadline_at) DO UPDATE SET policy_revision=EXCLUDED.policy_revision,ledger_revision=EXCLUDED.ledger_revision,
      level=EXCLUDED.level,planned_at=clock_timestamp(),state=CASE WHEN policy_deadline_timers.state='fired' THEN 'fired' ELSE 'pending' END`,
  [enrollmentId, JSON.stringify(rows), row.policy_revision, row.ledger_revision]);
  const records = [...snapshots.values()].map(s => ({ scope_id: s.scopeId, effective_deadline: s.effectiveDeadline, binding_scope_id: s.binding.deadline?.scopeId ?? null,
    binding_level: s.binding.deadline?.level ?? null, snapshot: s }));
  await client.query(`INSERT INTO policy_constraint_snapshots(enrollment_id,scope_id,policy_revision,ledger_revision,effective_deadline,binding_scope_id,binding_level,snapshot)
    SELECT $1,r.scope_id,$3,$4,r.effective_deadline,r.binding_scope_id,r.binding_level,r.snapshot
    FROM jsonb_to_recordset($2::jsonb) AS r(scope_id text,effective_deadline timestamptz,binding_scope_id text,binding_level text,snapshot jsonb)
    ON CONFLICT(enrollment_id,scope_id) DO UPDATE SET policy_revision=EXCLUDED.policy_revision,ledger_revision=EXCLUDED.ledger_revision,effective_deadline=EXCLUDED.effective_deadline,
      binding_scope_id=EXCLUDED.binding_scope_id,binding_level=EXCLUDED.binding_level,snapshot=EXCLUDED.snapshot,computed_at=clock_timestamp()
    WHERE (policy_constraint_snapshots.policy_revision,policy_constraint_snapshots.ledger_revision)<=(EXCLUDED.policy_revision,EXCLUDED.ledger_revision)`,
  [enrollmentId, JSON.stringify(records), row.policy_revision, row.ledger_revision]);
  await client.query('DELETE FROM policy_constraint_snapshots WHERE enrollment_id=$1 AND NOT (scope_id = ANY($2::text[]))', [enrollmentId, [...snapshots.keys()]]);
}

/** Fires one due timer. Under the policy row lock it first checks the fence: a timer planned
 * from an older policy revision (or, for a quota check, an older ledger) is re-planned and
 * fires only if the current policy still wants it now. Signals commit with the timer; closure
 * runs after, in its own transaction, re-checked by the policy at commit. */
async function fireTimer(db: Database, timer: TimerRow, now: Date, lead: number) {
  const outcome = { emitted: 0, closed: 0, fired: false };
  const key: unknown[] = [timer.enrollment_id, timer.scope_id, timer.phase, timer.deadline_at];
  const action = await transaction(db, async client => {
    if (!await lockPolicy(client, timer.enrollment_id)) return null;
    const current = (await client.query<{ policy_revision: number; ledger_revision: number; status: string; workspace_id: string; snapshot: PolicyState }>(
      'SELECT p.policy_revision,p.ledger_revision,e.status,e.workspace_id,p.snapshot FROM policy_states p JOIN enrollments e ON e.id=p.enrollment_id WHERE p.enrollment_id=$1', [timer.enrollment_id])).rows[0]!;
    const stale = current.policy_revision !== timer.policy_revision || (timer.phase === 'quota_cap' && current.ledger_revision !== timer.ledger_revision);
    if (stale || current.status !== 'active') await planTimers(client, timer.enrollment_id, now);
    const live = (await client.query<{ state: string }>('SELECT state FROM policy_deadline_timers WHERE enrollment_id=$1 AND scope_id=$2 AND phase=$3 AND deadline_at=$4 FOR UPDATE', key)).rows[0];
    if (live?.state !== 'pending') return null;
    const at = timer.deadline_at.getTime();
    if (timer.phase === 'cap' || timer.phase === 'quota_cap') return { kind: timer.phase, workspaceId: current.workspace_id };
    const markFired = () => client.query("UPDATE policy_deadline_timers SET state='fired',fired_at=$5 WHERE enrollment_id=$1 AND scope_id=$2 AND phase=$3 AND deadline_at=$4", [...key, now]);
    // A warning whose deadline already passed, or a scope whose work is all done, is spent silently.
    // Planned under a newer policy with a longer warning window than this scan's: not yet.
    if (timer.phase === 'approaching' && at - now.getTime() > lead) return null;
    const silent = (timer.phase === 'approaching' && at <= now.getTime())
      || (!ENVELOPE_LEVELS.has(timer.level) && await finished(client, current.snapshot, timer.enrollment_id, timer.scope_id));
    if (!silent) {
      const boundary = timer.scope_id === 'course' ? timer.deadline_at.toISOString() : `${timer.scope_id}@${timer.deadline_at.toISOString()}`;
      outcome.emitted += await signal(client, timer.enrollment_id, current.workspace_id, timer.phase === 'approaching' ? 'deadline_approaching' : 'deadline_reached', boundary,
        { scopeId: timer.scope_id, level: timer.level, deadline: timer.deadline_at.toISOString() });
    }
    await markFired();
    outcome.fired = true;
    return null;
  });
  if (!action) return outcome;
  const closed = await closeReached(db, timer.enrollment_id, { now, cap: action.kind === 'cap' ? 'deadline' : 'work_quota' });
  outcome.closed += closed;
  if (closed || action.kind === 'cap') {
    await db.query("UPDATE policy_deadline_timers SET state='fired',fired_at=$5 WHERE enrollment_id=$1 AND scope_id=$2 AND phase=$3 AND deadline_at=$4 AND state='pending'", [...key, now]);
    outcome.fired = true;
  } else {
    // Still a way forward: look again later (or sooner, when the policy changes and re-plans).
    await db.query("UPDATE policy_deadline_timers SET retry_at=$5 WHERE enrollment_id=$1 AND scope_id=$2 AND phase=$3 AND deadline_at=$4 AND state='pending'",
      [...key, new Date(now.getTime() + WAKEUP_RETRY_MS)]);
  }
  return outcome;
}

/** Records one supervised wake-up event per boundary, at most once. Returns how many it emitted. */
async function signal(client: PoolClient, enrollmentId: string, workspaceId: string, kind: Kind, key: string, payload: Record<string, unknown>) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wakeup:${enrollmentId}:${kind}:${key}`]);
  if ((await client.query('SELECT 1 FROM wakeup_signals WHERE enrollment_id=$1 AND kind=$2 AND boundary_key=$3', [enrollmentId, kind, key])).rowCount) return 0;
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
  return 1;
}

/** True when every episode under this chapter/episode scope is completed or placed. */
async function finished(client: PoolClient, state: PolicyState, enrollmentId: string, scopeId: string) {
  const leaves = state.scopes.filter(s => s.kind === 'episode' && (s.scopeId === scopeId || s.parentScopeId === scopeId));
  if (!leaves.length) return false;
  const completed = new Set((await client.query<{ episode_id: string }>("SELECT episode_id FROM episode_progress WHERE enrollment_id=$1 AND state IN ('completed','placed')", [enrollmentId])).rows.map(r => r.episode_id));
  return leaves.every(s => completed.has(s.scopeId.slice('episode:'.length)));
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
