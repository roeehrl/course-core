import { describe, expect, it } from 'vitest';
import { learnerTeachingArtifact } from '../src/learner-export.js';

const base = { digest: 'd'.repeat(64), generator: { id: 'KEY-generator', version: '1.0.0' }, objectiveIds: ['o'], sourceRefs: ['s'] };

describe('personal teaching in a data export', () => {
  it('keeps what the learner was shown and drops every key, fixture, recipe and generator', () => {
    const variant = learnerTeachingArtifact('v', { ...base, id: 'v', kind: 'assessment_variant', canonicalAssessmentId: 'KEY-canonical',
      assessment: { id: 'q', type: 'choice', objectiveIds: ['o'], familyId: 'KEY-family', prompt: 'Pick one.', misconceptionIds: ['KEY-m'],
        options: [{ id: 'a', text: 'A', misconceptionId: 'KEY-m' }, { id: 'b', text: 'B' }], grading: { correctOptionId: 'b', explanation: 'KEY' }, extra: 'KEY' },
      hiddenFixtures: { cases: ['KEY'] }, recipe: { variables: { a: 'KEY' } } });
    expect(variant).toEqual({ artifactId: 'v', kind: 'assessment_variant', objectiveIds: ['o'], sourceRefs: ['s'],
      question: { id: 'q', type: 'choice', objectiveIds: ['o'], prompt: 'Pick one.', allowAbstain: true, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] } });
    expect(JSON.stringify(variant)).not.toContain('KEY');
    expect(learnerTeachingArtifact('t', { ...base, kind: 'practice', markdown: 'Try it.', extra: 'KEY' }))
      .toEqual({ artifactId: 't', kind: 'practice', objectiveIds: ['o'], sourceRefs: ['s'], markdown: 'Try it.' });
    expect(learnerTeachingArtifact('e', { ...base, kind: 'episode', title: 'More', blocks: [{ id: 'b1', markdown: 'Text', extra: 'KEY' }] }))
      .toEqual({ artifactId: 'e', kind: 'episode', objectiveIds: ['o'], sourceRefs: ['s'], title: 'More', blocks: [{ id: 'b1', markdown: 'Text' }] });
  });
  it('keeps only the learner-facing part of every generated-content kind', () => {
    // A check question keyed by the course's scene model: the derived key, the model and the claimed answer stay out.
    const check = learnerTeachingArtifact('c', { ...base, id: 'c', kind: 'assessment_variant', canonicalAssessmentId: 'KEY-canonical',
      assessment: { id: 'c--item', type: 'numeric', objectiveIds: ['o'], familyId: 'KEY-family', prompt: 'How tall is the bar at x = 3?',
        grading: { expected: 42, absoluteTolerance: 0.5, unit: 'cm', explanation: 'KEY-explanation' } },
      hiddenFixtures: { protocol: 'scene-model-v1', model: { visualId: 'KEY-visual', read: 'KEY-read' }, visualDigest: 'KEY-digest', claimedAnswer: 'KEY-claimed' } });
    expect(check).toEqual({ artifactId: 'c', kind: 'assessment_variant', objectiveIds: ['o'], sourceRefs: ['s'],
      question: { id: 'c--item', type: 'numeric', objectiveIds: ['o'], prompt: 'How tall is the bar at x = 3?', allowAbstain: true, unit: 'cm' } });
    // A code exercise: starter code only; hidden tests, the reference and the wrong solutions stay out.
    const code = learnerTeachingArtifact('x', { ...base, id: 'x', kind: 'assessment_variant', canonicalAssessmentId: 'KEY-canonical',
      assessment: { id: 'x--item', type: 'code', objectiveIds: ['o'], familyId: 'KEY-family', prompt: 'Return the minimum.', language: 'python',
        starterCode: 'def minimum(values):\n    pass\n', grading: { evaluatorId: 'KEY-evaluator', fixtureRef: 'KEY-fixture' } },
      hiddenFixtures: { protocol: 'generated-code-v1', cases: [{ id: 't1', input: 'KEY-input', expected: 'KEY-expected' }],
        referenceSolution: 'KEY-reference', wrongSolutions: ['KEY-wrong'] } });
    expect(code).toEqual({ artifactId: 'x', kind: 'assessment_variant', objectiveIds: ['o'], sourceRefs: ['s'],
      question: { id: 'x--item', type: 'code', objectiveIds: ['o'], prompt: 'Return the minimum.', allowAbstain: true, language: 'python', starterCode: 'def minimum(values):\n    pass\n' } });
    // A simulation is the scene the learner ran; its generator and digest stay out.
    const scene = { id: 'sim', title: 'Bars', scene: { panes: [] } };
    expect(learnerTeachingArtifact('s', { ...base, id: 's', kind: 'visual', visual: scene }))
      .toEqual({ artifactId: 's', kind: 'visual', objectiveIds: ['o'], sourceRefs: ['s'], visual: scene });
    // A component's accessible text alternative is practice Markdown; the component body is elsewhere.
    expect(learnerTeachingArtifact('p', { ...base, id: 'p', kind: 'practice', markdown: 'Move the slider.', component: { tests: ['KEY-test'] } }))
      .toEqual({ artifactId: 'p', kind: 'practice', objectiveIds: ['o'], sourceRefs: ['s'], markdown: 'Move the slider.' });
    expect(JSON.stringify([check, code])).not.toContain('KEY');
  });
  it('lists an erased, unreadable or unknown artifact without its body', () => {
    expect(learnerTeachingArtifact('x', {})).toEqual({ artifactId: 'x', erased: true });
    expect(learnerTeachingArtifact('x', null)).toEqual({ artifactId: 'x', erased: true });
    expect(learnerTeachingArtifact('x', { ...base, kind: 'future_kind', secret: 'KEY' })).toEqual({ artifactId: 'x', kind: 'future_kind', objectiveIds: ['o'], sourceRefs: ['s'] });
    expect(learnerTeachingArtifact('x', { ...base, kind: 'assessment_variant', assessment: 'KEY' })).toMatchObject({ question: null });
  });
});
