import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { episodes } from './learning.js';
import { gateItemIds } from './gates.js';

/** The course's assessment policy: how many graded attempts a learner gets at one check and how
 * long they wait after an unsuccessful one. A check is an episode's gate (every item it lists),
 * or a single assessment item where the episode has no gate. Practice, placement and spaced
 * review are never limited, a limit never removes evidence already recorded, and a staff grant
 * of another attempt is recorded on the learner's event log with its reason. Like the other
 * course policy settings, an enrollment keeps the values in force when it started. */
export const assessmentPolicySchema = z.strictObject({
  /** Graded (independent) attempts per check; null means no limit. */
  maxGradedAttemptsPerCheck: z.number().int().min(1).max(100).nullable(),
  /** Minutes to wait after a graded attempt that did not pass before the next one at that check. */
  retryCooldownMinutes: z.number().int().min(0).max(10_080),
});
export type AssessmentPolicy = z.infer<typeof assessmentPolicySchema>;
/** Today's behaviour: unlimited graded attempts and no waiting. */
export const DEFAULT_ASSESSMENT_POLICY: AssessmentPolicy = Object.freeze({ maxGradedAttemptsPerCheck: null, retryCooldownMinutes: 0 }) as AssessmentPolicy;

type Sql = Pick<PoolClient, 'query'>;
export interface Check { checkId: string; title: string; itemIds: string[] }

/** The check an item belongs to in an episode: the episode's gate, else the item itself. */
export function checkFor(course: CourseManifest, episodeId: string, assessmentId: string): Check {
  const episode = episodes(course).find(e => e.id === episodeId);
  const gate = episode?.gateId ? course.gates.find(g => g.id === episode.gateId) : undefined;
  if (gate && gateItemIds(gate).includes(assessmentId)) return { checkId: `gate:${gate.id}`, title: episode!.title, itemIds: gateItemIds(gate) };
  return { checkId: `item:${assessmentId}`, title: episode?.title ?? assessmentId, itemIds: [assessmentId] };
}
/** Every check of a course, in course order: each gated episode's gate once. */
export function courseChecks(course: CourseManifest): Check[] {
  const seen = new Set<string>(), checks: Check[] = [];
  for (const episode of episodes(course)) {
    const gate = episode.gateId ? course.gates.find(g => g.id === episode.gateId) : undefined;
    if (!gate || seen.has(gate.id)) continue;
    seen.add(gate.id);
    checks.push({ checkId: `gate:${gate.id}`, title: episode.title, itemIds: gateItemIds(gate) });
  }
  return checks;
}

/** The assessment policy in force when this enrollment started: the course setting saved last
 * before the start, else the default. Later changes apply to new enrollments only. */
export async function enrollmentAssessmentPolicy(client: Sql, enrollment: { id: string; course_release_id: string; started_at: Date | string }): Promise<AssessmentPolicy> {
  const row = (await client.query<{ settings: { assessment?: unknown } }>(
    `SELECT h.settings FROM policy_setting_revisions h
       JOIN admin_course_catalog c ON c.id=h.catalog_id
       JOIN course_releases r ON r.workspace_id=c.workspace_id AND r.course_key=c.course_key
      WHERE r.id=$1 AND h.level='course' AND h.changed_at<=$2 ORDER BY h.revision DESC LIMIT 1`,
    [enrollment.course_release_id, new Date(enrollment.started_at).toISOString()])).rows[0];
  const parsed = assessmentPolicySchema.safeParse(row?.settings?.assessment);
  return parsed.success ? parsed.data : { ...DEFAULT_ASSESSMENT_POLICY };
}

export interface CheckAttempts {
  checkId: string;
  title: string;
  /** Graded attempts submitted at this check. */
  used: number;
  /** The course limit plus attempts staff granted; null when there is no limit. */
  limit: number | null;
  granted: number;
  /** When the next graded attempt may start, if the learner is waiting after an unsuccessful one. */
  retryAt: string | null;
}

/** Graded-attempt use at one check. Reads the database clock so every caller agrees on "now". */
export async function checkAttempts(client: Sql, enrollmentId: string, check: Check, policy: AssessmentPolicy): Promise<CheckAttempts> {
  const row = (await client.query<{ used: number; granted: number; retry_at: Date | null }>(
    `SELECT (SELECT count(*)::int FROM attempts WHERE enrollment_id=$1 AND mode='independent' AND assessment_id=ANY($2::text[])) AS used,
            (SELECT coalesce(sum((payload->>'count')::int),0)::int FROM learning_events
              WHERE enrollment_id=$1 AND event_type='assessment.attempt_granted' AND payload->>'checkId'=$3) AS granted,
            (SELECT a.submitted_at + make_interval(mins => $4::int) FROM attempts a
              WHERE a.enrollment_id=$1 AND a.mode='independent' AND a.assessment_id=ANY($2::text[])
                AND coalesce(a.result->>'status','') <> 'pending_review' AND coalesce((a.result->>'passed')::boolean,false)=false
                AND a.submitted_at + make_interval(mins => $4::int) > clock_timestamp()
                AND NOT EXISTS (SELECT 1 FROM learning_events g WHERE g.enrollment_id=$1 AND g.event_type='assessment.attempt_granted'
                  AND g.payload->>'checkId'=$3 AND g.created_at>=a.submitted_at)
              ORDER BY a.submitted_at DESC LIMIT 1) AS retry_at`,
    [enrollmentId, check.itemIds, check.checkId, policy.retryCooldownMinutes])).rows[0]!;
  const limit = policy.maxGradedAttemptsPerCheck === null ? null : policy.maxGradedAttemptsPerCheck + row.granted;
  return { checkId: check.checkId, title: check.title, used: row.used, limit, granted: row.granted,
    retryAt: policy.retryCooldownMinutes && row.retry_at ? row.retry_at.toISOString() : null };
}

/** Refuses a graded attempt the policy does not allow: the limit is reached or the learner is
 * still waiting after an unsuccessful attempt. The refusal says when to try again, or that
 * staff can allow another attempt; nothing already recorded changes. */
export function assertGradedAttemptAllowed(status: CheckAttempts) {
  if (status.limit !== null && status.used >= status.limit)
    throw new ApiError(409, 'ATTEMPT_LIMIT_REACHED', 'ATTEMPT_LIMIT_REACHED', { checkId: status.checkId, used: status.used, limit: status.limit });
  if (status.retryAt)
    throw new ApiError(409, 'RETRY_COOLDOWN', 'RETRY_COOLDOWN', { checkId: status.checkId, retryAt: status.retryAt });
}
