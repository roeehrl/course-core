import { createHash } from 'node:crypto';
import type { ActivityDefinition, Assessment, CourseManifest } from '@course-core/sdk';
import { ApiError } from './errors.js';
import { gradeDeterministic } from './learning.js';
import { parseDeclarative, type ActivityEvaluation, type ActivityEvaluatorPort, type DeclarativeControl } from './activity-runtime.js';
import type { RuntimeExtension } from './publication.js';

/**
 * Core's built-in, data-only checker for declarative activities (the controls Core's own
 * interpreter renders). It runs no course code: a course uses it by declaring it, the way a
 * course declares Core's declarative runtime, and needs no host installation.
 *
 * The key is the course's own server-only assessment items, graded exactly as Core grades them
 * as questions: control `<controlId>` of activity `<activityId>` is checked by the item with id
 * `<activityId>.<controlId>` (a numeric item for a number control, a choice item whose correct
 * option is one of the control's options for a choice control). Toggles are not checked. Every
 * checked control must match for a pass. The key never goes into block configuration, which the
 * learner receives.
 *
 * Feedback is an admin setting, not part of the key: when the admin section whose id is the
 * evaluator definition's id has the boolean setting `show-mismatched-controls` set (course,
 * chapter or enrollment scope), a result that did not pass names the author's labels of the
 * controls that did not match. It never changes a verdict.
 */
export const DECLARATIVE_EVALUATOR_ID = 'course-core-declarative-evaluator';
export const DECLARATIVE_EVALUATOR_VERSION = '1.0.0';
export const SHOW_MISMATCHES_SETTING = 'show-mismatched-controls';
const descriptor = JSON.stringify({
  id: DECLARATIVE_EVALUATOR_ID, version: DECLARATIVE_EVALUATOR_VERSION, protocol: 'declarative-controls-check-v1', method: 'deterministic',
  key: 'assessment <activityId>.<controlId>: numeric for number controls, choice for choice controls',
  feedback: { adminSection: 'id of the evaluator definition', setting: `${SHOW_MISMATCHES_SETTING} (boolean)` },
  result: 'passed when every checked control matches; objectives are the activity objectives',
});
export const DECLARATIVE_EVALUATOR_INTEGRITY = 'sha256-' + createHash('sha256').update(descriptor).digest('hex');

const refuse = (reason: string, details: Record<string, string> = {}) =>
  new ApiError(409, 'PUBLISH_EVALUATOR_CONFIGURATION_INVALID', 'PUBLISH_EVALUATOR_CONFIGURATION_INVALID', { reason, ...details });
const keyId = (activity: ActivityDefinition, control: DeclarativeControl) => `${activity.id}.${control.id}`;

/** The item that checks a control, when its type fits the control; undefined when none is declared. */
function keyItem(course: CourseManifest, activity: ActivityDefinition, control: DeclarativeControl): Assessment | null | undefined {
  const item = course.assessments.find(row => row.id === keyId(activity, control));
  if (!item) return undefined;
  const fits = control.kind === 'number' ? item.type === 'numeric'
    : control.kind === 'choice' ? item.type === 'choice' && control.options.some(option => option.id === item.grading.correctOptionId) : false;
  return fits && item.objectiveIds.every(o => activity.objectiveIds.includes(o)) ? item : null;
}

export function declarativeActivityEvaluator(): RuntimeExtension {
  const evaluator: ActivityEvaluatorPort = {
    validateActivity({ course, activity, configuration, evaluatorId }) {
      if (!evaluatorId) throw refuse('evaluator_definition_required');
      const parsed = activity.executionAdapter === 'declarative' ? parseDeclarative(configuration) : null;
      if (!parsed) throw refuse('declarative_activity_required');
      let checked = 0;
      for (const control of parsed.controls) {
        const item = keyItem(course, activity, control);
        if (item === null) throw refuse('key_item_mismatch', { assessmentId: keyId(activity, control) });
        if (item) checked++;
      }
      if (!checked) throw refuse('key_item_missing');
      const feedback = course.adminSections?.find(row => row.id === evaluatorId)?.settings.find(row => row.id === SHOW_MISMATCHES_SETTING);
      if (feedback && feedback.type !== 'boolean') throw refuse('feedback_setting_invalid', { settingId: SHOW_MISMATCHES_SETTING });
    },
    async evaluate({ activity, configuration, observation, evaluatorId, settings, course }): Promise<ActivityEvaluation> {
      const parsed = parseDeclarative(configuration);
      if (!parsed || !course) throw new Error('declarative evaluator key unavailable');
      const submitted = (observation.values ?? {}) as Record<string, unknown>, mismatched: string[] = [];
      let checked = 0;
      for (const control of parsed.controls) {
        const item = keyItem(course, activity, control);
        // Unavailable rather than failed: a missing key is the course's problem, not the learner's.
        if (item === null) throw new Error('declarative evaluator key unavailable');
        if (!item) continue;
        checked++;
        let passed = false;
        try { passed = gradeDeterministic(item, submitted[control.id]).passed; } catch { passed = false; }
        if (!passed) mismatched.push(control.label);
      }
      if (!checked) throw new Error('declarative evaluator key unavailable');
      const values = evaluatorId && settings ? await settings(evaluatorId) : null;
      const show = mismatched.length > 0 && values?.[SHOW_MISMATCHES_SETTING] === true;
      // The author's own control labels, in the course's language; never the expected values.
      return { passed: mismatched.length === 0, objectiveIds: [...activity.objectiveIds], ...(show ? { explanation: mismatched.join(' · ') } : {}) };
    },
  };
  return { id: DECLARATIVE_EVALUATOR_ID, version: DECLARATIVE_EVALUATOR_VERSION, integrity: DECLARATIVE_EVALUATOR_INTEGRITY,
    capabilities: ['assessment.evaluate'], platforms: ['web'], activityEvaluator: evaluator };
}
