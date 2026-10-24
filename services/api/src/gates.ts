import type { Assessment, CourseManifest, EvaluatorDefinition, GateDecisionStatus, NextAction, Rubric, VersionedProgressionGate } from '@course-core/sdk';
import { gateAssessmentIds, gateObjectiveIds, isVersionedGate, RECOGNITION_TYPES } from '@course-core/sdk';

/** Either gate shape: the family-count gate without a version, or the versioned gate bound to a policy revision. */
export type Gate = CourseManifest['gates'][number];
export type RubricItem = Extract<Assessment, { type: 'rubric' }>;
/** Item ID of the explain-for-review conversation of a gate that is judged in conversation. */
export const CONVERSATION_ITEM_PREFIX = 'gate-conversation:';
/** Version label recorded on decisions for gates without a version (the family-count shape). */
export const LEGACY_GATE_VERSION = 'legacy-0.4';
export const RUBRIC_PRODUCTION_TYPES: ReadonlySet<string> = new Set(['counterexample', 'experiment_design', 'teach_back']);
export const DETERMINISTIC_ITEM_TYPES: ReadonlySet<string> = new Set(['choice', 'numeric', 'prediction', 'trace']);
/** Unsuccessful or abstained relevant attempts since the last success that suggest help. */
export const HELP_THRESHOLD = 2;

export const gateVersion = (gate: Gate) => isVersionedGate(gate) ? gate.version : LEGACY_GATE_VERSION;
export const gateObjectives = (gate: Gate) => gateObjectiveIds(gate);
export const gateFamilies = (gate: Gate) => isVersionedGate(gate) ? gate.minimumIndependentEvidence.families : gate.minimumIndependentFamilies;
export const conversationItemId = (gateId: string) => CONVERSATION_ITEM_PREFIX + gateId;
/** Items that can contribute evidence to a gate, including its review conversation. */
export function gateItemIds(gate: Gate): string[] {
  const ids = gateAssessmentIds(gate);
  return declaresConversation(gate) ? [...ids, conversationItemId(gate.id)] : ids;
}
/** Evaluator IDs name a 0.5 evaluator definition or, for compatibility, a declared extension. */
export function evaluatorExtensionId(course: CourseManifest, id: string) {
  return course.evaluators?.find(e => e.id === id)?.extensionId ?? id;
}
/** An evaluator that may judge a gate conversation: either a human must confirm every judgment
 * (a model draft alone never confirms anything), or the method is deterministic and an installed
 * trusted adapter confirms quoted findings itself (see conversation-confirmation.ts). */
const judgesConversation = (e: EvaluatorDefinition) =>
  ((e.method === 'human' || e.method === 'rubric_model_assisted') && e.humanConfirmation === 'required') || e.method === 'deterministic';
/** Whether an evaluator confirms quoted conversation findings without a human. */
export const confirmsDeterministically = (e: EvaluatorDefinition) => e.method === 'deterministic' && e.humanConfirmation !== 'required';
export function conversationEvaluator(course: CourseManifest, rubricId: string): EvaluatorDefinition | undefined {
  return course.evaluators?.find(e => e.rubricIds?.includes(rubricId) && judgesConversation(e));
}
/** A versioned gate names the rubric; a legacy gate names the evaluator. Publication refuses a
 * declaration that does not resolve (gateConversation), so a published one always does. */
const declaresConversation = (gate: Gate) => Boolean(isVersionedGate(gate) ? gate.conversationalRubricRef : gate.conversationalEvaluatorId);
/**
 * The rubric and evaluator a gate's conversation is judged by: a versioned gate's
 * `conversationalRubricRef`, or an unversioned 0.4 gate's `conversationalEvaluatorId` when it
 * names a 0.5 evaluator definition bound to exactly one course rubric. A bare extension ID names
 * no rubric to cite, so it resolves to nothing and publication refuses that gate.
 */
export function gateConversation(course: CourseManifest, gate: Gate): { rubric: Rubric; evaluator: EvaluatorDefinition } | undefined {
  if (isVersionedGate(gate)) {
    const rubric = gate.conversationalRubricRef ? course.rubrics?.find(r => r.id === gate.conversationalRubricRef) : undefined;
    const evaluator = rubric && conversationEvaluator(course, rubric.id);
    return rubric && evaluator ? { rubric, evaluator } : undefined;
  }
  const evaluator = gate.conversationalEvaluatorId ? course.evaluators?.find(e => e.id === gate.conversationalEvaluatorId) : undefined;
  if (!evaluator || evaluator.rubricIds?.length !== 1 || !judgesConversation(evaluator)) return undefined;
  const rubric = course.rubrics?.find(r => r.id === evaluator.rubricIds![0]);
  return rubric ? { rubric, evaluator } : undefined;
}
export function conversationGate(course: CourseManifest, itemId: string): Gate | undefined {
  if (!itemId.startsWith(CONVERSATION_ITEM_PREFIX)) return undefined;
  const gate = course.gates.find(g => g.id === itemId.slice(CONVERSATION_ITEM_PREFIX.length));
  return gate && gateConversation(course, gate) ? gate : undefined;
}
const objectiveText = (course: CourseManifest, ids: readonly string[]) =>
  ids.map(id => course.objectives.find(o => o.id === id)?.description ?? id).join(' ');
/** The synthesized review item of a conversational gate: the learner explains in their own words,
 * a reviewer may ask neutral follow-up questions, and every met criterion must quote the learner. */
function conversationAssessment(course: CourseManifest, gate: Gate): RubricItem | undefined {
  const resolved = gateConversation(course, gate);
  if (!resolved) return undefined;
  const { rubric, evaluator } = resolved, objectives = gateObjectives(gate);
  return { id: conversationItemId(gate.id), type: 'rubric', objectiveIds: [...objectives], familyId: `conversation:${rubric.id}`, role: 'transfer',
    prompt: `Explain in your own words, with an example of your own: ${objectiveText(course, objectives)}`,
    grading: { evaluatorId: evaluator.extensionId, rubric: rubric.criteria.map(({ id, description, required }) => ({ id, description, required })) } };
}
/** Course items plus the synthesized conversation item of each conversational gate. */
export function findAssessment(course: CourseManifest, id: string): Assessment | undefined {
  const gate = conversationGate(course, id);
  return gate ? conversationAssessment(course, gate) : course.assessments.find(a => a.id === id);
}

/** Everything the human-reviewed rubric pipeline needs, for written rubric items, rubric-backed
 * production items (counterexample, experiment design, teach-back) and gate conversations. */
export interface ReviewedRubric {
  id: string; prompt: string; objectiveIds: string[]; familyId: string; evaluatorExtensionId: string;
  criteria: { id: string; description: string; required: boolean }[];
  /** The versioned course rubric, for production items and conversations. */
  rubricRef?: { id: string; version: string };
  /** The rubric requires quoted learner spans for every criterion. */
  citedEvidence: boolean;
  conversationGateId?: string;
}
export function reviewedRubric(course: CourseManifest, assessmentId: string): ReviewedRubric | undefined {
  const gate = conversationGate(course, assessmentId);
  const assessment = gate ? conversationAssessment(course, gate) : course.assessments.find(a => a.id === assessmentId);
  if (!assessment) return undefined;
  const base = { id: assessment.id, prompt: assessment.prompt, objectiveIds: assessment.objectiveIds, familyId: assessment.familyId };
  if (gate && assessment.type === 'rubric') {
    const { rubric } = gateConversation(course, gate)!;
    return { ...base, evaluatorExtensionId: assessment.grading.evaluatorId, criteria: assessment.grading.rubric, rubricRef: { id: rubric.id, version: rubric.version },
      citedEvidence: rubric.requiresCitedEvidence, conversationGateId: gate.id };
  }
  if (assessment.type === 'rubric') return { ...base, evaluatorExtensionId: evaluatorExtensionId(course, assessment.grading.evaluatorId), criteria: assessment.grading.rubric, citedEvidence: true };
  if (assessment.type === 'counterexample' || assessment.type === 'experiment_design' || assessment.type === 'teach_back') {
    const rubric: Rubric | undefined = course.rubrics?.find(r => r.id === assessment.grading.rubricId);
    if (!rubric) return undefined;
    return { ...base, evaluatorExtensionId: evaluatorExtensionId(course, assessment.grading.evaluatorId), rubricRef: { id: rubric.id, version: rubric.version },
      criteria: rubric.criteria.map(({ id, description, required }) => ({ id, description, required })), citedEvidence: true };
  }
  return undefined;
}

/** The reviewed-rubric view as a rubric item, for the installed reviewer's publish validation. */
export function reviewedRubricItem(view: ReviewedRubric): RubricItem {
  return { id: view.id, type: 'rubric', objectiveIds: view.objectiveIds, familyId: view.familyId, prompt: view.prompt, grading: { evaluatorId: view.evaluatorExtensionId, rubric: view.criteria } };
}
export type CodeItem = Extract<Assessment, { type: 'code' }>;
/** Code and code-repair items as the installed code evaluator sees them: repair is graded by the
 * same hidden reference cases, and a 0.5 evaluator definition resolves to its extension. */
export function codeView(course: CourseManifest, assessment: Assessment): CodeItem | undefined {
  if (assessment.type !== 'code' && assessment.type !== 'code_repair') return undefined;
  return { ...assessment, type: 'code', grading: { ...assessment.grading, evaluatorId: evaluatorExtensionId(course, assessment.grading.evaluatorId) } };
}

/** Persisted evidence as the gate evaluator sees it. Only server code paths create these rows. */
export interface GateEvidence {
  id: string; objective_id: string; family_id: string; assessment_id: string; independent: boolean; course_digest: string;
  result: { passed: boolean; reviewed?: boolean; conversation?: { gateId: string; rubricId: string; rubricVersion: string }; citedSpans?: { turnId: string; quote: string }[] };
  mode?: string; created_at?: Date | string; attempt_id?: string;
}
/** One submitted attempt, reduced to what readiness needs: its outcome, when, and which
 * declared misconceptions it signalled. Confidence is deliberately absent. */
export interface AttemptSignal {
  id: string; assessment_id: string; course_digest: string; mode: string;
  /** `clarification`: a reviewer asked a follow-up the learner has not answered yet; `continued`: answered. */
  outcome: 'correct' | 'incorrect' | 'abstained' | 'pending_review' | 'clarification' | 'continued';
  misconception_ids: string[]; at: Date | string;
}
/**
 * A learner-facing sentence as a message code and its parameters. The learner app translates it
 * (`gateDecision.msg.<code>`); the English text beside it (`reason`, `label`) is the fallback and
 * the stored record. String parameters are course text (titles, objectives, prompts) shown as
 * written; an array is a list of course text the app joins for the learner's language; `detail`
 * is a nested sentence the app translates first.
 */
export interface GateMessage { code: string; params?: Record<string, string | number | string[]>; detail?: GateMessage }
/** The decision's learner-visible text as codes, kept beside the SDK record (which stays exactly
 * the SDK shape): the reason, each criterion's reason by criterion ID, and each next action's label
 * by position. */
export interface DecisionMessages { reason: GateMessage; criteria: Record<string, GateMessage>; actions: (GateMessage | null)[] }
type GateNextAction = NextAction & { message?: GateMessage };
export interface DecisionObjective { id: string; families: string[]; required: number; passed: boolean; evidenceIds: string[] }
export interface CriterionResult { criterionId: string; kind: string; met: boolean | 'pending'; evidenceRefs: string[]; reason: string }
type CriterionWithMessage = CriterionResult & { message: GateMessage };
/** A Core gate decision before it is persisted (no decision ID, enrollment or timestamps). */
export interface ComputedDecision {
  gateId: string; gateVersion: string; courseDigest: string; policyRevision: number;
  status: GateDecisionStatus; passed: boolean; objectives: DecisionObjective[];
  criterionResults: CriterionResult[]; missingObjectiveIds: string[]; unresolvedMisconceptionIds: string[]; evidenceRefs: string[];
  evaluator: { kind: 'host_policy'; id: string; version: string };
  learnerVisibleReason: string; nextActions: NextAction[]; nextActivityId: string | null;
  /** The same text as codes, for the learner's language. Not part of the decision's digest. */
  messages: DecisionMessages;
}
export const GATE_EVALUATOR = { kind: 'host_policy' as const, id: 'course-core.gate-policy', version: '1.0.0' };
export interface DecisionContext {
  /** Applicable cap or deadline reached, or the enrollment is closed. */
  capReached?: boolean; policyRevision?: number; signals?: readonly AttemptSignal[];
  /** Restrict to placement evidence (placement exemptions). */
  placementOnly?: boolean;
  /** False when the companion is not offered (a research-study arm without it): no next action
   * may then point at the companion; non-AI help (reviewing the lesson, a fresh check) is offered. */
  companionAvailable?: boolean;
}

const time = (value: Date | string | undefined) => value === undefined ? 0 : new Date(value).getTime();
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const clip = (text: string, max = 90) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t; };
const quote = (text: string, max = 90) => `“${clip(text, max)}”`;
function episodeOf(course: CourseManifest, gate: Gate) {
  const all = course.chapters.flatMap(c => c.episodes);
  if (isVersionedGate(gate) && gate.scope.kind === 'episode') return all.find(e => e.id === (gate.scope as { episodeId: string }).episodeId);
  return all.find(e => e.gateId === gate.id);
}
function nextEpisodeAfter(course: CourseManifest, episodeId: string | undefined) {
  const all = course.chapters.flatMap(c => c.episodes), i = all.findIndex(e => e.id === episodeId);
  return i >= 0 ? all[i + 1] ?? null : null;
}
function activityTitle(course: CourseManifest, id: string | null) {
  if (!id) return undefined;
  return course.chapters.flatMap(c => c.episodes).find(e => e.id === id)?.title ?? course.learningSteps?.find(s => s.id === id)?.primaryAction.label
    ?? course.activities?.find(a => a.id === id)?.title;
}
/** Whether an item can show more than recognition: anything but choosing among given answers. */
const producesAnswer = (item: Assessment | undefined) => item !== undefined && !RECOGNITION_TYPES.has(item.type);

/**
 * Core's own readiness evaluator. Evidence rows come only from server-issued attempts of this
 * enrollment; a row counts when it is independent, correct, from this course version and from an
 * item the gate lists (or a reviewed, quoted conversation on the gate's current rubric version).
 * Recognition never establishes transfer, confidence is never an input, and an abstention is a
 * neutral signal. Gates without a version get the same false-mastery rules (there is no SDK 0.4
 * compatibility path): every objective needs independent success in the required families,
 * including one task beyond choosing among given answers (or a confirmed conversation), and a
 * declared critical misconception still open blocks the gate.
 */
export function evaluateGate(course: CourseManifest, gate: Gate, evidence: readonly GateEvidence[], digest: string, context: DecisionContext = {}): ComputedDecision {
  const items = new Set(gateItemIds(gate)), assessments = new Map(course.assessments.map(a => [a.id, a]));
  const versioned = isVersionedGate(gate) ? gate : undefined;
  // Either gate shape may be judged in conversation; only quoted, confirmed findings on its current rubric version count.
  const rubric = gateConversation(course, gate)?.rubric;
  const isConversation = (row: GateEvidence) => Boolean(rubric && row.assessment_id === conversationItemId(gate.id) && row.result.reviewed
    && row.result.conversation?.rubricId === rubric.id && row.result.conversation.rubricVersion === rubric.version && (row.result.citedSpans?.length ?? 0) > 0);
  const eligible = (row: GateEvidence) => row.course_digest === digest && (context.placementOnly ? row.mode === 'placement' : true)
    && (row.assessment_id.startsWith(CONVERSATION_ITEM_PREFIX) ? isConversation(row) : items.has(row.assessment_id));
  const counted = evidence.filter(row => eligible(row) && row.independent && row.result.passed && row.mode !== 'practice' && row.mode !== 'retention')
    .sort((a, b) => time(a.created_at) - time(b.created_at) || a.id.localeCompare(b.id));
  const objectiveIds = gateObjectives(gate), required = gateFamilies(gate);
  // Recognition alone never demonstrates an objective of a gate without a version (publication refuses one that offers nothing more).
  const productionRequired = !versioned;
  const produced = (row: GateEvidence) => isConversation(row) || producesAnswer(assessments.get(row.assessment_id));
  const objectives: DecisionObjective[] = objectiveIds.map(id => {
    const rows = counted.filter(row => row.objective_id === id), families = sorted(rows.map(row => row.family_id));
    const passed = families.length >= required && (!productionRequired || rows.some(produced));
    return { id, families, required, passed, evidenceIds: rows.map(row => row.id) };
  });
  const signals = (context.signals ?? []).filter(s => s.course_digest === digest && items.has(s.assessment_id) && (context.placementOnly ? s.mode === 'placement' : s.mode !== 'retention'))
    .sort((a, b) => time(a.at) - time(b.at));
  // An open review conversation (awaiting the reviewer or the learner's reply) is pending, never a failure.
  const pendingSignals = signals.filter(s => s.outcome === 'pending_review' || s.outcome === 'clarification');
  const followUps = signals.filter(s => s.outcome === 'clarification');
  const lastSuccess = counted.length ? time(counted[counted.length - 1]!.created_at) : 0;
  const struggles = signals.filter(s => time(s.at) > lastSuccess && (s.outcome === 'incorrect' || s.outcome === 'abstained')).length;
  const attempted = new Set(signals.map(s => s.assessment_id));
  const episode = episodeOf(course, gate);
  const objectiveText = (id: string) => clip((course.objectives.find(o => o.id === id)?.description ?? id).replace(/[.;:]\s*$/, ''), 70);
  const describe = (ids: readonly string[]) => ids.map(id => `“${objectiveText(id)}”`).join(', ');
  const freshItem = (accept: (id: string) => boolean) => [...items].find(id => !attempted.has(id) && accept(id));
  const targets = (id: string, misconception: string) => {
    const item = assessments.get(id);
    return item !== undefined && (item.misconceptionIds?.includes(misconception) || (item.type === 'choice' && item.options.some(o => o.misconceptionId === misconception)));
  };
  const critical = (objs: readonly string[]) => (course.hypotheses ?? []).filter(h => h.kind === 'misconception' && h.critical && h.objectiveIds.some(o => objs.includes(o)));
  /** Declared critical misconceptions the learner signalled and no later independent success on an item exposing them ruled out. */
  const open = (objs: readonly string[]) => critical(objs).filter(h => {
    const raised = signals.filter(s => s.misconception_ids.includes(h.id));
    if (!raised.length) return false;
    const last = time(raised[raised.length - 1]!.at);
    return !counted.some(row => time(row.created_at) > last && targets(row.assessment_id, h.id));
  });
  const rubricTitle = (): Record<string, string> => rubric?.title ? { rubric: clip(rubric.title, 90) } : {};

  let criterionResults: CriterionWithMessage[], unresolved: string[] = [];
  if (!versioned) {
    const pendingOn = (id: string) => pendingSignals.some(s => findAssessment(course, s.assessment_id)?.objectiveIds.includes(id));
    criterionResults = objectives.map(o => {
      const params = { required, objectives: [objectiveText(o.id)] };
      const recognitionOnly = !o.passed && o.families.length >= required;
      const message: GateMessage = o.passed ? { code: 'criterion.familiesFor.met', params }
        : recognitionOnly ? { code: 'criterion.familiesFor.needsProduction', params } : { code: 'criterion.familiesFor.unmet', params: { ...params, count: o.families.length } };
      const reason = o.passed ? `Independent success in ${required} item families for ${describe([o.id])}.`
        : recognitionOnly ? `Needs independent success on a task beyond choosing among given answers for ${describe([o.id])}.`
          : `Needs independent success in ${required} item families for ${describe([o.id])} (${o.families.length} so far).`;
      return { criterionId: `independent_families:${o.id}`, kind: 'independent_success', met: o.passed ? true : pendingOn(o.id) ? 'pending' as const : false, evidenceRefs: o.evidenceIds, reason, message };
    });
    // A declared critical misconception the learner showed must be ruled out by a later independent success.
    if (critical(objectiveIds).length) {
      const still = open(objectiveIds);
      criterionResults.push({ criterionId: 'no_critical_misconception', kind: 'no_critical_misconception', met: still.length === 0,
        evidenceRefs: sorted(counted.map(r => r.id)),
        reason: still.length ? `A later independent check must rule out: ${still.map(h => quote(h.statement, 80)).join(', ')}.` : 'No unresolved critical misconception.',
        message: still.length ? { code: 'criterion.misconception.open', params: { misconceptions: still.map(h => clip(h.statement, 80)) } } : { code: 'criterion.misconception.met' } });
      unresolved = sorted(still.map(h => h.id));
    }
  } else {
    const isTransfer = (row: GateEvidence) => isConversation(row) || (() => { const item = assessments.get(row.assessment_id); return item !== undefined && item.role === 'transfer' && !RECOGNITION_TYPES.has(item.type); })();
    const covering = (rows: GateEvidence[], objs: readonly string[]) => rows.filter(row => objs.includes(row.objective_id));
    const pendingFor = (objs: readonly string[]) => pendingSignals.filter(s => {
      const item = findAssessment(course, s.assessment_id);
      return item?.objectiveIds.some(o => objs.includes(o));
    });
    criterionResults = versioned.readinessCriteria.map(criterion => {
      const objs = criterion.objectiveIds.length ? criterion.objectiveIds : versioned.requiredObjectives;
      let met = false, refs: GateEvidence[] = [], reason: string, message: GateMessage;
      if (criterion.kind === 'independent_success') {
        refs = covering(counted, objs);
        const short = objs.filter(o => new Set(refs.filter(r => r.objective_id === o).map(r => r.family_id)).size < required);
        met = short.length === 0;
        reason = met ? `Independent success in ${required} item families.` : `Needs independent success in ${required} different item families for ${describe(short)}.`;
        message = met ? { code: 'criterion.families.met', params: { required } } : { code: 'criterion.families.unmet', params: { required, objectives: short.map(objectiveText) } };
      } else if (criterion.kind === 'transfer_success') {
        refs = covering(counted, objs).filter(isTransfer);
        met = new Set(refs.map(r => r.attempt_id ?? r.id)).size >= versioned.minimumIndependentEvidence.transferItems;
        reason = met ? 'Independent transfer evidence recorded.' : `Needs independent success on a new transfer task for ${describe(objs)}; choosing among given answers does not count as transfer.`;
        message = met ? { code: 'criterion.transfer.met' } : { code: 'criterion.transfer.unmet', params: { objectives: objs.map(objectiveText) } };
      } else if (criterion.kind === 'no_critical_misconception') {
        // "None remains" is only claimed on independent evidence, which the criterion cites.
        const still = open(objs), observed = covering(counted, objs);
        met = still.length === 0 && observed.length > 0;
        refs = observed;
        reason = met ? 'No unresolved critical misconception.' : still.length ? `A later independent check must rule out: ${still.map(h => quote(h.statement, 80)).join(', ')}.`
          : `Needs independent evidence for ${describe(objs)} before any mix-up can be ruled out.`;
        message = met ? { code: 'criterion.misconception.met' } : still.length ? { code: 'criterion.misconception.open', params: { misconceptions: still.map(h => clip(h.statement, 80)) } }
          : { code: 'criterion.misconception.unobserved', params: { objectives: objs.map(objectiveText) } };
      } else if (criterion.kind === 'rubric_criteria') {
        refs = covering(counted, objs).filter(isConversation);
        met = refs.length > 0;
        reason = met ? 'Rubric criteria met with quoted learner evidence.' : `Needs an explanation in your own words that a reviewer confirms against “${rubric?.title ?? 'the rubric'}”, quoting what you wrote.`;
        message = met ? { code: 'criterion.rubric.met' } : { code: rubric?.title ? 'criterion.rubric.unmet' : 'criterion.rubric.unmetUnnamed', params: rubricTitle() };
      } else {
        const practical = new Set(versioned.practicalTaskRefs ?? []);
        refs = covering(counted, objs).filter(row => practical.has(row.assessment_id));
        met = refs.length > 0;
        reason = met ? 'Verified practical task passed.' : `Needs a verified practical task for ${describe(objs)}.`;
        message = met ? { code: 'criterion.practical.met' } : { code: 'criterion.practical.unmet', params: { objectives: objs.map(objectiveText) } };
      }
      const state: boolean | 'pending' = !met && pendingFor(objs).length > 0 ? 'pending' : met;
      if (state === 'pending') reason = `${reason} Evidence is awaiting review.`;
      return { criterionId: criterion.id, kind: criterion.kind, met: state, evidenceRefs: sorted(refs.map(r => r.id)), reason, message };
    });
    unresolved = sorted(open(versioned.requiredObjectives).map(h => h.id));
  }
  const ready = versioned
    ? criterionResults.every(r => r.met === true) && unresolved.length === 0
    // Every objective, whatever `requireAllObjectives` says: one demonstrated objective never stands for the others.
    : objectives.every(o => o.passed) && unresolved.length === 0;
  const pendingCriterion = criterionResults.some(r => r.met === 'pending');
  const status: GateDecisionStatus = ready ? 'ready' : context.capReached ? 'closed_with_gaps' : pendingCriterion ? 'under_review' : struggles >= HELP_THRESHOLD ? 'needs_help' : 'needs_evidence';
  const missingObjectiveIds = sorted(objectiveIds.filter(o => !counted.some(row => row.objective_id === o)));
  const unmet = criterionResults.filter(r => r.met !== true);
  const unproven = sorted([...objectives.filter(o => !o.passed).map(o => o.id), ...missingObjectiveIds]);

  // Concrete next actions, most useful first.
  const nextActivityId = versioned ? versioned.nextActivityId : nextEpisodeAfter(course, episode?.id)?.id ?? null;
  const attempt: GateNextAction[] = [];
  const addAttempt = (action: GateNextAction) => { if (!attempt.some(a => a.targetId === action.targetId && a.label === action.label)) attempt.push(action); };
  const explain = (targetId: string): GateNextAction => ({ kind: 'attempt_check', label: `Explain your reasoning in your own words for review against “${rubric?.title ?? 'the rubric'}”`, targetId,
    message: { code: rubric?.title ? 'action.explainRubric' : 'action.explainRubricUnnamed', params: rubricTitle() } });
  const hypothesesOpen = (course.hypotheses ?? []).filter(h => unresolved.includes(h.id));
  const ruleOut = () => {
    const id = freshItem(id => { const item = assessments.get(id); return Boolean(item && hypothesesOpen.some(h => item.misconceptionIds?.includes(h.id) || (item.type === 'choice' && item.options.some(o => o.misconceptionId === h.id)))); });
    if (id) addAttempt({ kind: 'attempt_check', label: `Try a fresh check that rules out the mix-up ${quote(hypothesesOpen[0]?.statement ?? '', 80)}`, targetId: id,
      message: { code: 'action.ruleOutMixup', params: { statement: clip(hypothesesOpen[0]?.statement ?? '', 80) } } });
  };
  for (const result of unmet) {
    if (result.met === 'pending') continue;
    if (result.kind === 'transfer_success') {
      const id = freshItem(id => { const item = assessments.get(id); return item?.role === 'transfer' && !RECOGNITION_TYPES.has(item.type); });
      if (id) addAttempt({ kind: 'attempt_check', label: `Solve a new transfer task: ${quote(assessments.get(id)!.prompt)}`, targetId: id,
        message: { code: 'action.transferTask', params: { prompt: clip(assessments.get(id)!.prompt) } } });
      else if (versioned?.conversationalRubricRef) addAttempt(explain(conversationItemId(versioned.id)));
    } else if (result.kind === 'rubric_criteria' && versioned) {
      addAttempt(explain(conversationItemId(versioned.id)));
    } else if (result.kind === 'no_critical_misconception') {
      ruleOut();
    } else if (result.kind === 'practical_task' && versioned) {
      const id = freshItem(id => (versioned.practicalTaskRefs ?? []).includes(id));
      if (id) addAttempt({ kind: 'attempt_check', label: `Complete the practical task: ${quote(assessments.get(id)!.prompt)}`, targetId: id,
        message: { code: 'action.practicalTask', params: { prompt: clip(assessments.get(id)!.prompt) } } });
    } else {
      const short = objectives.filter(o => !o.passed);
      for (const o of short) {
        // An objective with enough families but only recognition evidence needs a produced answer.
        const needsProduction = productionRequired && o.families.length >= o.required;
        const id = freshItem(id => { const item = course.assessments.find(a => a.id === id); return Boolean(item && item.objectiveIds.includes(o.id) && (needsProduction ? producesAnswer(item) : !o.families.includes(item.familyId))); });
        if (id) addAttempt({ kind: 'attempt_check', label: `Answer a fresh independent check on ${describe([o.id])} (${o.families.length} of ${o.required} item families so far)`, targetId: id,
          message: { code: 'action.freshCheck', params: { objectives: [objectiveText(o.id)], count: o.families.length, required: o.required } } });
        // A gate without a version judged in conversation: explaining is always offered, and counts once a quoted finding is confirmed.
        if (rubric && !versioned && !o.families.includes(`conversation:${rubric.id}`)) addAttempt(explain(conversationItemId(gate.id)));
      }
    }
  }
  // The open learner focus: unproven objectives, else the lesson, else the checkpoint itself.
  const focus = unproven.length ? describe(unproven.slice(0, 2)) : episode ? quote(episode.title, 60) : 'this checkpoint';
  const focusParams = (ids: readonly string[]): Record<string, string | string[]> => ids.length ? { focusKind: 'objectives', focus: ids.map(objectiveText) }
    : episode ? { focusKind: 'lesson', focus: clip(episode.title, 60) } : { focusKind: 'checkpoint', focus: '' };
  const focusOf = focusParams(unproven.slice(0, 2));
  const help: GateNextAction = { kind: 'request_help', label: `Ask the companion for another explanation of ${focus}`, message: { code: 'action.askCompanion', params: focusOf } };
  const review: GateNextAction = episode
    ? { kind: 'review_material', label: `Review “${episode.title}” before your next attempt`, targetId: episode.id, message: { code: 'action.reviewLesson', params: { title: episode.title } } }
    : { kind: 'review_material', label: 'Review the lesson before your next attempt', message: { code: 'action.reviewLessonGeneric' } };
  const nextTitle = activityTitle(course, nextActivityId);
  const companion = context.companionAvailable !== false;
  let nextActions: GateNextAction[];
  if (status === 'ready') nextActions = [nextActivityId
    ? { kind: 'continue', label: nextTitle ? `Continue to “${nextTitle}”` : 'Continue', targetId: nextActivityId, message: nextTitle ? { code: 'action.continueTo', params: { title: nextTitle } } : { code: 'action.continue' } }
    : { kind: 'continue', label: 'Finish this part of the course', message: { code: 'action.finishPart' } }];
  else if (status === 'needs_evidence') nextActions = [...attempt.slice(0, 3), ...(companion ? [help] : []), review];
  else if (status === 'needs_help') nextActions = companion
    ? [{ kind: 'request_help', label: `Ask for help: your last ${struggles} attempts on this checkpoint did not succeed. Ask the companion about ${focus}`,
      message: { code: 'action.askHelpAfterStruggles', params: { count: struggles, ...focusOf } } }, review, ...attempt.slice(0, 2)]
    // Without the companion, the help is the lesson itself, then a fresh check.
    : [{ ...review, label: `Your last ${struggles} attempts on this checkpoint did not succeed. ${review.label}`,
      message: { code: 'action.reviewAfterStruggles', params: { count: struggles, ...(episode ? { titleKind: 'lesson', title: episode.title } : { titleKind: 'none', title: '' }) } } }, ...attempt.slice(0, 2)];
  else if (status === 'under_review') nextActions = [
    ...followUps.slice(0, 1).map(s => ({ kind: 'attempt_check' as const, label: `Reply to the reviewer's follow-up question about ${focus} in your own words`, targetId: s.assessment_id,
      message: { code: 'action.replyFollowUp', params: focusOf } })),
    { kind: 'await_review', label: `Wait for a reviewer to look at your answer on ${focus}; nothing counts against you meanwhile`, message: { code: 'action.awaitReview', params: focusOf } },
    ...(companion ? [help] : [review])];
  else nextActions = [{ kind: 'view_gaps', label: `See what remains unproven: ${unproven.length ? describe(unproven) : focus}`, message: { code: 'action.viewGaps', params: focusParams(unproven) } },
    ...(versioned?.appealPolicy.allowed ? [{ kind: 'appeal' as const, label: `Request ${versioned.appealPolicy.reviewer === 'staff' ? 'a staff' : 'an independent'} review of this decision within ${versioned.appealPolicy.windowDays ?? 0} days`,
      message: { code: 'action.appeal', params: { reviewer: versioned.appealPolicy.reviewer === 'staff' ? 'staff' : 'independent', days: versioned.appealPolicy.windowDays ?? 0 } } }] : []),
    ...(course.policy.extensions?.enabled ? [{ kind: 'consider_extension' as const, label: `Check whether an extension is available for ${episode ? `“${episode.title}”` : 'this course'}`,
      message: { code: 'action.extension', params: episode ? { titleKind: 'lesson', title: episode.title } : { titleKind: 'course', title: '' } } }] : [])];
  // The first open criterion, and how many more the criterion results list.
  const summary = unmet.length ? `${unmet[0]!.reason}${unmet.length > 1 ? ` (${unmet.length - 1} more open ${unmet.length === 2 ? 'criterion' : 'criteria'}.)` : ''}` : '';
  const more = Math.max(0, unmet.length - 1), detail = unmet[0]?.message;
  const reasons: Record<GateDecisionStatus, string> = {
    ready: 'All readiness criteria are met with independent evidence.',
    needs_evidence: summary || 'More independent evidence is needed.',
    needs_help: `Your recent attempts did not succeed. ${summary}`.trim(),
    under_review: 'Some of your evidence is awaiting review. Nothing is counted against you meanwhile.',
    closed_with_gaps: `The course limit was reached before this checkpoint was ready. ${summary}`.trim(),
  };
  // The same reason as a code; a missing first-criterion message falls back to the English text.
  const reasonMessage: GateMessage = status === 'ready' || status === 'under_review' || !detail ? { code: `reason.${status}` }
    : { code: `reason.${status}.detail`, params: { more }, detail };
  return {
    gateId: gate.id, gateVersion: gateVersion(gate), courseDigest: digest, policyRevision: context.policyRevision ?? 0,
    // A versioned gate demonstrates its objectives only as a whole (transfer and misconception rules included).
    status, passed: status === 'ready', objectives: versioned ? objectives.map(o => ({ ...o, passed: o.passed && ready })) : objectives,
    criterionResults: criterionResults.map(({ message: _m, ...result }) => result), missingObjectiveIds, unresolvedMisconceptionIds: unresolved,
    evidenceRefs: sorted(criterionResults.flatMap(r => r.evidenceRefs)), evaluator: GATE_EVALUATOR,
    learnerVisibleReason: reasons[status], nextActions: nextActions.map(({ message: _m, ...action }) => action), nextActivityId: status === 'ready' ? nextActivityId : null,
    messages: { reason: reasonMessage, criteria: Object.fromEntries(criterionResults.map(r => [r.criterionId, r.message])), actions: nextActions.map(a => a.message ?? null) },
  };
}

/** A decision without its translation codes, for digests: codes restate what the decision says. */
export function withoutMessages(decision: ComputedDecision) {
  const { messages: _messages, ...rest } = decision;
  return rest;
}
