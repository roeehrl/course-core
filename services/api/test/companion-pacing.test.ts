import { describe, expect, it } from 'vitest';
import type { ProviderRouter } from '@course-core/providers';
import { companionInstruction, companionStrategy, type TeachingContext } from '../src/agent-strategies.js';
import { asksToPractise, closingQuestion, companionPacing, pacingRule, replyConfirmsAnswer, withoutClosingQuestion } from '../src/companion-pacing.js';

// Pacing is Core's count of a lesson's conversation (companion-pacing.ts): it decides whether the
// companion may ask the learner something this turn. Stubs only: no provider is contacted.

const learner = (content: string) => ({ role: 'learner', content });
const companion = (content: string) => ({ role: 'assistant', content });
/** The lesson 1.1 report: the learner keeps answering w*x+b and the companion keeps asking. */
const drill = [
  learner('Parameters are w and b; the product is an activation.'),
  companion('Exactly: w and b are parameters and w * x is an activation. If x is 6, what does predict return?'),
  learner('1.5 * 6 - 0.5 = 8.5'),
  companion('Correct, 8.5. Now change b to 1: what is the output for x = 6?'),
];

describe('the pacing signal', () => {
  it('is open for an ordinary first question and asks nothing extra of the instruction', () => {
    const pacing = companionPacing([], 'What is an activation?');
    expect(pacing).toEqual({ mode: 'open', questionTurnsInARow: 0, correctAnswersInARow: 0, answering: false, practiceRequested: false, demonstrated: [] });
    expect(pacingRule(pacing)).toBe('');
  });

  it('marks an answer to the companion\'s question, and closes after a confirmed answer (two right in a row)', () => {
    const first = companionPacing(drill.slice(0, 2), '8.5');
    expect(first).toMatchObject({ mode: 'answer', answering: true, correctAnswersInARow: 0, questionTurnsInARow: 1 });
    const second = companionPacing(drill, '1.5 * 6 + 1 = 10');
    expect(second).toMatchObject({ mode: 'close', reason: 'correct_in_a_row', answering: true, correctAnswersInARow: 1, questionTurnsInARow: 2 });
    // The skill already shown is named, so the reply never tests it again.
    expect(second.demonstrated).toEqual(['If x is 6, what does predict return?']);
  });

  it('closes after three question turns in a row, even when the answers were wrong', () => {
    const wrong = [learner('What is b?'), companion('b is the bias. What is w * x when w = 2 and x = 3?'), learner('5'),
      companion('Not quite: 2 * 3 is 6. What is 2 * 4?'), learner('6'), companion('Almost, but 2 * 4 is 8. What is 3 * 3?')];
    const pacing = companionPacing(wrong, '9');
    expect(pacing).toMatchObject({ mode: 'close', reason: 'question_limit', questionTurnsInARow: 3, correctAnswersInARow: 0, demonstrated: [] });
    // Two question turns are not yet the limit: a wrong answer may get one new question.
    expect(companionPacing(wrong.slice(0, 4), '8')).toMatchObject({ mode: 'answer', questionTurnsInARow: 2 });
  });

  it('a reply that did not ask ends the run; a request to practise starts a new one', () => {
    const closed = [...drill, learner('10'), companion('Correct. You can trace a prediction with changed parameters. Continue with the lesson.')];
    expect(companionPacing(closed, 'What is a dataset?')).toMatchObject({ mode: 'open', questionTurnsInARow: 0, answering: false });
    expect(companionPacing(closed, 'Give me another practice question')).toMatchObject({ mode: 'practice', practiceRequested: true });
    // Asking to practise is the learner's choice even at the limit.
    const long = [...drill, learner('10'), companion('Right. What about x = 0?')];
    expect(companionPacing(long, 'quiz me on something else')).toMatchObject({ mode: 'practice', questionTurnsInARow: 3 });
    expect(companionPacing(long, '-0.5')).toMatchObject({ mode: 'close', reason: 'question_limit' });
    // After the request, only the replies since count.
    expect(companionPacing([...long, learner('Quiz me on something else'), companion('Which value is a parameter here, x or w?')], 'w')).toMatchObject({ mode: 'answer', questionTurnsInARow: 1 });
  });

  it('reads confirmations and practice requests in English and Hebrew, and hedged praise as no confirmation', () => {
    for (const text of ['Correct!', 'Exactly right.', '**Yes**, 8.5.', "That's right.", 'נכון מאוד.', 'בדיוק! 8.5.', 'מצוין, זה נכון.']) expect(replyConfirmsAnswer(text), text).toBe(true);
    for (const text of ['Good try, but 2 * 4 is 8.', 'Not quite.', 'Almost: check the sign.', 'לא נכון.', 'כמעט, אבל הסימן הפוך.', 'Let us look again.']) expect(replyConfirmsAnswer(text), text).toBe(false);
    for (const text of ['Quiz me', 'give me another question', 'Can you test me on this?', 'שאלת תרגול, בבקשה', 'עוד שאלה בבקשה']) expect(asksToPractise(text), text).toBe(true);
    for (const text of ['8.5', 'What is a dataset?', 'Why is the bias negative?']) expect(asksToPractise(text), text).toBe(false);
    expect(closingQuestion('Correct.\n\nNow: what is w * 2?')).toBe('what is w * 2?');
    expect(closingQuestion('Correct. Continue reading.')).toBeNull();
  });
});

describe('the instruction', () => {
  it('always limits follow-ups to gaps and practice, never repeats a shown skill and keeps questions to what was taught', () => {
    for (const instruction of [companionInstruction({}), companionInstruction({ replyStyle: 'detailed' }), companionInstruction({}, true), companionInstruction({}, false, true)]) {
      expect(instruction).toContain('ask the learner a question only when their message shows a gap or a mistake, or they asked to practise');
      expect(instruction).toContain('Never ask a question that tests a skill the learner already answered correctly in this conversation');
      expect(instruction).toContain('Lesson scope: every question, exercise or practice task you give the learner uses only ideas the current lesson');
      expect(instruction).toContain('say that a later lesson covers it');
      expect(instruction).not.toContain('ask one focused follow-up when useful');
      expect(instruction).not.toContain('Ask at most one short follow-up question');
    }
  });

  it('switches on the stricter rule for each pacing mode; check coaching keeps its own', () => {
    const close = companionPacing(drill, '10');
    expect(companionInstruction({}, false, false, close)).toContain('Do not ask the learner any question in this reply');
    expect(companionInstruction({}, false, false, close)).toContain('The learner is answering again after an answer you already confirmed as right');
    expect(companionInstruction({}, false, false, companionPacing(drill.slice(0, 2), '8.5'))).toContain('pacing.mode "answer"');
    expect(companionInstruction({}, false, false, companionPacing([], 'quiz me'))).toContain('pacing.mode "practice"');
    expect(companionInstruction({}, false, false, companionPacing([], 'What is w?'))).not.toContain('Pacing for this turn');
    expect(companionInstruction({}, true, false, close)).not.toContain('Pacing for this turn');
  });
});

describe('a close turn ends without a question', () => {
  it('removes the closing question sentences or paragraph and keeps the rest', () => {
    expect(withoutClosingQuestion('Correct: 10. You can trace a changed bias. What about x = 0?')).toEqual({ text: 'Correct: 10. You can trace a changed bias.', trimmed: true });
    expect(withoutClosingQuestion('Correct: 10. You can trace a changed bias.\n\n**Your turn:** what is the output for x = 2?')).toEqual({ text: 'Correct: 10. You can trace a changed bias.', trimmed: true });
    expect(withoutClosingQuestion('נכון, 10. הראית שאפשר לחשב עם הטיה אחרת. מה יוצא כש-x שווה 0?').text).toBe('נכון, 10. הראית שאפשר לחשב עם הטיה אחרת.');
    // Nothing to remove, or nothing would be left.
    expect(withoutClosingQuestion('Correct. Continue with the lesson.')).toEqual({ text: 'Correct. Continue with the lesson.', trimmed: false });
    expect(withoutClosingQuestion('What is 2 * 4?')).toEqual({ text: 'What is 2 * 4?', trimmed: false });
  });

  it('through the companion strategy: the delivered reply of a close turn does not ask, other turns are untouched', async () => {
    const sent: { systemInstruction: string; text: string }[] = [];
    const router = { tutor: async (request: { systemInstruction: string; messages: { text: string }[] }) => {
      sent.push({ systemInstruction: request.systemInstruction, text: request.messages[0]!.text });
      return { output: { text: 'Correct: 10. You have shown you can trace a changed bias. Now, what is the output for x = 0?' }, usage: {} };
    } } as unknown as ProviderRouter;
    const context = (history: TeachingContext['learner']['recentHistory'], question: string): TeachingContext => ({
      course: { title: 'Probe course', digest: 'probe' }, episode: { id: 'e1', title: 'A model is a parameterized program', teaching: 'prediction = f(input, parameters)', objectives: [{ id: 'o1', description: 'Trace a prediction.' }] },
      lessonMap: { chapter: 'Foundations', earlierLessons: [], laterLessons: ['Training versus inference'] },
      learner: { profile: {}, recentHistory: history }, question, constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: false } });
    const run = (value: TeachingContext) => companionStrategy.run({ role: 'companion', binding: { modelId: 'm', maxInputCharacters: 40000, maxOutputTokens: 800 }, context: value,
      accountingKey: 'k', signal: new AbortController().signal, router });
    const closed = await run(context(drill, '10'));
    expect((closed.content as { text: string }).text).toBe('Correct: 10. You have shown you can trace a changed bias.');
    const data = JSON.parse(sent[0]!.text) as TeachingContext;
    expect(data.pacing).toMatchObject({ mode: 'close', reason: 'correct_in_a_row' });
    expect(data.lessonMap?.laterLessons).toEqual(['Training versus inference']);
    // A caller cannot set the pacing: the strategy computes it.
    const open = await run({ ...context([], 'What is a parameter?'), pacing: { mode: 'close', questionTurnsInARow: 9, correctAnswersInARow: 9, answering: true, practiceRequested: false, demonstrated: [] } });
    expect((open.content as { text: string }).text).toContain('what is the output for x = 0?');
    expect(JSON.parse(sent[1]!.text).pacing).toMatchObject({ mode: 'open' });
  });
});
