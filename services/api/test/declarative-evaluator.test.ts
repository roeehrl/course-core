import { describe, expect, it } from 'vitest';
import type { AdminSection, Assessment, CourseManifest } from '@course-core/sdk';
import { validateCourse } from '@course-core/sdk';
import { compileCourse } from '@course-core/sdk/compiler';
import { assertCourseRunnable } from '../src/publication.js';
import { declarativeActivityRuntime, type AdminSettingValues } from '../src/activity-runtime.js';
import { DECLARATIVE_EVALUATOR_ID, DECLARATIVE_EVALUATOR_INTEGRITY, DECLARATIVE_EVALUATOR_VERSION, declarativeActivityEvaluator } from '../src/declarative-evaluator.js';
import { activityCourse, activityDefinition, declarativeConfiguration } from './activity-fixture.js';

// Core's built-in, data-only activity checker: keyed by the course's own server-only items, with
// an admin setting that only controls feedback, so a course needs no host-installed evaluator.
const EVALUATOR = 'smaller-value-check';
const installed = () => [declarativeActivityRuntime(), declarativeActivityEvaluator()];
const keyItem = (overrides: Partial<Assessment> = {}) => ({ id: 'min-explore.value', type: 'numeric', objectiveIds: ['minimum'], familyId: 'explore', prompt: 'Smaller of 4 and 9',
  grading: { expected: 4, absoluteTolerance: 0.5, explanation: '4 is below 9.' }, ...overrides }) as Assessment;
const feedbackSection: AdminSection = { id: EVALUATOR, version: '1.0.0', title: 'Activity feedback', requiredPermissions: ['course.read', 'course.settings.write'], learnerDataAccess: 'none', audit: 'all_mutations',
  settings: [{ id: 'show-mismatched-controls', label: 'Name the values that were off', scope: 'enrollment', mutationPermission: 'course.settings.write', type: 'boolean', default: false }] };
function course(items: Assessment[] = [keyItem()], section: AdminSection | null = feedbackSection): CourseManifest {
  const value = activityCourse(activityDefinition({ evaluatorRef: EVALUATOR }));
  // Declared exactly as any course declares it: the advertised id, version and integrity.
  value.extensions = value.extensions.filter(row => row.execution !== 'server');
  value.extensions.push({ id: DECLARATIVE_EVALUATOR_ID, version: DECLARATIVE_EVALUATOR_VERSION, integrity: DECLARATIVE_EVALUATOR_INTEGRITY, execution: 'server',
    entrypoint: 'core/declarative-controls-check-v1', platforms: ['web'], capabilities: ['assessment.evaluate'],
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Checks submitted control values.' } });
  value.evaluators = [{ id: EVALUATOR, version: '1.0.0', extensionId: DECLARATIVE_EVALUATOR_ID, method: 'deterministic', itemTypes: ['numeric', 'choice'], humanConfirmation: 'none',
    outputs: { uncertainty: true, provenance: true }, tests: { fixtureRef: 'checks/smaller-value.json', acceptsValidVariants: true, rejectsMisconceptions: true } }];
  value.assessments.push(...items);
  if (section) value.adminSections = [section];
  return value;
}
function refusal(run: () => void) {
  try { run(); } catch (error) { return error as { code: string; details?: Record<string, unknown> }; }
  return null;
}
const evaluate = (values: Record<string, unknown>, settings: AdminSettingValues | null = null, manifest = course()) =>
  declarativeActivityEvaluator().activityEvaluator!.evaluate({ activity: manifest.activities![0]!, configuration: declarativeConfiguration() as never,
    observation: { kind: 'submitted', values } as never, state: {}, course: manifest, evaluatorId: EVALUATOR, settings: async id => (id === EVALUATOR ? settings : null) });

describe('Core declarative activity evaluator', () => {
  it('is a valid SDK course that publishes on Core with no host-installed evaluator', () => {
    expect(validateCourse(course()).issues).toEqual([]);
    expect(() => assertCourseRunnable(course(), installed())).not.toThrow();
    // Without the built-in checker, the same course is refused as before.
    expect(refusal(() => assertCourseRunnable(course(), [declarativeActivityRuntime()]))?.code).toBe('PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
  });
  it('keeps the key out of everything the learner receives', () => {
    const learner = compileCourse(course()).learner, text = JSON.stringify(learner);
    expect(text).not.toContain('Smaller of 4 and 9');
    expect(text).not.toContain('"expected"');
    expect(text).not.toContain('show-mismatched-controls');
  });
  it('grades with the item key and tolerance, exactly as the question would be graded', async () => {
    expect(await evaluate({ value: 4, sure: true })).toEqual({ passed: true, objectiveIds: ['minimum'] });
    expect(await evaluate({ value: 4, sure: false })).toEqual({ passed: true, objectiveIds: ['minimum'] });
    expect((await evaluate({ value: 5, sure: true })).passed).toBe(false);
    expect((await evaluate({ value: '4', sure: true })).passed).toBe(false);
    expect((await evaluate({ sure: true })).passed).toBe(false);
  });
  it('names mismatched controls only when staff turned the feedback setting on, never changing the verdict', async () => {
    expect(await evaluate({ value: 5, sure: true }, { 'show-mismatched-controls': false })).toEqual({ passed: false, objectiveIds: ['minimum'] });
    expect(await evaluate({ value: 5, sure: true }, { 'show-mismatched-controls': true })).toEqual({ passed: false, objectiveIds: ['minimum'], explanation: 'Smaller value' });
    expect(await evaluate({ value: 4, sure: true }, { 'show-mismatched-controls': true })).toEqual({ passed: true, objectiveIds: ['minimum'] });
    // Without the section the checker still grades.
    expect((await evaluate({ value: 4, sure: true }, null, course([keyItem()], null))).passed).toBe(true);
  });
  it('reports no verdict, never a fail, when the key cannot be read', async () => {
    await expect(evaluate({ value: 4, sure: true }, null, course([]))).rejects.toThrow();
  });
  it('refuses declarations it could not apply, naming the problem', () => {
    const expectRefusal = (manifest: CourseManifest, reason: string) =>
      expect(refusal(() => assertCourseRunnable(manifest, installed()))).toMatchObject({ code: 'PUBLISH_EVALUATOR_CONFIGURATION_INVALID', details: { activityId: 'min-explore', reason } });
    expectRefusal(course([]), 'key_item_missing');
    expectRefusal(course([keyItem({ type: 'choice', options: [{ id: 'four', text: '4' }, { id: 'nine', text: '9' }], grading: { correctOptionId: 'four', explanation: 'x' } } as never)]), 'key_item_mismatch');
    expectRefusal(course([keyItem({ objectiveIds: ['maximum'] })]), 'key_item_mismatch');
    expectRefusal(course([keyItem()], { ...feedbackSection, settings: [{ id: 'show-mismatched-controls', label: 'x', scope: 'course', mutationPermission: 'course.settings.write', type: 'integer', default: 1, minimum: 0, maximum: 1 }] }), 'feedback_setting_invalid');
    const bare = course();
    bare.activities![0]!.evaluatorRef = DECLARATIVE_EVALUATOR_ID;
    delete bare.evaluators;
    expectRefusal(bare, 'evaluator_definition_required');
  });
});
