import type { CourseManifest } from '@course-core/sdk';
import { ApiError } from './errors.js';
import type { Assessment } from '@course-core/sdk';
import type { CodeGrade } from './code-evaluator.js';
import type {TrustedAdaptationAdapter} from './adaptation-store.js';
import { coreObjectiveIds } from './learning.js';
import { declarationMatchesInstalled, type BuildIdentity } from './extension-identity.js';

export interface RuntimeExtension { id: string; version: string; integrity: string; capabilities: string[]; platforms: string[];
  /** Reviewed prior builds (exact version + integrity) this installed adapter still serves. See extension-identity.ts. */
  acceptedPriorBuilds?: readonly BuildIdentity[];
  adaptationAdapter?: TrustedAdaptationAdapter;
  validateVisual?: (visual: CourseManifest['visuals'][number]) => void;
  /** Optional: runs validateVisual's work for these visuals ahead of time, off the event loop, so the
   * synchronous validateVisual can reuse passed results. Must never throw a verdict of its own. */
  prepareVisuals?: (visuals: readonly CourseManifest['visuals'][number][]) => Promise<void>;
  codeReady?: boolean; validateCodeAssessment?: (assessment: Assessment) => void; evaluateCode?: (assessment: Assessment, source: unknown) => Promise<CodeGrade>;
  rubricReady?: boolean; validateRubricAssessment?: (assessment: Assessment) => void }

/** Warms the installed renderers' visual checks for every visual block assertCourseRunnable will
 * check, in parallel and off the event loop. It decides nothing: assertCourseRunnable still runs
 * every check, reusing results only for identical bytes that passed on this installed build. */
export async function prepareCourseRunnable(course: CourseManifest, installed: RuntimeExtension[] = []) {
  const work = new Map<RuntimeExtension, CourseManifest['visuals'][number][]>();
  for (const chapter of course.chapters) for (const episode of chapter.episodes) for (const block of episode.blocks) {
    if (block.type !== 'visual') continue;
    const visual = course.visuals.find(row => row.id === block.visualId);
    const declaration = visual && course.extensions.find(row => row.id === visual.rendererId), adapter = visual && installed.find(row => row.id === visual.rendererId);
    if (!visual || !declaration || !adapter?.prepareVisuals || !declarationMatchesInstalled(declaration, adapter)) continue;
    work.set(adapter, [...(work.get(adapter) ?? []), visual]);
  }
  await Promise.all([...work].map(([adapter, visuals]) => adapter.prepareVisuals!(visuals).catch(() => undefined)));
}

/** Declarations describe what a course wants; only installed trusted adapters supply it. */
export function assertCourseRunnable(course: CourseManifest, installed: RuntimeExtension[] = []) {
  if (!coreObjectiveIds(course).length) throw new ApiError(409, 'COURSE_REQUIRED_PATH_MISSING');
  // The SDK accepts gate.conversationalEvaluatorId, but Core has no conversational gate
  // runtime yet, so such a gate could never be decided. Refuse it precisely, whatever is
  // installed, rather than publish a gate nobody can pass. A rubric assessment in the
  // gate's assessmentIds is the supported way to judge a written or conversational
  // answer (human review with quoted findings, including clarification replies).
  const conversational = course.gates.filter(gate => gate.conversationalEvaluatorId).map(gate => gate.id);
  if (conversational.length) throw new ApiError(409, 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED', 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED',
    { gateIds: conversational, supported: 'rubric_assessment' });
  const requireAdapter = (id: string, capability?: string) => {
    const declaration = course.extensions.find(row => row.id === id), adapter = installed.find(row => row.id === id);
    if (!declaration || !adapter || !declarationMatchesInstalled(declaration, adapter)
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
}
