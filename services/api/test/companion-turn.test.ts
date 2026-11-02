import { describe, expect, it } from 'vitest';
import { replyAsksLearner } from '../src/companion-turn.js';

describe('a companion reply that asks the learner', () => {
  it('asks when its last paragraph ends with a question mark, in English or Hebrew', () => {
    expect(replyAsksLearner('Compare the first two values.\n\nWhich one is smaller?')).toBe(true);
    expect(replyAsksLearner('השוו את שני הערכים.\n\nאיזה מהם קטן יותר?')).toBe(true);
    expect(replyAsksLearner('ما هو الأصغر؟')).toBe(true);
    expect(replyAsksLearner('Why is it 2? Because 2 is below 5.')).toBe(false);
    expect(replyAsksLearner('Which is smaller?\n\nTake your time and compare them.')).toBe(false);
    expect(replyAsksLearner('')).toBe(false);
    expect(replyAsksLearner('   \n\n  ')).toBe(false);
  });

  it('ignores closing quotes, brackets and emphasis after the question mark', () => {
    expect(replyAsksLearner('Try this: "what is min(3, 5)?"')).toBe(true);
    expect(replyAsksLearner('(Which value comes first?)')).toBe(true);
    expect(replyAsksLearner('**Can you say why?**')).toBe(true);
    expect(replyAsksLearner('Ask yourself: “which is smaller?”')).toBe(true);
  });

  it('does not count a question mark inside code', () => {
    expect(replyAsksLearner('Here is the idea:\n\n```python\nx = a if a < b else b  # smaller?\n```')).toBe(false);
    expect(replyAsksLearner('What does this print?\n\n```js\nconsole.log(1 < 2 ? "yes" : "no")\n```')).toBe(true);
    expect(replyAsksLearner('Look at it:\n\n    y = x ?? 0')).toBe(false);
  });

  it("counts Core's coaching for a withheld answer as asking", () => {
    expect(replyAsksLearner('Start by listing both values.', { withheld: true })).toBe(true);
  });
});
