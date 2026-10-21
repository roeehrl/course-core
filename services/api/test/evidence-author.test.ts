import { describe, expect, it } from 'vitest';
import { evidenceAuthor } from '../src/learner-model.js';

describe('evidence provenance (C06)', () => {
  it('names who decided a piece of evidence from its evaluator and result, never a staff identity', () => {
    expect(evidenceAuthor('deterministic-choice@1', { passed: true })).toBe('automatic_check');
    expect(evidenceAuthor('reviewed-rubric@1', { passed: true, reviewed: true })).toBe('staff_review');
    expect(evidenceAuthor('reviewed-rubric@1', { passed: true, reviewed: true, confirmation: 'deterministic' })).toBe('automatic_check');
    expect(evidenceAuthor('reviewed-rubric-appeal@1', { passed: false, reviewed: true, appealed: true })).toBe('second_opinion');
    expect(evidenceAuthor('reviewed-rubric-regrade@1', { passed: true })).toBe('staff_regrade');
  });
});
