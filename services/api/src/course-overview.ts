import type { PoolClient } from 'pg';
import { resolveConstraints, type PolicyState } from '@course-core/policy';
import type { Database } from './database.js';
import { episodes } from './learning.js';
import type { CourseManifest } from '@course-core/sdk';

type Sql = Database | PoolClient;
const DAY_MS = 86_400_000;
/** An active enrollment whose nearest deadline is within this many days (or passed) is at risk. */
export const DEADLINE_RISK_DAYS = 7;
const TERMINAL_JOB_STATES = ['applied', 'failed', 'cancelled'];

export interface OverviewCatalog { id: string; workspace_id: string; course_key: string; active_release_id: string | null }
export interface OverviewAccess { enrollments: boolean; policy: boolean; runs: boolean }

/** The nearest effective deadline across an enrollment's policy scopes, or null. */
export function nearestDeadline(policy: PolicyState | null) {
  if (!policy?.scopes?.length) return null;
  let nearest: string | null = null;
  for (const scope of policy.scopes) {
    let at: string | null = null;
    try { at = resolveConstraints(policy, scope.scopeId).effectiveDeadline; } catch { at = null; }
    if (at && (nearest === null || Date.parse(at) < Date.parse(nearest))) nearest = at;
  }
  return nearest;
}

/**
 * Course overview for administration: one read that answers "what needs attention".
 * Sections the actor's role cannot read are null rather than empty. Counts only: no learner
 * free text, no evidence content, nothing learner-private (learner-privacy.ts).
 */
export async function courseOverview(client: Sql, catalog: OverviewCatalog, access: OverviewAccess,
  releaseChecks: (release: { id: string; server_bundle: CourseManifest; digest: string; version: string }) => { label: string; passed: boolean; detail: string }[], now = new Date()) {
  const releases = (await client.query<{ id: string; version: string; status: string; digest: string; created_at: Date; server_bundle: CourseManifest; review_state: string }>(
    `SELECT r.id,r.version,r.status,r.digest,r.created_at,r.server_bundle,v.state AS review_state FROM course_releases r
       JOIN admin_release_reviews v ON v.release_id=r.id WHERE v.catalog_id=$1 AND r.workspace_id=$2 AND r.course_key=$3 ORDER BY r.created_at DESC,r.id`,
    [catalog.id, catalog.workspace_id, catalog.course_key])).rows;
  const active = releases.find(r => r.id === catalog.active_release_id) ?? null;
  const pinned = (await client.query<{ release_id: string; n: number }>(
    `SELECT e.course_release_id AS release_id,count(*)::int AS n FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id
      WHERE e.workspace_id=$1 AND r.course_key=$2 AND e.status IN ('active','paused') GROUP BY e.course_release_id`, [catalog.workspace_id, catalog.course_key])).rows;
  const release = {
    active: active ? { id: active.id, version: active.version, status: active.status, digest: active.digest, createdAt: active.created_at.toISOString() } : null,
    counts: { draft: releases.filter(r => r.status === 'draft').length, published: releases.filter(r => r.status === 'published').length, archived: releases.filter(r => r.status === 'archived').length },
    // Learners stay on the release they started; older releases can still have learners.
    pinnedLearners: pinned.map(p => ({ releaseId: p.release_id, version: releases.find(r => r.id === p.release_id)?.version ?? null, learners: p.n })),
    // The course updater's latest finding (course-updates.ts): a newer package at the update source.
    update: (await client.query<{ available_version: string | null; last_result: string | null; last_checked_at: Date | null; level: string }>(
      'SELECT available_version,last_result,last_checked_at,level FROM course_update_sources WHERE workspace_id=$1 AND course_key=$2', [catalog.workspace_id, catalog.course_key]))
      .rows.map(row => ({ availableVersion: row.last_result === 'update_available' ? row.available_version : null, lastResult: row.last_result,
        lastCheckedAt: row.last_checked_at?.toISOString() ?? null, level: row.level }))[0] ?? null,
  };
  const failingChecks = active ? releaseChecks(active).filter(c => !c.passed).map(c => ({ label: c.label, detail: c.detail })) : [];
  const invalidated = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM evidence ev JOIN enrollments e ON e.id=ev.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
      WHERE e.workspace_id=$1 AND r.course_key=$2 AND ev.invalidated_at > $3`, [catalog.workspace_id, catalog.course_key, new Date(now.getTime() - 30 * DAY_MS)])).rows[0]!.n;
  const contentDefects = { activeReleaseChecksFailing: failingChecks, evidenceInvalidatedLast30Days: invalidated };

  let lifecycle: Record<string, number> | null = null, deadlineRisks: { enrollmentId: string; learner: string; deadline: string; daysLeft: number; remainingEpisodes: number }[] | null = null;
  if (access.enrollments) {
    const rows = (await client.query<{ id: string; status: string; display_name: string; snapshot: PolicyState | null; completed: number; server_bundle: CourseManifest }>(
      `SELECT e.id,e.status,u.display_name,p.snapshot,r.server_bundle,
          (SELECT count(*)::int FROM episode_progress x WHERE x.enrollment_id=e.id AND x.state IN ('completed','placed')) AS completed
         FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id JOIN app_users u ON u.id=e.user_id
         LEFT JOIN policy_states p ON p.enrollment_id=e.id
        WHERE e.workspace_id=$1 AND r.course_key=$2 ORDER BY e.started_at DESC LIMIT 2000`, [catalog.workspace_id, catalog.course_key])).rows;
    lifecycle = { active: 0, paused: 0, completed: 0, closed: 0, erased: 0 };
    for (const row of rows) lifecycle[row.status] = (lifecycle[row.status] ?? 0) + 1;
    if (access.policy) {
      deadlineRisks = [];
      for (const row of rows) {
        if (row.status !== 'active') continue;
        const deadline = nearestDeadline(row.snapshot);
        if (!deadline) continue;
        const daysLeft = Math.floor((Date.parse(deadline) - now.getTime()) / DAY_MS);
        const remainingEpisodes = Math.max(0, episodes(row.server_bundle).length - row.completed);
        if (daysLeft <= DEADLINE_RISK_DAYS && remainingEpisodes > 0)
          deadlineRisks.push({ enrollmentId: row.id, learner: row.display_name, deadline, daysLeft, remainingEpisodes });
      }
      deadlineRisks.sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
      deadlineRisks = deadlineRisks.slice(0, 50);
    }
  }

  let supervisorHealth: { jobsByState: Record<string, number>; failedLast24h: number; oldestOpenJobAgeSeconds: number | null } | null = null;
  if (access.runs) {
    const jobs = (await client.query<{ state: string; n: number; oldest: Date | null; failed_recent: number }>(
      `SELECT j.state,count(*)::int AS n,min(j.created_at) FILTER (WHERE j.state <> ALL($3::text[])) AS oldest,
          count(*) FILTER (WHERE j.state='failed' AND j.updated_at > $4)::int AS failed_recent
         FROM supervisor_jobs j JOIN enrollments e ON e.id=j.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
        WHERE e.workspace_id=$1 AND r.course_key=$2 GROUP BY j.state`,
      [catalog.workspace_id, catalog.course_key, TERMINAL_JOB_STATES, new Date(now.getTime() - DAY_MS)])).rows;
    const oldest = jobs.map(j => j.oldest).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0];
    supervisorHealth = { jobsByState: Object.fromEntries(jobs.map(j => [j.state, j.n])), failedLast24h: jobs.reduce((n, j) => n + j.failed_recent, 0),
      oldestOpenJobAgeSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null };
  }

  const count = async (sql: string, values: unknown[]) => (await client.query<{ n: number }>(sql, values)).rows[0]!.n;
  const course = [catalog.workspace_id, catalog.course_key];
  const scoped = `JOIN enrollments e ON e.id=q.enrollment_id JOIN course_releases r ON r.id=e.course_release_id WHERE e.workspace_id=$1 AND r.course_key=$2 AND e.status<>'erased'`;
  const approvalQueue = {
    writtenAnswers: await count(`SELECT count(*)::int AS n FROM attempts q LEFT JOIN rubric_reviews v ON v.attempt_id=q.id ${scoped} AND v.id IS NULL AND q.result->>'status'='pending_review'`, course),
    secondOpinions: await count(`SELECT count(*)::int AS n FROM rubric_appeals q ${scoped} AND q.state='open'`, course),
    gateReviews: await count(`SELECT count(*)::int AS n FROM gate_review_requests q ${scoped} AND q.state='open'`, course),
    generatedMedia: await count(`SELECT count(*)::int AS n FROM media_jobs q ${scoped} AND q.state='under_review'`, course),
    releases: releases.filter(r => r.status === 'draft' && r.review_state === 'pending_review').length,
    providerRequests: await count(`SELECT count(*)::int AS n FROM admin_provider_requests WHERE catalog_id=$1 AND state='pending_review'`, [catalog.id]),
  };
  return { catalogId: catalog.id, generatedAt: now.toISOString(), release, lifecycle, deadlineRisks, contentDefects, supervisorHealth, approvalQueue };
}
