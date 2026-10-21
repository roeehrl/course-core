import type { PoolClient } from 'pg';
import { getEpisodeRequirement, type ContentBlock, type CourseManifest } from '@course-core/sdk';
import { compileCourse, CourseValidationError } from '@course-core/sdk/compiler';
import type { Database } from './database.js';
import { ApiError } from './errors.js';
import { digestJson } from './repository.js';
import { episodes, learningSnapshot, type ProgressRow } from './learning.js';
import { defectiveItems, releaseDiff, type SafetyRelease } from './release-safety.js';

type Sql = Database | PoolClient;

/**
 * Safe editing of a draft release (Q03, Q14): checking a manifest before it is saved, previewing
 * the draft as representative learners would see it, and the affected-learner analysis that
 * staff confirm before publishing forward. Everything here reads; nothing changes a release, an
 * enrollment or evidence.
 */

/** At most this many problems are returned; the first ones are enough to fix the file. */
export const MAX_ISSUES = 50;

export interface ManifestCheck {
  valid: boolean;
  /** Stable SDK problem codes and the JSON path they concern; never free text. */
  issues: { code: string; path: string }[];
  /** True when the manifest's course id and version match the draft it would replace. */
  identityMatches: boolean | null;
  summary: { chapters: number; episodes: number; assessments: number; objectives: number } | null;
  digest: string | null;
}

/** Validates a manifest exactly as saving would, without saving it. */
export function checkManifest(manifest: unknown, identity?: { courseKey: string; version: string }): ManifestCheck {
  try {
    const compiled = compileCourse(manifest);
    const course = compiled.server;
    return {
      valid: true, issues: [],
      identityMatches: identity ? course.id === identity.courseKey && course.version === identity.version : null,
      summary: { chapters: course.chapters.length, episodes: episodes(course).length, assessments: course.assessments.length, objectives: course.objectives.length },
      digest: compiled.digest,
    };
  } catch (error) {
    if (!(error instanceof CourseValidationError)) throw error;
    const issues = error.issues.slice(0, MAX_ISSUES).map(issue => ({
      code: /^[A-Za-z0-9_.-]{1,80}$/.test(issue.code) ? issue.code : 'invalid',
      path: String(issue.path).slice(0, 300),
    }));
    return { valid: false, issues, identityMatches: null, summary: null, digest: null };
  }
}

// ---------------------------------------------------------------- representative learners

/** The synthetic learners a draft is previewed as. None of them is a real person. */
export const PREVIEW_PROFILES = ['new_learner', 'placed_out', 'first_chapter_done', 'nearly_finished'] as const;
export type PreviewProfile = typeof PREVIEW_PROFILES[number];

const EXCERPT = 280;
function blockPreview(course: CourseManifest, block: ContentBlock) {
  switch (block.type) {
    case 'text': return { id: block.id, type: block.type, excerpt: block.markdown.slice(0, EXCERPT), truncated: block.markdown.length > EXCERPT };
    case 'assessment': {
      const item = course.assessments.find(a => a.id === block.assessmentId);
      return { id: block.id, type: block.type, assessmentId: block.assessmentId, itemType: item?.type ?? null,
        excerpt: item ? item.prompt.slice(0, EXCERPT) : null, truncated: Boolean(item && item.prompt.length > EXCERPT) };
    }
    case 'visual': return { id: block.id, type: block.type, visualId: block.visualId };
    case 'media': return { id: block.id, type: block.type, mediaId: block.mediaId, required: block.required };
    case 'activity': return { id: block.id, type: block.type, extensionId: 'extensionId' in block ? block.extensionId : null, activityId: 'activityId' in block ? block.activityId : null };
  }
}

/** Progress rows for one synthetic learner. Credited lessons use the engine's own staff-exception
 * path on this exact draft digest, so the roadmap is computed by the same rules as for a real
 * learner without inventing evidence. */
function syntheticProgress(course: CourseManifest, digest: string, profile: PreviewProfile): ProgressRow[] {
  const all = episodes(course), required = all.filter(e => getEpisodeRequirement(e) === 'required');
  const done = (ids: string[], state: 'completed' | 'placed' = 'completed'): ProgressRow[] => ids.map(id => {
    const episode = all.find(e => e.id === id)!;
    return { episode_id: id, state, completed_block_ids: episode.blocks.map(b => b.id), evidence_refs: [],
      gate_exception_id: state === 'completed' && episode.gateId ? 'preview' : null, exception_course_digest: state === 'completed' && episode.gateId ? digest : null };
  });
  if (profile === 'new_learner') return [];
  if (profile === 'first_chapter_done') return done((course.chapters[0]?.episodes ?? []).map(e => e.id));
  if (profile === 'nearly_finished') return done(required.slice(0, Math.max(0, required.length - 1)).map(e => e.id));
  // Tested out of every objective the course allows placement for.
  const placeable = new Set(course.objectives.filter(o => o.placeable).map(o => o.id));
  return done(all.filter(e => e.objectiveIds.length && e.objectiveIds.every(o => placeable.has(o)) && !e.gateId).map(e => e.id), 'placed');
}

/** The draft as each representative learner would meet it: their roadmap, computed by the
 * learner engine, and the next lesson's content. */
export function previewAsLearners(course: CourseManifest, digest: string) {
  const chapterOf = new Map(course.chapters.flatMap(c => c.episodes.map(e => [e.id, c.id] as const)));
  const profiles = PREVIEW_PROFILES.map(profile => {
    const progress = syntheticProgress(course, digest, profile);
    const snapshot = learningSnapshot(course, digest, progress, []);
    const next = snapshot.nextEpisodeId ? episodes(course).find(e => e.id === snapshot.nextEpisodeId) : undefined;
    const counts = { completed: 0, placed: 0, available: 0, locked: 0 };
    for (const lesson of snapshot.lessons) counts[lesson.status as keyof typeof counts] += 1;
    return {
      profile, complete: snapshot.complete, counts,
      lessons: snapshot.lessons.map(l => ({ episodeId: l.id, chapterId: chapterOf.get(l.id) ?? null, requirement: l.requirement, status: l.status })),
      next: next ? { episodeId: next.id, title: next.title, chapterId: chapterOf.get(next.id) ?? null, blocks: next.blocks.map(b => blockPreview(course, b)) } : null,
    };
  });
  return {
    course: { id: course.id, version: course.version, title: course.title, locale: course.locale },
    outline: course.chapters.map(c => ({ id: c.id, title: c.title, episodes: c.episodes.map(e => ({ id: e.id, title: e.title,
      requirement: getEpisodeRequirement(e), gateId: e.gateId ?? null, blocks: e.blocks.length })) })),
    profiles,
    syntheticLearners: true as const,
  };
}

// ---------------------------------------------------------------- publishing forward

/**
 * What publishing a draft does to learners. Publishing selects the draft for new learners;
 * learners already enrolled stay on the release they started (nobody is moved), so they keep the
 * old content, including any item the draft fixes. The analysis says who is on each side, what
 * changes, how many learners are part-way through lessons the draft changes, and which defective
 * items the draft fixes or carries over. Publishing requires the digest of exactly this analysis
 * whenever learners are pinned to the current release.
 */
export async function publishImpact(client: Sql, catalog: { id: string; workspace_id: string; course_key: string }, active: SafetyRelease | null, draft: SafetyRelease) {
  const diff = active ? releaseDiff(active, draft) : null;
  const changedEpisodes = diff ? [...(diff.kinds.episodes?.changed ?? []), ...(diff.kinds.episodes?.removed ?? [])].sort() : [];
  const changedItems = diff ? [...(diff.kinds.assessments?.changed ?? []), ...(diff.kinds.assessments?.removed ?? [])].sort() : [];
  const pinned = active ? (await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM enrollments WHERE course_release_id=$1 AND status IN ('active','paused')", [active.id])).rows[0]!.n : 0;
  const midway = active && changedEpisodes.length ? (await client.query<{ n: number }>(
    `SELECT count(DISTINCT p.enrollment_id)::int AS n FROM episode_progress p JOIN enrollments e ON e.id=p.enrollment_id
      WHERE e.course_release_id=$1 AND e.status IN ('active','paused') AND p.state='started' AND p.episode_id=ANY($2::text[])`, [active.id, changedEpisodes])).rows[0]!.n : 0;
  const recent = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id
      WHERE r.workspace_id=$1 AND r.course_key=$2 AND e.started_at > clock_timestamp() - interval '30 days'`, [catalog.workspace_id, catalog.course_key])).rows[0]!.n;
  const defective = active ? (await defectiveItems(client, active.id)).map(d => d.assessment_id) : [];
  const draftItems = new Set(draft.server_bundle.assessments.map(a => a.id));
  const impact = {
    from: diff?.from ?? null, to: { id: draft.id, version: draft.version, digest: draft.digest },
    contentChanges: diff?.changes ?? null,
    kinds: diff ? Object.fromEntries(Object.entries(diff.kinds).map(([kind, k]) => [kind, { added: k.added.length, removed: k.removed.length, changed: k.changed.length }])) : null,
    changedOrRemovedEpisodes: changedEpisodes.slice(0, 200), changedOrRemovedItems: changedItems.slice(0, 200),
    learnersPinnedToActive: pinned, learnersMidwayInChangedLessons: midway, enrollmentsLast30Days: recent,
    defectiveItemsFixed: defective.filter(id => changedItems.includes(id)).sort(),
    defectiveItemsCarriedOver: defective.filter(id => draftItems.has(id) && !changedItems.includes(id)).sort(),
    newLearnersGet: draft.version, existingLearnersMove: false as const,
  };
  return { impact, impactDigest: digestJson(impact), confirmationRequired: pinned > 0 };
}

/** Refuses a forward publish whose analysis staff did not confirm (428) or that changed (409). */
export function requireConfirmedImpact(analysis: Awaited<ReturnType<typeof publishImpact>>, impactDigest: string | undefined) {
  const details = { impact: analysis.impact, impactDigest: analysis.impactDigest };
  if (impactDigest === undefined) {
    if (analysis.confirmationRequired) throw new ApiError(428, 'IMPACT_CONFIRMATION_REQUIRED', 'IMPACT_CONFIRMATION_REQUIRED', details);
    return;
  }
  if (impactDigest !== analysis.impactDigest) throw new ApiError(409, 'IMPACT_CHANGED', 'IMPACT_CHANGED', details);
}
