import {resolveResearchInputWithin} from './research-store.js';
import type { RunRef } from '@course-core/supervisor';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { requireCondition } from './errors.js';
import type { SupervisorInputContext } from './supervisor-bridge.js';
import type { TeachingContext } from './provider-runtime.js';
import type { SupervisorTask } from './agent-strategies.js';
import { supervisionSettingsWithin } from './supervision-settings.js';
import type { PoolClient } from 'pg';
import { gateDecision, type EvidenceRow } from './learning.js';
import { excludedAttemptIds, readLearnerModelForSupervisorJob } from './learner-model.js';
import type { SemanticVisualContext } from './interactive-context.js';
import { loadEnrollment, policyEpisodeId } from './repository.js';
import {loadPolicy} from './policy-adapter.js';
import {teachingPolicyView} from './teaching-constraints.js';
import { resolveRubricAssistWithin } from './rubric-assist-store.js';
import { capsuleFacts, constraintSnapshot, retrieveConversation, simulationState, storeCapsule, type CompanionCapsule, type QuestionFocus } from './context-capsule.js';
import { effectiveDigestSql } from './carried-digest.js';
import { questionCheckCoaching } from './companion-check-scope.js';

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
    const message = input.messageId ? (await client.query<{ content: string; created_at: Date; context: QuestionFocus & { courseDigest?: string; episodeId?: string; interactiveContext?: SemanticVisualContext } }>(
      "SELECT content,created_at,context FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='learner'", [input.messageId, ref.enrollmentId])).rows[0] : undefined;
    // Only this lesson's conversation in this course version, bounded and referenced; never other lessons
    // or messages the learner excluded. Earlier questions become an extractive summary naming its sources.
    const conversation = await retrieveConversation(client, { enrollmentId: ref.enrollmentId, episodeId: episode.id, courseDigest: loaded.release.digest,
      ...(input.messageId ? { currentMessageId: input.messageId } : {}), ...(message ? { before: message.created_at } : {}) });
    const question = input.messageId ? message?.content : 'Review the saved learning event and identify any teaching support that is needed.';
    requireCondition(question, 'PROVIDER_CONTEXT_NOT_FOUND', 404);
    const active = await client.query('SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() AND independent_eligible=true LIMIT 1', [ref.enrollmentId]);
    // The course's graded checks this question is about, open or not (companion-check-integrity.ts):
    // only their prompts and options reach the model, never a key. The same match sized the
    // question's reservation when it was prepared (companion-check-scope.ts).
    const checkCoaching = input.messageId && message ? await questionCheckCoaching(client, { enrollmentId: ref.enrollmentId, courseDigest: loaded.release.digest, course,
      episodeId: episode.id, blockId: input.blockId ?? null, messageId: input.messageId, question: question!, before: message.created_at,
      earlier: conversation.history.filter(turn => turn.role === 'learner').map(turn => turn.content) }) : undefined;
    const evidence = (await client.query<EvidenceRow>(`SELECT e.id,e.objective_id,e.independent,e.result,a.family_id,a.assessment_id,${effectiveDigestSql()} AS course_digest,a.mode
      FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`, [ref.enrollmentId])).rows;
    const gate = course.gates.find(row => row.id === episode.gateId), decisionForGate = gate ? gateDecision(course, gate, evidence, loaded.release.digest) : null;
    const understanding = decisionForGate?.objectives.map(objective => ({ objectiveId: objective.id, independentFamilies: objective.families.length, requiredFamilies: objective.required,
      status: objective.passed ? 'demonstrated' as const : 'needs_evidence' as const })) ?? [];
    const latest = (await client.query<{ id: string; assessment_id: string; mode: string; assistance: string; result: { passed: boolean; abstained?: boolean; explanation?: string; message?: { code: string } } }>(
      'SELECT id,assessment_id,mode,assistance,result FROM attempts WHERE enrollment_id=$1 ORDER BY submitted_at DESC LIMIT 8', [ref.enrollmentId])).rows;
    // Answers whose evidence the learner excluded from AI context are left out.
    const excluded = await excludedAttemptIds(client, ref.enrollmentId, latest.map(attempt => attempt.id));
    const attempts = latest.filter(attempt => !excluded.has(attempt.id));
    const recentAttempts = attempts.map(attempt => ({ assessmentId: attempt.assessment_id,
      prompt: course.assessments.find(assessment => assessment.id === attempt.assessment_id)?.prompt.slice(0, 2000) ?? '',
      passed: attempt.result.passed, ...(attempt.result.abstained === true ? { abstained: true as const } : {}),
      assistance: attempt.assistance, mode: attempt.mode, feedback: (attempt.result.explanation ?? attempt.result.message?.code ?? '').slice(0, 1000) }));
    const policy=await loadPolicy(client,ref.enrollmentId),now=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
    // Policy scopes and the learner model cover base episodes; an inserted episode uses its anchor's.
    const scopeEpisodeId=policyEpisodeId(loaded.release,episode.id);
    const resolvedPolicy=teachingPolicyView(policy,scopeEpisodeId,episode.objectiveIds,now);
    const effectiveDeadline=resolvedPolicy.deadlines.reduce<string|null>((first,d)=>first===null||Date.parse(d.at)<Date.parse(first)?d.at:first,null);
    const sameScope = message?.context.courseDigest === loaded.release.digest && message.context.episodeId === episode.id;
    const interactiveContext = sameScope ? message!.context.interactiveContext : undefined;
    const focus = sameScope && (message!.context.selectedAnchor || message!.context.mediaRef) ? {
      ...(message!.context.selectedAnchor ? { selection: message!.context.selectedAnchor } : {}),
      ...(message!.context.mediaRef ? { media: message!.context.mediaRef } : {}),
      authority: 'learner_pointed_at_this_not_evidence' as const } : undefined;
    const context: TeachingContext = { ...(interactiveContext ? { interactiveContext } : {}), ...(focus ? { focus } : {}),
      ...(conversation.summary ? { conversation: { scope: 'this_lesson_only' as const, earlierQuestions: { count: conversation.summary.count,
        excerpts: conversation.summary.items.map(item => item.excerpt), note: 'Extracted from the learner\'s earlier questions in this lesson; not a model summary.' } } } : {}),
      revisions:{enrollment:loaded.enrollment.revision,profile:loaded.enrollment.profile_revision,policy:policy.policyRevision,policyLedger:policy.ledgerRevision},
      course: { title: course.title, digest: loaded.release.digest }, episode: { id: episode.id, title: episode.title,
      teaching: episode.blocks.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.markdown : '').join('\n\n'),
      objectives: course.objectives.filter(objective => episode.objectiveIds.includes(objective.id)).map(({ id, description }) => ({ id, description })) },
      learner: { profile: loaded.enrollment.profile, recentHistory: conversation.history, understanding, recentAttempts }, question,
      constraints: { deadline: effectiveDeadline, expansionAllowed: resolvedPolicy.minimumExpansionProbe.allowed, independentAssessmentActive: Boolean(active.rowCount),resolvedPolicy } };
    const facts = await capsuleFacts(client, ref.enrollmentId, episode, episode.gateId);
    const capsule = { schemaVersion: 1 as const, kind: 'companion_context_capsule' as const, enrollmentId: ref.enrollmentId, courseDigest: loaded.release.digest,
      pathRevision: loaded.release.planRevision ?? null, planDigest: loaded.release.planDigest ?? null, episodeId: episode.id, blockId: input.blockId ?? null,
      currentStepId: input.blockId ?? null, activityInstanceId: facts.activityInstanceId, attemptId: facts.attemptId, answersMessageId: input.messageId ?? null,
      uiRevision: message?.context.uiRevision ?? null, contextRevision: loaded.enrollment.revision - (loaded.enrollment as { navigation_revision?: number }).navigation_revision!,
      enrollmentRevision: loaded.enrollment.revision, profileRevision: loaded.enrollment.profile_revision, policyRevision: policy.policyRevision, learnerModelRevision: null,
      recentEventCursor: message?.context.recentEventCursor ?? null, selectedAnchor: focus?.selection ?? null, simulationState: simulationState(interactiveContext),
      codeSnapshotHash: focus?.selection?.kind === 'code_line' ? focus.selection.codeSnapshotHash : null, assessmentMode: facts.assessmentMode,
      mediaRef: focus?.media ?? null, playbackSeconds: focus?.media?.playbackSeconds ?? null, reviewedSegment: focus?.media?.reviewedSegment ?? null,
      evidenceRefs: [], historyRefs: conversation.refs, summary: conversation.summary,
      sourceRefs: episode.blocks.flatMap(block => block.type === 'text' ? block.sourceRefs ?? [] : []).slice(0, 20),
      authorizationScopes: [`enrollment:${ref.enrollmentId}`, `episode:${episode.id}`, 'learner-model:provider-projection', `job:${ref.jobId}`],
      extensionAllowanceRefs: facts.extensionAllowanceRefs, pendingGateDecisionRef: facts.pendingGateDecisionRef,
      resolvedConstraintSnapshot: constraintSnapshot(context.constraints, policy.policyRevision) } satisfies CompanionCapsule;
    return { context, userId: row.user_id, scopeEpisodeId, capsule, checkCoaching };
  });
  // Avoid holding one pool connection while requesting another bounded projection.
  // Authorized by this admitted supervisor job, not by the learner's identity or a staff role.
  const memory = await readLearnerModelForSupervisorJob(db, { jobId: ref.jobId, workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId }, { episodeId: built.scopeEpisodeId });
  requireCondition(memory.revision===built.context.revisions!.enrollment&&memory.courseDigest===built.context.course.digest,'PROVIDER_CONTEXT_CHANGED',409);
  built.context.revisions!.learnerModel=memory.modelRevision;
  // The learner's own statements about themselves (preferences, goal, prior knowledge, accepted suggestions) reach a
  // companion turn, which answers the learner's own question, always: they wrote them to shape how
  // they are taught. Autonomous supervisor work receives them only under the course-scoped
  // supervision opt-in, like teaching hypotheses (design: autonomy follows one course-scoped opt-in).
  const job = (await db.query<{ role: string; opted: boolean }>(`SELECT j.role,COALESCE(p.adaptive_teaching,false) AS opted FROM supervisor_jobs j
    LEFT JOIN supervisor_permissions p ON p.enrollment_id=j.enrollment_id AND p.workspace_id=j.workspace_id
    WHERE j.id=$1 AND j.enrollment_id=$2 AND j.workspace_id=$3`, [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  const selfReport = job?.role === 'companion' || job?.opted === true;
  if (job?.role === 'companion' && built.checkCoaching) built.context.checkCoaching = built.checkCoaching;
  built.context.learner.profile = { displayName: built.context.learner.profile.displayName, ...(selfReport ? memory.selfReport.preferences : {}) };
  built.context.learner.model = { selfReport: selfReport ? memory.selfReport : { trust: memory.selfReport.trust, withheld: 'supervision_opt_in_required' },
    // Suggestions the learner accepted are preferences too, and follow the same rule.
    understanding: memory.understanding, suggestions: selfReport ? memory.suggestions : { items: [], truncated: false, withheld: 'supervision_opt_in_required' }, ...(memory.teaching ? { teaching: memory.teaching } : {}) };
  const task = await transaction(db, client => supervisorTaskWithin(client, ref, input));
  if (task) built.context.task = task;
  if (job?.role === 'supervisor') {
    const settings = await supervisionSettingsWithin(db, ref.workspaceId);
    if (settings.revision > 0) built.context.permittedToolFamilies = settings.permittedToolFamilies;
  }
  // Keep what this job was given, for "Context used" on the answer to this question.
  if (input.messageId) await transaction(db, client => storeCapsule(client, { jobId: ref.jobId, workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, learnerMessageId: input.messageId!,
    capsule: { ...built.capsule, learnerModelRevision: memory.modelRevision,
      evidenceRefs: memory.understanding.flatMap(row => row.evidenceRefs.map(item => ({ evidenceId: item.evidenceId, attemptId: item.attemptId }))).slice(0, 12) } }));
  return built.context;
}

/** What a supervisor run is for (design §4): its teaching action or follow-up, its logical role,
 * and for builders the planner's brief, for the evaluator the builders' drafts. Read from this
 * job's own rows; summaries are the job's own artifacts, bounded. Undefined for a plain event job. */
async function supervisorTaskWithin(client: PoolClient, ref: RunRef, input: SupervisorInputContext): Promise<SupervisorTask | undefined> {
  const job = (await client.query<{ role: string; objective: { kind: string; objectiveIds: string[]; refs: string[] } | null; runtime_snapshot: { operations: { checkpointId: string; outcome: { status: string; artifact?: { artifactId: string } } | null }[] } }>(
    'SELECT role,objective,runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3', [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  if (!job || job.role !== 'supervisor' || (!input.task && (!job.objective || job.objective.kind === 'learning_event'))) return undefined;
  const refs = job.objective && job.objective.kind !== 'learning_event' ? job.objective.refs : [];
  const actions = refs.length ? (await client.query<{ action: string; objective_ids: string[]; outcome: { objectives?: unknown; transferItem?: unknown } | null }>(
    'SELECT action,objective_ids,outcome FROM teaching_actions WHERE id=ANY($1::uuid[]) AND enrollment_id=$2 ORDER BY created_at', [refs, ref.enrollmentId])).rows : [];
  const task: SupervisorTask = { objective: job.objective ? { kind: job.objective.kind, objectiveIds: job.objective.objectiveIds } : null,
    actions: actions.map(a => ({ action: a.action, objectiveIds: a.objective_ids,
      ...(a.outcome ? { followUp: { objectives: a.outcome.objectives ?? [], ...(a.outcome.transferItem ? { transferItem: a.outcome.transferItem } : {}) } } : {}) })) };
  if (!input.task) return task;
  task.logicalRole = input.task.logicalRole;
  if (input.task.alternative) task.alternative = input.task.alternative;
  const plans = async (prefix: string) => {
    const ids = job.runtime_snapshot.operations.filter(o => o.checkpointId.startsWith(prefix) && o.outcome?.status === 'succeeded').map(o => ({ checkpointId: o.checkpointId, artifactId: o.outcome!.artifact!.artifactId }));
    const rows = ids.length ? (await client.query<{ id: string; content: Record<string, unknown> | null }>('SELECT id,content FROM supervisor_artifacts WHERE id=ANY($1::uuid[]) AND job_id=$2', [ids.map(i => i.artifactId), ref.jobId])).rows : [];
    return ids.map(i => ({ checkpointId: i.checkpointId, content: rows.find(r => r.id === i.artifactId)?.content ?? null }));
  };
  if (task.logicalRole !== 'planner') {
    const plan = (await plans('plan'))[0]?.content;
    if (plan?.kind === 'supervised_plan' && typeof plan.summary === 'string') task.brief = plan.summary.slice(0, 2000);
  }
  if (task.logicalRole === 'evaluator')
    task.alternatives = (await plans('build-')).filter(p => p.content?.kind === 'supervised_plan').map(p => ({ checkpointId: p.checkpointId,
      summary: String(p.content!.summary).slice(0, 1000),
      builds: ['selection', 'generatedTeaching', 'resourceChoices', 'suggestions'].filter(k => p.content![k] !== undefined && p.content![k] !== null) }));
  return task;
}
