import type { CourseManifest } from '@course-core/sdk';
import { ApiError } from './errors.js';
import type { Assessment } from '@course-core/sdk';
import type { CodeGrade } from './code-evaluator.js';
import type {TrustedAdaptationAdapter} from './adaptation-store.js';
import { coreObjectiveIds } from './learning.js';

export interface RuntimeExtension { id: string; version: string; integrity: string; capabilities: string[]; platforms: string[];
  adaptationAdapter?: TrustedAdaptationAdapter;
  validateVisual?: (visual: CourseManifest['visuals'][number]) => void;
  codeReady?: boolean; validateCodeAssessment?: (assessment: Assessment) => void; evaluateCode?: (assessment: Assessment, source: unknown) => Promise<CodeGrade>;
  rubricReady?: boolean; validateRubricAssessment?: (assessment: Assessment) => void }

/** Declarations describe what a course wants; only installed trusted adapters supply it. */
export function assertCourseRunnable(course: CourseManifest, installed: RuntimeExtension[] = []) {
  if (!coreObjectiveIds(course).length) throw new ApiError(409, 'COURSE_REQUIRED_PATH_MISSING');
  const requireAdapter = (id: string, capability?: string) => {
    const declaration = course.extensions.find(row => row.id === id), adapter = installed.find(row => row.id === id);
    if (!declaration || !adapter || declaration.version !== adapter.version || declaration.integrity !== adapter.integrity
      || !adapter.platforms.includes('web') || (capability && !adapter.capabilities.includes(capability))) throw new ApiError(409, 'PUBLISH_CAPABILITY_MISSING');
    return adapter;
  };
  const required = new Set(course.gates.flatMap(gate => gate.assessmentIds));
  for (const chapter of course.chapters) for (const episode of chapter.episodes) for (const block of episode.blocks) {
    if (block.type === 'assessment') required.add(block.assessmentId);
    // Runtime activity/evaluator execution is a separate integration gate. A declared
    // capability string cannot substitute for an implemented, qualified handler.
    if (block.type === 'activity') throw new ApiError(409, 'PUBLISH_ACTIVITY_RUNTIME_UNAVAILABLE');
    if (block.type === 'visual') {
      const visual = course.visuals.find(visual => visual.id === block.visualId)!, adapter = requireAdapter(visual.rendererId);
      if (!adapter.validateVisual) throw new ApiError(409, 'PUBLISH_VISUAL_VALIDATOR_MISSING');
      try { adapter.validateVisual(visual); } catch { throw new ApiError(409, 'PUBLISH_VISUAL_INVALID'); }
    }
  }
  for (const assessment of course.assessments) if (required.has(assessment.id) && (assessment.type === 'code' || assessment.type === 'rubric')) {
    const adapter = requireAdapter(assessment.grading.evaluatorId, 'assessment.evaluate');
    if (assessment.type === 'rubric') {
      if (!adapter.rubricReady || !adapter.validateRubricAssessment) throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
      adapter.validateRubricAssessment(assessment);
      continue;
    }
    if (!adapter.codeReady || !adapter.evaluateCode || !adapter.validateCodeAssessment) throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
    adapter.validateCodeAssessment(assessment);
  }
  for (const gate of course.gates) if (gate.conversationalEvaluatorId) throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
}
