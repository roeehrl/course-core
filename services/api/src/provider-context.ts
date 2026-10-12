import type { CourseManifest } from '@course-core/sdk';
import { checkAction, type PolicyState } from '@course-core/policy';
import type { RunRef } from '@course-core/supervisor';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { requireCondition } from './errors.js';
import type { SupervisorInputContext } from './supervisor-bridge.js';
import type { TeachingContext } from './provider-runtime.js';
import { gateDecision, type EvidenceRow } from './learning.js';
import { readLearnerModel } from './learner-model.js';
import type { SemanticVisualContext } from './interactive-context.js';
import { loadEnrollment } from './repository.js';

/** Resolve only server-held, scoped references. The model never receives the answer bank. */
export async function teachingContext(db: Database, ref: RunRef, input: SupervisorInputContext): Promise<TeachingContext> {
  const built = await transaction(db, async client => {
    const row = (await client.query<{ user_id: string; profile: Record<string, unknown>; current_episode_id: string | null; server_bundle: CourseManifest; digest: string; snapshot: PolicyState }>(
      `SELECT e.user_id,e.profile,e.current_episode_id,c.server_bundle,c.digest,p.snapshot FROM enrollments e
       JOIN course_releases c ON c.id=e.course_release_id AND c.workspace_id=e.workspace_id
       JOIN policy_states p ON p.enrollment_id=e.id
       WHERE e.id=$1 AND e.workspace_id=$2 AND c.id=$3`, [ref.enrollmentId, ref.workspaceId, input.courseReleaseId])).rows[0];
    requireCondition(row, 'PROVIDER_CONTEXT_NOT_FOUND', 404);
    const loaded = await loadEnrollment(client, { id: row.user_id, displayName: 'Learner' }, ref.enrollmentId);
    const course = loaded.release.server_bundle;
    const episode = course.chapters.flatMap(chapter => chapter.episodes).find(episode => episode.id === (input.episodeId ?? row.current_episode_id)) ?? course.chapters[0]?.episodes[0];
    requireCondition(episode, 'PROVIDER_CONTEXT_NOT_FOUND', 404);
    const messages = (await client.query<{ role: string; content: string }>('SELECT role,content FROM companion_messages WHERE enrollment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [ref.enrollmentId])).rows.reverse();
    const message = input.messageId ? (await client.query<{ content: string; context: { courseDigest?: string; episodeId?: string; interactiveContext?: SemanticVisualContext } }>(
      "SELECT content,context FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='learner'", [input.messageId, ref.enrollmentId])).rows[0] : undefined;
    const question = input.messageId ? message?.content : 'Review the saved learning event and identify any teaching support that is needed.';
    requireCondition(question, 'PROVIDER_CONTEXT_NOT_FOUND', 404);
    const active = await client.query('SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() AND independent_eligible=true LIMIT 1', [ref.enrollmentId]);
    const evidence = (await client.query<EvidenceRow>(`SELECT e.id,e.objective_id,e.independent,e.result,a.family_id,a.assessment_id,a.course_digest,a.mode
      FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`, [ref.enrollmentId])).rows;
    const gate = course.gates.find(row => row.id === episode.gateId), decisionForGate = gate ? gateDecision(gate, evidence, row.digest) : null;
    const understanding = decisionForGate?.objectives.map(objective => ({ objectiveId: objective.id, independentFamilies: objective.families.length, requiredFamilies: objective.required,
      status: objective.passed ? 'demonstrated' as const : 'needs_evidence' as const })) ?? [];
    const attempts = (await client.query<{ assessment_id: string; mode: string; assistance: string; result: { passed: boolean; explanation?: string } }>(
      'SELECT assessment_id,mode,assistance,result FROM attempts WHERE enrollment_id=$1 ORDER BY submitted_at DESC LIMIT 8', [ref.enrollmentId])).rows;
    const recentAttempts = attempts.map(attempt => ({ assessmentId: attempt.assessment_id,
      prompt: course.assessments.find(assessment => assessment.id === attempt.assessment_id)?.prompt.slice(0, 2000) ?? '',
      passed: attempt.result.passed, assistance: attempt.assistance, mode: attempt.mode, feedback: (attempt.result.explanation ?? '').slice(0, 1000) }));
    const decision = checkAction(row.snapshot, { scopeId: `episode:${episode.id}`, now: new Date().toISOString(), kind: 'publish', expectedPolicyRevision: row.snapshot.policyRevision,
      work: { additionalEpisodes: 1, additionalMinutes: 1, remediation: [] } });
    const interactiveContext = message?.context.courseDigest === row.digest && message.context.episodeId === episode.id ? message.context.interactiveContext : undefined;
    const context: TeachingContext = { ...(interactiveContext ? { interactiveContext } : {}), course: { title: course.title, digest: row.digest }, episode: { id: episode.id, title: episode.title,
      teaching: episode.blocks.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.markdown : '').join('\n\n'),
      objectives: course.objectives.filter(objective => episode.objectiveIds.includes(objective.id)).map(({ id, description }) => ({ id, description })) },
      learner: { profile: row.profile, recentHistory: messages, understanding, recentAttempts }, question,
      constraints: { deadline: decision.snapshot.effectiveDeadline, expansionAllowed: decision.allowed, independentAssessmentActive: Boolean(active.rowCount) } };
    return { context, userId: row.user_id };
  });
  // Avoid holding one pool connection while requesting another bounded projection.
  const memory = await readLearnerModel(db, { id: built.userId, displayName: 'Learner' }, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, episodeId: built.context.episode.id });
  built.context.learner.profile = { displayName: built.context.learner.profile.displayName, ...memory.selfReport.preferences };
  built.context.learner.model = { selfReport: memory.selfReport, understanding: memory.understanding, suggestions: memory.suggestions };
  return built.context;
}
