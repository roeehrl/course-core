/**
 * Graded-check integrity for the companion (docs/companion-check-integrity.md).
 *
 * The tutor never hands a learner the answer to one of the course's graded checks, whether or not
 * an attempt is open. Three deterministic, provider-independent layers:
 *
 * 1. Instruction. Core's companion strategy always carries the graded-check rule, and a stricter
 *    check-coaching rule when the question matches a check (agent-strategies.ts).
 * 2. Matching (`matchGradedChecks`). Before a companion call, the learner's question is matched
 *    against the course's checks: an item pasted anywhere in the course, an item described in
 *    this lesson or a neighbouring one, or "the check" referred to with a request for its answer.
 *    A short follow-up ("is it 3?") is matched through the learner's last messages in the lesson.
 *    A match puts the call in check-coaching mode: the model is told which items they are (prompt
 *    and options only, never a key) and the reply is not streamed as a draft.
 * 3. Verification (`findCheckAnswerLeak`). Before a reply in check-coaching mode is stored, the
 *    provider gateway checks it against the matched items' answer keys: a choice item's correct
 *    option by its text, or any option by letter, number or position (naming some options but not
 *    all chooses or rules out); a numeric or prediction value within its tolerance, in digits or
 *    words; a trace step's answer; and a yes/no verdict on an answer the learner proposed. On a hit
 *    the reply is withheld (never stored, any draft withdrawn) and a fixed coaching message is
 *    delivered instead, charged at the call's reported usage like any reply.
 *
 * Limits: the verifier catches explicit answers. A paraphrase that decides an item without naming
 * its option, value or wording is not detected here; the instruction and the eval cases
 * (agent-evals, `check_answer:*` findings) cover it. Rubric, code and production items have no
 * deterministic key, so only the instruction and the confirmation rule apply to them.
 */
import type { PoolClient } from 'pg';
import type { Database } from './database.js';

/** A deterministic answer key of a graded check. Host-only: never sent to a model. */
export type CheckKey = { kind: 'option'; index: number } | { kind: 'number'; value: number; tolerance: number } | { kind: 'text'; value: string };
export interface GradedCheck {
  id: string; type: string; prompt: string;
  /** Option texts in the order the learner sees them (choice items). */
  options: string[];
  /** Step prompts (trace items). */
  steps: string[];
  /** Empty for items graded by a rubric, code tests or a reviewer. */
  keys: CheckKey[];
}
export type CheckMatchKind = 'quoted' | 'described' | 'referenced' | 'earlier_message';
export interface CheckMatch { check: GradedCheck; how: CheckMatchKind; score: number }
/** What the model is told in check-coaching mode (TeachingContext.checkCoaching). No key, ever. */
export interface CheckCoaching {
  note: string;
  items: { checkId: string; type: string; prompt: string; options?: string[]; match: CheckMatchKind }[];
}
export type CheckLeakReason = 'check_answer_stated' | 'check_option_named' | 'check_answer_confirmed';
export interface CheckLeak { reason: CheckLeakReason; checkId: string }
/** Why a reply was withheld, recorded on the stored message (codes only). `check_keys_unavailable`:
 * the matched checks could not be read back from the course release, so nothing could be verified. */
export const WITHHELD_REASONS = ['check_answer_stated', 'check_option_named', 'check_answer_confirmed', 'check_keys_unavailable'] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

const MAX_CHECKS = 2000;
const MAX_MATCHES = 3;
const COACHING_NOTE = 'The learner\'s message matches these graded checks of the course. Their answers are withheld from you on purpose: coach without giving, choosing, confirming or ruling out any answer.';

// ---------------------------------------------------------------------------
// Course checks
// ---------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function tolerance(grading: Record<string, unknown>, expected: number) {
  const absolute = finite(grading.absoluteTolerance) && grading.absoluteTolerance > 0 ? grading.absoluteTolerance : 0;
  const relative = finite(grading.relativeTolerance) && grading.relativeTolerance > 0 ? grading.relativeTolerance * Math.abs(expected) : 0;
  return Math.max(absolute, relative, 1e-9);
}
/** A plain number written as text ("2", "-3.5", "1,000"), else null. */
function plainNumber(text: string): number | null {
  const value = text.trim().replace(/[−–]/g, '-');
  if (!/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** The graded check of one SDK assessment, or null when it is not one. */
export function gradedCheck(raw: unknown): GradedCheck | null {
  const item = record(raw);
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || typeof item.prompt !== 'string') return null;
  const grading = record(item.grading) ?? {};
  const options = (Array.isArray(item.options) ? item.options : []).flatMap(option => {
    const o = record(option);
    return o && typeof o.id === 'string' && typeof o.text === 'string' ? [{ id: o.id, text: o.text.slice(0, 1000) }] : [];
  }).slice(0, 12);
  const steps = (Array.isArray(item.steps) ? item.steps : []).flatMap(step => {
    const s = record(step);
    return s && typeof s.prompt === 'string' ? [s.prompt.slice(0, 1000)] : [];
  }).slice(0, 40);
  const keys: CheckKey[] = [];
  if (item.type === 'choice') {
    const index = options.findIndex(option => option.id === grading.correctOptionId);
    if (index >= 0) {
      keys.push({ kind: 'option', index });
      // A choice whose correct option is a bare number also leaks as that number.
      const value = plainNumber(options[index]!.text);
      if (value !== null) keys.push({ kind: 'number', value, tolerance: 1e-9 });
    }
  } else if ((item.type === 'numeric' || item.type === 'prediction') && finite(grading.expected)) {
    keys.push({ kind: 'number', value: grading.expected, tolerance: tolerance(grading, grading.expected) });
  } else if (item.type === 'trace' && Array.isArray(grading.expected)) {
    for (const step of grading.expected) {
      const answer = record(step)?.answer;
      if (typeof answer !== 'string' || !answer.trim()) continue;
      const value = plainNumber(answer);
      keys.push(value !== null ? { kind: 'number', value, tolerance: 1e-9 } : { kind: 'text', value: answer.slice(0, 500) });
    }
  }
  return { id: item.id.slice(0, 200), type: item.type.slice(0, 40), prompt: item.prompt.slice(0, 4000), options: options.map(option => option.text), steps, keys };
}
/** Every graded check of a course bundle (bounded). */
export function gradedChecks(bundle: unknown): GradedCheck[] {
  const assessments = record(bundle)?.assessments;
  return (Array.isArray(assessments) ? assessments.slice(0, MAX_CHECKS) : []).flatMap(raw => { const check = gradedCheck(raw); return check ? [check] : []; });
}

interface BundleEpisode { id: string; objectiveIds?: unknown; gateId?: unknown; blocks?: unknown }
function episodesOf(bundle: unknown): BundleEpisode[] {
  const chapters = record(bundle)?.chapters;
  return (Array.isArray(chapters) ? chapters : []).flatMap(chapter => {
    const episodes = record(chapter)?.episodes;
    return Array.isArray(episodes) ? episodes.filter((e): e is BundleEpisode => typeof record(e)?.id === 'string') : [];
  });
}
/** The checks of one lesson, in reading order: its check blocks (those after `blockId` first),
 * its gate's items, then items for its objectives. */
function lessonCheckIds(bundle: unknown, episode: BundleEpisode, blockId?: string | null): string[] {
  const blocks = Array.isArray(episode.blocks) ? episode.blocks.map(record).filter((b): b is Record<string, unknown> => b !== null) : [];
  const at = blockId ? blocks.findIndex(block => block.id === blockId) : -1;
  const ordered = at >= 0 ? [...blocks.slice(at + 1), ...blocks.slice(0, at + 1)] : blocks;
  const fromBlocks = ordered.flatMap(block => block.type === 'assessment' && typeof block.assessmentId === 'string' ? [block.assessmentId] : []);
  const gates = record(bundle)?.gates;
  const gate = (Array.isArray(gates) ? gates : []).map(record).find(g => g?.id === episode.gateId);
  const fromGate = Array.isArray(gate?.assessmentIds) ? gate.assessmentIds.filter((id): id is string => typeof id === 'string') : [];
  const objectives = new Set(Array.isArray(episode.objectiveIds) ? episode.objectiveIds : []);
  const assessments = record(bundle)?.assessments;
  const fromObjectives = (Array.isArray(assessments) ? assessments.slice(0, MAX_CHECKS) : []).flatMap(raw => {
    const a = record(raw);
    return a && typeof a.id === 'string' && Array.isArray(a.objectiveIds) && a.objectiveIds.some(id => objectives.has(id)) ? [a.id] : [];
  });
  return [...new Set([...fromBlocks, ...fromGate, ...fromObjectives])];
}
/** Which checks count as this lesson's (`current`, in reading order) and as nearby (this lesson,
 * the lessons just before and after it, and every item with an open attempt). */
export function checkScope(bundle: unknown, episodeId: string, blockId: string | null | undefined, openCheckIds: readonly string[] = []) {
  const episodes = episodesOf(bundle), index = episodes.findIndex(e => e.id === episodeId);
  const current = index >= 0 ? lessonCheckIds(bundle, episodes[index]!, blockId) : [];
  const nearby = new Set([...current, ...openCheckIds]);
  for (const neighbour of [episodes[index - 1], episodes[index + 1]]) if (index >= 0 && neighbour) for (const id of lessonCheckIds(bundle, neighbour)) nearby.add(id);
  return { current: [...new Set([...openCheckIds, ...current])], nearby };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Points and cantillation, but not the maqaf (U+05BE), which reads as a hyphen. */
const HEBREW_MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;
/** Case, typography, Markdown and simple TeX folded away; line breaks kept. */
export function fold(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(HEBREW_MARKS, '')
    .replace(/[‐-―−־]/g, '-').replace(/[‘’‛′`´]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^}]*)\}/g, ' $1 ').replace(/\\(?:times|cdot)/g, ' * ').replace(/\\[a-z]+/g, ' ')
    .replace(/\be\.g\./g, 'eg').replace(/\bi\.e\./g, 'ie')
    .replace(/[*_~$\\{}]/g, ' ').replace(/[ \t]+/g, ' ');
}
const WORD = /[\p{L}\p{N}]+(?:\.\p{N}+)?/gu;
const HEBREW_LETTER = /[א-ת]/;
const STOP = new Set(('a an the of to in on for and or but nor is are was were be been being it its it\'s this that these those with as at by from into onto than then so if not no do does did '
  + 'can could should would will shall may might must i you he she we they me my your our their them what which who whom whose when where why how there here just only also very about '
  + 'over under up down out more most less such each every any all some both either neither please tell give let us am has have had get got im ive youre dont isnt whats thats '
  + 'של את על עם זה זו זאת הוא היא הם הן אני אתה אנחנו מה מי איך למה כי אם או גם רק כל לא כן יש אין אבל אז עוד כמו בין אל היה היתה להיות האם אשר לי לך לו לה שלי שלך').split(' '));
/** Generic words that say "a check" without saying which one. */
const GENERIC = new Set(['check', 'quiz', 'test', 'exam', 'question', 'answer', 'option', 'choice', 'which', 'pick', 'choos', 'independent', 'correct', 'right', 'number', 'valu', 'result',
  'בדיקה', 'שאלה', 'תשובה', 'אפשרות', 'נכונה', 'נכון']);
function stem(token: string) {
  if (HEBREW_LETTER.test(token)) {
    let t = token;
    for (let i = 0; i < 2 && t.length > 3 && 'ובהלמשכ'.includes(t[0]!); i++) t = t.slice(1);
    return t;
  }
  if (!/^[a-z]+$/.test(token)) return token;
  // A light English stem, the same on both sides: sorted/sorting/sorts -> sort, names/name -> nam.
  let t = token;
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 4 && t.endsWith('es')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}
function contentTokens(text: string): string[] {
  return (fold(text).match(WORD) ?? []).filter(t => !STOP.has(t)).map(stem).filter(t => !STOP.has(t) && (t.length > 1 || /\p{N}/u.test(t)));
}
interface Bag { set: Set<string>; trigrams: Set<string> }
function bag(text: string): Bag {
  const tokens = contentTokens(text), trigrams = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i++) trigrams.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  return { set: new Set(tokens), trigrams };
}
const shared = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const hebrewLetters = (text: string) => (text.match(/[א-ת]/g) ?? []).length;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const ANSWER_SEEKING = [
  /\b(?:answers?|options?|choices?|pick|choose|select|correct|right one|which one|tell me|give me|solutions?|solve it|is it|is that|am i right|did i get|confirm|cross off|rule out|eliminate)\b/,
  /\b(?:what|which)(?:'s| is)? (?:the )?(?:value|number|result)\b/,
  /(?:תשוב|אפשרו|לבחור|בוחר|נכון|נכונה|פתרון|לפתור|תגיד|תגידי|תגידו|תאשר|לפסול|לשלול|מה הערך|מה המספר|איזה ערך|איזה מספר)/,
];
const CHECK_REFERENCE = [
  /\b(?:checks?|quiz(?:zes)?|tests?|exams?|assessments?|graded|exercises?|homework)\b/,
  /\b(?:the|this|that) (?:question|item|problem)\b/,
  /(?:בדיק|בוחן|מבחן|תרגיל|מטל|הערכה|השאלה)/,
];
const CONFIRMATION_ASKED = [
  /\b(?:is it|is that|is the answer|so it'?s|am i (?:right|correct)|did i get|i think it'?s|i think the answer|i got|my answer is|is my answer|would it be|should it be|can i rule out|can i cross off)\b/,
  /\b(?:right|correct)\s*\?/,
  /(?:^|\s)[(\[]?(?:[a-h]|-?\d+(?:\.\d+)?)[)\]]?\s*\?/,
  /(?:האם|נכון\s*\?|זה נכון|צדקתי|יצא לי|התשובה שלי|אני חושב|אני חושבת|לדעתי|זה יוצא)/,
];
const anyOf = (patterns: readonly RegExp[], text: string) => patterns.some(pattern => pattern.test(text));

interface Scored { check: GradedCheck; shared: number; coverage: number; trigrams: number; options: number; distinctive: number }
/** A check's own words, computed once per check object (checks are cached per release). */
const checkWords = new WeakMap<GradedCheck, { prompt: Bag; options: Bag[]; distinctive: string[] }>();
function wordsOfCheck(check: GradedCheck) {
  let words = checkWords.get(check);
  if (!words) {
    const prompt = bag(`${check.prompt} ${check.steps.join(' ')}`);
    words = { prompt, options: check.options.map(bag),
      distinctive: [...new Set([...prompt.set, ...contentTokens(check.id.replace(/[-_]/g, ' '))])].filter(token => !GENERIC.has(token) && !/^\p{N}+$/u.test(token) && token.length > 2) };
    checkWords.set(check, words);
  }
  return words;
}
function score(check: GradedCheck, message: Bag): Scored {
  const { prompt, options: optionWords, distinctive: own } = wordsOfCheck(check);
  const sharedTokens = shared(prompt.set, message.set);
  // A short option ("Six units left.") counts only whole; a longer one by most of its words.
  const options = optionWords.filter(option => option.set.size > 0 && shared(option.set, message.set) / option.set.size >= (option.set.size <= 3 ? 1 : 0.6)).length;
  const distinctive = own.filter(token => message.set.has(token)).length;
  return { check, shared: sharedTokens, coverage: prompt.set.size ? sharedTokens / prompt.set.size : 0,
    trigrams: prompt.trigrams.size >= 2 ? shared(prompt.trigrams, message.trigrams) / prompt.trigrams.size : 0, options, distinctive };
}
const quoted = (s: Scored) => (s.coverage >= 0.6 && s.shared >= 3) || s.trigrams >= 0.5 || (s.check.options.length >= 2 && s.options >= 2 && (s.shared >= 1 || !s.check.prompt.trim()));
const described = (s: Scored) => s.coverage >= 0.35 && s.shared >= 3;

/** One message against the checks: pasted anywhere; described with an answer request nearby, or
 * anywhere when it also names a check ("the answer for the garden check: how many tulips..."). */
function matchMessage(text: string, checks: readonly GradedCheck[], nearby: ReadonlySet<string>, intent: { asks: boolean; anywhere: boolean }): { scored: Scored; how: 'quoted' | 'described' }[] {
  const message = bag(text);
  return checks.map(check => score(check, message)).flatMap((s): { scored: Scored; how: 'quoted' | 'described' }[] => quoted(s) ? [{ scored: s, how: 'quoted' }]
    : intent.asks && (intent.anywhere || nearby.has(s.check.id)) && described(s) ? [{ scored: s, how: 'described' }] : []);
}

const sentencesOf = (folded: string) => folded.split(/(?<=[.!?;])\s+|\n+/).map(sentence => sentence.replace(/\s+/g, ' ').trim()).filter(Boolean);
const COURSE_TEXT_LIMIT = 4_000_000;
/** The course's lesson text, folded and with whitespace collapsed (bounded), for telling text the
 * learner copied from a lesson from their own words. */
export function courseText(bundle: unknown): string {
  const parts: string[] = [];
  let size = 0;
  for (const episode of episodesOf(bundle)) for (const block of Array.isArray(episode.blocks) ? episode.blocks : []) {
    const markdown = record(block)?.markdown;
    if (typeof markdown !== 'string' || size > COURSE_TEXT_LIMIT) continue;
    const text = fold(markdown).replace(/\s+/g, ' ');
    parts.push(text); size += text.length;
  }
  return parts.join('\n');
}
const cache = new Map<string, { checks: GradedCheck[]; text: string }>();
/** A release's checks and lesson text, remembered per release digest (bounded). */
export function courseChecksFor(digest: string, bundle: unknown) {
  const hit = cache.get(digest);
  if (hit) return hit;
  const value = { checks: gradedChecks(bundle), text: courseText(bundle) };
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(digest, value);
  return value;
}
/** The learner's own sentences: a sentence of 25 or more characters found in a lesson is left out. */
function ownSentences(question: string, lessonText?: string) {
  const all = sentencesOf(fold(question));
  return lessonText ? all.filter(sentence => sentence.length < 25 || !lessonText.includes(sentence)) : all;
}
/** A pasted check is the item: checks that only share its vocabulary are left out. Without a
 * paste, the described checks closest to the best one. */
function strongest(rows: { scored: Scored; how: 'quoted' | 'described' }[]) {
  const pasted = rows.filter(row => row.how === 'quoted');
  if (pasted.length) return pasted;
  const best = Math.max(...rows.map(row => row.scored.coverage));
  return rows.filter(row => row.scored.coverage >= best * 0.75);
}
/**
 * The graded checks a learner's message is about (at most three, strongest first), or none.
 * `current` lists this lesson's checks in reading order (checks with an open attempt first);
 * `nearby` adds the neighbouring lessons'. `earlier` are the learner's own earlier messages in this
 * lesson, oldest first.
 */
export function matchGradedChecks(input: { question: string; earlier?: readonly string[]; checks: readonly GradedCheck[]; current: readonly string[]; nearby: ReadonlySet<string>;
  /** The course's own lesson text (courseText): text copied from a lesson is neither a check nor
   * the learner asking for an answer. */
  courseText?: string }): CheckMatch[] {
  const own = ownSentences(input.question, input.courseText), folded = own.join('\n');
  const seeking = anyOf(ANSWER_SEEKING, folded), reference = anyOf(CHECK_REFERENCE, folded);
  // "Which option should I pick for the check?" asks and names the check in one sentence or the next.
  const asksAboutCheck = own.some((sentence, i) => anyOf(ANSWER_SEEKING, sentence)
    && [own[i - 1], sentence, own[i + 1]].some(near => near !== undefined && anyOf(CHECK_REFERENCE, near)));
  const ranked = (rows: { scored: Scored; how: CheckMatchKind }[]) => rows
    .sort((a, b) => b.scored.coverage + b.scored.trigrams - (a.scored.coverage + a.scored.trigrams) || b.scored.shared - a.scored.shared)
    .slice(0, MAX_MATCHES).map(row => ({ check: row.scored.check, how: row.how, score: Math.round((row.scored.coverage + row.scored.trigrams) * 1000) / 1000 }));
  // A pasted check is the item; a check that only shares vocabulary with it is not added.
  const direct = matchMessage(own.join('\n'), input.checks, input.nearby, { asks: seeking || reference, anywhere: asksAboutCheck });
  if (direct.length) return ranked(strongest(direct));
  // "Which option should I pick for the check?": this lesson's check the words point at, else the next one.
  if (asksAboutCheck) {
    const byId = new Map(input.checks.map(check => [check.id, check]));
    const lesson = input.current.flatMap(id => { const check = byId.get(id); return check ? [check] : []; });
    if (lesson.length) {
      const message = bag(folded), wantsOption = /\b(?:option|choice|pick|choose|select)\b|אפשרו|לבחור/.test(folded), wantsValue = /\b(?:value|number|result|calculate|compute)\b|ערך|מספר|לחשב/.test(folded);
      const rows = lesson.map(check => {
        const kind = (wantsOption && check.type === 'choice') || (wantsValue && check.keys.some(k => k.kind === 'number')) ? 1 : 0;
        return { check, value: score(check, message).distinctive * 2 + kind };
      });
      const best = Math.max(...rows.map(row => row.value));
      const chosen = best > 0 ? rows.filter(row => row.value === best).slice(0, 2) : rows.slice(0, 1);
      return chosen.map(row => ({ check: row.check, how: 'referenced' as const, score: row.value }));
    }
  }
  // A short follow-up ("so is it 3?") about a check the learner pasted or described just before.
  if (input.question.length <= 300 && (seeking || reference || anyOf(CONFIRMATION_ASKED, folded))) {
    for (const earlier of [...(input.earlier ?? [])].slice(-3).reverse()) {
      const found = matchMessage(ownSentences(earlier, input.courseText).join('\n'), input.checks, input.nearby, { asks: true, anywhere: false });
      if (found.length) return ranked(strongest(found).map(row => ({ ...row, how: 'earlier_message' as const })));
    }
  }
  return [];
}

/** The model-facing view of the matched checks: prompts and options, never a key. */
export function checkCoachingView(matches: readonly CheckMatch[]): CheckCoaching | undefined {
  if (!matches.length) return undefined;
  return { note: COACHING_NOTE, items: matches.map(({ check, how }) => ({ checkId: check.id, type: check.type, prompt: check.prompt.slice(0, 400),
    ...(check.options.length ? { options: check.options.map(text => text.slice(0, 160)) } : {}), match: how })) };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const EN_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const HE_NUMBER_WORDS: [string, number][] = [['אפס', 0], ['שתיים', 2], ['שניים', 2], ['שלוש', 3], ['שלושה', 3], ['ארבע', 4], ['ארבעה', 4], ['חמש', 5], ['חמישה', 5],
  ['שש', 6], ['שישה', 6], ['שבע', 7], ['שבעה', 7], ['שמונה', 8], ['תשע', 9], ['תשעה', 9], ['עשר', 10], ['עשרה', 10]];
const NUMBER = /(?<![\p{L}\p{N}_.^])(-?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\p{L}\p{N}_]|\.\d)/gu;
const LIST_MARKER = /^[ \t>•-]*\d{1,2}[.)]\s/gm;
/** Every number a reply states: digits (not list markers, exponents or parts of words),
 * simple fractions, "minus 6", and number words. "one" is too common to count. */
export function statedNumbers(folded: string): number[] {
  const values: number[] = [];
  // Numbered lines are a list only when there are at least two of them.
  const list = (folded.match(LIST_MARKER) ?? []).length >= 2;
  for (const match of folded.matchAll(NUMBER)) {
    const start = match.index, end = start + match[0].length;
    const lineStart = folded.lastIndexOf('\n', start - 1) + 1;
    if (list && !folded.slice(lineStart, start).replace(/[>•-]/g, '').trim() && /^[.)]\s/.test(folded.slice(end, end + 2))) continue;
    const value = Number(match[2]!.replaceAll(',', ''));
    if (Number.isFinite(value)) values.push(match[1] ? -value : value);
  }
  for (const match of folded.matchAll(/(?<![\p{L}\p{N}.])(\d+)\s*\/\s*(\d+)(?![\p{L}\p{N}]|\.\d)/gu))
    if (Number(match[2]) !== 0) values.push(Number(match[1]) / Number(match[2]));
  for (const match of folded.matchAll(/(?:\bminus|\bnegative|מינוס)\s+(\d+(?:\.\d+)?)/gu)) values.push(-Number(match[1]));
  for (const [index, word] of EN_NUMBER_WORDS.entries()) if (index !== 1 && new RegExp(`\\b${word}\\b`).test(folded)) values.push(index);
  for (const [word, value] of HE_NUMBER_WORDS) if (new RegExp(`(?<![\\p{L}])[והבלמשכ]{0,2}${word}(?![\\p{L}])`, 'u').test(folded)) values.push(value);
  return values;
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function phraseIn(folded: string, phrase: string) {
  const value = phrase.trim().replace(/[.!?;:,]+$/, '').replace(/\s+/g, ' ');
  return value.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, 'u').test(folded.replace(/\s+/g, ' '));
}
/** Share of an option's words found in `text` (0 for an option of fewer than `least` words). */
function wordsOf(option: string, text: string, least: number) {
  const words = new Set(contentTokens(option));
  return words.size < least ? 0 : shared(words, new Set(contentTokens(text))) / words.size;
}
/** The correct option's own wording: verbatim, or most of its words in one sentence. */
function optionStated(folded: string, option: string) {
  const text = fold(option).trim().replace(/[.!?;:,]+$/, '').replace(/\s+/g, ' ');
  if (text.length >= 12 && folded.replace(/\s+/g, ' ').includes(text)) return true;
  return folded.split(/[.!?;\n]+/).some(sentence => wordsOf(option, sentence, 4) >= 0.8);
}

const LETTERS = 'abcdefgh', HE_LETTERS = 'אבגדהוזח';
const EN_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const EN_CARDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const HE_ORDINALS = [['ראשונה', 'ראשון'], ['שנייה', 'שניה', 'שני'], ['שלישית', 'שלישי'], ['רביעית', 'רביעי'], ['חמישית', 'חמישי'], ['שישית', 'שישי'], ['שביעית', 'שביעי'], ['שמינית', 'שמיני']];
type Label = { index: number | 'last'; length: number };
/** One option label at the start of `rest`, with its length, or null. `words`: ordinal and
 * cardinal words count too (after a singular option noun). */
function label(rest: string, words: boolean): Label | null {
  const word = /^(?:ה)?(\p{L}+)/u.exec(rest);
  if (word && words) {
    const w = word[1]!, length = word[0].length;
    if (EN_ORDINALS.includes(w)) return { index: EN_ORDINALS.indexOf(w), length };
    // "two" to "eight" ("one" is too common: "answer one question").
    if (EN_CARDINALS.indexOf(w) > 0 && !/^\s+by\b/.test(rest.slice(length))) return { index: EN_CARDINALS.indexOf(w), length };
    if (w === 'last' || w === 'אחרונה' || w === 'אחרון') return { index: 'last', length };
    const he = HE_ORDINALS.findIndex(forms => forms.includes(w));
    if (he >= 0) return { index: he, length };
  }
  const single = /^([(\["']?)([a-h]|[א-ח]|[1-8])(['׳]?)([)\]"']?)/u.exec(rest);
  if (!single) return null;
  const [all, open, value, geresh, close] = single as unknown as [string, string, string, string, string];
  const after = rest.slice(all.length);
  // Never part of a longer word or number.
  if (/^[\p{L}\p{N}]/u.test(after)) return null;
  // A bare "a" is usually the article: it counts only marked (brackets, quotes) or followed by
  // punctuation, the end, or a connecting word. A Hebrew letter standing alone is always a label.
  const marked = Boolean(open || close || geresh) || /^\s*(?:$|[,.;:!?)\n/&-]|(?:and|or|nor|is|isn't|was|would|could|fits|works|because|since)\b)/.test(after);
  if (value === 'a' && !marked) return null;
  const index = LETTERS.includes(value) ? LETTERS.indexOf(value) : HE_LETTERS.includes(value) ? HE_LETTERS.indexOf(value) : Number(value) - 1;
  return { index, length: all.length };
}
/** A list of labels after a noun or verb ("options a and c", "אפשרויות א' ו-ג"). */
function labels(rest: string, words: boolean): (number | 'last')[] {
  const found: (number | 'last')[] = [];
  let at = 0;
  for (let guard = 0; guard < 8; guard++) {
    const spaces = /^\s*(?:#|no\.\s*|number\s+|מספר\s+)?/.exec(rest.slice(at))![0].length;
    const next = label(rest.slice(at + spaces), words);
    if (!next) break;
    found.push(next.index); at += spaces + next.length;
    const separator = /^\s*(?:,|\/|&|\band\b|\bor\b|\bnor\b|או(?!\p{L})|ו-?(?=[א-ח](?!\p{L}))|-)\s*/u.exec(rest.slice(at));
    if (!separator) break;
    at += separator[0].length;
  }
  return found;
}
/** Option nouns; singular ones may be followed by "three" or "third". */
const OPTION_NOUN = /\b(?:(option|choice|answer|alternative)|options|choices|answers|alternatives|letters?|statements?|sentences?)\b|(?<!\p{L})[והבלמשכ]{0,2}(?:(אפשרות|תשובה|חלופה|סעיף)|אפשרויות|תשובות|חלופות|סעיפים)(?!\p{L})/gu;
const OPTION_WORD = /\b(?:options?|choices?|answers?|alternatives?)\b|אפשרו|תשוב|חלופ/u;
const ORDINAL_NOUN_EN = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|last)\s+(?:options?|choices?|answers?|alternatives?)\b/g;
const ORDINAL_ONE_EN = /\bthe\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|last)\s+one\b/g;
const ORDINAL_NOUN_HE = /(?<!\p{L})[והבלמשכ]{0,2}(?:אפשרות|תשובה|חלופה)\s+(?:מספר\s+)?ה?(ראשונה|שנייה|שניה|שלישית|רביעית|חמישית|שישית|שביעית|שמינית|אחרונה)(?!\p{L})/gu;
/** A label right after "pick", "it's (not)", "rule out", "היא", "לבחור ב-", "לפסול את"... */
const VERB_LABEL = /(?:\b(?:pick|choose|select|go with|mark|circle|rule out|eliminate|cross off|cross out|exclude|it'?s|it is|isn'?t|is|be)(?:\s+not)?|(?<!\p{L})(?:היא|הוא|זו|זה|לבחור|בחרו|בחר|בחרי|לסמן|לפסול|לשלול|פוסלים|שוללים)(?:\s+לא)?)\s+(?:ב-?|את\s+)?(?=[(\["']?(?:[a-h]|[א-ח])['׳]?[)\]"']?(?:$|[\s,.;:!?]))/gu;
/** "(c)", a line opening "c)" or "c.", and "ג'": also how a reply enumerates its own steps, so these
 * count only when the reply speaks of options or the label is followed by that option's words. */
const MARKED_LABELS = [/(?:^|[\s,;:/])(?=[(\[](?:[a-h]|[א-ח])[)\]](?:$|[\s,.;:!?]))/gmu, /^[ \t>•-]*(?=(?:[a-h]|[א-ח])[.)]\s)/gmu,
  /(?:^|[\s(,;:])(?=[א-ח]['׳](?:$|[\s,.;:!?)]))/gmu];
/** Which options (by index) a reply names by letter, number or position. */
export function namedOptions(reply: string, options: readonly string[]): Set<number> {
  const folded = fold(reply), named = new Set<number>(), count = options.length;
  const add = (index: number | 'last') => { const i = index === 'last' ? count - 1 : index; if (i >= 0 && i < count) named.add(i); };
  for (const match of folded.matchAll(OPTION_NOUN)) for (const index of labels(folded.slice(match.index + match[0].length), Boolean(match[1] || match[2]))) add(index);
  for (const match of folded.matchAll(VERB_LABEL)) for (const index of labels(folded.slice(match.index + match[0].length), false)) add(index);
  const speaksOfOptions = OPTION_WORD.test(folded);
  for (const pattern of MARKED_LABELS) for (const match of folded.matchAll(pattern)) {
    const at = match.index + match[0].length, found = label(folded.slice(at), false);
    if (!found || found.index === 'last') continue;
    const following = folded.slice(at + found.length, at + found.length + 200).split('\n')[0]!;
    if (speaksOfOptions || (options[found.index] !== undefined && wordsOf(options[found.index]!, following, 1) >= 0.5)) add(found.index);
  }
  for (const match of folded.matchAll(ORDINAL_NOUN_EN)) add(match[1] === 'last' ? 'last' : EN_ORDINALS.indexOf(match[1]!));
  for (const match of folded.matchAll(ORDINAL_NOUN_HE)) add(match[1] === 'אחרונה' ? 'last' : HE_ORDINALS.findIndex(forms => forms.includes(match[1]!)));
  if (speaksOfOptions) for (const match of folded.matchAll(ORDINAL_ONE_EN)) add(match[1] === 'last' ? 'last' : EN_ORDINALS.indexOf(match[1]!));
  // The whole reply is one label ("c", "(c)", "C.", "ג'").
  const whole = /^\s*[(\["']?([a-h]|[א-ח])['׳]?[)\]"']?\s*[.!]?\s*$/u.exec(folded);
  if (whole) add(LETTERS.includes(whole[1]!) ? LETTERS.indexOf(whole[1]!) : HE_LETTERS.indexOf(whole[1]!));
  // A reply that opens with a label: "C. Fine-tuning...", "c - because ...".
  const opening = /^\s*[(\["']?([b-h]|[א-ח])['׳]?[)\]"']?\s*[.)!,:-]\s/u.exec(folded);
  if (opening) add(LETTERS.includes(opening[1]!) ? LETTERS.indexOf(opening[1]!) : HE_LETTERS.indexOf(opening[1]!));
  return named;
}

/** A verdict word opening the reply on its own ("Yes,", "No.", "כן,", "לא!"); "No problem" and
 * "לא אבחר" are not verdicts. */
const VERDICT_OPENING = [
  /^\s*(?:(?:yes|yeah|yep|yup|correct|right|exactly|indeed|absolutely|definitely|precisely|no|nope|incorrect|wrong|close)(?=\s*(?:[,.!:;\u2013\u2014-]|$))|not quite\b|not exactly\b)/,
  /^\s*(?:כן|נכון|בדיוק|אכן|צודק|צודקת|צדקת|ממש לא|לא בדיוק|לא נכון|לא|טעות|כמעט)(?=\s*(?:[,.!:;\u2013\u2014-]|$))/u,
];
const VERDICT_ANYWHERE = [
  /\b(?:that'?s|that is|it'?s|it is|you(?:'re| are)|you were)\s+(?:absolutely\s+|exactly\s+|not\s+)?(?:right|correct|wrong|incorrect)\b/,
  /\b(?:exactly|absolutely|quite) right\b/,
  /\byou got it\b|\bspot on\b|\bwell done\b/,
  /\b(?:is|isn'?t|is not)\s+the\s+(?:right|correct)\s+(?:answer|option|choice)\b/,
  /(?:זה|זו|התשובה|הבחירה)\s+(?:לא\s+)?(?:נכונה|נכון|שגויה|שגוי)(?![\p{L}])|צדקת/u,
];
function verdict(folded: string) { return anyOf(VERDICT_OPENING, folded) || anyOf(VERDICT_ANYWHERE, folded); }

/**
 * Whether a reply gives away the answer of one of the matched checks, and how. `question` is the
 * learner's message: a yes/no verdict counts only when they asked whether an answer is right.
 */
export function findCheckAnswerLeak(reply: string, checks: readonly GradedCheck[], question = ''): CheckLeak | null {
  const folded = fold(reply), numbers = statedNumbers(folded), confirming = anyOf(CONFIRMATION_ASKED, fold(question));
  for (const check of checks) {
    for (const key of check.keys) {
      if (key.kind === 'number' && numbers.some(value => Math.abs(value - key.value) <= key.tolerance)) return { reason: 'check_answer_stated', checkId: check.id };
      if (key.kind === 'text' && phraseIn(folded, fold(key.value))) return { reason: 'check_answer_stated', checkId: check.id };
      if (key.kind === 'option' && check.options[key.index] !== undefined && optionStated(folded, check.options[key.index]!)) return { reason: 'check_answer_stated', checkId: check.id };
    }
    // Naming some options but not all chooses one or rules others out.
    if (check.options.length >= 2) {
      const named = namedOptions(reply, check.options);
      if (named.size > 0 && named.size < check.options.length) return { reason: 'check_option_named', checkId: check.id };
    }
    if (confirming && verdict(folded)) return { reason: 'check_answer_confirmed', checkId: check.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The coaching message delivered in place of a withheld reply
// ---------------------------------------------------------------------------

/**
 * Tutor text, in the language of the learner's question (Hebrew when it has Hebrew words, else
 * English; Hebrew is gender-neutral: first-person future and infinitives, and the glossary's בדיקה
 * and ניסיון). It is the reply itself, stored and exported like
 * a model's reply, so it is rendered here rather than by the app.
 */
const COACHING_MESSAGES = {
  en: {
    choice: 'I can\'t choose, confirm or rule out options on a graded check, even when no attempt is open: the check is there to show what you can already do. I can still help you get there. Tell me which option looks right to you and why, or ask about the idea the check tests and I\'ll explain it with a different example.',
    number: 'I can\'t give or confirm the answer to a graded check, even when no attempt is open. I can help you work it out: write down what the question gives you and which rule from the lesson applies, then tell me what you get. I can also work through a similar example with different numbers.',
    other: 'I can\'t give or confirm the answer to a graded check, even when no attempt is open. I can help you work it out: tell me your reasoning so far, or ask about the idea the check tests and I\'ll explain it with a different example.',
  },
  he: {
    choice: 'לא אבחר, לא אאשר ולא אפסול תשובות בבדיקה של הקורס, גם כשאין ניסיון פתוח: הבדיקה נועדה להראות מה כבר ידוע לך. אפשר בכל זאת להתקדם יחד. כדאי לכתוב לי איזו אפשרות נראית מתאימה ולמה, או לשאול על הרעיון שהבדיקה בודקת, ואסביר אותו בעזרת דוגמה אחרת.',
    number: 'לא אתן ולא אאשר את התשובה לבדיקה של הקורס, גם כשאין ניסיון פתוח. אפשר לעבוד עליה יחד: כדאי לרשום מה נתון בשאלה ואיזה כלל מהשיעור מתאים לה, ואז לכתוב לי מה יוצא. אפשר גם לעבור יחד על דוגמה דומה עם מספרים אחרים.',
    other: 'לא אתן ולא אאשר את התשובה לבדיקה של הקורס, גם כשאין ניסיון פתוח. אפשר לעבוד עליה יחד: כדאי לכתוב לי את הדרך שלך עד עכשיו, או לשאול על הרעיון שהבדיקה בודקת, ואסביר אותו בעזרת דוגמה אחרת.',
  },
} as const;
export function checkCoachingMessage(question: string, checks: readonly GradedCheck[]): string {
  const locale = hebrewLetters(question) >= 8 ? 'he' : 'en';
  const kind = checks.some(check => check.options.length >= 2) ? 'choice' : checks.some(check => check.keys.some(key => key.kind === 'number')) ? 'number' : 'other';
  return COACHING_MESSAGES[locale][kind];
}

// ---------------------------------------------------------------------------
// Host checks (provider gateway and companion verifier)
// ---------------------------------------------------------------------------

type Sql = Database | PoolClient;
/** The graded checks with these ids in one course release, keys included (host-only). */
export async function releaseChecks(db: Sql, workspaceId: string, courseReleaseId: string, ids: readonly string[]): Promise<GradedCheck[]> {
  const row = (await db.query<{ assessments: unknown }>("SELECT server_bundle->'assessments' AS assessments FROM course_releases WHERE id=$1 AND workspace_id=$2",
    [courseReleaseId, workspaceId])).rows[0];
  const wanted = new Set(ids);
  return gradedChecks({ assessments: row?.assessments }).filter(check => wanted.has(check.id));
}
/** The companion strategy's output in check-coaching mode (agent-strategies.ts). */
interface CoachedReply { kind: 'companion_text'; text: string; episodeId?: string; cutShort?: true; checkCoaching: { checkIds: string[] } }
const coachedIds = (content: unknown): string[] | null => {
  const ids = record(record(content)?.checkCoaching)?.checkIds;
  return Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string') ? ids as string[] : null;
};
/**
 * The gateway's check before a companion reply is stored or its draft completed. A reply in
 * check-coaching mode that gives away a matched check's answer is replaced by the coaching message
 * (`withheld` names why); every other output is returned unchanged. When the matched checks cannot
 * be read back, nothing can be verified and the reply is withheld as well.
 */
export async function guardCompanionReply(db: Sql, scope: { workspaceId: string; courseReleaseId: string }, question: string, content: unknown):
  Promise<{ content: unknown; withheld: WithheldReason | null }> {
  const ids = coachedIds(content), value = record(content);
  if (!ids || value?.kind !== 'companion_text' || typeof value.text !== 'string') return { content, withheld: null };
  const checks = await releaseChecks(db, scope.workspaceId, scope.courseReleaseId, ids);
  const leak = checks.length === new Set(ids).size ? findCheckAnswerLeak(value.text, checks, question) : null;
  const withheld: WithheldReason | null = checks.length < new Set(ids).size ? 'check_keys_unavailable' : leak?.reason ?? null;
  if (!withheld) return { content, withheld: null };
  const reply: CoachedReply & { checkCoaching: { checkIds: string[]; withheld: WithheldReason } } = { kind: 'companion_text', text: checkCoachingMessage(question, checks),
    ...(typeof value.episodeId === 'string' ? { episodeId: value.episodeId } : {}), checkCoaching: { checkIds: ids, withheld } };
  return { content: reply, withheld };
}
/**
 * The companion verifier's re-check of a stored reply (companion-verifier.ts): when the job's
 * dispatch ran in check-coaching mode, the reply must not give away a matched check's answer. A
 * reply Core already put in place of a withheld one (`withheld`) is its own coaching text.
 */
export async function storedReplyKeepsChecks(db: Sql, ref: { jobId: string; enrollmentId: string; workspaceId: string }, text: string): Promise<boolean> {
  const dispatch = (await db.query<{ candidate: unknown }>("SELECT candidate FROM provider_dispatches WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND state='completed' ORDER BY finished_at DESC NULLS LAST LIMIT 1",
    [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  const ids = coachedIds(dispatch?.candidate);
  if (!ids) return true;
  const input = (await db.query<{ context: { courseReleaseId?: unknown } }>("SELECT context FROM supervisor_inputs WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND checkpoint_id='generate'",
    [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  if (typeof input?.context.courseReleaseId !== 'string') return false;
  const checks = await releaseChecks(db, ref.workspaceId, input.context.courseReleaseId, ids);
  if (checks.length < new Set(ids).size) return false;
  const question = (await db.query<{ content: string }>("SELECT content FROM companion_messages WHERE job_id=$1 AND enrollment_id=$2 AND role='learner' LIMIT 1", [ref.jobId, ref.enrollmentId])).rows[0]?.content ?? '';
  return !findCheckAnswerLeak(text, checks, question);
}
