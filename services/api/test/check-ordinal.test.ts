import { describe, expect, it } from 'vitest';
import { checkOrdinal } from '../src/check-ordinal.js';

// The same example as apps/learner/tests/checkOrdinal.test.ts: both sides number questions alike.
const EXAMPLE = [
  { families: ['a'], required: 2 },
  { families: ['x', 'y', 'z'], required: 1 },
  { families: [], required: 1 },
];

describe('check ordinal', () => {
  it('is one more than the counted successes, objective by objective, capped at the total', () => {
    expect(checkOrdinal(EXAMPLE)).toBe(3);
    expect(checkOrdinal([{ families: [], required: 2 }])).toBe(1);
    expect(checkOrdinal([{ families: ['a', 'b'], required: 2 }])).toBe(2);
    expect(checkOrdinal([])).toBe(1);
  });
});
