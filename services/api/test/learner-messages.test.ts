import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANSWER_MESSAGE_CODES, CODE_LIMITS, answerMessage } from '../src/answer-messages.js';
import { SKILL_STATES, skillStateExplanation } from '../src/learner-model.js';

// The API sends learner-facing reasons as codes, never sentences (docs/i18n.md). The 0.1.56
// qualification found the learner model's English skill-state reason on the Hebrew profile. Each
// code the API can send must have an English and a Hebrew message in the learner app.
const catalog = (locale: 'en' | 'he', namespace: string) =>
  JSON.parse(readFileSync(new URL(`../../../apps/learner/src/i18n/messages/${locale}/${namespace}.json`, import.meta.url), 'utf8')) as Record<string, string>;
const sentence = /[A-Za-z]+ [A-Za-z]+ [A-Za-z]+/;
/** A message's own words: ICU argument names, plural/select keywords and case names removed. */
const words = (message: string) => message.replace(/\{\s*[A-Za-z]+\s*(,\s*(plural|select)\s*,)?/g, ' ').replace(/(^|[\s{}])(=\d+|zero|one|two|few|many|other|[a-z_]+)\s*\{/g, ' ');

describe('learner codes have learner-app messages in every locale', () => {
  const cases: [string, string, readonly string[], (code: string) => string][] = [
    ['skill-state reasons', 'learnerMemoryPanel', SKILL_STATES, (c) => `why.${c}`],
    ['answer feedback', 'answerFeedback', ANSWER_MESSAGE_CODES, (c) => `message.${c}`],
  ];
  for (const [name, namespace, codes, key] of cases)
    it(name, () => {
      const en = catalog('en', namespace), he = catalog('he', namespace);
      for (const code of codes) {
        expect(typeof en[key(code)], `en/${namespace}.json ${key(code)}`).toBe('string');
        expect(typeof he[key(code)], `he/${namespace}.json ${key(code)}`).toBe('string');
        // Translated, not copied: a Hebrew message has no English words outside its ICU arguments.
        expect(words(he[key(code)]!), `he/${namespace}.json ${key(code)}`).not.toMatch(sentence);
        expect(words(en[key(code)]!)).toMatch(sentence);
      }
    });
  it('every skill state is sent as its own code with values, never a sentence', () => {
    for (const status of SKILL_STATES) {
      const reason = skillStateExplanation(status, { independent: 1, required: 2 });
      expect(reason).toEqual({ code: status, params: { independentFamilies: 1, requiredFamilies: 2 } });
      expect(skillStateExplanation(status)).toEqual({ code: status });
      expect(JSON.stringify(reason)).not.toMatch(sentence);
    }
  });
  it('answer feedback is a code with values; code limits are the ones the learner app words', () => {
    expect(answerMessage('code_some_matched', { passed: 2, total: 3 })).toEqual({ code: 'code_some_matched', params: { passed: 2, total: 3 } });
    expect(answerMessage('pending_review')).toEqual({ code: 'pending_review' });
    const limit = catalog('en', 'answerFeedback')['message.code_limit']!;
    for (const value of CODE_LIMITS.filter(v => v !== 'execution')) expect(limit).toContain(`${value} {`);
    const learnerCodes = readFileSync(new URL('../../../apps/learner/src/connected/answerFeedback.ts', import.meta.url), 'utf8');
    for (const code of ANSWER_MESSAGE_CODES) expect(learnerCodes).toContain(`"${code}"`);
  });
});
