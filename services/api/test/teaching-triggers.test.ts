import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIGGER_POLICY, TEACHING_TRIGGER_TABLE, confidenceLevel, evaluateTriggers, interpretProbe, probeEffects, teachingContracts,
  type HypothesisState, type TeachingSignal, type TriggerState,
} from '../src/teaching-triggers.js';
import { hypothesisCourse, hypothesisSource } from './hypothesis-fixture.js';

const contracts = teachingContracts(hypothesisCourse().server);
const empty = (): TriggerState => ({ hypotheses: [], recentIncorrectUnlinked: {}, recentAbstained: {}, recentQuestionsInEpisode: 0, openProbeRuns: 0,
  probeRunsToday: 0, probeRunsByTemplate: {}, independentAssessmentActive: false, recentRecommendations: [] });
const answer = (patch: Partial<Extract<TeachingSignal, { kind: 'answer' }>>): TeachingSignal => ({ kind: 'answer', attemptId: 'a1', assessmentId: 'min-practice',
  objectiveIds: ['minimum'], outcome: 'incorrect', linkedTemplateIds: ['min-largest'], linkSpecificity: 'option', itemTemplateIds: ['min-largest', 'min-first'],
  confidence: null, independent: false, ...patch });
const hypothesis = (patch: Partial<HypothesisState>): HypothesisState => ({ id: 'h1', templateId: 'min-largest', kind: 'misconception', status: 'proposed', pinned: false,
  rejectedBy: null, objectiveIds: ['minimum'], evidenceAttemptIds: ['a0'], expired: false, ...patch });

describe('course contracts', () => {
  it('reads SDK 0.5 templates, probes and links; a bundle without them has none', () => {
    expect([...contracts.templates.keys()]).toEqual(['min-largest', 'min-first', 'max-needs-min']);
    expect(contracts.probes.map(p => p.id)).toEqual(['min-probe']);
    expect(contracts.links('min-practice', 'nine')).toEqual({ templateIds: ['min-largest'], specificity: 'option' });
    expect(contracts.links('min-ambiguous', 'eight')).toEqual({ templateIds: ['min-largest', 'min-first'], specificity: 'item' });
    expect(contracts.links('min-b', 7)).toEqual({ templateIds: [], specificity: 'none' });
    const plain = teachingContracts(hypothesisSource());
    expect(plain.templates.size + plain.probes.length).toBe(0);
  });
  it('refuses probes whose item counts toward a gate, placement or retention, shares a family with one, and malformed entries', () => {
    const server = structuredClone(hypothesisCourse().server) as any;
    const gateItem = server.assessments.find((a: { id: string }) => a.id === 'min-a');
    server.assessments.push({ ...structuredClone(server.assessments.find((a: { id: string }) => a.id === 'min-probe-item')), id: 'gate-family-twin', familyId: gateItem.familyId });
    server.probes.push({ ...server.probes[0], id: 'gate-probe', assessmentId: 'min-a' }, { id: 'Bad Id', objectiveId: 'minimum' },
      { ...server.probes[0], id: 'gate-family-probe', assessmentId: 'gate-family-twin' },
      { ...server.probes[0], id: 'unknown-hypothesis', distinguishes: ['min-largest', 'nope'] });
    server.hypotheses.push({ id: 'off-course', kind: 'misconception', statement: 'x', objectiveIds: ['not-an-objective'] });
    const read = teachingContracts(server);
    expect(read.probes.map(p => p.id)).toEqual(['min-probe']);
    expect(read.templates.has('off-course')).toBe(false);
  });
});

describe('trigger table rows', () => {
  it('documents every row it implements', () => {
    expect(TEACHING_TRIGGER_TABLE.map(r => r.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10']);
  });
  it('T1: a first linked wrong answer proposes with high uncertainty and never confirms', () => {
    const d = evaluateTriggers(answer({}), empty(), contracts);
    expect(d.ruleIds).toEqual(['T1']);
    expect(d.effects).toEqual([{ kind: 'propose_hypothesis', templateId: 'min-largest', status: 'proposed', uncertainty: 'high' }]);
    expect(d.restraints).toContain('single_error_is_not_a_stable_misconception');
    expect(d.effects.some(e => e.kind === 'set_status' && e.status === 'confirmed')).toBe(false);
    expect(d.recommendations).toEqual([]);
    expect(d.affectsEvidence).toBe(false);
  });
  it('T1: a confident wrong answer also recommends a contrast case', () => {
    const d = evaluateTriggers(answer({ confidence: 'high' }), empty(), contracts);
    expect(d.recommendations).toEqual([{ action: 'contrast_case', objectiveIds: ['minimum'], ruleId: 'T1' }]);
  });
  it('T2: an ambiguous error schedules a discriminating probe and proposes nothing', () => {
    const d = evaluateTriggers(answer({ assessmentId: 'min-ambiguous', linkedTemplateIds: ['min-largest', 'min-first'], linkSpecificity: 'item' }), empty(), contracts);
    expect(d.ruleIds).toEqual(['T2']);
    expect(d.effects).toEqual([{ kind: 'schedule_probe', probeId: 'min-probe', templateIds: ['min-largest', 'min-first'] }]);
    expect(d.effects.some(e => e.kind === 'propose_hypothesis')).toBe(false);
  });
  it('T2: the probe waits while an independent check is open, or when caps are reached', () => {
    const signal = answer({ linkedTemplateIds: ['min-largest', 'min-first'], linkSpecificity: 'item' });
    expect(evaluateTriggers(signal, { ...empty(), independentAssessmentActive: true }, contracts).skipped[0]!.reason).toBe('independent_assessment_active');
    expect(evaluateTriggers(signal, { ...empty(), openProbeRuns: 2 }, contracts).skipped[0]!.reason).toBe('open_probe_cap');
    expect(evaluateTriggers(signal, { ...empty(), probeRunsToday: 3 }, contracts).skipped[0]!.reason).toBe('daily_probe_cap');
    expect(evaluateTriggers(signal, { ...empty(), probeRunsByTemplate: { 'min-largest': 2 } }, contracts).skipped[0]!.reason).toBe('per_hypothesis_probe_cap');
    expect(evaluateTriggers(signal, empty(), { ...contracts, probes: [] }).skipped[0]!.reason).toBe('no_discriminating_probe');
  });
  it('T3: a repeated error on a fresh item escalates to probing, probes and changes representation', () => {
    const d = evaluateTriggers(answer({ attemptId: 'a2' }), { ...empty(), hypotheses: [hypothesis({})] }, contracts);
    expect(d.ruleIds).toEqual(['T3']);
    expect(d.effects).toEqual([
      { kind: 'observe_hypothesis', hypothesisId: 'h1', supports: true },
      { kind: 'set_status', hypothesisId: 'h1', status: 'probing', uncertainty: 'medium' },
      { kind: 'schedule_probe', probeId: 'min-probe', templateIds: ['min-largest', 'min-first'] },
    ]);
    expect(d.recommendations.map(r => r.action)).toEqual(['change_representation']);
  });
  it('T3: the same attempt never counts twice', () => {
    const d = evaluateTriggers(answer({ attemptId: 'a0' }), { ...empty(), hypotheses: [hypothesis({})] }, contracts);
    expect(d.effects).toEqual([]);
  });
  it('T3: a learner pin keeps the status; a learner rejection blocks re-proposal and observation', () => {
    const pinned = evaluateTriggers(answer({ attemptId: 'a2' }), { ...empty(), hypotheses: [hypothesis({ pinned: true })] }, contracts);
    expect(pinned.effects.filter(e => e.kind === 'set_status')).toEqual([]);
    expect(pinned.restraints).toContain('learner_pinned_hypothesis_unchanged');
    const rejected = evaluateTriggers(answer({ attemptId: 'a2' }), { ...empty(), hypotheses: [hypothesis({ status: 'rejected', rejectedBy: 'learner' })] }, contracts);
    expect(rejected.effects).toEqual([]);
    expect(rejected.skipped.map(s => s.reason)).toEqual(['learner_rejected_hypothesis']);
  });
  it('T1 respects the active-hypothesis cap', () => {
    const many = Array.from({ length: 8 }, (_, i) => hypothesis({ id: 'h' + i, templateId: null }));
    const d = evaluateTriggers(answer({}), { ...empty(), hypotheses: many }, contracts);
    expect(d.effects).toEqual([]);
    expect(d.skipped[0]!.reason).toBe('active_hypothesis_cap');
  });
  it('T4: one unlinked error proposes nothing; repeated ones recommend a prerequisite and its declared hypothesis', () => {
    const unlinked = answer({ assessmentId: 'max-a', objectiveIds: ['maximum'], linkedTemplateIds: [], linkSpecificity: 'none', itemTemplateIds: [] });
    const once = evaluateTriggers(unlinked, empty(), contracts);
    expect(once.ruleIds).toEqual([]);
    expect(once.effects).toEqual([]);
    expect(once.restraints).toEqual(['no_misconception_link']);
    const twice = evaluateTriggers(unlinked, { ...empty(), recentIncorrectUnlinked: { maximum: 1 } }, contracts);
    expect(twice.ruleIds).toEqual(['T4']);
    expect(twice.recommendations.map(r => r.action)).toEqual(['visit_prerequisite']);
    expect(twice.effects).toEqual([{ kind: 'propose_hypothesis', templateId: 'max-needs-min', status: 'proposed', uncertainty: 'high' }]);
  });
  it('T5: repeated companion questions change representation; a question never lowers evidence', () => {
    const signal: TeachingSignal = { kind: 'companion_question', eventId: 'e1', episodeId: 'max', objectiveIds: ['maximum'] };
    expect(evaluateTriggers(signal, { ...empty(), recentQuestionsInEpisode: 1 }, contracts).ruleIds).toEqual([]);
    const d = evaluateTriggers(signal, { ...empty(), recentQuestionsInEpisode: 2 }, contracts);
    expect(d.ruleIds).toEqual(['T5']);
    expect(d.recommendations.map(r => r.action)).toEqual(['change_representation']);
    expect(d.effects).toEqual([{ kind: 'propose_hypothesis', templateId: 'max-needs-min', status: 'proposed', uncertainty: 'high' }]);
    expect(d.restraints).toContain('question_never_lowers_evidence');
    expect(d.affectsEvidence).toBe(false);
  });
  it('T6: low confidence on a correct answer recommends a transfer check and changes nothing else', () => {
    const d = evaluateTriggers(answer({ outcome: 'correct', confidence: 'low', linkedTemplateIds: [], linkSpecificity: 'none', independent: true }), empty(), contracts);
    expect(d.ruleIds).toEqual(['T6']);
    expect(d.effects).toEqual([]);
    expect(d.recommendations.map(r => r.action)).toEqual(['transfer_check']);
    expect(d.restraints).toContain('confidence_alone_never_passes_or_fails');
  });
  it('T7: “I don’t know” is not a misconception; repeating it proposes a declared prerequisite', () => {
    const idk = answer({ assessmentId: 'max-a', objectiveIds: ['maximum'], outcome: 'abstained', linkedTemplateIds: [], linkSpecificity: 'none' });
    const once = evaluateTriggers(idk, empty(), contracts);
    expect(once.ruleIds).toEqual(['T7']);
    expect(once.effects).toEqual([]);
    expect(once.recommendations.map(r => r.action)).toEqual(['worked_example']);
    expect(once.restraints).toContain('abstain_is_not_a_misconception');
    const again = evaluateTriggers(idk, { ...empty(), recentAbstained: { maximum: 1 } }, contracts);
    expect(again.effects).toEqual([{ kind: 'propose_hypothesis', templateId: 'max-needs-min', status: 'proposed', uncertainty: 'high' }]);
  });
  it('T8: strong independent evidence resolves confirmed hypotheses it rules out, never pinned ones', () => {
    const signal = answer({ attemptId: 'a9', outcome: 'correct', independent: true, confidence: 'high', linkedTemplateIds: [], linkSpecificity: 'none' });
    const d = evaluateTriggers(signal, { ...empty(), hypotheses: [hypothesis({ status: 'confirmed' }), hypothesis({ id: 'h2', templateId: 'min-first', status: 'confirmed', pinned: true })] }, contracts);
    expect(d.ruleIds).toEqual(['T8']);
    expect(d.effects).toEqual([
      { kind: 'observe_hypothesis', hypothesisId: 'h1', supports: false },
      { kind: 'set_status', hypothesisId: 'h1', status: 'resolved', uncertainty: 'medium' },
      { kind: 'observe_hypothesis', hypothesisId: 'h2', supports: false },
    ]);
    expect(d.recommendations).toEqual([]);
    const clear = evaluateTriggers(signal, empty(), contracts);
    expect(clear.recommendations.map(r => r.action)).toEqual(['compress_advance']);
    expect(clear.restraints).toContain('preserve_required_objectives_and_delayed_checks');
  });
  it('T8 needs independent work: practice success changes nothing', () => {
    const d = evaluateTriggers(answer({ outcome: 'correct', independent: false, linkedTemplateIds: [], linkSpecificity: 'none' }), { ...empty(), hypotheses: [hypothesis({ status: 'confirmed' })] }, contracts);
    expect(d.effects).toEqual([]);
  });
  it('T9 and T10 recommend re-evaluation and review preparation only', () => {
    const challenged = evaluateTriggers({ kind: 'grade_challenged', attemptId: 'a1', objectiveIds: ['minimum'] }, empty(), contracts);
    expect([challenged.ruleIds, challenged.recommendations.map(r => r.action), challenged.effects]).toEqual([['T9'], ['reevaluate'], []]);
    const due = evaluateTriggers({ kind: 'review_due', objectiveIds: ['minimum'] }, empty(), contracts);
    expect([due.ruleIds, due.recommendations.map(r => r.action), due.effects]).toEqual([['T10'], ['prepare_review'], []]);
  });
  it('T10 session ended prepares the next lesson, once per cooldown, and nothing when every lesson is finished', () => {
    const ended = evaluateTriggers({ kind: 'session_ended', objectiveIds: ['minimum'] }, empty(), contracts);
    expect([ended.ruleIds, ended.recommendations.map(r => r.action), ended.effects, ended.affectsEvidence]).toEqual([['T10'], ['prepare_review'], [], false]);
    expect(ended.restraints).toEqual(expect.arrayContaining(['notifications_follow_explicit_preferences', 'one_preparation_per_session']));
    // A review that came due for the same objective just now: not prepared twice.
    const coalesced = evaluateTriggers({ kind: 'session_ended', objectiveIds: ['minimum'] }, { ...empty(), recentRecommendations: ['prepare_review:minimum'] }, contracts);
    expect([coalesced.recommendations, coalesced.skipped.map(s => s.reason)]).toEqual([[], ['recommendation_cooldown']]);
    const finished = evaluateTriggers({ kind: 'session_ended', objectiveIds: [] }, empty(), contracts);
    expect([finished.recommendations, finished.skipped]).toEqual([[], [{ ruleId: 'T10', what: 'recommend:prepare_review', reason: 'nothing_to_prepare' }]]);
  });
  it('a recommendation inside its cooldown is skipped, not repeated', () => {
    const d = evaluateTriggers(answer({ confidence: 'high' }), { ...empty(), recentRecommendations: ['contrast_case:minimum'] }, contracts);
    expect(d.recommendations).toEqual([]);
    expect(d.skipped.map(s => s.reason)).toContain('recommendation_cooldown');
  });
});

describe('probe interpretation', () => {
  const probe = contracts.probes[0]!;
  it('a matching option supports one hypothesis and rules out the other', () => {
    expect(interpretProbe(probe, { optionId: 'nine', outcome: 'incorrect' })).toEqual({ supported: ['min-largest'], ruledOut: ['min-first'], conclusive: true });
  });
  it('a correct or abstained answer with no matching signal is inconclusive', () => {
    expect(interpretProbe(probe, { optionId: 'two', outcome: 'correct' })).toEqual({ supported: [], ruledOut: [], conclusive: false });
    expect(interpretProbe(probe, { outcome: 'abstained' }).conclusive).toBe(false);
  });
  it('confirms only with an earlier observation, rejects the ruled-out one and leaves pins alone', () => {
    const states = [{ ...hypothesis({ status: 'probing' }), observations: 1 }, { ...hypothesis({ id: 'h2', templateId: 'min-first', status: 'probing', pinned: true }), observations: 1 }];
    const result = probeEffects(states, interpretProbe(probe, { optionId: 'nine', outcome: 'incorrect' }));
    expect(result.effects).toEqual([
      { kind: 'observe_hypothesis', hypothesisId: 'h1', supports: true },
      { kind: 'set_status', hypothesisId: 'h1', status: 'confirmed', uncertainty: 'low' },
      { kind: 'observe_hypothesis', hypothesisId: 'h2', supports: false },
    ]);
    expect(result.restraints).toEqual(['probe_is_never_assessment_evidence', 'learner_pinned_hypothesis_unchanged']);
    const unobserved = probeEffects([{ ...hypothesis({ status: 'probing' }), observations: 0 }], interpretProbe(probe, { optionId: 'nine', outcome: 'incorrect' }));
    expect(unobserved.effects.filter(e => e.kind === 'set_status')).toEqual([]);
  });
});

it('maps confidence ratings to thirds of the declared scale', () => {
  expect([1, 2, 3, 4, 5].map(v => confidenceLevel(v))).toEqual(['low', 'low', 'medium', 'high', 'high']);
  expect([1, 2, 3].map(v => confidenceLevel(v, 3))).toEqual(['low', 'medium', 'high']);
  expect([confidenceLevel(0), confidenceLevel(6), confidenceLevel(2.5), confidenceLevel(null)]).toEqual([null, null, null, null]);
  expect(DEFAULT_TRIGGER_POLICY.maxActiveHypotheses).toBeGreaterThan(0);
});
