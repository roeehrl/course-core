import type { CourseManifest, VersionedProgressionGate } from '@course-core/sdk';
import { gateAssessmentIds, isVersionedGate, RECOGNITION_TYPES } from '@course-core/sdk';
import { ApiError } from './errors.js';
import { codeView, conversationEvaluator, conversationItemId, DETERMINISTIC_ITEM_TYPES, evaluatorExtensionId, findAssessment, reviewedRubric, reviewedRubricItem,
  RUBRIC_PRODUCTION_TYPES, type RubricItem } from './gates.js';
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
  // The SDK still accepts an unversioned gate's conversationalEvaluatorId, which names no rubric
  // to cite, so such a gate could never be decided. Refuse it precisely, whatever is installed.
  // Conversational evidence is supported on versioned gates through conversationalRubricRef
  // (quoted human review, see below), and a rubric assessment remains supported in any gate.
  const conversational = course.gates.filter(gate => !isVersionedGate(gate) && gate.conversationalEvaluatorId).map(gate => gate.id);
  if (conversational.length) throw new ApiError(409, 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED', 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED',
    { gateIds: conversational, supported: 'rubric_assessment_or_versioned_conversational_rubric' });
  const requireAdapter = (id: string, capability?: string) => {
    const declaration = course.extensions.find(row => row.id === id), adapter = installed.find(row => row.id === id);
    if (!declaration || !adapter || !declarationMatchesInstalled(declaration, adapter)
      || !adapter.platforms.includes('web') || (capability && !adapter.capabilities.includes(capability))) throw new ApiError(409, 'PUBLISH_CAPABILITY_MISSING');
    return adapter;
  };
  const required = new Set(course.gates.flatMap(gate => gateAssessmentIds(gate)));
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
  const requireReviewer = (extensionId: string, item: RubricItem) => {
    const adapter = requireAdapter(extensionId, 'assessment.evaluate');
    if (!adapter.rubricReady || !adapter.validateRubricAssessment) throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
    adapter.validateRubricAssessment(item);
  };
  for (const assessment of course.assessments) {
    if (!required.has(assessment.id)) continue;
    if (assessment.type === 'rubric') requireReviewer(evaluatorExtensionId(course, assessment.grading.evaluatorId), assessment);
    else if (RUBRIC_PRODUCTION_TYPES.has(assessment.type)) {
      // Core's reviewed-rubric protocol confirms criteria only with quoted learner words.
      const rubric = course.rubrics?.find(r => 'rubricId' in assessment.grading && r.id === assessment.grading.rubricId), view = reviewedRubric(course, assessment.id);
      if (!rubric || !view || rubric.criteria.some(c => c.evidence !== 'cited_learner_span')) throw new ApiError(409, 'PUBLISH_RUBRIC_EVIDENCE_UNSUPPORTED');
      requireReviewer(view.evaluatorExtensionId, reviewedRubricItem(view));
    } else if (assessment.type === 'code' || assessment.type === 'code_repair') {
      const view = codeView(course, assessment)!, adapter = requireAdapter(view.grading.evaluatorId, 'assessment.evaluate');
      if (!adapter.codeReady || !adapter.evaluateCode || !adapter.validateCodeAssessment) throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
      adapter.validateCodeAssessment(view);
    } else if (!DETERMINISTIC_ITEM_TYPES.has(assessment.type)) throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
  }
  for (const gate of course.gates) {
    if (!isVersionedGate(gate)) continue;
    assertVersionedGateRules(course, gate);
    if (gate.conversationalRubricRef) {
      const rubric = course.rubrics?.find(r => r.id === gate.conversationalRubricRef), evaluator = rubric && conversationEvaluator(course, rubric.id);
      // Model impressions are not evidence: the rubric must require quotes and a human must confirm every judgment.
      if (!rubric?.requiresCitedEvidence || !evaluator || !gate.eligibleEvidenceKinds.some(k => k === 'rubric_backed_conversation' || k === 'configured_combination'))
        throw new ApiError(409, 'PUBLISH_CONVERSATION_RUBRIC_UNSUPPORTED');
      const item = findAssessment(course, conversationItemId(gate.id));
      requireReviewer(evaluator.extensionId, item as RubricItem);
    }
  }
}

/** Assessment rules for versioned gates, enforced again here although the SDK validates them at
 * import: recognition alone cannot pass, transfer evidence must be collectable, and declared
 * critical misconceptions must be checked by a criterion and an item that can expose them. */
export function assertVersionedGateRules(course: CourseManifest, gate: VersionedProgressionGate) {
  const items = gateAssessmentIds(gate).map(id => course.assessments.find(a => a.id === id)).filter(item => item !== undefined);
  const conversation = gate.conversationalRubricRef ? 1 : 0;
  if (!conversation && items.every(item => RECOGNITION_TYPES.has(item.type))) throw new ApiError(409, 'PUBLISH_RECOGNITION_ONLY_GATE', 'PUBLISH_RECOGNITION_ONLY_GATE', { gateId: gate.id });
  const transfer = items.filter(item => item.role === 'transfer' && !RECOGNITION_TYPES.has(item.type)).length + conversation;
  if (!gate.readinessCriteria.some(c => c.kind === 'transfer_success') || gate.minimumIndependentEvidence.transferItems < 1 || transfer < gate.minimumIndependentEvidence.transferItems)
    throw new ApiError(409, 'PUBLISH_TRANSFER_EVIDENCE_REQUIRED', 'PUBLISH_TRANSFER_EVIDENCE_REQUIRED', { gateId: gate.id });
  const critical = (course.hypotheses ?? []).filter(h => h.kind === 'misconception' && h.critical && h.objectiveIds.some(o => gate.requiredObjectives.includes(o)));
  const exposes = (id: string) => items.some(item => item.misconceptionIds?.includes(id) || (item.type === 'choice' && item.options.some(o => o.misconceptionId === id)));
  if (critical.length && (!gate.readinessCriteria.some(c => c.kind === 'no_critical_misconception') || critical.some(h => !exposes(h.id))))
    throw new ApiError(409, 'PUBLISH_MISCONCEPTION_CHECK_REQUIRED', 'PUBLISH_MISCONCEPTION_CHECK_REQUIRED', { gateId: gate.id });
}
