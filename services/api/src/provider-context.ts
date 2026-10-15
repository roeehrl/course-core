import {resolveResearchInputWithin} from './research-store.js';
import type { RunRef } from '@course-core/supervisor';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { requireCondition } from './errors.js';
import type { SupervisorInputContext } from './supervisor-bridge.js';
import type { TeachingContext } from './provider-runtime.js';
import { gateDecision, type EvidenceRow } from './learning.js';
import { readLearnerModel } from './learner-model.js';
import type { SemanticVisualContext } from './interactive-context.js';
import { loadEnrollment, policyEpisodeId } from './repository.js';
import {loadPolicy} from './policy-adapter.js';
import {teachingPolicyView} from './teaching-constraints.js';
import { resolveRubricAssistWithin } from './rubric-assist-store.js';

/** Resolve only server-held, scoped references. The model never receives the answer bank. */
export async function teachingContext(db: Database, ref: RunRef, input: SupervisorInputContext): Promise<TeachingContext> {
  if (input.rubricRequestId) return transaction(db, async client => {
    // Only the question, rubric and answer; the learner's identity, profile and history stay out.
    const { input: rubricReview } = await resolveRubricAssistWithin(client, ref.enrollmentId, ref.workspaceId, input.rubricRequestId!, ref.jobId);
    return { rubricReview, course: { title: '', digest: rubricReview.rubricDigest }, episode: { id: input.episodeId ?? '', title: '', teaching: '', objectives: [] },
      learner: { profile: {}, recentHistory: [] }, question: '', constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: false } };
  });
  if(input.researchRequestId)return transaction(db,async client=>{const research=await resolveResearchInputWithin(client,ref.enrollmentId,ref.workspaceId,input.researchRequestId!,input.eventId,ref.jobId);return {publicResearchTopic:research.publicRequest.queryText,publicResearchScope:{requestId:research.requestId,topicId:research.topicId,queryDigest:research.queryDigest,...(research.publicRequest.allowedDomains?{allowedDomains:research.publicRequest.allowedDomains}:{})},course:{title:"Public-topic research",digest:"public-query-only"},episode:{id:research.episodeId,title:"Approved public topic",teaching:"",objectives:[]},learner:{profile:{},recentHistory:[]},question:"",constraints:{deadline:null,expansionAllowed:false,independentAssessmentActive:false}};});
  const built = await transaction(db, async client => {
    const row = (await client.query<{ user_id: string }>(
      `SELECT e.user_id FROM enrollments e
       JOIN course_releases c ON c.id=e.course_release_id AND c.workspace_id=e.workspace_id
       WHERE e.id=$1 AND e.workspace_id=$2 AND c.id=$3`, [ref.enrollmentId, ref.workspaceId, input.courseReleaseId])).rows[0];
    requireCondition(row, 'PROVIDER_CONTEXT_NOT_FOUND', 404);
    const loaded = await loadEnrollment(client, { id: row.user_id, displayName: 'Learner' }, ref.enrollmentId,true);
    requireCondition(loaded.release.id===input.courseReleaseId && loaded.enrollment.workspace_id===ref.workspaceId,'PROVIDER_CONTEXT_CHANGED',409);
    const course = loaded.release.server_bundle;
    const episodeId=input.episodeId??loaded.enrollment.current_episode_id;
    const episode=episodeId?course.chapters.flatMap(chapter=>chapter.episodes).find(episode=>episode.id===episodeId):course.chapters[0]?.episodes[0];
    requireCondition(episode, 'PROVIDER_CONTEXT_NOT_FOUND', 404);
    const messages = (await client.query<{ role: string; content: string }>('SELECT role,content FROM companion_messages WHERE enrollment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [ref.enrollmentId])).rows.reverse();
    const message = input.messageId ? (await client.query<{ content: string; context: { courseDigest?: string; episodeId?: string; interactiveContext?: SemanticVisualContext } }>(
      "SELECT content,context FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='learner'", [input.messageId, ref.enrollmentId])).rows[0] : undefined;
    const question = input.messageId ? message?.content : 'Review the saved learning event and identify any teaching support that is needed.';
    requireCondition(question, 'PROVIDER_CONTEXT_NOT_FOUND', 404);
    const active = await client.query('SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() AND independent_eligible=true LIMIT 1', [ref.enrollmentId]);
    const evidence = (await client.query<EvidenceRow>(`SELECT e.id,e.objective_id,e.independent,e.result,a.family_id,a.assessment_id,a.course_digest,a.mode
      FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`, [ref.enrollmentId])).rows;
    const gate = course.gates.find(row => row.id === episode.gateId), decisionForGate = gate ? gateDecision(gate, evidence, loaded.release.digest) : null;
    const understanding = decisionForGate?.objectives.map(objective => ({ objectiveId: objective.id, independentFamilies: objective.families.length, requiredFamilies: objective.required,
      status: objective.passed ? 'demonstrated' as const : 'needs_evidence' as const })) ?? [];
    const attempts = (await client.query<{ assessment_id: string; mode: string; assistance: string; result: { passed: boolean; explanation?: string } }>(
      'SELECT assessment_id,mode,assistance,result FROM attempts WHERE enrollment_id=$1 ORDER BY submitted_at DESC LIMIT 8', [ref.enrollmentId])).rows;
    const recentAttempts = attempts.map(attempt => ({ assessmentId: attempt.assessment_id,
      prompt: course.assessments.find(assessment => assessment.id === attempt.assessment_id)?.prompt.slice(0, 2000) ?? '',
      passed: attempt.result.passed, assistance: attempt.assistance, mode: attempt.mode, feedback: (attempt.result.explanation ?? '').slice(0, 1000) }));
    const policy=await loadPolicy(client,ref.enrollmentId),now=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
    // Policy scopes and the learner model cover base episodes; an inserted episode uses its anchor's.
    const scopeEpisodeId=policyEpisodeId(loaded.release,episode.id);
    const resolvedPolicy=teachingPolicyView(policy,scopeEpisodeId,episode.objectiveIds,now);
    const effectiveDeadline=resolvedPolicy.deadlines.reduce<string|null>((first,d)=>first===null||Date.parse(d.at)<Date.parse(first)?d.at:first,null);
    const interactiveContext = message?.context.courseDigest === loaded.release.digest && message.context.episodeId === episode.id ? message.context.interactiveContext : undefined;
    const context: TeachingContext = { ...(interactiveContext ? { interactiveContext } : {}),
      revisions:{enrollment:loaded.enrollment.revision,profile:loaded.enrollment.profile_revision,policy:policy.policyRevision,policyLedger:policy.ledgerRevision},
      course: { title: course.title, digest: loaded.release.digest }, episode: { id: episode.id, title: episode.title,
      teaching: episode.blocks.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.markdown : '').join('\n\n'),
      objectives: course.objectives.filter(objective => episode.objectiveIds.includes(objective.id)).map(({ id, description }) => ({ id, description })) },
      learner: { profile: loaded.enrollment.profile, recentHistory: messages, understanding, recentAttempts }, question,
      constraints: { deadline: effectiveDeadline, expansionAllowed: resolvedPolicy.minimumExpansionProbe.allowed, independentAssessmentActive: Boolean(active.rowCount),resolvedPolicy } };
    return { context, userId: row.user_id, scopeEpisodeId };
  });
  // Avoid holding one pool connection while requesting another bounded projection.
  const memory = await readLearnerModel(db, { id: built.userId, displayName: 'Learner' }, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, episodeId: built.scopeEpisodeId });
  requireCondition(memory.revision===built.context.revisions!.enrollment&&memory.courseDigest===built.context.course.digest,'PROVIDER_CONTEXT_CHANGED',409);
  built.context.revisions!.learnerModel=memory.modelRevision;
  built.context.learner.profile = { displayName: built.context.learner.profile.displayName, ...memory.selfReport.preferences };
  built.context.learner.model = { selfReport: memory.selfReport, understanding: memory.understanding, suggestions: memory.suggestions, ...(memory.teaching ? { teaching: memory.teaching } : {}) };
  return built.context;
}
