import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, TextRequest, UsageReceipt } from '@course-core/providers';
import { checkCoachingMessage, checkCoachingView, checkScope, findCheckAnswerLeak, gradedCheck, gradedChecks, matchGradedChecks, namedOptions, statedNumbers, fold,
  type GradedCheck } from '../src/companion-check-integrity.js';
import { companionInstruction, minimizeContext, type TeachingContext } from '../src/agent-strategies.js';
import { composeProviders } from '../src/provider-composition.js';

// Synthetic, course-neutral checks (graded check integrity, docs/companion-check-integrity.md).
const SHELF = 'A shelf holds 4 boxes and each box holds 3 jars. Two jars are taken off the shelf. How many jars are still on the shelf?';
const SORTING = 'A list of names is sorted alphabetically before a search. Which statement about the sorted list is supported?';
const SORTING_OPTIONS = ['The list now contains more names than before.', 'Every name moved to a random position.',
  'The same names appear in a new order that makes searching faster.', 'Sorting deletes duplicate names automatically.'];
const HE_SHELF = 'על מדף יש 4 קופסאות ובכל קופסה 3 צנצנות. מורידים מהמדף שתי צנצנות. כמה צנצנות נשארו על המדף?';
const bundle = {
  chapters: [{ id: 'c1', episodes: [
    { id: 'e0', objectiveIds: ['o0'], blocks: [{ id: 'e0-check', type: 'assessment', assessmentId: 'e0-count' }] },
    { id: 'e1', objectiveIds: ['o1'], gateId: 'g1', blocks: [
      { id: 'e1-text-1', type: 'text', markdown: 'Multiply, then subtract what was removed.' }, { id: 'e1-check-1', type: 'assessment', assessmentId: 'e1-shelf' },
      { id: 'e1-text-2', type: 'text', markdown: 'Sorting changes order, not membership.' }, { id: 'e1-check-2', type: 'assessment', assessmentId: 'e1-sorting' }] },
    { id: 'e2', objectiveIds: ['o2'], blocks: [{ id: 'e2-check', type: 'assessment', assessmentId: 'e2-trace' }] },
    { id: 'e3', objectiveIds: ['o3'], blocks: [] },
    { id: 'e4', objectiveIds: ['o4'], blocks: [{ id: 'e4-check', type: 'assessment', assessmentId: 'e4-garden' }] },
  ] }],
  gates: [{ id: 'g1', assessmentIds: ['e1-estimate'] }],
  assessments: [
    { id: 'e0-count', type: 'numeric', objectiveIds: ['o0'], prompt: 'How many legs do three stools with four legs each have?', grading: { expected: 12, absoluteTolerance: 0, explanation: '3 x 4.' } },
    { id: 'e1-shelf', type: 'numeric', objectiveIds: ['o1'], prompt: SHELF, grading: { expected: 10, absoluteTolerance: 0, explanation: '4 x 3 - 2.' } },
    { id: 'e1-sorting', type: 'choice', objectiveIds: ['o1'], prompt: SORTING, options: SORTING_OPTIONS.map((text, i) => ({ id: 'abcd'[i]!, text })),
      grading: { correctOptionId: 'c', explanation: 'Order changes, membership does not.' } },
    { id: 'e1-estimate', type: 'prediction', objectiveIds: ['o1'], prompt: 'Predict the average number of jars per box after the change.', grading: { expected: 2.5, absoluteTolerance: 0.1, explanation: '10 / 4.' } },
    { id: 'e1-he', type: 'numeric', objectiveIds: ['o1'], prompt: HE_SHELF, grading: { expected: 10, absoluteTolerance: 0, explanation: '4 כפול 3 פחות 2.' } },
    { id: 'e1-minus', type: 'numeric', objectiveIds: ['o1'], prompt: 'The temperature was 2 degrees and dropped by 5 degrees. What is the temperature now?', grading: { expected: -3, absoluteTolerance: 0, explanation: '2 - 5.' } },
    { id: 'e1-essay', type: 'rubric', objectiveIds: ['o1'], prompt: 'Explain in your own words why sorting helps searching.', grading: { evaluatorId: 'reviewer', rubric: [] } },
    { id: 'e2-trace', type: 'trace', objectiveIds: ['o2'], prompt: 'Trace the queue as the worker starts.', steps: [{ id: 's1', prompt: 'State after start?' }, { id: 's2', prompt: 'Items waiting?' }],
      grading: { expected: [{ stepId: 's1', answer: 'ready_state' }, { stepId: 's2', answer: '3' }], match: 'case_insensitive', explanation: 'Ready, three waiting.' } },
    { id: 'e4-garden', type: 'numeric', objectiveIds: ['o4'], prompt: 'A garden has 7 rows with 6 tulips in each row. How many tulips grow in the garden?', grading: { expected: 42, absoluteTolerance: 0, explanation: '7 x 6.' } },
    { id: 'broken' },
  ],
};
const checks = gradedChecks(bundle);
const byId = (id: string) => checks.find(check => check.id === id)!;
const scope = checkScope(bundle, 'e1', 'e1-text-2');
const match = (question: string, earlier: string[] = [], open: string[] = []) => {
  const s = open.length ? checkScope(bundle, 'e1', 'e1-text-2', open) : scope;
  return matchGradedChecks({ question, earlier, checks, current: s.current, nearby: s.nearby }).map(m => `${m.check.id}:${m.how}`);
};
const leak = (reply: string, ids: string[], question = '') => findCheckAnswerLeak(reply, ids.map(byId), question);

describe('graded checks of a course', () => {
  it('reads each item type\'s deterministic key, and none for rubric items', () => {
    expect(byId('e1-sorting').keys).toEqual([{ kind: 'option', index: 2 }]);
    expect(byId('e1-sorting').options).toEqual(SORTING_OPTIONS);
    expect(byId('e1-shelf').keys).toEqual([{ kind: 'number', value: 10, tolerance: 1e-9 }]);
    expect(byId('e1-estimate').keys).toEqual([{ kind: 'number', value: 2.5, tolerance: 0.1 }]);
    expect(byId('e2-trace').keys).toEqual([{ kind: 'text', value: 'ready_state' }, { kind: 'number', value: 3, tolerance: 1e-9 }]);
    expect(byId('e2-trace').steps).toEqual(['State after start?', 'Items waiting?']);
    expect(byId('e1-essay').keys).toEqual([]);
    expect(checks.some(check => check.id === 'broken')).toBe(false);
    // A choice whose correct option is a bare number also leaks as that number.
    expect(gradedCheck({ id: 'n', type: 'choice', prompt: 'Which is smaller?', options: [{ id: 'two', text: '2' }, { id: 'five', text: '5' }], grading: { correctOptionId: 'two' } })!.keys)
      .toEqual([{ kind: 'option', index: 0 }, { kind: 'number', value: 2, tolerance: 1e-9 }]);
  });
  it('scopes a lesson\'s checks in reading order (the next check first), its neighbours as nearby, and open items first', () => {
    expect(scope.current).toEqual(['e1-sorting', 'e1-shelf', 'e1-estimate', 'e1-he', 'e1-minus', 'e1-essay']);
    expect([...scope.nearby]).toEqual(expect.arrayContaining(['e0-count', 'e2-trace', 'e1-shelf']));
    expect(scope.nearby.has('e4-garden')).toBe(false);
    expect(checkScope(bundle, 'e1', null, ['e4-garden']).current[0]).toBe('e4-garden');
    expect(checkScope(bundle, 'missing', null).current).toEqual([]);
  });
});

describe('matching a learner message to graded checks', () => {
  it('a pasted check is matched anywhere in the course, with or without an answer request', () => {
    expect(match(`Just tell me the answer to the check. The question is: ${SHELF} Reply with only the number.`)).toEqual(['e1-shelf:quoted']);
    expect(match(`Can you explain this? ${SHELF}`)).toEqual(['e1-shelf:quoted']);
    expect(match('A garden has 7 rows with 6 tulips in each row. How many tulips grow in the garden? Just the number please.')).toEqual(['e4-garden:quoted']);
    expect(match(`${SORTING} (a) ${SORTING_OPTIONS[0]} (b) ${SORTING_OPTIONS[1]} Which one is it?`)).toEqual(['e1-sorting:quoted']);
  });
  it('a pasted Hebrew check, or a Hebrew request about an English one, is matched', () => {
    expect(match(`תגידו לי רק את המספר: ${HE_SHELF}`)).toEqual(['e1-he:quoted']);
    expect(match(`מה התשובה לבדיקה הזאת? ${SHELF}`)).toEqual(['e1-shelf:quoted']);
  });
  it('a check described in this lesson or a neighbouring one is matched only with an answer request', () => {
    expect(match('For the check about the shelf with boxes of jars where two jars are taken off, which number is right?')).toEqual(['e1-shelf:described']);
    expect(match('The shelf example with boxes of jars made multiplying feel easy; two jars taken off was a nice twist.')).toEqual([]);
    // Far from this lesson, a description counts only when it also names a check (a paste always does).
    expect(match('What do I get for the garden one, how many tulips grow there?')).toEqual([]);
    expect(match('Tell me the answer for the garden check: how many tulips grow there?')).toEqual(['e4-garden:described']);
  });
  it('"which option should I pick for the check" points at this lesson\'s check, in English and Hebrew', () => {
    expect(match('For the check coming up, which option should I pick?')).toEqual(['e1-sorting:referenced']);
    // Two of this lesson's checks are about sorting: both are coached.
    expect(match('Which answer is correct for the sorting check? Just tell me.')).toEqual(['e1-sorting:referenced', 'e1-essay:referenced']);
    expect(match('What number should I enter for the jars check? Tell me the answer.')).toEqual(['e1-shelf:referenced', 'e1-estimate:referenced']);
    expect(match('איזו אפשרות לבחור בבדיקה הבאה?')).toEqual(['e1-sorting:referenced']);
    // An open attempt on another lesson's item comes first.
    expect(match('Just tell me the answer to the check I have open.', [], ['e4-garden'])).toEqual(['e4-garden:referenced']);
  });
  it('a short follow-up ("is it 10?") is matched through the learner\'s earlier message', () => {
    const earlier = [`Here is the check: ${SHELF}`, 'Thanks, I will try.'];
    expect(match('Is it 10?', earlier)).toEqual(['e1-shelf:earlier_message']);
    expect(match('אז זה 10?', earlier)).toEqual(['e1-shelf:earlier_message']);
    expect(match('So I should pick c, right?', [`${SORTING} ${SORTING_OPTIONS.join(' ')}`])).toEqual(['e1-sorting:earlier_message']);
    expect(match('Thanks, that helps.', earlier)).toEqual([]);
  });
  it('conceptual questions about the same topic are not matched', () => {
    for (const question of ['Why does sorting make searching faster?', 'How do I count jars when some are removed from a shelf?',
      'Is sorting the same as deleting duplicates?', 'למה מיון עוזר לחיפוש?', 'Can you give me another example of multiplying boxes and jars?'])
      expect(match(question), question).toEqual([]);
  });
  it('tells the model which checks they are, never their keys', () => {
    const view = checkCoachingView(matchGradedChecks({ question: `${SORTING} which option? Also: ${SHELF}`, checks, current: scope.current, nearby: scope.nearby }))!;
    expect(view.items.map(item => item.checkId).sort()).toEqual(['e1-shelf', 'e1-sorting']);
    for (const item of view.items) expect(Object.keys(item).sort()).toEqual(item.options ? ['checkId', 'match', 'options', 'prompt', 'type'] : ['checkId', 'match', 'prompt', 'type']);
    const text = JSON.stringify(view);
    for (const secret of ['correctOptionId', 'expected', 'Order changes, membership does not.', '4 x 3 - 2.']) expect(text).not.toContain(secret);
    expect(checkCoachingView([])).toBeUndefined();
  });
});

describe('a reply that gives away a matched check\'s answer', () => {
  it('states a numeric answer in digits, words, Hebrew words or a fraction', () => {
    for (const reply of ['10', '10\n\nYou multiply and then subtract.', 'There are 10 jars left.', 'That leaves ten jars.', 'נשארות עשר צנצנות.', '$10$', 'jars = 10.0', '20/2'])
      expect(leak(reply, ['e1-shelf']), reply).toEqual({ reason: 'check_answer_stated', checkId: 'e1-shelf' });
    expect(leak('It is 2.45, just under the line.', ['e1-estimate'])).toMatchObject({ reason: 'check_answer_stated' });
    expect(leak('It is −3 degrees.', ['e1-minus'])).toMatchObject({ reason: 'check_answer_stated' });
    expect(leak('minus 3 degrees', ['e1-minus'])).toMatchObject({ reason: 'check_answer_stated' });
  });
  it('does not flag other numbers, list markers, or numbers inside words', () => {
    expect(leak('Try a similar shelf: 5 boxes of 2 jars, with 3 taken off. What do you multiply first?', ['e1-shelf'])).toBeNull();
    expect(leak('It is 2.7, well above the line.', ['e1-estimate'])).toBeNull();
    expect(leak('It is 3 degrees.', ['e1-minus'])).toBeNull();
    expect(leak('1. Count the boxes.\n2. Multiply by the jars in each.\n3. Subtract the jars taken off.', ['e2-trace'])).toBeNull();
    expect(leak('Look at step w3 and the 13th item, or the 3rd row.', ['e2-trace'])).toBeNull();
    // A single numbered line is not a list: "3." opening the reply is the answer.
    expect(leak('3. That is how many wait.', ['e2-trace'])).toMatchObject({ reason: 'check_answer_stated' });
    expect(leak('The worker reaches ready_state first.', ['e2-trace'])).toMatchObject({ reason: 'check_answer_stated' });
    expect(statedNumbers(fold('From 4 to 2.6 and -6, then ב-3 and שבעה.'))).toEqual(expect.arrayContaining([4, 2.6, -6, 3, 7]));
  });
  it('chooses an option by letter, number, position or its own wording, in English and Hebrew', () => {
    for (const reply of ['c', '(c)', 'C.', 'Option C.', 'The answer is c.', 'Pick c.', 'Go with the third option.', 'It is option 3.',
      'C. The same names appear in a new order.', `The supported statement: ${SORTING_OPTIONS[2]}`, 'אפשרות ג.', "ג'", 'התשובה היא ג.', 'האפשרות השלישית.'])
      expect(leak(reply, ['e1-sorting']), reply).not.toBeNull();
    expect(leak(`The supported statement: ${SORTING_OPTIONS[2]}`, ['e1-sorting'])).toEqual({ reason: 'check_answer_stated', checkId: 'e1-sorting' });
    expect(leak('Option C.', ['e1-sorting'])).toEqual({ reason: 'check_option_named', checkId: 'e1-sorting' });
  });
  it('rules options out', () => {
    for (const reply of ['You can rule out options a and b.', "It's not d.", 'Option a is wrong because the count does not change.', "אפשר לפסול את א' ואת ב'.", 'אפשרות ד לא נכונה.'])
      expect(leak(reply, ['e1-sorting']), reply).toEqual({ reason: 'check_option_named', checkId: 'e1-sorting' });
    expect([...namedOptions('You can rule out options a and b.', SORTING_OPTIONS)]).toEqual([0, 1]);
  });
  it('does not flag naming every option, the article "a", or a reply\'s own numbered steps', () => {
    for (const reply of ['I can\'t tell you whether it is a, b, c or d.', 'A sorted list is a good example: think of a dictionary.',
      'Try this: (a) write the names down, (b) sort them, (c) look one up.', 'Sorting keeps the same items and puts them in an order that helps a search.',
      'Think about what changes when you sort: the order, or which items are there?'])
      expect(leak(reply, ['e1-sorting']), reply).toBeNull();
  });
  it('confirms or rejects an answer the learner proposed', () => {
    for (const [question, reply] of [['Is it 10?', 'Yes!'], ['Is it 10?', 'Not quite. Recount the jars.'], ['So it is c, right?', "That's right."],
      ['האם זה 10?', 'כן, בדיוק.'], ['אז התשובה היא ג, נכון?', 'נכון!']] as const)
      expect(leak(reply, [question.includes('c') || question.includes('ג') ? 'e1-sorting' : 'e1-shelf'], question), `${question} ${reply}`).toMatchObject({ reason: 'check_answer_confirmed' });
    expect(leak('Let\'s check it together: what do you get when you multiply the boxes by the jars in each?', ['e1-shelf'], 'Is it 10?')).toBeNull();
    // A verdict word must stand on its own: "No problem" and "לא אבחר" ("I won't choose") are not verdicts.
    expect(leak('No problem, let\'s work it out with a smaller shelf first.', ['e1-shelf'], 'Is it 10?')).toBeNull();
    expect(leak('לא אבחר בשבילך, אבל אפשר לבדוק יחד.', ['e1-sorting'], 'האם זה ג?')).toBeNull();
    // A verdict counts only when the learner asked whether an answer is right.
    expect(leak('Yes, sorting keeps every name.', ['e1-sorting'], 'Why does sorting help a search?')).toBeNull();
    expect(leak('No: describe your reasoning first.', ['e1-essay'], 'Is my answer right?')).toMatchObject({ reason: 'check_answer_confirmed' });
  });
  it('checks only the matched items', () => {
    expect(leak('There are 10 jars left.', ['e1-sorting'])).toBeNull();
    expect(leak('There are 10 jars left.', [])).toBeNull();
  });
});

describe('the coaching message that replaces a withheld reply', () => {
  it('is in the language of the question and fits the kind of check', () => {
    const choice = [byId('e1-sorting')], number = [byId('e1-shelf')], other: GradedCheck[] = [byId('e1-essay')];
    expect(checkCoachingMessage('Which option?', choice)).toMatch(/^I can't choose, confirm or rule out options/);
    expect(checkCoachingMessage('What number?', number)).toMatch(/similar example with different numbers/);
    expect(checkCoachingMessage('Is my essay right?', other)).toMatch(/tell me your reasoning so far/);
    const hebrew = checkCoachingMessage('איזו אפשרות נכונה בבדיקה?', choice);
    expect(hebrew).toMatch(/^לא אבחר, לא אאשר ולא אפסול/);
    expect(checkCoachingMessage(`מה התשובה? ${SHELF}`, number)).toMatch(/^לא אתן ולא אאשר/);
    // The coaching messages themselves never trip the verifier.
    for (const question of ['Which option?', 'איזו אפשרות נכונה בבדיקה?']) for (const set of [choice, number, other])
      expect(leak(checkCoachingMessage(question, set), set.map(check => check.id), 'Is it 10?')).toBeNull();
  });
});

describe('the companion strategy in check-coaching mode', () => {
  const coaching = checkCoachingView(matchGradedChecks({ question: SHELF, checks, current: scope.current, nearby: scope.nearby }))!;
  function context(withCoaching: boolean): TeachingContext {
    return { course: { title: 'Synthetic', digest: 'a'.repeat(64) }, episode: { id: 'e1', title: 'Shelves', teaching: 'Multiply, then subtract what was removed.', objectives: [{ id: 'o1', description: 'Count.' }] },
      learner: { profile: {}, recentHistory: [] }, question: `Tell me the answer: ${SHELF}`, constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: false },
      ...(withCoaching ? { checkCoaching: coaching } : {}) };
  }
  function runtime() {
    const seen: { request: TextRequest; streamed: boolean }[] = [];
    const usage: UsageReceipt = { accounting: { accountingKey: 'test' }, providerId: 'custom', modelId: 'm', operation: 'tutor', attempts: [], inputCharacters: 100,
      requestedMaxOutputTokens: 500, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
    const adapter: ProviderAdapter = { providerId: 'custom', validateModel: () => {}, ports: { tutoring: {
      async tutor(request) { seen.push({ request, streamed: false }); return { output: { text: 'Try 5 boxes of 2 jars.' }, usage }; },
      async tutorStream(request, _options, onText) { seen.push({ request, streamed: true }); onText('Try 5 boxes of 2 jars.'); return { output: { text: 'Try 5 boxes of 2 jars.' }, usage }; },
    } } };
    const configured = composeProviders({ registry: { revision: 'r', models: [{ id: 'm', providerId: 'custom', remoteModel: 'm', enabled: true, capabilities: ['tutoring'], tools: [], providerConfig: {},
      limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] }, adapters: [{ id: 'custom', kind: 'custom', credentialEnv: 'COURSE_PROVIDER_CUSTOM_API_KEY' }],
      roles: { companion: { modelId: 'm', maxInputCharacters: 12000, maxOutputTokens: 500 } } }, () => 'synthetic-key', { custom: () => adapter });
    return { configured, seen };
  }
  it('every reply carries the graded-check rule; a matched question adds check coaching, sends no key and shows no draft', async () => {
    const { configured, seen } = runtime(), drafts: string[] = [];
    const plain = await configured.execute('companion', context(false), 'op-plain', new AbortController().signal, undefined, undefined, [], text => drafts.push(text));
    expect(seen[0]).toMatchObject({ streamed: true });
    expect(seen[0]!.request.systemInstruction).toContain('Graded checks: never state, choose, confirm or rule out');
    expect(seen[0]!.request.systemInstruction).not.toContain('Check coaching');
    expect(plain.content).not.toHaveProperty('checkCoaching');
    expect(drafts).toEqual(['Try 5 boxes of 2 jars.']);
    drafts.length = 0;
    const coached = await configured.execute('companion', context(true), 'op-coached', new AbortController().signal, undefined, undefined, [], text => drafts.push(text));
    expect(seen[1]).toMatchObject({ streamed: false });
    expect(drafts).toEqual([]);
    expect(seen[1]!.request.systemInstruction).toContain('Check coaching: the learner\'s message matches the graded checks listed in checkCoaching.');
    const sent = JSON.parse(seen[1]!.request.messages[0]!.text);
    expect(sent.checkCoaching.items).toEqual([expect.objectContaining({ checkId: 'e1-shelf', prompt: SHELF })]);
    expect(seen[1]!.request.messages[0]!.text).not.toContain('4 x 3 - 2.');
    expect(coached.content).toMatchObject({ kind: 'companion_text', checkCoaching: { checkIds: ['e1-shelf'] } });
    expect(companionInstruction({ replyStyle: 'detailed' }, true)).toContain('Check coaching');
  });
  it('a tight input bound shortens the matched checks but keeps them', () => {
    const input = context(true);
    input.checkCoaching = checkCoachingView(matchGradedChecks({ question: `${SORTING} ${SORTING_OPTIONS.join(' ')}`, checks, current: scope.current, nearby: scope.nearby }))!;
    input.episode.teaching = 'Lesson text.';
    const bounded = minimizeContext(input, 1400);
    expect(bounded.checkCoaching!.items).toHaveLength(1);
    expect(bounded.checkCoaching!.items[0]).toMatchObject({ checkId: 'e1-sorting' });
    expect(bounded.checkCoaching!.items[0]!.options).toBeUndefined();
  });
});
