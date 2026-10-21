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
  it('lists an erased, unreadable or unknown artifact without its body', () => {
    expect(learnerTeachingArtifact('x', {})).toEqual({ artifactId: 'x', erased: true });
    expect(learnerTeachingArtifact('x', null)).toEqual({ artifactId: 'x', erased: true });
    expect(learnerTeachingArtifact('x', { ...base, kind: 'future_kind', secret: 'KEY' })).toEqual({ artifactId: 'x', kind: 'future_kind', objectiveIds: ['o'], sourceRefs: ['s'] });
    expect(learnerTeachingArtifact('x', { ...base, kind: 'assessment_variant', assessment: 'KEY' })).toMatchObject({ question: null });
  });
});
