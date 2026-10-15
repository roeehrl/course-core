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

it('refuses a conversational gate precisely, even when the named evaluator is installed', () => {
  const course = fixture();
  const declaration = { id: 'talker', version: '1.0.0', integrity: 'c'.repeat(64), platforms: ['web' as const], execution: 'server' as const,
    entrypoint: 'talker.js', capabilities: ['assessment.evaluate'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Conversation' } };
  course.extensions.push(declaration);
  const gate = legacyGate(course.gates[1]);
  gate.conversationalEvaluatorId = 'talker';
  const adapter = { id: 'talker', version: '1.0.0', integrity: declaration.integrity, platforms: ['web'], capabilities: ['assessment.evaluate'], rubricReady: true, validateRubricAssessment: () => {} };
  let error: unknown;
  try { assertCourseRunnable(course, [adapter]); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ statusCode: 409, code: 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED', details: { gateIds: ['max-gate'], supported: 'rubric_assessment' } });
  delete gate.conversationalEvaluatorId;
  expect(() => assertCourseRunnable(course, [adapter])).not.toThrow();
});
