import { createHash } from 'node:crypto';
import type { Assessment } from '@course-core/sdk';
import { ApiError } from './errors.js';
import type { RuntimeExtension } from './publication.js';
import { digestJson } from './repository.js';

export const RUBRIC_EVALUATOR_ID = 'course-core-reviewed-rubric';
export const RUBRIC_EVALUATOR_VERSION = '1.0.0';
export const RUBRIC_RESPONSE_LIMITS = { min: 20, max: 8000 } as const;
/** The protocol a course declares when it wants human-reviewed written answers. */
const descriptor = JSON.stringify({
  id: RUBRIC_EVALUATOR_ID, version: RUBRIC_EVALUATOR_VERSION, protocol: 'reviewed-rubric-v1',
  evidence: 'issued only after an authorized reviewer cites the learner response for every required criterion',
  response: RUBRIC_RESPONSE_LIMITS,
});
export const RUBRIC_EVALUATOR_INTEGRITY = 'sha256-' + createHash('sha256').update(descriptor).digest('hex');
type Rubric = Extract<Assessment, { type: 'rubric' }>;
export function validateRubricAssessment(assessment: Assessment) {
  if (assessment.type !== 'rubric') throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
  const rubric = assessment.grading.rubric;
  if (!rubric.length || rubric.length > 12 || !rubric.some(c => c.required) || new Set(rubric.map(c => c.id)).size !== rubric.length
    || rubric.some(c => !c.description.trim() || c.description.length > 500)) throw new ApiError(409, 'PUBLISH_RUBRIC_INVALID');
}
export const rubricDigest = (assessment: Rubric) => digestJson({ id: assessment.id, prompt: assessment.prompt, rubric: assessment.grading.rubric });
export function reviewedRubricEvaluator(): RuntimeExtension {
  return { id: RUBRIC_EVALUATOR_ID, version: RUBRIC_EVALUATOR_VERSION, integrity: RUBRIC_EVALUATOR_INTEGRITY,
    capabilities: ['assessment.evaluate'], platforms: ['web'], rubricReady: true, validateRubricAssessment };
}
