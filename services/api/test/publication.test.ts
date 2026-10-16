import { expect, it } from 'vitest';
import { assertCourseRunnable } from '../src/publication.js';
import { fixture } from './fixture.js';
import { legacyGate } from './legacy-gate.js';

it('refuses a mandatory evaluator declared by the course but not installed by the host', () => {
  const course = fixture();
  const declaration = { id: 'grader', version: '1.0.0', integrity: 'a'.repeat(64), platforms: ['web' as const], execution: 'server' as const,
    entrypoint: 'grader.js', capabilities: ['assessment.evaluate'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Graded response' } };
  course.extensions.push(declaration);
  course.assessments[0] = { id: 'min-a', familyId: 'compare', objectiveIds: ['minimum'], type: 'rubric', prompt: 'Explain your comparison.', grading: { evaluatorId: 'grader', rubric: [{ id: 'claim', description: 'Correct ordering', required: true }] } };
  expect(() => assertCourseRunnable(course)).toThrowError(/PUBLISH_CAPABILITY_MISSING/);
  const adapter = { id: 'grader', version: '1.0.0', integrity: declaration.integrity, platforms: ['web'], capabilities: ['assessment.evaluate'] };
  expect(() => assertCourseRunnable(course, [{ ...adapter, integrity: 'b'.repeat(64) }])).toThrow();
  expect(() => assertCourseRunnable(course, [{ ...adapter, capabilities: [] }])).toThrow();
  expect(() => assertCourseRunnable(course, [adapter])).toThrowError(/PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE/);
});

it('supports ordinary courses without any domain-specific adapters', () => {
  expect(() => assertCourseRunnable(fixture())).not.toThrow();
});

/** A 0.4 gate judged in conversation: its evaluator definition names exactly one cited rubric. */
function conversationalLegacy(method: 'human' | 'deterministic' = 'human') {
  const course = fixture();
  const declaration = { id: 'talker', version: '1.0.0', integrity: 'c'.repeat(64), platforms: ['web' as const], execution: 'server' as const,
    entrypoint: 'talker.js', capabilities: ['assessment.evaluate'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Conversation' } };
  course.extensions.push(declaration);
  course.rubrics = [{ id: 'explain-max', version: '1.0.0', title: 'Explaining a maximum', requiresCitedEvidence: true, uncertain: 'pending_review',
    criteria: [{ id: 'invariant', description: 'States that the kept value is never smaller than any value seen.', required: true, evidence: 'cited_learner_span' }] }];
  course.evaluators = [{ id: 'conversation', version: '1.0.0', extensionId: 'talker', method, itemTypes: ['rubric'], rubricIds: ['explain-max'],
    humanConfirmation: method === 'human' ? 'required' : 'none', outputs: { uncertainty: true, provenance: true },
    tests: { fixtureRef: 'fixtures/conversation.json', acceptsValidVariants: true, rejectsMisconceptions: true } }];
  const gate = legacyGate(course.gates[1]);
  gate.conversationalEvaluatorId = 'conversation';
  const adapter = { id: 'talker', version: '1.0.0', integrity: declaration.integrity, platforms: ['web'], capabilities: ['assessment.evaluate'], rubricReady: true, validateRubricAssessment: () => {} };
  return { course, gate, adapter };
}
const refusal = (run: () => void) => { try { run(); } catch (caught) { return caught; } return undefined; };

it('refuses a 0.4 conversational gate whose evaluator names no rubric to cite, whatever is installed', () => {
  const { course, gate, adapter } = conversationalLegacy();
  gate.conversationalEvaluatorId = 'talker';
  expect(refusal(() => assertCourseRunnable(course, [adapter]))).toMatchObject({ statusCode: 409, code: 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED',
    details: { gateIds: ['max-gate'], supported: 'evaluator_definition_with_one_rubric' } });
  // An evaluator definition bound to two rubrics does not say which one the conversation cites.
  gate.conversationalEvaluatorId = 'conversation';
  course.evaluators![0]!.rubricIds = ['explain-max', 'explain-max-2'];
  expect(refusal(() => assertCourseRunnable(course, [adapter]))).toMatchObject({ code: 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED' });
  delete gate.conversationalEvaluatorId;
  expect(() => assertCourseRunnable(course, [adapter])).not.toThrow();
});

it('publishes a 0.4 conversational gate judged against one cited rubric by a human-confirmed evaluator', () => {
  const { course, adapter } = conversationalLegacy();
  expect(() => assertCourseRunnable(course, [adapter])).not.toThrow();
  // The installed reviewer must accept the synthesized conversation item.
  expect(refusal(() => assertCourseRunnable(course, [{ ...adapter, validateRubricAssessment: () => { throw new Error('rejected'); } }]))).toBeInstanceOf(Error);
  expect(refusal(() => assertCourseRunnable(course, [{ ...adapter, rubricReady: false }]))).toMatchObject({ code: 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE' });
});

it('refuses a 0.4 conversational gate that would accept an impression, or whose families cannot be reached', () => {
  const uncited = conversationalLegacy();
  uncited.course.rubrics![0]!.requiresCitedEvidence = false;
  expect(refusal(() => assertCourseRunnable(uncited.course, [uncited.adapter]))).toMatchObject({ code: 'PUBLISH_CONVERSATION_RUBRIC_UNSUPPORTED' });
  // A model-assisted evaluator that a human confirms only when the model is unsure would let a model decide alone.
  const unconfirmed = conversationalLegacy();
  Object.assign(unconfirmed.course.evaluators![0]!, { method: 'rubric_model_assisted', humanConfirmation: 'on_uncertain' });
  expect(refusal(() => assertCourseRunnable(unconfirmed.course, [unconfirmed.adapter]))).toMatchObject({ code: 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED' });
  // Three families: the conversation and the two listed items' families are all there is.
  const short = conversationalLegacy();
  short.gate.minimumIndependentFamilies = 4;
  expect(refusal(() => assertCourseRunnable(short.course, [short.adapter]))).toMatchObject({ code: 'PUBLISH_GATE_EVIDENCE_UNREACHABLE', details: { gateId: 'max-gate' } });
  short.gate.minimumIndependentFamilies = 3;
  expect(() => assertCourseRunnable(short.course, [short.adapter])).not.toThrow();
});

it('publishes a deterministic conversation evaluator only when its installed adapter confirms quoted findings', () => {
  const { course, adapter } = conversationalLegacy('deterministic');
  expect(refusal(() => assertCourseRunnable(course, [adapter]))).toMatchObject({ code: 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE' });
  expect(() => assertCourseRunnable(course, [{ ...adapter, confirmConversationFindings: () => [] }])).not.toThrow();
});
