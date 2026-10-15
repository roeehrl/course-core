import { z } from 'zod';

/**
 * The §4 trigger table: which learner signals lead to which teaching actions,
 * bounded by caps and restraints. Pure: no database, clock or model. The store
 * (teaching-hypotheses.ts) assembles TriggerState and applies the effects.
 *
 * Course contracts are read with Core-side schemas that mirror the SDK 0.5
 * shapes (defineTeachingHypothesis, defineDiagnosticProbe, assessment
 * misconceptionIds / option misconceptionId). A bundle without them simply has
 * no templates or probes; malformed entries are ignored rather than trusted.
 * Nothing decided here is assessment evidence.
 */
const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/);
export const HYPOTHESIS_KINDS = ['misconception', 'missing_prerequisite', 'slip', 'ambiguous_item', 'useful_analogy'] as const;
export type HypothesisKind = (typeof HYPOTHESIS_KINDS)[number];
export const HYPOTHESIS_STATUSES = ['proposed', 'probing', 'confirmed', 'rejected', 'resolved'] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
export const ACTIVE_STATUSES: readonly HypothesisStatus[] = ['proposed', 'probing', 'confirmed'];
export type Uncertainty = 'low' | 'medium' | 'high';

export const hypothesisTemplateSchema = z.object({
  id, kind: z.enum(HYPOTHESIS_KINDS), statement: z.string().trim().min(1).max(500),
  objectiveIds: z.array(id).min(1).max(20), critical: z.boolean().optional(), prerequisiteObjectiveId: id.optional(),
});
export type HypothesisTemplate = z.infer<typeof hypothesisTemplateSchema>;
const probeSignalSchema = z.union([
  z.object({ hypothesisId: id, optionIds: z.array(z.string().min(1).max(200)).min(1).max(20) }),
  z.object({ hypothesisId: id, outcome: z.enum(['correct', 'incorrect', 'abstained']) }),
]);
export const diagnosticProbeSchema = z.object({
  id, objectiveId: id, assessmentId: z.string().min(1).max(200),
  distinguishes: z.array(id).min(2).max(8), signals: z.array(probeSignalSchema).min(1).max(32),
});
export type DiagnosticProbe = z.infer<typeof diagnosticProbeSchema>;

interface BundleAssessment { id: string; type: string; objectiveIds: string[]; familyId?: string; misconceptionIds?: unknown;
  options?: { id: string; text?: string; misconceptionId?: unknown }[] }
interface Bundle { objectives?: { id: string }[]; assessments?: BundleAssessment[]; gates?: { assessmentIds: string[] }[];
  placement?: { assessmentIds?: string[] }; retention?: { assessmentIds?: string[] }; hypotheses?: unknown; probes?: unknown }

export interface TeachingContracts {
  templates: Map<string, HypothesisTemplate>;
  probes: DiagnosticProbe[];
  /** Hypothesis templates a wrong answer to this item points at, and how specifically. */
  links(assessmentId: string, answer: unknown): { templateIds: string[]; specificity: 'option' | 'item' | 'none' };
  /** Templates an item can expose or rule out (option or item level). */
  itemTemplates(assessmentId: string): string[];
}

/** Reads SDK 0.5 teaching contracts from a compiled server bundle. A probe item
 * that also counts toward a gate, placement or retention is unusable: probe
 * answers must never be (or pre-expose) evidence. Probes are limited to
 * deterministic choice/numeric items. */
export function teachingContracts(course: unknown): TeachingContracts {
  const bundle = (course ?? {}) as Bundle, objectives = new Set((bundle.objectives ?? []).map(o => o.id));
  const templates = new Map<string, HypothesisTemplate>();
  for (const raw of Array.isArray(bundle.hypotheses) ? bundle.hypotheses : []) {
    const parsed = hypothesisTemplateSchema.safeParse(raw);
    if (parsed.success && !templates.has(parsed.data.id) && parsed.data.objectiveIds.every(o => objectives.has(o))) templates.set(parsed.data.id, parsed.data);
  }
  const assessments = new Map((bundle.assessments ?? []).map(a => [a.id, a]));
  const protectedItems = new Set([...(bundle.gates ?? []).flatMap(g => g.assessmentIds ?? []),
    ...(bundle.placement?.assessmentIds ?? []), ...(bundle.retention?.assessmentIds ?? [])]);
  const probes: DiagnosticProbe[] = [];
  for (const raw of Array.isArray(bundle.probes) ? bundle.probes : []) {
    const parsed = diagnosticProbeSchema.safeParse(raw);
    if (!parsed.success) continue;
    const probe = parsed.data, item = assessments.get(probe.assessmentId);
    if (!item || protectedItems.has(item.id) || !['choice', 'numeric'].includes(item.type)) continue;
    if (!probe.distinguishes.every(t => templates.has(t)) || !probe.signals.every(s => probe.distinguishes.includes(s.hypothesisId))) continue;
    if (probes.some(p => p.id === probe.id)) continue;
    probes.push(probe);
  }
  const known = (values: unknown): string[] => Array.isArray(values) ? [...new Set(values.filter((v): v is string => typeof v === 'string' && templates.has(v)))] : [];
  return {
    templates, probes,
    links(assessmentId, answer) {
      const item = assessments.get(assessmentId);
      if (!item) return { templateIds: [], specificity: 'none' };
      if (item.type === 'choice' && typeof answer === 'string') {
        const option = item.options?.find(o => o.id === answer);
        if (option && typeof option.misconceptionId === 'string' && templates.has(option.misconceptionId)) return { templateIds: [option.misconceptionId], specificity: 'option' };
      }
      const itemLevel = known(item.misconceptionIds);
      return itemLevel.length ? { templateIds: itemLevel, specificity: 'item' } : { templateIds: [], specificity: 'none' };
    },
    itemTemplates(assessmentId) {
      const item = assessments.get(assessmentId);
      if (!item) return [];
      return [...new Set([...known(item.misconceptionIds), ...known((item.options ?? []).map(o => o.misconceptionId))])];
    },
  };
}

export type TeachingActionKind = 'contrast_case' | 'change_representation' | 'visit_prerequisite' | 'transfer_check'
  | 'worked_example' | 'compress_advance' | 'reevaluate' | 'prepare_review';
export type ConfidenceLevel = 'low' | 'medium' | 'high';
export type TeachingSignal =
  | { kind: 'answer'; attemptId: string; assessmentId: string; objectiveIds: string[]; outcome: 'correct' | 'incorrect' | 'abstained';
      linkedTemplateIds: string[]; linkSpecificity: 'option' | 'item' | 'none'; itemTemplateIds: string[];
      confidence: ConfidenceLevel | null; independent: boolean }
  | { kind: 'companion_question'; eventId: string; episodeId: string; objectiveIds: string[] }
  | { kind: 'grade_challenged'; attemptId: string; objectiveIds: string[] }
  | { kind: 'review_due'; objectiveIds: string[] };

export interface HypothesisState { id: string; templateId: string | null; kind: HypothesisKind; status: HypothesisStatus; pinned: boolean;
  rejectedBy: 'learner' | 'evidence' | 'supervisor' | null; objectiveIds: string[]; evidenceAttemptIds: string[]; expired: boolean }
export interface TriggerState {
  hypotheses: HypothesisState[];
  /** Earlier signals in the policy window, excluding this one. */
  recentIncorrectUnlinked: Record<string, number>;
  recentAbstained: Record<string, number>;
  recentQuestionsInEpisode: number;
  openProbeRuns: number;
  probeRunsToday: number;
  probeRunsByTemplate: Record<string, number>;
  independentAssessmentActive: boolean;
  /** `${action}:${objectiveId}` recommended within the cooldown. */
  recentRecommendations: string[];
}
export interface TriggerPolicy {
  maxActiveHypotheses: number; maxOpenProbeRuns: number; maxProbeRunsPerDay: number; maxProbeRunsPerTemplate: number;
  repeatedErrorThreshold: number; companionQuestionThreshold: number; abstainThreshold: number;
  windowHours: number; recommendationCooldownMinutes: number; proposedExpiryDays: number; probeExpiryDays: number;
}
export const DEFAULT_TRIGGER_POLICY: Readonly<TriggerPolicy> = Object.freeze({
  maxActiveHypotheses: 8, maxOpenProbeRuns: 2, maxProbeRunsPerDay: 3, maxProbeRunsPerTemplate: 2,
  repeatedErrorThreshold: 2, companionQuestionThreshold: 3, abstainThreshold: 2,
  windowHours: 24, recommendationCooldownMinutes: 60, proposedExpiryDays: 30, probeExpiryDays: 7,
});

export type TriggerEffect =
  | { kind: 'propose_hypothesis'; templateId: string; status: 'proposed' | 'probing'; uncertainty: 'medium' | 'high' }
  | { kind: 'observe_hypothesis'; hypothesisId: string; supports: boolean }
  | { kind: 'set_status'; hypothesisId: string; status: HypothesisStatus; uncertainty: Uncertainty }
  | { kind: 'schedule_probe'; probeId: string; templateIds: string[] };
export interface Recommendation { action: TeachingActionKind; objectiveIds: string[]; ruleId: string }
export interface TriggerDecision {
  ruleIds: string[];
  effects: TriggerEffect[];
  recommendations: Recommendation[];
  restraints: string[];
  skipped: { ruleId: string; what: string; reason: string }[];
  /** Always false: a trigger decision never adds, removes or lowers evidence. */
  affectsEvidence: false;
}

/** The table itself, for documentation, admin display and per-row tests. */
export const TEACHING_TRIGGER_TABLE = Object.freeze([
  { id: 'T1', signal: 'Wrong answer whose chosen option (or only linked hypothesis) names a misconception', action: 'Propose that hypothesis with high uncertainty; a confident wrong answer also recommends a contrast case.', restraint: 'One error never confirms a stable misconception.' },
  { id: 'T2', signal: 'Wrong answer linked to several competing hypotheses', action: 'Schedule a discriminating probe instead of guessing.', restraint: 'No hypothesis is proposed from an ambiguous error.' },
  { id: 'T3', signal: 'Repeated error on a fresh item for an active hypothesis', action: 'Record the observation, move it to probing, schedule a discriminating probe and recommend a change of representation.', restraint: 'Learner-pinned or learner-rejected hypotheses are not changed by the trigger.' },
  { id: 'T4', signal: 'Repeated wrong answers with no misconception link', action: 'Recommend a prerequisite visit; propose a declared missing-prerequisite hypothesis.', restraint: 'A single unlinked error proposes nothing.' },
  { id: 'T5', signal: 'Repeated companion questions in one lesson', action: 'Recommend a change of representation; propose a declared missing-prerequisite hypothesis.', restraint: 'A question never lowers skill evidence.' },
  { id: 'T6', signal: 'Correct answer with low confidence', action: 'Recommend a novel transfer check.', restraint: 'Confidence alone never passes or fails anything.' },
  { id: 'T7', signal: '“I don’t know”', action: 'Recommend a worked example; repeated abstaining proposes a declared missing-prerequisite hypothesis.', restraint: 'Abstaining is not a misconception.' },
  { id: 'T8', signal: 'Strong independent evidence', action: 'Record counter-evidence; resolve confirmed hypotheses it rules out; otherwise recommend compressing repetition.', restraint: 'Required objectives and delayed checks are preserved.' },
  { id: 'T9', signal: 'Grade or source challenged', action: 'Recommend re-evaluation of affected teaching.', restraint: 'History is preserved; defective items are invalidated explicitly.' },
  { id: 'T10', signal: 'Review due or session ended', action: 'Recommend preparing the next review within budget.', restraint: 'Notifications follow explicit preferences.' },
] as const);

const active = (h: HypothesisState) => ACTIVE_STATUSES.includes(h.status) && !h.expired;
function templatesFor(contracts: Pick<TeachingContracts, 'templates'>, kind: HypothesisKind, objectiveIds: string[]) {
  // A template applies to the objectives it is about (for a missing prerequisite:
  // the objective being studied, not the prerequisite itself).
  return [...contracts.templates.values()].filter(t => t.kind === kind && t.objectiveIds.some(o => objectiveIds.includes(o)));
}

export function evaluateTriggers(signal: TeachingSignal, state: TriggerState, contracts: Pick<TeachingContracts, 'templates' | 'probes'>,
  policy: TriggerPolicy = DEFAULT_TRIGGER_POLICY): TriggerDecision {
  const decision: TriggerDecision = { ruleIds: [], effects: [], recommendations: [], restraints: [], skipped: [], affectsEvidence: false };
  const rule = (ruleId: string) => { if (!decision.ruleIds.includes(ruleId)) decision.ruleIds.push(ruleId); };
  const restrain = (text: string) => { if (!decision.restraints.includes(text)) decision.restraints.push(text); };
  let activeCount = state.hypotheses.filter(active).length, openProbes = state.openProbeRuns, probesToday = state.probeRunsToday;
  const probesByTemplate = { ...state.probeRunsByTemplate };
  const byTemplate = (templateId: string) => state.hypotheses.find(h => h.templateId === templateId && (active(h) || h.rejectedBy === 'learner'));
  const recommend = (ruleId: string, action: TeachingActionKind, objectiveIds: string[]) => {
    if (objectiveIds.length && objectiveIds.every(o => state.recentRecommendations.includes(`${action}:${o}`))) {
      decision.skipped.push({ ruleId, what: `recommend:${action}`, reason: 'recommendation_cooldown' }); return;
    }
    if (!decision.recommendations.some(r => r.action === action)) decision.recommendations.push({ action, objectiveIds, ruleId });
  };
  const propose = (ruleId: string, templateId: string, status: 'proposed' | 'probing', uncertainty: 'medium' | 'high') => {
    const existing = byTemplate(templateId);
    if (existing?.rejectedBy === 'learner') { decision.skipped.push({ ruleId, what: `propose:${templateId}`, reason: 'learner_rejected_hypothesis' }); restrain('learner_rejection_is_respected'); return false; }
    if (existing) return false;
    if (decision.effects.some(e => e.kind === 'propose_hypothesis' && e.templateId === templateId)) return false;
    if (activeCount >= policy.maxActiveHypotheses) { decision.skipped.push({ ruleId, what: `propose:${templateId}`, reason: 'active_hypothesis_cap' }); return false; }
    activeCount++;
    decision.effects.push({ kind: 'propose_hypothesis', templateId, status, uncertainty });
    return true;
  };
  /** Pick a declared probe that separates the given templates, within caps. */
  const probe = (ruleId: string, templateIds: string[]) => {
    const candidates = contracts.probes.filter(p => templateIds.every(t => p.distinguishes.includes(t)) || (templateIds.length === 1 && p.distinguishes.includes(templateIds[0]!)));
    const what = `probe:${templateIds.join('+')}`;
    if (!candidates.length) { decision.skipped.push({ ruleId, what, reason: 'no_discriminating_probe' }); return; }
    if (state.independentAssessmentActive) { decision.skipped.push({ ruleId, what, reason: 'independent_assessment_active' }); return; }
    if (openProbes >= policy.maxOpenProbeRuns) { decision.skipped.push({ ruleId, what, reason: 'open_probe_cap' }); return; }
    if (probesToday >= policy.maxProbeRunsPerDay) { decision.skipped.push({ ruleId, what, reason: 'daily_probe_cap' }); return; }
    const chosen = candidates.find(p => p.distinguishes.every(t => (probesByTemplate[t] ?? 0) < policy.maxProbeRunsPerTemplate));
    if (!chosen) { decision.skipped.push({ ruleId, what, reason: 'per_hypothesis_probe_cap' }); return; }
    if (decision.effects.some(e => e.kind === 'schedule_probe' && e.probeId === chosen.id)) return;
    openProbes++; probesToday++;
    for (const t of chosen.distinguishes) probesByTemplate[t] = (probesByTemplate[t] ?? 0) + 1;
    decision.effects.push({ kind: 'schedule_probe', probeId: chosen.id, templateIds: chosen.distinguishes.filter(t => contracts.templates.has(t)) });
  };
  const prerequisiteTemplates = (objectiveIds: string[]) => templatesFor(contracts, 'missing_prerequisite', objectiveIds);

  if (signal.kind === 'answer' && signal.outcome === 'incorrect') {
    if (signal.linkSpecificity === 'none' || !signal.linkedTemplateIds.length) {
      restrain('no_misconception_link');
      const repeated = signal.objectiveIds.filter(o => (state.recentIncorrectUnlinked[o] ?? 0) + 1 >= policy.repeatedErrorThreshold);
      if (repeated.length) {
        rule('T4');
        recommend('T4', 'visit_prerequisite', repeated);
        for (const t of prerequisiteTemplates(repeated)) propose('T4', t.id, 'proposed', 'high');
      }
      return decision;
    }
    const linked = signal.linkedTemplateIds;
    const existing = linked.map(t => ({ templateId: t, hypothesis: byTemplate(t) }));
    const fresh = (h: HypothesisState) => !h.evidenceAttemptIds.includes(signal.attemptId);
    if (signal.linkSpecificity === 'item' && linked.length > 1 && !existing.some(e => e.hypothesis && active(e.hypothesis))) {
      rule('T2'); restrain('ambiguous_error_needs_discriminating_probe');
      probe('T2', linked);
      return decision;
    }
    for (const { templateId, hypothesis } of existing) {
      if (hypothesis?.rejectedBy === 'learner') { rule('T3'); decision.skipped.push({ ruleId: 'T3', what: `observe:${templateId}`, reason: 'learner_rejected_hypothesis' }); restrain('learner_rejection_is_respected'); continue; }
      if (hypothesis && active(hypothesis)) {
        rule('T3');
        if (!fresh(hypothesis)) continue;
        decision.effects.push({ kind: 'observe_hypothesis', hypothesisId: hypothesis.id, supports: true });
        if (hypothesis.pinned) { restrain('learner_pinned_hypothesis_unchanged'); decision.skipped.push({ ruleId: 'T3', what: `status:${hypothesis.id}`, reason: 'learner_pinned' }); }
        else if (hypothesis.status === 'proposed') decision.effects.push({ kind: 'set_status', hypothesisId: hypothesis.id, status: 'probing', uncertainty: 'medium' });
        if (hypothesis.status !== 'confirmed') probe('T3', [templateId]);
        recommend('T3', 'change_representation', signal.objectiveIds);
        continue;
      }
      rule('T1'); restrain('single_error_is_not_a_stable_misconception');
      propose('T1', templateId, 'proposed', 'high');
      if (signal.confidence === 'high') recommend('T1', 'contrast_case', signal.objectiveIds);
    }
    return decision;
  }
  if (signal.kind === 'answer' && signal.outcome === 'abstained') {
    rule('T7'); restrain('abstain_is_not_a_misconception');
    recommend('T7', 'worked_example', signal.objectiveIds);
    const repeated = signal.objectiveIds.filter(o => (state.recentAbstained[o] ?? 0) + 1 >= policy.abstainThreshold);
    for (const t of prerequisiteTemplates(repeated)) propose('T7', t.id, 'proposed', 'high');
    return decision;
  }
  if (signal.kind === 'answer') {
    restrain('confidence_alone_never_passes_or_fails');
    if (signal.confidence === 'low') { rule('T6'); recommend('T6', 'transfer_check', signal.objectiveIds); return decision; }
    if (!signal.independent) return decision;
    rule('T8'); restrain('preserve_required_objectives_and_delayed_checks');
    const countered = state.hypotheses.filter(h => active(h) && h.templateId && signal.itemTemplateIds.includes(h.templateId) && !h.evidenceAttemptIds.includes(signal.attemptId));
    for (const h of countered) {
      decision.effects.push({ kind: 'observe_hypothesis', hypothesisId: h.id, supports: false });
      if (h.status === 'confirmed' && !h.pinned) decision.effects.push({ kind: 'set_status', hypothesisId: h.id, status: 'resolved', uncertainty: 'medium' });
      else if (h.pinned) { restrain('learner_pinned_hypothesis_unchanged'); decision.skipped.push({ ruleId: 'T8', what: `status:${h.id}`, reason: 'learner_pinned' }); }
    }
    const open = state.hypotheses.some(h => active(h) && h.objectiveIds.some(o => signal.objectiveIds.includes(o)));
    if (!open) recommend('T8', 'compress_advance', signal.objectiveIds);
    return decision;
  }
  if (signal.kind === 'companion_question') {
    restrain('question_never_lowers_evidence');
    if (state.recentQuestionsInEpisode + 1 < policy.companionQuestionThreshold) return decision;
    rule('T5');
    recommend('T5', 'change_representation', signal.objectiveIds);
    for (const t of prerequisiteTemplates(signal.objectiveIds)) propose('T5', t.id, 'proposed', 'high');
    return decision;
  }
  if (signal.kind === 'grade_challenged') {
    rule('T9'); restrain('preserve_history_invalidate_explicitly');
    recommend('T9', 'reevaluate', signal.objectiveIds);
    return decision;
  }
  rule('T10'); restrain('notifications_follow_explicit_preferences');
  recommend('T10', 'prepare_review', signal.objectiveIds);
  return decision;
}

/** How a probe answer bears on the hypotheses it separates. Inconclusive when
 * no declared signal matches: then nothing is confirmed or ruled out. */
export function interpretProbe(probe: DiagnosticProbe, answer: { optionId?: string; outcome: 'correct' | 'incorrect' | 'abstained' }) {
  const supported = [...new Set(probe.signals.filter(s => 'optionIds' in s ? answer.optionId !== undefined && s.optionIds.includes(answer.optionId) : s.outcome === answer.outcome).map(s => s.hypothesisId))];
  return { supported, ruledOut: supported.length ? probe.distinguishes.filter(t => !supported.includes(t)) : [], conclusive: supported.length > 0 };
}

/** Status changes a probe result makes. Learner-pinned and learner-rejected
 * hypotheses only receive the observation. Confirmation needs the probe plus
 * at least one earlier observation (the probe is never the only support). */
export function probeEffects(hypotheses: (HypothesisState & { observations: number })[], interpretation: ReturnType<typeof interpretProbe>) {
  const effects: TriggerEffect[] = [], restraints: string[] = ['probe_is_never_assessment_evidence'];
  for (const h of hypotheses) {
    if (!h.templateId) continue;
    const supports = interpretation.supported.includes(h.templateId), against = interpretation.ruledOut.includes(h.templateId);
    if (!supports && !against) continue;
    effects.push({ kind: 'observe_hypothesis', hypothesisId: h.id, supports });
    if (h.pinned || h.rejectedBy === 'learner' || !active(h)) { if (h.pinned) restraints.push('learner_pinned_hypothesis_unchanged'); continue; }
    if (supports && h.observations >= 1 && h.status !== 'confirmed') effects.push({ kind: 'set_status', hypothesisId: h.id, status: 'confirmed', uncertainty: 'low' });
    if (against) effects.push({ kind: 'set_status', hypothesisId: h.id, status: 'rejected', uncertainty: 'low' });
  }
  return { effects, restraints: [...new Set(restraints)] };
}

/** Map a 1..maximum confidence rating onto low/medium/high thirds. */
export function confidenceLevel(value: number | null | undefined, maximum = 5): ConfidenceLevel | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum || maximum < 2) return null;
  const position = (value - 1) / (maximum - 1);
  return position < 1 / 3 ? 'low' : position > 2 / 3 ? 'high' : 'medium';
}
