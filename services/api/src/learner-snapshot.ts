import { closedRecordNotices } from './closed-record.js';
import type { PoolClient } from 'pg';
import { checkActions } from '@course-core/policy';
import { policyEpisodeId, type EnrollmentContext } from './repository.js';
import { publicQuestion } from './learning.js';
import { findAssessment } from './gates.js';
import { gateLearningSnapshot } from './gate-decisions.js';
import { loadPolicy } from './policy-adapter.js';
import { hiddenOptionalBlocks } from './personal-changes.js';
import { readRelease } from './release-cache.js';
import { adaptationSummary } from './adaptation-store.js';
import { assessmentRecovery } from './assessment-recovery.js';
import { armOffersRole, studyArmWithin } from './study.js';
import { learnerMoveOffer } from './course-version-moves.js';
import { INDEPENDENT_CHECK_SQL } from './independence.js';

/** Why an open question counts as practice, as a code (the learner app words it, kindLine namespace). */
export const PRACTICE_REASONS = ['companion', 'hint', 'solution', 'fresh_question', 'seen_before'] as const;
export type PracticeReason = (typeof PRACTICE_REASONS)[number];
/** The reasons the learner app gives a reason line; a fresh question has none. */
export const WORDED_PRACTICE_REASONS: readonly PracticeReason[] = ['companion', 'hint', 'solution', 'seen_before'];
/**
 * Why a question no longer counts: the reason stored with its downgrade (help from the companion, a
 * hint, the explanation, a fresh question), or `seen_before` for a question issued in a counted mode
 * that was not eligible although no help was given (it had been shown before). Null while it counts,
 * for a question requested as practice, and for questions downgraded before reasons were stored:
 * never a guess.
 */
export function practiceReason(row: { independent_eligible: boolean; assistance: string; assistance_reason: string | null; mode: string }): PracticeReason | null {
  if (row.independent_eligible) return null;
  if (row.assistance_reason) return row.assistance_reason as PracticeReason;
  return row.assistance === 'none' && (row.mode === 'independent' || row.mode === 'placement') ? 'seen_before' : null;
}

/**
 * Per lesson, how many answers to its check counted (on your own) and how many were practice, on
 * the course version the learner is on: submitted answers only, never "I don't know yet", placement
 * or review items. The conversation's lesson recap reads it. Reads only.
 */
export async function checkSummaries(client: PoolClient, enrollmentId: string, courseDigest: string) {
  const rows = (await client.query<{ episode_id: string; own: number; practice: number }>(
    `SELECT c.episode_id, count(*) FILTER (WHERE ${INDEPENDENT_CHECK_SQL('c')})::int AS own, count(*) FILTER (WHERE NOT ${INDEPENDENT_CHECK_SQL('c')})::int AS practice
       FROM assessment_challenges c JOIN attempts a ON a.id=c.attempt_id AND a.enrollment_id=c.enrollment_id
      WHERE c.enrollment_id=$1 AND c.course_digest=$2 AND c.mode IN ('independent','practice') AND (a.result->>'abstained') IS DISTINCT FROM 'true'
      GROUP BY c.episode_id`, [enrollmentId, courseDigest])).rows;
  return Object.fromEntries(rows.map(row => [row.episode_id, { own: row.own, practice: row.practice }]));
}

/** The enrollment state every learner command returns, with each gate's current decision status,
 * its persisted decision ID and the learner's latest gate review request. Reads only. */
export async function enrollmentState(client: PoolClient, context: EnrollmentContext) {
  return { enrollmentId: context.enrollment.id, revision: context.enrollment.revision, profile: context.enrollment.profile,
    profileRevision: context.enrollment.profile_revision, policyRevision: context.enrollment.policy_revision, status: context.enrollment.status,
    courseDigest: context.release.digest, planRevision: context.release.planRevision ?? 0, planDigest: context.release.planDigest,
    adaptationRequirements: context.release.adaptationRequirements ?? [], ...await gateLearningSnapshot(client, context) };
}

/** How long the learner app tells a moved learner their course was updated (course-version-moves.ts). */
export const MOVE_NOTICE_DAYS = 30;
/**
 * The learner's "your course was updated" notice: their latest move to the version they are on now,
 * within MOVE_NOTICE_DAYS. None once the move was undone (they are back on the old version). Versions
 * only, never prose: the learner app words it (courseVersionNotice namespace).
 */
export async function courseVersionNotice(client: PoolClient, enrollmentId: string, releaseId: string) {
  const row = (await client.query<{ id: string; payload: { moveId?: string; fromVersion?: string; toVersion?: string; carriedCheckpoints?: number; personalChangesArchived?: number;
    personalChanges?: 'accepted' | 'forced' }; created_at: Date }>(
    `SELECT id,payload,created_at FROM learning_events WHERE enrollment_id=$1 AND event_type='course_version.moved' AND payload->>'toReleaseId'=$2
      AND created_at > now() - make_interval(days => $3) ORDER BY sequence DESC LIMIT 1`, [enrollmentId, releaseId, MOVE_NOTICE_DAYS])).rows[0];
  if (!row?.payload.fromVersion || !row.payload.toVersion) return null;
  return { id: row.id, fromVersion: row.payload.fromVersion, toVersion: row.payload.toVersion, movedAt: row.created_at.toISOString(),
    carriedCheckpoints: row.payload.carriedCheckpoints ?? 0,
    // The move dropped their personal changes: they accepted it, or staff moved them anyway. Archived, not lost.
    personalChanges: row.payload.personalChanges ?? null, personalChangesArchived: row.payload.personalChangesArchived ?? 0 };
}

/** What the learner app loads for one enrollment: its personal course (hidden
 * optional additions removed, policy-closed episodes emptied), progress, gates,
 * recovery offers and open checks. Reads only; the caller owns authorization. */
export async function learnerSnapshot(client: PoolClient, context: EnrollmentContext) {
  const enrollmentId = context.enrollment.id;
  const policy = await loadPolicy(client, enrollmentId), course = structuredClone(context.release.learner_bundle), now = new Date().toISOString();
  // Optional personal additions the learner hid are left out of their view.
  const hidden = await hiddenOptionalBlocks(client, context);
  if (hidden.size) for (const chapter of course.chapters) for (const episode of chapter.episodes) episode.blocks = episode.blocks.filter(block => !hidden.has(`${episode.id}/${block.id}`));
  const inaccessibleEpisodeIds: string[] = [];
  // One policy validation for the whole course, not one per episode.
  const all = course.chapters.flatMap(chapter => chapter.episodes);
  const reads = checkActions(policy, all.map(episode => ({ scopeId: `episode:${policyEpisodeId(context.release, episode.id)}`, now, kind: 'read' as const, expectedPolicyRevision: policy.policyRevision })));
  all.forEach((episode, i) => { if (!reads[i]!.allowed) { inaccessibleEpisodeIds.push(episode.id); episode.blocks = []; } });
  const blocks = course.chapters.flatMap(row => row.episodes.flatMap(ep => ep.blocks));
  course.visuals = course.visuals.filter(visual => blocks.some(block => block.type === 'visual' && block.visualId === visual.id));
  course.media = course.media.filter(media => blocks.some(block => block.type === 'media' && block.mediaId === media.id));
  // A lesson's counted question comes before a practice one (the app shows the first): after "Get a
  // fresh check" on a practice question, the fresh one is the one shown.
  const challenges = (await client.query<{ id: string; episode_id: string; assessment_id: string; mode: string; independent_eligible: boolean; assistance: string; assistance_reason: string | null; expires_at: Date }>(`SELECT id,episode_id,assessment_id,mode,independent_eligible,assistance,assistance_reason,expires_at FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() ORDER BY independent_eligible DESC,issued_at`, [enrollmentId])).rows;
  const base = (await readRelease(client, context.enrollment.course_release_id, context.enrollment.workspace_id))!;
  const recoveryRegistry = await adaptationSummary(client, context.enrollment, base, context.release.server_bundle), exposed = (await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1 AND course_digest=$2', [enrollmentId, base.digest])).rows.map(r => r.assessment_id);
  const recovery = assessmentRecovery(context.release.server_bundle, base.digest, context.progress, context.evidence, exposed, recoveryRegistry.approvedFamilies);
  // What the enrollment's study arm switches off, so the app does not offer it (null: no arm).
  const arm = await studyArmWithin(client, enrollmentId);
  const studyArm = arm ? { label: arm.label, behaviour: arm.behaviour, companion: armOffersRole(arm.behaviour, 'companion'), supervision: armOffersRole(arm.behaviour, 'supervisor'),
    // The participant agreed to usability timing (study.ts): the app records and sends it.
    measuresUsability: arm.usabilityMeasures } : null;
  return { ...await enrollmentState(client, context), course, studyArm, recovery, recoveryRegistryRevision: recoveryRegistry.registryRevision, inaccessibleEpisodeIds, closureReport: policy.closure ?? null, closedRecordNotices: await closedRecordNotices(client, enrollmentId),
    // Staff moved this learner to the version they are on now (K13): the app says so for a while.
    courseVersionNotice: await courseVersionNotice(client, enrollmentId, context.enrollment.course_release_id),
    // A newer version they can move to by dropping their personal changes (they accept or decline).
    courseVersionOffer: await learnerMoveOffer(client, enrollmentId, context.enrollment.course_release_id),
    checkSummaries: await checkSummaries(client, enrollmentId, context.release.digest), activeChallenges: challenges.filter(row => !inaccessibleEpisodeIds.includes(row.episode_id)).map(row => ({ challengeId: row.id, episodeId: row.episode_id,
    question: publicQuestion(findAssessment(context.release.server_bundle, row.assessment_id)!, context.release.server_bundle), mode: row.mode, independentEligible: row.independent_eligible,
    practiceReason: practiceReason(row), expiresAt: row.expires_at })) };
}
