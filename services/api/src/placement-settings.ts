import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';
import type { Database } from './database.js';

type Sql = Database | PoolClient;
const HOUR_MS = 3_600_000;

export interface PlacementSettingsRow {
  workspace_id: string; course_key: string; enabled: boolean; retest_cooldown_hours: number; max_runs: number;
  max_items: number | null; min_families_per_episode: number | null; revision: number; updated_by: string | null; updated_at: Date;
}
export const DEFAULT_PLACEMENT_SETTINGS = { enabled: false, retestCooldownHours: 168, maxRuns: 1, maxItems: null, minFamiliesPerEpisode: null, revision: 0 } as const;

export async function placementSettingsRow(client: Sql, workspaceId: string, courseKey: string) {
  return (await client.query<PlacementSettingsRow>('SELECT * FROM placement_settings WHERE workspace_id=$1 AND course_key=$2', [workspaceId, courseKey])).rows[0] ?? null;
}
export const settingsView = (row: PlacementSettingsRow | null) => row
  ? { enabled: row.enabled, retestCooldownHours: row.retest_cooldown_hours, maxRuns: row.max_runs, maxItems: row.max_items,
    minFamiliesPerEpisode: row.min_families_per_episode, revision: row.revision, updatedAt: row.updated_at.toISOString() }
  : { ...DEFAULT_PLACEMENT_SETTINGS, updatedAt: null };

/**
 * The highest staff question limit the author allows across a course's live releases (published or
 * archived: learners may still be enrolled on either). Only releases whose manifest offers placement
 * count: a release without placement asks no questions, so it neither bounds nor loosens the limit.
 * An offered policy without `maxItems` (not schema-valid, but stored bundles are trusted as-is) is
 * read the way the runtime reads it in `placementPlan`: zero questions. `null` when no release offers
 * placement, so there is nothing for a staff limit to tighten.
 */
export function authorPlacementLimit(courses: Pick<CourseManifest, 'placement'>[]): number | null {
  const offered = courses.filter((c) => c.placement?.enabled === true);
  return offered.length ? Math.min(...offered.map((c) => c.placement?.maxItems ?? 0)) : null;
}
/** Why a staff question limit is refused, or null when it is acceptable. */
export function placementLimitError(maxItems: number | null, authorLimit: number | null) {
  if (maxItems === null) return null;
  if (authorLimit === null) return 'PLACEMENT_NOT_OFFERED' as const;
  return maxItems > authorLimit ? 'PLACEMENT_LIMIT_LOOSENS_AUTHOR' as const : null;
}

/**
 * What placement may do for one course: on only when the manifest offers it AND staff enabled it.
 * Staff limits only tighten the author's: fewer items, and optionally more independent item
 * families per episode than each gate requires on its own.
 */
export function effectivePlacement(course: CourseManifest, row: PlacementSettingsRow | null) {
  const author = course.placement;
  const enabled = Boolean(author?.enabled) && Boolean(row?.enabled);
  const maxItems = author ? Math.min(author.maxItems, row?.max_items ?? author.maxItems) : 0;
  return {
    authorEnabled: Boolean(author?.enabled), staffEnabled: Boolean(row?.enabled), enabled, authorMaxItems: author?.maxItems ?? 0, maxItems,
    minFamiliesPerEpisode: row?.min_families_per_episode ?? null,
    maxRuns: row?.max_runs ?? DEFAULT_PLACEMENT_SETTINGS.maxRuns, retestCooldownHours: row?.retest_cooldown_hours ?? DEFAULT_PLACEMENT_SETTINGS.retestCooldownHours,
  };
}
export type EffectivePlacement = ReturnType<typeof effectivePlacement>;
/** The course as placement sees it: the author's policy with the staff switch and limits applied. */
export function placementCourse(course: CourseManifest, effective: EffectivePlacement): CourseManifest {
  return course.placement ? { ...course, placement: { ...course.placement, enabled: effective.enabled, maxItems: effective.maxItems } } : course;
}
export async function enrollmentPlacement(client: Sql, enrollment: { workspace_id: string; course_release_id: string }, course: CourseManifest) {
  const key = (await client.query<{ course_key: string }>('SELECT course_key FROM course_releases WHERE id=$1', [enrollment.course_release_id])).rows[0]?.course_key;
  return effectivePlacement(course, key ? await placementSettingsRow(client, enrollment.workspace_id, key) : null);
}
/** When the next run may start after a finished one; null when no further run is allowed. */
export function retestAvailability(effective: EffectivePlacement, runs: { state: string; finished_at: Date | null }[], now = Date.now()) {
  const latest = runs.at(-1);
  const counted = runs.filter(r => r.state !== 'declined').length;
  if (!effective.enabled || !latest || latest.state !== 'finished' || counted >= effective.maxRuns) return { allowed: false, availableAt: null, runsUsed: counted };
  const at = (latest.finished_at?.getTime() ?? now) + effective.retestCooldownHours * HOUR_MS;
  return { allowed: at <= now, availableAt: new Date(at).toISOString(), runsUsed: counted };
}

/**
 * Placement quality signals for one course.
 * - falseSkips: exemptions staff revoked, plus exempted episodes whose objectives the learner
 *   later failed on an independent-mode attempt.
 * - unnecessaryRepetitions: episodes a learner studied in full although a placement run of theirs
 *   had already demonstrated all of the episode's objectives.
 */
export async function placementCounters(client: Sql, workspaceId: string, courseKey: string) {
  const runs = (await client.query<{ state: string; n: number }>(
    `SELECT p.state,count(*)::int AS n FROM placement_runs p JOIN enrollments e ON e.id=p.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
      WHERE e.workspace_id=$1 AND r.course_key=$2 GROUP BY p.state`, [workspaceId, courseKey])).rows;
  const exemptions = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_progress x JOIN enrollments e ON e.id=x.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
      WHERE e.workspace_id=$1 AND r.course_key=$2 AND x.state='placed'`, [workspaceId, courseKey])).rows[0]!.n;
  const revoked = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM placement_exemption_overrides o JOIN enrollments e ON e.id=o.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
      WHERE e.workspace_id=$1 AND r.course_key=$2`, [workspaceId, courseKey])).rows[0]!.n;
  // A failed answer in independent mode after the exemption, on an item that tests one of the
  // exempted episode's objectives (the item may have been seen before, so evidence need not be independent).
  const laterFailed = (await client.query<{ n: number }>(
    `SELECT count(DISTINCT (x.enrollment_id, x.episode_id))::int AS n
       FROM episode_progress x JOIN enrollments e ON e.id=x.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
       JOIN attempts a ON a.enrollment_id=x.enrollment_id AND a.mode='independent' AND a.submitted_at > x.completed_at AND (a.result->>'passed')::boolean IS FALSE
      WHERE e.workspace_id=$1 AND r.course_key=$2 AND x.state='placed'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.server_bundle->'assessments') item, jsonb_array_elements_text(item->'objectiveIds') io,
              jsonb_array_elements(r.server_bundle->'chapters') ch, jsonb_array_elements(ch->'episodes') ep, jsonb_array_elements_text(ep->'objectiveIds') eo
             WHERE item->>'id'=a.assessment_id AND ep->>'id'=x.episode_id AND io=eo)`,
    [workspaceId, courseKey])).rows[0]!.n;
  const repetitions = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episode_progress x JOIN enrollments e ON e.id=x.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
      WHERE e.workspace_id=$1 AND r.course_key=$2 AND x.state='completed'
        AND EXISTS (SELECT 1 FROM placement_runs p WHERE p.enrollment_id=x.enrollment_id AND p.proposal IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.server_bundle->'chapters') ch, jsonb_array_elements(ch->'episodes') ep, jsonb_array_elements_text(ep->'objectiveIds') o
             WHERE ep->>'id'=x.episode_id AND o NOT IN (SELECT d->>'objectiveId' FROM jsonb_array_elements(p.proposal->'demonstrated') d))
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.server_bundle->'chapters') ch, jsonb_array_elements(ch->'episodes') ep WHERE ep->>'id'=x.episode_id
             AND jsonb_array_length(ep->'objectiveIds') > 0))`,
    [workspaceId, courseKey])).rows[0]!.n;
  return {
    runs: Object.fromEntries(runs.map(r => [r.state, r.n])),
    exemptions,
    falseSkips: { total: revoked + laterFailed, revokedByStaff: revoked, laterFailed },
    unnecessaryRepetitions: repetitions,
  };
}

/** Every run and every exemption of one enrollment, with the evidence and course version behind
 * each exemption and any staff override. Staff-visible: answers' outcomes, never answer text. */
export async function enrollmentPlacementView(client: Sql, enrollment: { id: string; course_release_id: string }, course: CourseManifest) {
  const release = (await client.query<{ version: string; digest: string }>('SELECT version,digest FROM course_releases WHERE id=$1', [enrollment.course_release_id])).rows[0]!;
  const runs = (await client.query<{ id: string; run_number: number; state: string; started_at: Date | null; finished_at: Date | null; accepted_at: Date | null;
    stop_reason: string | null; proposal: { itemsUsed?: number; exemptEpisodeIds?: string[] } | null }>(
    'SELECT id,run_number,state,started_at,finished_at,accepted_at,stop_reason,proposal FROM placement_runs WHERE enrollment_id=$1 ORDER BY run_number', [enrollment.id])).rows;
  const placed = (await client.query<{ episode_id: string; evidence_refs: string[]; completed_at: Date | null }>(
    "SELECT episode_id,evidence_refs,completed_at FROM episode_progress WHERE enrollment_id=$1 AND state='placed' ORDER BY completed_at,episode_id", [enrollment.id])).rows;
  const refs = [...new Set(placed.flatMap(p => p.evidence_refs))];
  const evidence = new Map((await client.query<{ id: string; objective_id: string; independent: boolean; passed: boolean | null; invalidated_at: Date | null;
    assessment_id: string; family_id: string; course_digest: string; mode: string }>(
    `SELECT ev.id,ev.objective_id,ev.independent,(ev.result->>'passed')::boolean AS passed,ev.invalidated_at,a.assessment_id,a.family_id,a.course_digest,a.mode
       FROM evidence ev JOIN attempts a ON a.id=ev.attempt_id AND a.enrollment_id=ev.enrollment_id WHERE ev.enrollment_id=$1 AND ev.id=ANY($2::uuid[])`,
    [enrollment.id, refs])).rows.map(r => [r.id, r]));
  const overrides = (await client.query<{ episode_id: string; reason: string; created_at: Date; revoked_by_name: string; evidence_refs: string[] }>(
    `SELECT o.episode_id,o.reason,o.created_at,u.display_name AS revoked_by_name,o.evidence_refs FROM placement_exemption_overrides o JOIN app_users u ON u.id=o.revoked_by
      WHERE o.enrollment_id=$1 ORDER BY o.created_at`, [enrollment.id])).rows;
  const accepted = runs.find(r => r.state === 'accepted');
  const title = (id: string) => course.chapters.flatMap(c => c.episodes).find(e => e.id === id)?.title ?? id;
  return {
    release: { version: release.version, digest: release.digest },
    runs: runs.map(r => ({ runNumber: r.run_number, state: r.state, startedAt: r.started_at?.toISOString() ?? null, finishedAt: r.finished_at?.toISOString() ?? null,
      acceptedAt: r.accepted_at?.toISOString() ?? null, stopReason: r.stop_reason, itemsUsed: r.proposal?.itemsUsed ?? null, proposedExemptions: r.proposal?.exemptEpisodeIds ?? [] })),
    exemptions: placed.map(p => ({
      episodeId: p.episode_id, title: title(p.episode_id), placedAt: p.completed_at?.toISOString() ?? null, runNumber: accepted?.run_number ?? null,
      evidence: p.evidence_refs.map(id => evidence.get(id)).filter(e => e !== undefined).map(e => ({
        evidenceId: e.id, objectiveId: e.objective_id, assessmentId: e.assessment_id, familyId: e.family_id, independent: e.independent, passed: e.passed,
        invalidated: e.invalidated_at !== null, sameCourseVersion: e.course_digest === release.digest, placement: e.mode === 'placement' })),
    })),
    overrides: overrides.map(o => ({ episodeId: o.episode_id, title: title(o.episode_id), reason: o.reason, revokedBy: o.revoked_by_name, at: o.created_at.toISOString(), evidenceRefs: o.evidence_refs })),
  };
}
