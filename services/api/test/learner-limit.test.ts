import { describe, expect, it } from 'vitest';
import { effectiveLearnerLimit } from '../src/learner-limit.js';

// The one rule the bridge, authority approvals, run inspector and budgets view share.
describe('the limit that applies to one learner', () => {
  const own = { limit_source: 'own', limit_micro_usd: '500', limit_tokens: '40' };
  const fromDefault = { limit_source: 'default', limit_micro_usd: '0', limit_tokens: '0' };
  it("is the learner's own limit whatever the workspace chose, even zero", () => {
    for (const mode of ['unset', 'limit', 'unlimited'])
      expect(effectiveLearnerLimit(own, { default_enrollment_limit_mode: mode, default_enrollment_limit_micro_usd: '9', default_enrollment_limit_tokens: '9' }))
        .toEqual({ microUsd: 500, tokens: 40 });
    expect(effectiveLearnerLimit({ ...own, limit_micro_usd: '0', limit_tokens: '0' }, { default_enrollment_limit_mode: 'unlimited' })).toEqual({ microUsd: 0, tokens: 0 });
  });
  it('is the workspace amount, none only by the explicit choice, and zero while nothing is chosen', () => {
    expect(effectiveLearnerLimit(fromDefault, { default_enrollment_limit_mode: 'limit', default_enrollment_limit_micro_usd: '2000000', default_enrollment_limit_tokens: '1000000000' }))
      .toEqual({ microUsd: 2_000_000, tokens: 1_000_000_000 });
    expect(effectiveLearnerLimit(fromDefault, { default_enrollment_limit_mode: 'unlimited', default_enrollment_limit_micro_usd: null, default_enrollment_limit_tokens: null })).toBeNull();
    // Missing amounts never mean "no limit": unset, a missing row and an older row all pay for nothing.
    expect(effectiveLearnerLimit(fromDefault, { default_enrollment_limit_mode: 'unset', default_enrollment_limit_micro_usd: null })).toEqual({ microUsd: 0, tokens: 0 });
    expect(effectiveLearnerLimit(undefined, undefined)).toEqual({ microUsd: 0, tokens: 0 });
    expect(effectiveLearnerLimit(fromDefault, { default_enrollment_limit_micro_usd: null, default_enrollment_limit_tokens: null })).toEqual({ microUsd: 0, tokens: 0 });
  });
});
