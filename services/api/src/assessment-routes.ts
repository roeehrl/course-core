import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Assessment } from '@course-core/sdk';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { enrollmentCommand, loadEnrollment, policyEpisodeId, type CommandInput, type EnrollmentContext } from './repository.js';
import { episodes, gateDecision, gradeDeterministic, publicQuestion, requireAvailable } from './learning.js';
import { activateWindows, assertPolicyAction } from './policy-adapter.js';
import type { RuntimeExtension } from './publication.js';
import { closeCompletedCourse } from './closure.js';
import { qualifiedCodeEvaluator } from './code-evaluator.js';
import { RUBRIC_RESPONSE_LIMITS, rubricDigest } from './rubric-evaluator.js';
import { recordRetentionOutcome } from './retention.js';
import { systemClock, type Clock } from './clock.js';
import { optionalPersonalBlocks } from './personal-changes.js';
import { declarationMatchesInstalled } from './extension-identity.js';
import { codeView, DETERMINISTIC_ITEM_TYPES, findAssessment, gateItemIds, reviewedRubric } from './gates.js';
import { refreshDecisionsForItem, refreshGateDecision, requireReadyDecision } from './gate-decisions.js';
import { enrollmentState } from './learner-snapshot.js';
import { offeredPlacementItem, placementItemsUsed } from './placement.js';
import { recordAnswerSignal } from './teaching-hypotheses.js';

const uuid = { type: 'string', format: 'uuid' };
const id = { type: 'string', minLength: 1, maxLength: 200 };
const commandProperties = { expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' } };
function commandSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', additionalProperties: false, properties: { ...commandProperties, ...properties }, required: ['expectedRevision', 'idempotencyKey', ...required] };
}
const enrollmentParams = { type: 'object', properties: { enrollmentId: uuid }, required: ['enrollmentId'] };
const commandPath = '/api/enrollments/:enrollmentId';
type Input = CommandInput & Record<string, unknown>;

/** An answer reproducing a sentence of a companion (tutor) reply is agent-authored. It is refused,
 * never recorded as the learner's evidence. */
export async function agentAuthored(client: PoolClient, enrollmentId: string, answer: string) {
  const normal = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const response = normal(answer);
  const replies = (await client.query<{ content: string }>("SELECT content FROM companion_messages WHERE enrollment_id=$1 AND role='assistant' ORDER BY created_at DESC LIMIT 200", [enrollmentId])).rows;
  return replies.some(reply => normal(reply.content).split(/(?<=[.!?])\s+/).some(sentence => sentence.length >= 60 && response.includes(sentence)));
}
/** Whether this host can evaluate the item now (installed, declared and qualified evaluator). */
function requireEvaluator(context: EnrollmentContext, assessment: Assessment, installed: RuntimeExtension[]) {
  const course = context.release.server_bundle, code = codeView(course, assessment), rubric = reviewedRubric(course, assessment.id);
  if (code) { qualifiedCodeEvaluator(code, course.extensions, installed); return; }
  if (rubric) {
    requireCondition(installed.some(e => e.rubricReady && e.id === rubric.evaluatorExtensionId && course.extensions.some(d => d.id === e.id && declarationMatchesInstalled(d, e))), 'EVALUATOR_NOT_CONFIGURED', 409);
    return;
  }
  requireCondition(DETERMINISTIC_ITEM_TYPES.has(assessment.type), 'EVALUATOR_NOT_CONFIGURED', 409);
}
const explanationOf = (assessment: Assessment) => 'explanation' in assessment.grading && typeof assessment.grading.explanation === 'string' ? assessment.grading.explanation : undefined;

export function registerAssessmentRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installed: RuntimeExtension[], clock: Clock = systemClock) {
  app.post(`${commandPath}/challenges`, { schema: { params: enrollmentParams, body: commandSchema({ episodeId: id, assessmentId: id, mode: { enum: ['practice', 'independent', 'placement'] } }, ['episodeId', 'mode']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { episodeId: string; assessmentId?: string; mode: string };
    return enrollmentCommand(db, actor, enrollmentId, 'challenge', input, async (client, context) => {
      const course = context.release.server_bundle, episode = episodes(course).find(row => row.id === input.episodeId);
      requireCondition(episode, 'EPISODE_NOT_FOUND', 404);
      const gate = course.gates.find(row => row.id === episode.gateId), items = gate ? gateItemIds(gate) : [];
      const exposed = (await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1', [enrollmentId])).rows.map(row => row.assessment_id);
      // The default pick is the next unexposed listed item; a gate conversation is only issued on request.
      const assessmentId = input.assessmentId ?? items.find(candidate => !exposed.includes(candidate) && course.assessments.some(a => a.id === candidate));
      requireCondition(assessmentId, 'FRESH_EVIDENCE_ITEM_REQUIRED', 409);
      if (input.mode === 'placement') {
        requireCondition(course.placement?.enabled && !course.placement.protectedEpisodeIds.includes(episode.id) && course.placement.assessmentIds.includes(assessmentId), 'PLACEMENT_UNAVAILABLE', 409);
        requireCondition(episode.objectiveIds.every(obj => course.placement!.objectiveIds.includes(obj)), 'PLACEMENT_UNAVAILABLE', 409);
        // Placement items exist only inside the learner's in-progress placement run.
        const run = (await client.query<{ state: string; started_at: Date; finished_at: Date | null }>('SELECT state,started_at,finished_at FROM placement_runs WHERE enrollment_id=$1 FOR UPDATE', [enrollmentId])).rows[0];
        requireCondition(run?.state === 'in_progress', 'PLACEMENT_RUN_REQUIRED', 409);
        requireCondition(!(await client.query("SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND mode='placement' AND attempt_id IS NULL AND expires_at>clock_timestamp() AND issued_at>=$2", [enrollmentId, run.started_at])).rowCount, 'PLACEMENT_ITEM_PENDING', 409);
        // The allowance belongs to this run, counted exactly as the run view counts it.
        requireCondition(await placementItemsUsed(client, enrollmentId, run, context.release.digest) < course.placement.maxItems, 'PLACEMENT_ITEM_LIMIT', 409);
        // Only the item the run's plan offers next: never one the client chose itself.
        const offered = await offeredPlacementItem(client, context, run);
        requireCondition(offered?.episodeId === episode.id && offered.assessmentId === assessmentId, 'PLACEMENT_ITEM_NOT_OFFERED', 409);
      } else requireAvailable(course, context.release.digest, context.progress, context.evidence, input.episodeId);
      requireCondition(items.includes(assessmentId) || episode.blocks.some(block => block.type === 'assessment' && block.assessmentId === assessmentId), 'ASSESSMENT_OUT_OF_SCOPE', 403);
      const assessment = findAssessment(course, assessmentId);
      requireCondition(assessment, 'ASSESSMENT_OUT_OF_SCOPE', 403);
      requireEvaluator(context, assessment, installed);
      const now = new Date().toISOString();
      // Placement probes later material without starting its study clocks.
      if (input.mode !== 'placement') await activateWindows(client, course, enrollmentId, policyEpisodeId(context.release, input.episodeId), now);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'plan', now);
      const exposures = exposed.filter(id => id === assessmentId).length;
      const independentEligible = input.mode !== 'practice' && exposures === 0;
      const challengeId = randomUUID();
      await client.query(`INSERT INTO assessment_challenges (id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '60 minutes')`, [challengeId, enrollmentId, input.episodeId, assessmentId, context.release.digest, input.mode, independentEligible]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'assessment.issued', payload: { challengeId, assessmentId, mode: input.mode, independentEligible }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { challengeId, question: publicQuestion(assessment, course), independentEligible, revision: context.enrollment.revision + 1 };
    });
  });
  app.post(`${commandPath}/solution`, { schema: { params: enrollmentParams, body: commandSchema({ challengeId: uuid }, ['challengeId']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { challengeId: string };
    return enrollmentCommand(db, actor, enrollmentId, 'solution', input, async (client, context) => {
      const challenge = (await client.query<{ assessment_id: string; attempt_id: string | null }>('SELECT assessment_id,attempt_id FROM assessment_challenges WHERE id=$1 AND enrollment_id=$2', [input.challengeId, enrollmentId])).rows[0];
      requireCondition(challenge, 'CHALLENGE_NOT_FOUND', 404);
      requireCondition(!challenge.attempt_id, 'CHALLENGE_ALREADY_SUBMITTED', 409);
      const assessment = findAssessment(context.release.server_bundle, challenge.assessment_id)!, explanation = explanationOf(assessment);
      requireCondition(DETERMINISTIC_ITEM_TYPES.has(assessment.type) && explanation !== undefined, 'EVALUATOR_NOT_CONFIGURED', 409);
      await client.query("UPDATE assessment_challenges SET assistance='solution',independent_eligible=false WHERE id=$1", [input.challengeId]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'assessment.assisted', payload: { challengeId: input.challengeId, assistance: 'solution', independentEligible: false }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { explanation, independentEligible: false, revision: context.enrollment.revision + 1 };
    });
  });
  const answer = { anyOf: [{ type: 'string', maxLength: 64000 }, { type: 'number' },
    // Trace items: one short answer per step.
    { type: 'object', maxProperties: 100, propertyNames: { minLength: 1, maxLength: 200 }, additionalProperties: { type: 'string', maxLength: 2000 } }] };
  app.post(`${commandPath}/answers`, { schema: { params: enrollmentParams, body: commandSchema({ challengeId: uuid, answer, abstain: { const: true }, confidence: { type: 'integer', minimum: 1, maximum: 7 } }, ['challengeId']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as Input & { challengeId: string; answer?: unknown; abstain?: true; confidence?: number };
    // Exactly one of an answer or an explicit "I don't know".
    requireCondition((input.answer !== undefined) !== (input.abstain === true), 'INVALID_ANSWER');
    return enrollmentCommand(db, actor, enrollmentId, 'answer', input, async (client, context) => {
      const challenge = (await client.query<{ id: string; episode_id: string; assessment_id: string; mode: string; assistance: string; independent_eligible: boolean; attempt_id: string | null; course_digest: string; expires_at: Date }>('SELECT * FROM assessment_challenges WHERE id=$1 AND enrollment_id=$2 FOR UPDATE', [input.challengeId, enrollmentId])).rows[0];
      requireCondition(challenge, 'CHALLENGE_NOT_FOUND', 404);
      requireCondition(!challenge.attempt_id, 'CHALLENGE_ALREADY_SUBMITTED', 409);
      requireCondition(challenge.expires_at.getTime() > Date.now(), 'CHALLENGE_EXPIRED', 409);
      requireCondition(challenge.course_digest === context.release.digest, 'COURSE_VERSION_CHANGED', 409);
      const course = context.release.server_bundle;
      if (challenge.mode !== 'placement') requireAvailable(course, context.release.digest, context.progress, context.evidence, challenge.episode_id);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, challenge.episode_id), 'submit', new Date().toISOString());
      const assessment = findAssessment(course, challenge.assessment_id)!;
      // Confidence is optional, only on items that declare it, and never part of grading.
      if (input.confidence !== undefined) requireCondition(assessment.confidence && input.confidence <= assessment.confidence.scale.maximum, 'INVALID_CONFIDENCE');
      const confidence = input.confidence ?? null;
      const independent = challenge.independent_eligible && challenge.assistance === 'none', attemptId = randomUUID();
      const finish = async (payload: Record<string, unknown>, result: Record<string, unknown>) => {
        await client.query('UPDATE assessment_challenges SET attempt_id=$2 WHERE id=$1', [challenge.id, attemptId]);
        await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
        await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'assessment.submitted', payload: { attemptId, assessmentId: assessment.id, independent, ...payload }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
        const updated = await loadEnrollment(client, actor, enrollmentId);
        if (challenge.mode !== 'retention' && challenge.mode !== 'placement') await refreshDecisionsForItem(client, updated, assessment.id);
        return { result: { ...result, independent }, state: await enrollmentState(client, updated) };
      };
      const insertAttempt = (response: unknown, result: unknown) => client.query(
        `INSERT INTO attempts (id,enrollment_id,assessment_id,course_digest,family_id,mode,assistance,response,result,idempotency_key,confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [attemptId, enrollmentId, assessment.id, context.release.digest, assessment.familyId, challenge.mode, challenge.assistance, JSON.stringify(response), JSON.stringify(result), input.idempotencyKey, confidence]);
      if (input.abstain) {
        // "I don't know" is recorded honestly: no evidence row, no failed evidence, no credit.
        requireCondition(assessment.allowAbstain !== false, 'ABSTAIN_NOT_ALLOWED', 409);
        const explanation = explanationOf(assessment) ?? 'Nothing was recorded against you. A reviewer or the companion can help you prepare for a fresh check.';
        await insertAttempt(null, { status: 'abstained', abstained: true, passed: false, evaluator: 'abstain@1', independentEligible: independent });
        // A held-out retention check answered "I don't know" schedules a review; it is not a failed result.
        if (challenge.mode === 'retention') await recordRetentionOutcome(client, context, attemptId, assessment.objectiveIds, false, independent, clock.now());
        // Teaching signal only (T7): "I don't know" is never a misconception.
        await recordAnswerSignal(client, context, { attemptId, assessment, answer: null, passed: false, independent, mode: challenge.mode, confidence, abstained: true });
        return finish({ abstained: true }, { passed: false, abstained: true, explanation });
      }
      const rubric = reviewedRubric(course, assessment.id);
      if (rubric) {
        // A written explanation earns nothing until an authorized reviewer cites it.
        requireCondition(typeof input.answer === 'string' && input.answer.trim().length >= RUBRIC_RESPONSE_LIMITS.min && input.answer.length <= RUBRIC_RESPONSE_LIMITS.max, 'INVALID_ANSWER');
        requireCondition(!(await agentAuthored(client, enrollmentId, input.answer)), 'AGENT_AUTHORED_ANSWER', 409);
        const pending = { status: 'pending_review', passed: false, evaluator: 'reviewed-rubric@1', rubricDigest: rubricDigest(rubric), independentEligible: independent,
          ...(rubric.conversationGateId ? { conversation: { gateId: rubric.conversationGateId, rubricId: rubric.rubricRef!.id, rubricVersion: rubric.rubricRef!.version } } : {}) };
        await insertAttempt(input.answer, pending);
        return finish({ pendingReview: true }, { passed: false, pendingReview: true, explanation: 'Submitted for review against the rubric. It counts only after a reviewer cites your answer for every required criterion.' });
      }
      const code = codeView(course, assessment);
      const result = code ? await qualifiedCodeEvaluator(code, course.extensions, installed)(code, input.answer) : gradeDeterministic(assessment, input.answer);
      await insertAttempt(input.answer, result);
      for (const objectiveId of assessment.objectiveIds) await client.query(`INSERT INTO evidence (id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), enrollmentId, attemptId, objectiveId, result.evaluator, JSON.stringify({ passed: result.passed }), independent]);
      if (challenge.mode === 'retention') await recordRetentionOutcome(client, context, attemptId, assessment.objectiveIds, result.passed, independent, clock.now());
      // Teaching signal only: hypotheses and recommendations never change evidence.
      await recordAnswerSignal(client, context, { attemptId, assessment, answer: input.answer, passed: result.passed, independent, mode: challenge.mode, confidence });
      return finish({ passed: result.passed }, result as unknown as Record<string, unknown>);
    });
  });
  app.post(`${commandPath}/complete`, { schema: { params: enrollmentParams, body: commandSchema({ episodeId: id, placement: { type: 'boolean' }, gateDecisionId: uuid }, ['episodeId']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Input & { episodeId: string; placement?: boolean; gateDecisionId?: string };
    // Record the current decision first, so a refusal below still leaves the decision it was based on.
    if (!input.placement) await transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, true);
      if (episodes(context.release.server_bundle).some(e => e.id === input.episodeId && e.gateId) && context.enrollment.revision === input.expectedRevision) await refreshGateDecision(client, context, input.episodeId);
    }).catch(() => undefined);
    return enrollmentCommand(db, actor, enrollmentId, 'complete', input, async (client, context) => {
      const course = context.release.server_bundle, episode = requireAvailable(course, context.release.digest, context.progress, context.evidence, input.episodeId);
      const gate = course.gates.find(row => row.id === episode.gateId);
      // Exemptions are applied only by accepting a finished placement run.
      if (input.placement) {
        await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'submit', new Date().toISOString());
        const decision = gate ? gateDecision(course, gate, context.evidence, context.release.digest, { placementOnly: true }) : null;
        if (gate && !decision?.passed) throw new ApiError(409, 'EVIDENCE_REQUIRED', 'EVIDENCE_REQUIRED', { missing: decision!.objectives.filter(o => !o.passed)
          .map(o => ({ objectiveId: o.id, independentFamilies: o.families.length, requiredFamilies: o.required })) });
        throw new ApiError(409, 'PLACEMENT_REQUIRES_RUN_ACCEPTANCE');
      }
      // Unversioned gates keep the 0.4 order (policy first); a versioned gate explains a reached cap as closed with gaps.
      const versioned = gate && 'version' in gate;
      if (!versioned) await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'submit', new Date().toISOString());
      const ready = gate ? await requireReadyDecision(client, context, episode.id, input.gateDecisionId) : null;
      if (versioned) await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'submit', new Date().toISOString());
      const progress = context.progress.find(row => row.episode_id === input.episodeId);
      // Optional personal additions never become required reading.
      const optional = optionalPersonalBlocks(context);
      const unread = episode.blocks.filter(block => block.type !== 'assessment' && block.type !== 'activity' && !optional.has(`${episode.id}/${block.id}`) && !progress?.completed_block_ids.includes(block.id)).map(block => block.id);
      if (unread.length) throw new ApiError(409, 'COVERAGE_REQUIRED', 'COVERAGE_REQUIRED', { unreadBlockIds: unread });
      requireCondition(!episode.blocks.some(block => block.type === 'activity'), 'ACTIVITY_EVIDENCE_REQUIRED', 409);
      const refs = ready?.computed.objectives.flatMap(row => row.evidenceIds) ?? [];
      const decisionId = ready?.record.decisionId ?? null;
      // A staff exception authorizes this completion only on the course version it was granted for.
      const exceptionId = ready?.exceptionId ?? null, exceptionDigest = exceptionId ? ready!.record.courseDigest : null;
      await client.query(`INSERT INTO episode_progress (enrollment_id,episode_id,state,evidence_refs,completed_at,gate_decision_id,gate_exception_id,exception_course_digest) VALUES ($1,$2,'completed',$3,now(),$4,$5,$6)
        ON CONFLICT (enrollment_id,episode_id) DO UPDATE SET state=EXCLUDED.state,evidence_refs=EXCLUDED.evidence_refs,completed_at=now(),gate_decision_id=EXCLUDED.gate_decision_id,
          gate_exception_id=EXCLUDED.gate_exception_id,exception_course_digest=EXCLUDED.exception_course_digest`, [enrollmentId, input.episodeId, JSON.stringify(refs), decisionId, exceptionId, exceptionDigest]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'episode.completed', payload: { episodeId: input.episodeId, evidenceIds: refs, ...(decisionId ? { gateDecisionId: decisionId } : {}), ...(exceptionId ? { gateExceptionId: exceptionId } : {}) }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      let snapshot = await enrollmentState(client, await loadEnrollment(client, actor, enrollmentId));
      if (snapshot.nextEpisodeId) {
        await activateWindows(client, course, enrollmentId, policyEpisodeId(context.release, snapshot.nextEpisodeId), new Date().toISOString(), 'scope_assigned');
        snapshot = await enrollmentState(client, await loadEnrollment(client, actor, enrollmentId));
      }
      if (snapshot.complete) {
        await closeCompletedCourse(client, await loadEnrollment(client, actor, enrollmentId));
        snapshot = await enrollmentState(client, await loadEnrollment(client, actor, enrollmentId));
      }
      return snapshot;
    });
  });
}
