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

/** The enrollment state every learner command returns, with each gate's current decision status,
 * its persisted decision ID and the learner's latest gate review request. Reads only. */
export async function enrollmentState(client: PoolClient, context: EnrollmentContext) {
  return { enrollmentId: context.enrollment.id, revision: context.enrollment.revision, profile: context.enrollment.profile,
    profileRevision: context.enrollment.profile_revision, policyRevision: context.enrollment.policy_revision, status: context.enrollment.status,
    courseDigest: context.release.digest, planRevision: context.release.planRevision ?? 0, planDigest: context.release.planDigest,
    adaptationRequirements: context.release.adaptationRequirements ?? [], ...await gateLearningSnapshot(client, context) };
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
  const challenges = (await client.query<{ id: string; episode_id: string; assessment_id: string; mode: string; independent_eligible: boolean; expires_at: Date }>(`SELECT id,episode_id,assessment_id,mode,independent_eligible,expires_at FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() ORDER BY issued_at`, [enrollmentId])).rows;
  const base = (await readRelease(client, context.enrollment.course_release_id, context.enrollment.workspace_id))!;
  const recoveryRegistry = await adaptationSummary(client, context.enrollment, base, context.release.server_bundle), exposed = (await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1 AND course_digest=$2', [enrollmentId, base.digest])).rows.map(r => r.assessment_id);
  const recovery = assessmentRecovery(context.release.server_bundle, base.digest, context.progress, context.evidence, exposed, recoveryRegistry.approvedFamilies);
  // What the enrollment's study arm switches off, so the app does not offer it (null: no arm).
  const arm = await studyArmWithin(client, enrollmentId);
  const studyArm = arm ? { label: arm.label, behaviour: arm.behaviour, companion: armOffersRole(arm.behaviour, 'companion'), supervision: armOffersRole(arm.behaviour, 'supervisor') } : null;
  return { ...await enrollmentState(client, context), course, studyArm, recovery, recoveryRegistryRevision: recoveryRegistry.registryRevision, inaccessibleEpisodeIds, closureReport: policy.closure ?? null, closedRecordNotices: await closedRecordNotices(client, enrollmentId), activeChallenges: challenges.filter(row => !inaccessibleEpisodeIds.includes(row.episode_id)).map(row => ({ challengeId: row.id, episodeId: row.episode_id,
    question: publicQuestion(findAssessment(context.release.server_bundle, row.assessment_id)!, context.release.server_bundle), mode: row.mode, independentEligible: row.independent_eligible, expiresAt: row.expires_at })) };
}
