import { replyAsksLearner } from './companion-turn.js';

/**
 * The companion's pacing in one lesson's conversation, computed by Core from the recent history
 * (never by the model's say-so) and handed to the companion as context `pacing`. It decides
 * whether the reply may ask the learner something:
 *
 * - `close`: no question this turn. After three companion replies in a row that asked the learner
 *   something (`question_limit`), or when the learner answers again after an answer the companion
 *   already confirmed (`correct_in_a_row`: a second right answer needs no third question). The
 *   reply confirms or corrects, says what the learner has shown, and points back to the lesson; a
 *   closing question the model writes anyway is removed (`withoutClosingQuestion`).
 * - `practice`: the learner asked to practise; one question, on a skill not yet shown.
 * - `answer`: the learner answers the companion's last question; a right answer is confirmed
 *   without a new question, a wrong one may get one new question that varies it.
 * - `open`: an ordinary question; a follow-up only when the message shows a gap.
 *
 * `demonstrated` lists the companion's questions the learner already answered right in the
 * retrieved history (excerpts), so the reply never tests that skill again.
 *
 * Whether an answer was right is read from the companion's own next reply (it opens by confirming
 * it: "Correct", "Exactly", "נכון"...). That is a heuristic over Core's stored conversation; it
 * only ever makes the companion ask less.
 */
export const PACING_QUESTION_LIMIT = 3;
export type PacingMode = 'open' | 'answer' | 'practice' | 'close';
export interface CompanionPacing {
  mode: PacingMode;
  /** Why the mode is `close`. */
  reason?: 'question_limit' | 'correct_in_a_row';
  /** Companion replies in a row, up to the latest, that ended by asking the learner something (since the learner last asked to practise). */
  questionTurnsInARow: number;
  /** The learner's answers in a row, up to the latest, that the companion confirmed as right. */
  correctAnswersInARow: number;
  /** The learner's message answers the companion's last question. */
  answering: boolean;
  /** The learner's message asks to practise (a quiz, another question). */
  practiceRequested: boolean;
  /** The companion's questions the learner already answered right in this conversation (excerpts). */
  demonstrated: string[];
}
interface Turn { role: string; content: string }

const DEMONSTRATED_MAX = 4, EXCERPT_MAX = 200;
/** The learner asks for a question or exercise ("quiz me", "give me another question", "שאלת תרגול"). */
const PRACTICE_REQUEST = new RegExp([
  String.raw`\b(?:quiz|test|drill)\s+me\b`,
  String.raw`\bask\s+me\s+(?:another|a|one\s+more|more)\b`,
  String.raw`\b(?:give|send|show)\s+me\s+(?:another|a|an|one\s+more|more|some)\s+(?:practice\s+|practise\s+)?(?:question|exercise|problem|task|challenge)`,
  String.raw`\b(?:another|one\s+more|a)\s+(?:practice|practise)\s+(?:question|exercise|problem)`,
  String.raw`\blet(?:'s| us)\s+(?:practi[cs]e|do\s+(?:a|an|another)\s+(?:exercise|question))`,
  String.raw`\b(?:i\s+(?:want|would\s+like|'d\s+like)\s+to\s+)?practi[cs]e\s+(?:this|more|it|that)\b`,
  String.raw`(?<!\p{L})(?:שאל(?:ת|ות)\s+תרגול|תרגיל|תרגול|עוד\s+שאלה|לבחון\s+אותי|לשאול\s+אותי|שאלה\s+נוספת)(?!\p{L})`,
].join('|'), 'iu');
/** A reply that opens by confirming the learner's answer. */
const CONFIRMS = /^[\s"'“”*_>#-]*(?:yes\b|yep\b|correct\b|exactly\b|right\b|that'?s\s+(?:right|correct|it)\b|that\s+is\s+(?:right|correct)\b|spot\s+on\b|perfect\b|precisely\b|well\s+done\b|nicely\s+done\b|nice\b|great\b|good\b|you\s+got\s+it\b|you'?ve\s+got\s+it\b|bingo\b|נכון|בדיוק|מצוין|מעולה|יפה|כל\s+הכבוד|נהדר|תשובה\s+נכונה|צודק)/iu;
/** Words in the opening sentence that take the confirmation back ("Good try, but", "Almost", "לא בדיוק"). */
const HEDGED = /\b(?:but|however|not\s+quite|almost|close|nearly|partly|partially|careful|although)\b|(?<!\p{L})(?:אבל|אך|כמעט|לא\s+בדיוק|חלקית|שימו\s+לב)(?!\p{L})/iu;
const firstSentence = (text: string) => text.trim().split(/(?<=[.!?؟])\s+|\n/u)[0] ?? '';
export const replyConfirmsAnswer = (text: string) => CONFIRMS.test(text) && !HEDGED.test(firstSentence(text).slice(0, 160));
export const asksToPractise = (text: string) => PRACTICE_REQUEST.test(text);

/** The question a reply ends with: the last sentence of its last paragraph, up to its question mark. */
export function closingQuestion(text: string): string | null {
  if (!replyAsksLearner(text)) return null;
  const paragraphs = text.split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
  const last = paragraphs.at(-1) ?? '';
  const sentences = last.split(/(?<=[.!:؟?])\s+/u);
  const question = sentences.at(-1)?.trim() ?? '';
  return question ? question.replace(/\s+/g, ' ').slice(0, EXCERPT_MAX) : null;
}

/**
 * The pacing of the turn answering `question`, from the lesson's retrieved history (oldest first,
 * the current question not included). Pure: the same history always gives the same pacing.
 */
export function companionPacing(history: readonly Turn[], question: string): CompanionPacing {
  const turns = history.filter(turn => turn.role === 'learner' || turn.role === 'assistant');
  const practiceRequested = asksToPractise(question);
  // Companion replies that asked, back to one that did not or to the learner's request to practise.
  let questionTurnsInARow = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.role === 'learner') { if (asksToPractise(turn.content)) break; continue; }
    if (!replyAsksLearner(turn.content)) break;
    questionTurnsInARow++;
  }
  const lastReply = [...turns].reverse().find(turn => turn.role === 'assistant');
  const answering = !!lastReply && turns.at(-1) === lastReply && replyAsksLearner(lastReply.content) && !practiceRequested;
  // The learner's answers: a learner turn right after a reply that asked, judged by the next reply's opening.
  const answers: { asked: string; confirmed: boolean }[] = [];
  for (let index = 2; index < turns.length; index++) {
    const asked = turns[index - 2]!, answer = turns[index - 1]!, verdict = turns[index]!;
    if (asked.role !== 'assistant' || answer.role !== 'learner' || verdict.role !== 'assistant' || !replyAsksLearner(asked.content)) continue;
    answers.push({ asked: closingQuestion(asked.content) ?? '', confirmed: replyConfirmsAnswer(verdict.content) });
  }
  let correctAnswersInARow = 0;
  for (const answer of [...answers].reverse()) { if (!answer.confirmed) break; correctAnswersInARow++; }
  const demonstrated = [...new Set(answers.filter(answer => answer.confirmed && answer.asked).map(answer => answer.asked))].slice(-DEMONSTRATED_MAX);
  const base = { questionTurnsInARow, correctAnswersInARow, answering, practiceRequested, demonstrated };
  if (questionTurnsInARow >= PACING_QUESTION_LIMIT && !practiceRequested) return { mode: 'close', reason: 'question_limit', ...base };
  if (answering && correctAnswersInARow >= 1) return { mode: 'close', reason: 'correct_in_a_row', ...base };
  if (practiceRequested) return { mode: 'practice', ...base };
  return { mode: answering ? 'answer' : 'open', ...base };
}

/** Every companion reply: when to ask at all, and never the same skill twice. */
export const FOLLOW_UP_RULE = 'Follow-up questions: ask the learner a question only when their message shows a gap or a mistake, or they asked to practise; never by habit, and never more than one. '
  + 'When the learner answers your question correctly, confirm it in a few words, say in one line what they have shown, and end without a question, pointing them back to the lesson (continue reading, or try the lesson\'s own check). '
  + 'After a wrong or partial answer, correct it briefly; only then may you ask one new question on the same idea, with a different structure, not just new numbers. '
  + 'Never ask a question that tests a skill the learner already answered correctly in this conversation (context pacing.demonstrated lists those questions), whatever the numbers. Context `pacing` is Core\'s count of this conversation: follow its mode.';
/** Every companion reply: questions stay within what the course has taught so far. */
export const SCOPE_RULE = 'Lesson scope: every question, exercise or practice task you give the learner uses only ideas the current lesson\'s teaching text and objectives actually teach, or that earlier lessons taught (context lessonMap.earlierLessons). '
  + 'An idea the lesson only names, uses without explaining or mentions in passing (for example "a rule for measuring error", or a word it never defines), or one a later lesson covers (lessonMap.laterLessons), is not taught yet: '
  + 'if the learner asks about it, answer in one or two sentences and say that a later lesson covers it (name that lesson when lessonMap lists it), and never quiz them on it or build an exercise on it.';
const CLOSE_REASON = {
  question_limit: 'You have already asked the learner several questions in a row.',
  correct_in_a_row: 'The learner is answering again after an answer you already confirmed as right: they have shown the idea.',
} as const;
/** The rule for this turn's pacing mode; `open` adds nothing to the base rules. */
export function pacingRule(pacing: CompanionPacing | null): string {
  if (!pacing) return '';
  if (pacing.mode === 'close') return `Pacing for this turn (Core's decision, pacing.mode "close"): ${CLOSE_REASON[pacing.reason ?? 'question_limit']} Do not ask the learner any question in this reply, not even an optional or rhetorical one. `
    + 'If their answer is right, confirm it briefly and say in one line what they have shown; if it is wrong, correct it in a sentence or two. '
    + 'End with one sentence that sends them back to the lesson (continue with the next part, or try the lesson\'s check); the reply\'s last sentence is not a question.';
  if (pacing.mode === 'practice') return 'Pacing for this turn (pacing.mode "practice"): the learner asked to practise. Ask exactly one question, on an idea the lesson teaches, that tests a skill not listed in pacing.demonstrated.';
  if (pacing.mode === 'answer') return 'Pacing for this turn (pacing.mode "answer"): the learner is answering your last question. If the answer is right, confirm it, say in one line what they have shown and end without a question, pointing back to the lesson. If it is wrong or partial, correct it briefly; you may then ask one new question that varies it.';
  return '';
}

/**
 * The reply without the question it closes with: Core's enforcement of a `close` turn. Trailing
 * question sentences of the last paragraph are removed (the paragraph too when nothing else is
 * left in it). A reply that would be left empty, or whose end is inside code, is returned as it is.
 */
export function withoutClosingQuestion(text: string): { text: string; trimmed: boolean } {
  if (!replyAsksLearner(text) || (text.match(/^ {0,3}(?:`{3,}|~{3,})/gm)?.length ?? 0) % 2 === 1) return { text, trimmed: false };
  const paragraphs = text.replace(/\s+$/u, '').split(/(\n\s*\n)/);
  // A trailing question paragraph, or the trailing question sentences of the last paragraph.
  while (paragraphs.length) {
    const last = paragraphs.at(-1)!.trim();
    if (!last) { paragraphs.pop(); continue; }
    const sentences = last.split(/(?<=[.!:؟?])\s+/u);
    while (sentences.length && /[?؟][\s"'”’»)\]}*_`>]*$/u.test(sentences.at(-1)!)) sentences.pop();
    if (sentences.length) { paragraphs[paragraphs.length - 1] = sentences.join(' '); break; }
    paragraphs.pop();
    if (paragraphs.length && /^\n\s*\n$/.test(paragraphs.at(-1)!)) paragraphs.pop();
  }
  const result = paragraphs.join('').replace(/\s+$/u, '');
  if (result.replace(/[\s*_#>`-]/g, '').length < 20) return { text, trimmed: false };
  return { text: result, trimmed: true };
}
