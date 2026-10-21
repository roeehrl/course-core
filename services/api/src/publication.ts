import type { CourseManifest, LegacyProgressionGate, VersionedProgressionGate } from '@course-core/sdk';
import { gateAssessmentIds, isVersionedGate, RECOGNITION_TYPES } from '@course-core/sdk';
import { ApiError } from './errors.js';
import { codeView, confirmsDeterministically, conversationItemId, gateConversation, DETERMINISTIC_ITEM_TYPES, evaluatorExtensionId, findAssessment, reviewedRubric, reviewedRubricItem,
  RUBRIC_PRODUCTION_TYPES, type RubricItem } from './gates.js';
import type { Assessment } from '@course-core/sdk';
import type { CodeGrade } from './code-evaluator.js';
import type {TrustedAdaptationAdapter} from './adaptation-store.js';
import { coreObjectiveIds } from './learning.js';
import { declarationMatchesInstalled, type BuildIdentity } from './extension-identity.js';
import { assertActivitiesRunnable, type ActivityEvaluatorPort, type ActivityRuntimePort } from './activity-runtime.js';

export interface RuntimeExtension { id: string; version: string; integrity: string; capabilities: string[]; platforms: string[];
  /** Other exact (version + integrity) declarations this installed adapter serves. See extension-identity.ts. */
  acceptedPriorBuilds?: readonly BuildIdentity[];
  adaptationAdapter?: TrustedAdaptationAdapter;
  validateVisual?: (visual: CourseManifest['visuals'][number]) => void;
  /** Optional: runs validateVisual's work for these visuals ahead of time, off the event loop, so the
   * synchronous validateVisual can reuse passed results. Must never throw a verdict of its own. */
  prepareVisuals?: (visuals: readonly CourseManifest['visuals'][number][]) => Promise<void>;
  /** The render features (SDK RenderFeature values, plus `symbol`) this adapter supports for a build a
   * course declares. A reviewed prior build may support fewer than the installed one. */
  renderFeatures?: (declared: BuildIdentity) => readonly string[];
  /** The render features a visual requires. Throws when the visual cannot be parsed. */
  visualFeatures?: (visual: CourseManifest['visuals'][number]) => readonly string[];
  codeReady?: boolean; validateCodeAssessment?: (assessment: Assessment) => void; evaluateCode?: (assessment: Assessment, source: unknown) => Promise<CodeGrade>;
  rubricReady?: boolean; validateRubricAssessment?: (assessment: Assessment) => void;
  /** Deterministic evaluators of gate conversations (method 'deterministic'): confirms or declines
   * each quoted finding a proposal makes. Pure and synchronous, so the same proposal always gets
   * the same verdict; see conversation-confirmation.ts. */
  confirmConversationFindings?: (input: ConversationFindingsInput) => readonly { criterionId: string; confirmed: boolean }[];
  /** Renders SDK 0.5 activities (Core's declarative interpreter or a sandboxed web frame). See activity-runtime.ts. */
  activityRuntime?: ActivityRuntimePort;
  /** Judges activity observations; the only path from an observation to activity evidence. */
  activityEvaluator?: ActivityEvaluatorPort }
/** What a deterministic conversation evaluator sees: the rubric, the learner's own turns and the
 * proposed findings whose quotes Core has already found verbatim in those turns. */
export interface ConversationFindingsInput {
  rubric: { id: string; version: string; criteria: { id: string; description: string; required: boolean }[] };
  learnerTurns: { turnId: string; text: string }[];
  findings: { criterionId: string; met: boolean; quote: string; turnId: string | null }[];
}

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
  // An unversioned gate's conversationalEvaluatorId must name a 0.5 evaluator definition bound to
  // exactly one course rubric: a bare extension ID names no rubric to cite, so such a gate could
  // never be decided. Refuse it precisely, whatever is installed.
  const unresolved = course.gates.filter(gate => !isVersionedGate(gate) && gate.conversationalEvaluatorId && !gateConversation(course, gate)).map(gate => gate.id);
  if (unresolved.length) throw new ApiError(409, 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED', 'PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED',
    { gateIds: unresolved, supported: 'evaluator_definition_with_one_rubric' });
  const requireAdapter = (id: string, capability?: string) => {
    const declaration = course.extensions.find(row => row.id === id), adapter = installed.find(row => row.id === id);
    if (!declaration || !adapter || !declarationMatchesInstalled(declaration, adapter)
      || !adapter.platforms.includes('web') || (capability && !adapter.capabilities.includes(capability))) throw new ApiError(409, 'PUBLISH_CAPABILITY_MISSING');
    return adapter;
  };
  const required = new Set(course.gates.flatMap(gate => gateAssessmentIds(gate)));
  for (const chapter of course.chapters) for (const episode of chapter.episodes) for (const block of episode.blocks) {
    if (block.type === 'assessment') required.add(block.assessmentId);
    if (block.type === 'visual') {
      const visual = course.visuals.find(visual => visual.id === block.visualId)!, adapter = requireAdapter(visual.rendererId);
      assertVisualAccessible(course, visual.rendererId, { visualId: visual.id }, visual.accessibility.description);
      if (!adapter.validateVisual) throw new ApiError(409, 'PUBLISH_VISUAL_VALIDATOR_MISSING');
      let required: readonly string[];
      try { adapter.validateVisual(visual); required = adapter.visualFeatures?.(visual) ?? []; }
      catch (error) { throw visualRefusal(visual.id, error); }
      // A valid scene may still need features the declared build lacks (a 0.1.x declaration using a clip).
      assertRenderFeatures(course, adapter, visual.rendererId, required, { visualId: visual.id });
    }
  }
  // Renderer definitions for visuals name the features they need; the declared build must have them.
  for (const renderer of course.renderers ?? []) {
    const adapter = installed.find(row => row.id === renderer.extensionId), declaration = course.extensions.find(row => row.id === renderer.extensionId);
    if (renderer.surface === 'visual' && declaration) assertVisualAccessible(course, renderer.extensionId, { rendererDefinitionId: renderer.id });
    if (renderer.surface !== 'visual' || !adapter?.renderFeatures || !declarationMatchesInstalled(declaration, adapter)) continue;
    assertRenderFeatures(course, adapter, renderer.extensionId, renderer.features, { rendererDefinitionId: renderer.id });
  }
  // Activities run only on an installed runtime for every declared target (or an equivalent
  // fallback), with implemented capabilities and, when declared, an installed evaluator.
  assertActivitiesRunnable(course, installed);
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
    if (isVersionedGate(gate)) assertVersionedGateRules(course, gate);
    if (isVersionedGate(gate) ? !gate.conversationalRubricRef : !gate.conversationalEvaluatorId) continue;
    const resolved = gateConversation(course, gate);
    // Model impressions are not evidence: the rubric must require quotes, and a human or an installed
    // deterministic evaluator must confirm every judgment.
    if (!resolved?.rubric.requiresCitedEvidence || (isVersionedGate(gate) && !gate.eligibleEvidenceKinds.some(k => k === 'rubric_backed_conversation' || k === 'configured_combination')))
      throw new ApiError(409, 'PUBLISH_CONVERSATION_RUBRIC_UNSUPPORTED');
    if (!isVersionedGate(gate)) assertLegacyConversationReachable(course, gate, resolved.rubric.id);
    const item = findAssessment(course, conversationItemId(gate.id));
    requireReviewer(resolved.evaluator.extensionId, item as RubricItem);
    if (confirmsDeterministically(resolved.evaluator) && !requireAdapter(resolved.evaluator.extensionId, 'assessment.evaluate').confirmConversationFindings)
      throw new ApiError(409, 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE');
  }
}

/** A scene's own publish-time checks failing gets its own code; anything else is an invalid visual. */
const CHECK_CODES: Record<string, string> = { INVARIANT_FAILED: 'PUBLISH_VISUAL_INVARIANT_FAILED', GOLDEN_MISMATCH: 'PUBLISH_VISUAL_GOLDEN_MISMATCH' };
function visualRefusal(visualId: string, error: unknown): ApiError {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const mapped = Object.hasOwn(CHECK_CODES, code) ? CHECK_CODES[code]! : undefined;
  if (!mapped) return new ApiError(409, 'PUBLISH_VISUAL_INVALID');
  // The message names the author's check, layout and time; it carries no learner data.
  return new ApiError(409, mapped, mapped, { visualId, check: String((error as Error).message).slice(0, 400) });
}

/**
 * Visuals are required lesson content (S12): the renderer a course declares for one must declare
 * keyboard support and a non-blank text alternative, and the visual itself a non-blank
 * description. SDK 0.6 validate refuses the same (INACCESSIBLE_VISUAL, MISSING_TEXT_ALTERNATIVE);
 * Core refuses it here for bundles from every supported SDK release, whatever the SDK checked.
 * `reasons` are stable codes: keyboard, renderer_text_alternative, visual_description.
 */
function assertVisualAccessible(course: CourseManifest, extensionId: string, subject: Record<string, string>, description?: string) {
  const declared = course.extensions.find(row => row.id === extensionId);
  if (!declared) return;
  const blank = (value: unknown) => typeof value !== 'string' || value.trim() === '';
  const access = declared.accessibility as Partial<CourseManifest['extensions'][number]['accessibility']> | undefined;
  const reasons = [
    ...(access?.keyboard !== true ? ['keyboard'] : []),
    ...(blank(access?.textAlternative) ? ['renderer_text_alternative'] : []),
    ...(description !== undefined && blank(description) ? ['visual_description'] : []),
  ];
  if (reasons.length) throw new ApiError(409, 'PUBLISH_VISUAL_INACCESSIBLE', 'PUBLISH_VISUAL_INACCESSIBLE', { ...subject, rendererId: extensionId, reasons });
}

/** Refuses, at publication, a visual or renderer definition needing a render feature the declared
 * build of its renderer does not support. Adapters that report no features support none. */
function assertRenderFeatures(course: CourseManifest, adapter: RuntimeExtension, extensionId: string, required: readonly string[], subject: Record<string, string>) {
  if (!required.length) return;
  const declared = course.extensions.find(row => row.id === extensionId)!;
  const supported = adapter.renderFeatures?.({ version: declared.version, integrity: declared.integrity }) ?? [];
  const missing = required.filter(feature => !supported.includes(feature));
  if (missing.length) throw new ApiError(409, 'PUBLISH_RENDER_FEATURE_UNSUPPORTED', 'PUBLISH_RENDER_FEATURE_UNSUPPORTED',
    { ...subject, rendererId: extensionId, declaredVersion: declared.version, missingFeatures: [...missing].sort(), supportedFeatures: [...supported].sort() });
}

/** A 0.4 gate judged in conversation keeps its family rule: the conversation is one family for
 * every gate objective, so the listed items must supply the rest. */
function assertLegacyConversationReachable(course: CourseManifest, gate: LegacyProgressionGate, rubricId: string) {
  const items = gate.assessmentIds.map(id => course.assessments.find(a => a.id === id)).filter(item => item !== undefined);
  const reachable = (objective: string) => new Set([...items.filter(item => item.objectiveIds.includes(objective)).map(item => item.familyId), `conversation:${rubricId}`]).size >= gate.minimumIndependentFamilies;
  if (gate.requireAllObjectives ? !gate.objectiveIds.every(reachable) : !gate.objectiveIds.some(reachable))
    throw new ApiError(409, 'PUBLISH_GATE_EVIDENCE_UNREACHABLE', 'PUBLISH_GATE_EVIDENCE_UNREACHABLE', { gateId: gate.id });
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
