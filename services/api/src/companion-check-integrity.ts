/**
 * Graded-check integrity for the companion (docs/companion-check-integrity.md).
 *
 * The tutor never hands a learner the answer to one of the course's graded checks, whether or not
 * an attempt is open. Four layers:
 *
 * 1. Instruction. Core's companion strategy always carries the graded-check rule, and a stricter
 *    check-coaching rule when the question is about a check's answer (agent-strategies.ts).
 * 2. Matching (`matchGradedChecks`). Before a companion call, the learner's CURRENT message is read
 *    for what it does: pasting a check, or asking for or testing an answer ("is it 3?", "it's not a
 *    or b, right?", "which option should I pick?", "רק תרמזו על איזו אפשרות"). Only then is it
 *    matched against the course's checks: the item pasted anywhere in the course, an item described
 *    near this lesson, or the check it refers to, scored over this lesson's and the neighbouring
 *    lessons' checks by its words, its kind ("the transfer check", "בדיקת המעקב"), the numbers it
 *    shares with an item and what it proposes (an option letter fits a choice item, a value a
 *    numeric one). With no confident match the turn is coached generically over the candidates,
 *    never one assumed. A short follow-up about an answer ("is it 3?") inherits the check of the
 *    learner's last messages; an ordinary question after a paste is tutored normally.
 *    A match puts the call in check-coaching mode: the model is told which items they are (prompt
 *    and options only, never a key) and the reply is held back from the learner until it is checked.
 * 3. Deterministic verification (`findCheckAnswerLeak`), high-precision patterns only: a choice
 *    item's correct option by its text, or some options by letter, number or position; a numeric
 *    value within its tolerance, in digits or words, except a number the lesson itself uses that
 *    the reply does not assert as the answer; a trace step's answer; and a yes/no verdict, only when
 *    the learner proposed an answer.
 * 4. A semantic judge (companion-check-judge.ts), a second model call through the workspace's
 *    reviewer role (or the role the companion binding names): given the checks, their keys and the
 *    draft, it answers whether the reply states, confirms, rules out or decides an equivalent case
 *    of an answer. It fails closed. On a hit by either stage the reply is withheld (never stored or
 *    shown) and a fixed coaching message is delivered instead, charged at what the calls used.
 *
 * Rubric, code and production items have no deterministic key, so only the instruction, the judge
 * and the confirmation rule apply to them.
 */
import type { PoolClient } from 'pg';
import type { Database } from './database.js';

/** A deterministic answer key of a graded check. Host-only: never sent to a model. */
export type CheckKey = { kind: 'option'; index: number } | { kind: 'number'; value: number; tolerance: number } | { kind: 'text'; value: string };
export interface GradedCheck {
  id: string; type: string;
  /** The SDK item role ('recognition', 'application', 'transfer', 'diagnostic_probe'), when declared. */
  role?: string;
  prompt: string;
  /** Option texts in the order the learner sees them (choice items). */
  options: string[];
  /** Step prompts (trace items). */
  steps: string[];
  /** Empty for items graded by a rubric, code tests or a reviewer. */
  keys: CheckKey[];
}
/** `unresolved`: the learner asked about a check's answer but which check is not certain; the turn
 * is coached generically and every candidate is verified. */
export type CheckMatchKind = 'quoted' | 'described' | 'referenced' | 'earlier_message' | 'unresolved';
export interface CheckMatch { check: GradedCheck; how: CheckMatchKind; score: number }
/** What the model is told in check-coaching mode (TeachingContext.checkCoaching). No key, ever. */
export interface CheckCoaching {
  note: string;
  items: { checkId: string; type: string; prompt: string; options?: string[]; match: CheckMatchKind }[];
}
export type CheckLeakReason = 'check_answer_stated' | 'check_option_named' | 'check_answer_confirmed';
export interface CheckLeak { reason: CheckLeakReason; checkId: string }
/** Why a reply was withheld, recorded on the stored message (codes only). `check_keys_unavailable`:
 * the matched checks could not be read back from the course release, so nothing could be verified.
 * `check_answer_judged`: the semantic judge found that the reply gives an answer away.
 * `check_judge_unavailable`: the judge could not give a verdict (not configured, unpriced, no room
 * in the reservation, failed or malformed), so the reply was not kept (fail closed). */
export const WITHHELD_REASONS = ['check_answer_stated', 'check_option_named', 'check_answer_confirmed', 'check_keys_unavailable',
  'check_answer_judged', 'check_judge_unavailable'] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

const MAX_CHECKS = 2000;
const MAX_MATCHES = 3;
/** Candidates of a turn whose check is not certain (all are coached and verified). */
const MAX_CANDIDATES = 4;
const COACHING_NOTE = 'The learner\'s message is about the answer to these graded checks of the course. Their answers are withheld from you on purpose: coach without giving, choosing, confirming or ruling out any answer.';
const UNRESOLVED_NOTE = 'The learner is asking about the answer to one of this lesson\'s graded checks, but which one is not certain: these are the candidates. Their answers are withheld from you on purpose: do not give, choose, confirm or rule out an answer for any of them. Ask which check they mean when it matters, and coach on the ideas.';

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
  return { id: item.id.slice(0, 200), type: item.type.slice(0, 40), ...(typeof item.role === 'string' ? { role: item.role.slice(0, 40) } : {}),
    prompt: item.prompt.slice(0, 4000), options: options.map(option => option.text), steps, keys };
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
/** Which checks count as this lesson's (`current`, in reading order, items with an open attempt
 * first), as nearby (this lesson, the lessons just before and after it, and every open item), and
 * which have an open attempt (`open`). */
export function checkScope(bundle: unknown, episodeId: string, blockId: string | null | undefined, openCheckIds: readonly string[] = []) {
  const episodes = episodesOf(bundle), index = episodes.findIndex(e => e.id === episodeId);
  const current = index >= 0 ? lessonCheckIds(bundle, episodes[index]!, blockId) : [];
  const nearby = new Set([...current, ...openCheckIds]);
  for (const neighbour of [episodes[index - 1], episodes[index + 1]]) if (index >= 0 && neighbour) for (const id of lessonCheckIds(bundle, neighbour)) nearby.add(id);
  return { current: [...new Set([...openCheckIds, ...current])], nearby, open: [...new Set(openCheckIds)] };
}
/** One lesson's own text (its text blocks, as the companion's context carries them). */
export function lessonText(bundle: unknown, episodeId: string): string {
  const episode = episodesOf(bundle).find(e => e.id === episodeId);
  const blocks = Array.isArray(episode?.blocks) ? episode.blocks : [];
  return blocks.flatMap(block => { const b = record(block); return b?.type === 'text' && typeof b.markdown === 'string' ? [b.markdown] : []; }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Points and cantillation, but not the maqaf (U+05BE), which reads as a hyphen. */
const HEBREW_MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;
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
const shared = <T,>(a: Set<T>, b: Set<T>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const hebrewLetters = (text: string) => (text.match(/[א-ת]/g) ?? []).length;
const anyOf = (patterns: readonly RegExp[], text: string) => patterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(text); });
/** Digits written in a text (language-neutral: a Hebrew description of an English item shares them). */
const digitsIn = (folded: string) => new Set((folded.match(/(?<![\p{L}\p{N}.])-?\d+(?:\.\d+)?(?![\p{L}\p{N}])/gu) ?? []).map(Number));

// ---------------------------------------------------------------------------
// What the learner's message does (answer intent)
// ---------------------------------------------------------------------------

/**
 * What one learner message does about an answer. `asks`: asks for an answer, or a hint to it
 * ("which option should I pick", "just the number", "תרמזו על איזו אפשרות"). `tests`: proposes or
 * eliminates an answer ("is it 3?", "it's not a or b, right?", "I think it's c", "אז זה 3?").
 * `reference`: names a check ("the check", "בדיקת ההעברה"). `kind`: whether an option or a value
 * is meant. Ordinary questions ("Is it correct that...", "Which option in a library freezes a
 * layer?", "...right?") do none of these.
 */
export interface AnswerIntent { asks: boolean; tests: boolean; reference: boolean; kind: 'option' | 'value' | null; labels: number[]; values: number[] }

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const SUBJECT_EN = String.raw`(?:it|that|this|the\s+(?:final\s+|correct\s+|right\s+)?(?:answer|result|value|solution|option|choice|one)|my\s+answer)`;
/** Where a proposed value or option follows: "is it", "would the answer be", "it's", "the answer is". */
const TEST_ANCHORS = [
  new RegExp(String.raw`\b(?:is|was|would|could|should|will|must)\s+${SUBJECT_EN}\s+(?:be\s+|then\s+)?(?:option\s+|choice\s+|answer\s+|letter\s+)?`, 'gu'),
  new RegExp(String.raw`\b${SUBJECT_EN}\s*(?:'s|is|=|would\s+be|will\s+be|must\s+be|should\s+be|has\s+to\s+be)\s+(?:then\s+|probably\s+|just\s+|definitely\s+|really\s+)?(?:option\s+|choice\s+|answer\s+|letter\s+)?`, 'gu'),
  /(?<!\p{L})(?:אז\s+|כלומר\s+|בעצם\s+|ש)?(?:זה|זו|התשובה(?:\s+(?:היא|זה|זו))?|הערך(?:\s+הוא)?|התוצאה(?:\s+היא)?|יוצא(?:\s+לי)?|יצא(?:\s+לי)?)\s+(?:אפשרות\s+|תשובה\s+|מספר\s+)?/gu,
];
/** A proposal stated outright ("I think it's c", "my answer is 3", "בחרתי בג'"): no question mark needed. */
const PROPOSAL_ANCHORS = [
  /\b(?:i\s+(?:think|guess|believe|chose|picked|put|got|have|entered|answered|went\s+with|would\s+say|'d\s+say|would\s+go\s+with|'d\s+go\s+with)|my\s+(?:answer|guess|pick)\s+(?:is|was)|i'?m\s+going\s+with|i'?ll\s+(?:go\s+with|pick|choose))\s+(?:that\s+)?(?:it'?s\s+|it\s+is\s+|the\s+answer\s+is\s+)?(?:option\s+|choice\s+|answer\s+)?/gu,
  /(?<!\p{L})(?:אני\s+חושב(?:ת|ים)?\s+ש(?:זה\s+|התשובה\s+(?:היא\s+)?)?|לדעתי\s+(?:זה\s+|התשובה\s+(?:היא\s+)?)?|קיבלתי\s+|בחרתי\s+(?:ב-?|את\s+)?|סימנתי\s+(?:את\s+)?|התשובה\s+שלי\s+(?:היא\s+)?)(?:אפשרות\s+)?/gu,
];
/** Verbs that take an option label ("pick c", "rule out a and b", "לפסול את א'"). */
const LABEL_VERBS = [
  /\b(?:pick|choose|select|go\s+with|mark|circle|tick|rule\s+out|eliminate|cross\s+off|cross\s+out|exclude|discard)\s+(?:option\s+|choice\s+|answer\s+)?/gu,
  /(?<!\p{L})(?:לבחור|לסמן|לפסול|לשלול|לבטל|בוחר(?:ת|ים)?|פוסל(?:ת|ים)?|שולל(?:ת|ים)?)\s+(?:ב-?|את\s+|על\s+)?(?:אפשרות\s+|תשובה\s+)?/gu,
];
/** "option c", "answer b", "אפשרות ג'" in the learner's message. */
const OPTION_LABEL_NOUN = /\b(?:option|choice|answer|letter)\s+(?=[(\["']?(?:[a-h]|[1-8])['׳]?[)\]"']?(?:$|[\s,.;:!?]))|(?<!\p{L})[והבלמשכ]{0,2}(?:אפשרות|אפשרויות|תשובה|חלופה)\s+(?=[(\["']?[א-ח]['׳]?[)\]"']?(?:$|[\s,.;:!?]))/gu;
/** What may follow a proposed value for it to be a question about it: ", right?", "?", the end. */
const CLOSES_PROPOSAL = /^\s*(?:[,;:]?\s*(?:right|correct|then|too|instead|maybe|perhaps|or\s+not|isn'?t\s+it|is\s+it|yes|true|נכון|כן|בטוח|לא)\s*)*(?:[?]|[.!]*\s*$)/u;
/** Asking whether an answer is right without restating it ("is my answer right?", "צדקתי?"). */
const VERDICT_ASKED = [
  /\b(?:is|was)\s+(?:my|this|that|the)\s+(?:answer|solution|choice|pick|guess|result|option)\s+(?:right|correct|wrong|ok|okay|good)\b/u,
  /\bdid\s+i\s+get\s+(?:it|the\s+(?:answer|check|question)|this\s+one|that\s+one)\s+(?:right|correct|wrong)\b/u,
  /(?<!\p{L})(?:התשובה|הפתרון|הבחירה)\s+שלי\s+(?:נכונה|נכון|טובה|בסדר|שגויה)(?!\p{L})|(?<!\p{L})צדקתי(?!\p{L})/u,
];
const ASKS = [
  /\b(?:tell|give|show|send|reveal)\s+(?:me\s+|us\s+)?(?:just\s+|only\s+)?(?:the|your)\s+(?:final\s+|correct\s+|right\s+|exact\s+)?(?:answer|solution|number|value|result|letter|option)\b/u,
  /\bwhat(?:'s|\s+is|\s+was)\s+the\s+(?:final\s+|correct\s+|right\s+|exact\s+)?(?:answer|solution)\b/u,
  /\b(?:just|only)\s+(?:the\s+)?(?:answer|number|letter|value|result)\b/u,
  /\bwhich\s+(?:option|answer|choice|one|letter|statement)\s+(?:(?:should|do|would|shall|must|can|could)\s+(?:i|we)|(?:i|we)\s+(?:should|need\s+to|have\s+to|must|ought\s+to))\s+(?:pick|choose|select|go\s+with|mark|circle|tick|look\s+at|focus\s+on|consider|use|enter|submit)\b/u,
  /\bwhich\s+(?:option|answer|choice|one|letter|statement|number|value)\s+(?:is|'s|would\s+be|seems|looks)\s+(?:the\s+)?(?:right|correct|best|true|supported|it|valid)\b/u,
  /\b(?:hint|clue|nudge|point\s+me|steer\s+me|tip)\b[^.?!\n]{0,60}\b(?:which|what)\s+(?:option|answer|choice|one|letter|number|value)\b/u,
  /\bwhat\s+(?:number|value|letter|option|answer)\s+(?:should|do|would|must)\s+(?:i|we)\s+(?:enter|put|write|type|pick|give|submit|choose)\b/u,
  /\bwhich\s+(?:option|answer|choice|one)\s*\?/u,
  /\b(?:answer|solve|do)\s+(?:the|this|that|it)\s+(?:(?:check|quiz|test|question|item|problem|exercise)\s+)?for\s+me\b/u,
  /(?<!\p{L})(?:תגיד|תגידי|תגידו|תן|תני|תנו|תכתוב|תכתבי|תכתבו|תראה|תראי|תראו|להגיד|לתת|תאמר|תאמרי|תאמרו)\s+(?:לי\s+|לנו\s+)?(?:רק\s+)?(?:את\s+)?ה?(?:תשובה|פתרון|מספר|ערך|אפשרות|אות)(?!\p{L})/u,
  /(?<!\p{L})מה\s+ה?(?:תשובה|פתרון)(?!\p{L})/u,
  /(?<!\p{L})(?:רק|אך\s+ורק)\s+(?:את\s+)?ה?(?:תשובה|מספר|אות|ערך)(?!\p{L})/u,
  /(?<!\p{L})[בעלמ]?(?:איזו|איזה|אילו)\s+ה?(?:אפשרות|תשובה|חלופה|אות|ערך|מספר)\s+(?:נכונה|נכון|הנכונה|הנכון|לבחור|כדאי|צריך|צריכה|לסמן|היא|הוא|זו|זה|מתאימה|מתאים|הכי)/u,
  /(?<!\p{L})על\s+איזו\s+ה?(?:אפשרות|תשובה|חלופה)/u,
  /(?<!\p{L})(?:איזו|איזה)\s+ה?(?:אפשרות|תשובה|חלופה)\s*\?/u,
  /(?<!\p{L})(?:תרמוז|תרמזי|תרמזו|לרמוז|רמז|רמזים)(?!\p{L})[^.?!\n]{0,60}(?:אפשרו|תשוב|כיוון)/u,
  /(?<!\p{L})(?:תענה|תעני|תענו|לענות)\s+רק\s+ב?(?:מספר|אות)/u,
  /(?<!\p{L})(?:תפתור|תפתרי|תפתרו|לפתור)\s+(?:לי\s+)?(?:את\s+)?ה?(?:בדיקה|שאלה|תרגיל)/u,
];
const ASKS_OPTION = /\b(?:which|what)\s+(?:option|choice|letter|statement)\b|(?:hint|clue|point\s+me)[^.?!\n]{0,60}\bwhich\s+one\b|(?<!\p{L})(?:איזו|איזה|אילו)\s+ה?(?:אפשרות|חלופה|אות)|אפשרו/u;
const ASKS_VALUE = /\b(?:what|which)\s+(?:number|value)\b|\b(?:just|only)\s+(?:the\s+)?(?:number|value)\b|(?<!\p{L})(?:רק\s+)?(?:את\s+)?ה?(?:מספר|ערך)(?!\p{L})/u;
const CHECK_REFERENCE = [
  /\b(?:checks?|quiz(?:zes)?|tests?|exams?|assessments?|graded|homework)\b/u,
  /\b(?:the|this|that)\s+(?:question|item|problem|exercise)\b/u,
  /(?<!\p{L})[והבלמשכ]{0,3}(?:בדיק|בוחן|מבחן|מבדק|מטל)|(?<!\p{L})[והבלמשכ]{0,2}(?:השאלה|התרגיל)\s+(?:הזו|הזאת|הזה|הבא|הבאה)/u,
];
/** A number or option list at the start of `rest`, optionally negated ("not a or b", "לא א'"). */
function proposal(rest: string, optionNoun: boolean): { negated: boolean; labels: number[]; values: number[]; length: number } | null {
  const neg = /^\s*(?:not|n't|neither|לא)\s+(?:option\s+|choice\s+|אפשרות\s+)?/u.exec(rest), at = neg ? neg[0].length : 0;
  if (!optionNoun) {
    const value = new RegExp(String.raw`^\s*(${NUM})(?![\p{L}\p{N}])`, 'u').exec(rest.slice(at));
    if (value) return { negated: Boolean(neg), labels: [], values: [Number(value[1])], length: at + value[0].length };
  }
  const found: number[] = [];
  let length = at;
  for (let guard = 0; guard < 8; guard++) {
    const spaces = /^\s*/.exec(rest.slice(length))![0].length;
    const next = label(rest.slice(length + spaces), false);
    if (!next || next.index === 'last') break;
    found.push(next.index); length += spaces + next.length;
    const separator = /^\s*(?:,|\/|&|\band\b|\bor\b|\bnor\b|או(?!\p{L})|ו-?(?=[א-ח](?!\p{L})))\s*/u.exec(rest.slice(length));
    if (!separator) break;
    length += separator[0].length;
  }
  return found.length ? { negated: Boolean(neg), labels: found, values: [], length } : null;
}
export function answerIntent(text: string): AnswerIntent {
  const folded = fold(text).replace(/[ \t]+/g, ' ');
  const labels = new Set<number>(), values = new Set<number>();
  let tests = false;
  const take = (found: ReturnType<typeof proposal>, closure: boolean, rest: string) => {
    if (!found) return;
    // A value is a proposal only when it ends the question ("is it 3?"); "is it 3 steps?" is not.
    if (found.values.length && closure && !CLOSES_PROPOSAL.test(rest.slice(found.length))) return;
    for (const value of found.values) values.add(value);
    for (const index of found.labels) labels.add(index);
    tests = true;
  };
  for (const pattern of TEST_ANCHORS) for (const match of folded.matchAll(pattern)) {
    const rest = folded.slice(match.index + match[0].length);
    take(proposal(rest, /(?:option|choice|letter|אפשרות)\s+$/u.test(match[0])), true, rest);
  }
  for (const pattern of PROPOSAL_ANCHORS) for (const match of folded.matchAll(pattern)) {
    const rest = folded.slice(match.index + match[0].length);
    take(proposal(rest, /(?:option|choice|אפשרות)\s+$/u.test(match[0])), false, rest);
  }
  for (const pattern of LABEL_VERBS) for (const match of folded.matchAll(pattern)) {
    const rest = folded.slice(match.index + match[0].length), found = proposal(rest, true);
    if (found) take(found, false, rest);
  }
  for (const match of folded.matchAll(OPTION_LABEL_NOUN)) {
    const rest = folded.slice(match.index + match[0].length), found = proposal(rest, true);
    if (found) take(found, false, rest);
  }
  // "...not a or b, right?" without an anchor before it.
  for (const match of folded.matchAll(/(?<![\p{L}'])(?:not|לא)\s+(?=[(\["']?(?:[a-h]|[א-ח])['׳]?[)\]"']?\s*(?:,|\bor\b|\bnor\b|\band\b|או(?!\p{L})|ו-?[א-ח]))/gu)) {
    const rest = folded.slice(match.index);
    const found = proposal(rest, true);
    if (found && found.labels.length >= 2) take(found, false, rest);
  }
  if (anyOf(VERDICT_ASKED, folded)) tests = true;
  const asks = anyOf(ASKS, folded);
  const reference = anyOf(CHECK_REFERENCE, folded);
  const kind = labels.size || (asks && ASKS_OPTION.test(folded)) ? 'option' : values.size || (asks && ASKS_VALUE.test(folded)) ? 'value' : null;
  return { asks, tests, reference, kind, labels: [...labels].sort((a, b) => a - b), values: [...values] };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Core's own words for kinds of check, in English and Hebrew: a Hebrew learner naming "בדיקת
 * ההעברה" or "שאלת הבחירה" points at an English item of that type, SDK role or id word. */
const idHas = (check: GradedCheck, word: string) => check.id.toLowerCase().split(/[^a-z]+/).some(part => part.startsWith(word));
const KIND_WORDS: { pattern: RegExp; fits: (check: GradedCheck) => boolean }[] = [
  { pattern: /\bmultiple[- ]choice\b|\bchoice\s+(?:check|question|item)\b|רב[- ]?ברירה|(?<!\p{L})[והבלמשכ]{0,3}(?:אמריקאית|בחירה)(?!\p{L})/u, fits: c => c.type === 'choice' },
  { pattern: /\btrac(?:e|ing)\b|(?<!\p{L})[והבלמשכ]{0,3}מעקב(?!\p{L})/u, fits: c => c.type === 'trace' || idHas(c, 'trace') },
  { pattern: /\bpredict(?:ion)?\b|(?<!\p{L})[והבלמשכ]{0,3}(?:חיזוי|ניבוי|תחזית)(?!\p{L})/u, fits: c => c.type === 'prediction' || idHas(c, 'predict') },
  { pattern: /\bnumeric(?:al)?\b|(?<!\p{L})[והבלמשכ]{0,3}(?:מספרית|מספרי)(?!\p{L})/u, fits: c => c.type === 'numeric' },
  { pattern: /\bcod(?:e|ing)\s+(?:check|question|task|exercise)\b|(?<!\p{L})[והבלמשכ]{0,3}קוד(?!\p{L})/u, fits: c => c.type === 'code' },
  { pattern: /\b(?:essay|rubric|written)\b|(?<!\p{L})[והבלמשכ]{0,3}(?:חיבור|מחוון)(?!\p{L})/u, fits: c => c.type === 'rubric' },
  { pattern: /\btransfer\b|(?<!\p{L})[והבלמשכ]{0,3}(?:העברה|העברת)(?!\p{L})/u, fits: c => c.role === 'transfer' || idHas(c, 'transfer') },
  { pattern: /\brecognition\b|(?<!\p{L})[והבלמשכ]{0,3}זיהוי(?!\p{L})/u, fits: c => c.role === 'recognition' || idHas(c, 'recogn') },
  { pattern: /\b(?:diagnostic|probe)\b|(?<!\p{L})[והבלמשכ]{0,3}אבחון(?!\p{L})/u, fits: c => c.role === 'diagnostic_probe' || idHas(c, 'probe') },
];

interface Scored { check: GradedCheck; shared: number; coverage: number; trigrams: number; options: number }
interface CheckWords { prompt: Bag; options: Bag[]; distinctive: string[]; numbers: Set<number>; all: Set<string> }
/** A check's own words, computed once per check object (checks are cached per release). */
const checkWords = new WeakMap<GradedCheck, CheckWords>();
function wordsOfCheck(check: GradedCheck): CheckWords {
  let words = checkWords.get(check);
  if (!words) {
    const text = `${check.prompt} ${check.steps.join(' ')}`, prompt = bag(text), options = check.options.map(bag);
    words = { prompt, options,
      distinctive: [...new Set([...prompt.set, ...contentTokens(check.id.replace(/[-_]/g, ' '))])].filter(token => !GENERIC.has(token) && !/^\p{N}+$/u.test(token) && token.length > 2),
      numbers: digitsIn(fold(text)), all: new Set([...prompt.set, ...options.flatMap(o => [...o.set])]) };
    checkWords.set(check, words);
  }
  return words;
}
function score(check: GradedCheck, message: Bag): Scored {
  const { prompt, options: optionWords } = wordsOfCheck(check);
  const sharedTokens = shared(prompt.set, message.set);
  // A short option ("Six units left.") counts only whole; a longer one by most of its words.
  const options = optionWords.filter(option => option.set.size > 0 && shared(option.set, message.set) / option.set.size >= (option.set.size <= 3 ? 1 : 0.6)).length;
  return { check, shared: sharedTokens, coverage: prompt.set.size ? sharedTokens / prompt.set.size : 0,
    trigrams: prompt.trigrams.size >= 2 ? shared(prompt.trigrams, message.trigrams) / prompt.trigrams.size : 0, options };
}
/** A pasted check reproduces its wording: most of its word sequences, or most of its words with
 * some of its sequences (a topical question that shares a short item's words is not a paste), or
 * two of its options. */
const quoted = (s: Scored) => s.trigrams >= 0.5 || (s.coverage >= 0.6 && s.shared >= 3 && (s.trigrams >= 0.2 || wordsOfCheck(s.check).prompt.trigrams.size < 2))
  || (s.check.options.length >= 2 && s.options >= 2 && (s.shared >= 1 || !s.check.prompt.trim()));
const described = (s: Scored) => s.coverage >= 0.35 && s.shared >= 3;

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
type Row = { scored: Scored; how: 'quoted' | 'described' };
/** A pasted check is the item: checks that only share its vocabulary are left out. Without a
 * paste, the described checks closest to the best one. */
function strongest(rows: Row[]) {
  const pasted = rows.filter(row => row.how === 'quoted');
  if (pasted.length) return pasted;
  const best = Math.max(...rows.map(row => row.scored.coverage));
  return rows.filter(row => row.scored.coverage >= best * 0.75);
}
const ranked = (rows: Row[], how?: CheckMatchKind): CheckMatch[] => rows
  .sort((a, b) => b.scored.coverage + b.scored.trigrams - (a.scored.coverage + a.scored.trigrams) || b.scored.shared - a.scored.shared)
  .slice(0, MAX_MATCHES).map(row => ({ check: row.scored.check, how: how ?? row.how, score: Math.round((row.scored.coverage + row.scored.trigrams) * 1000) / 1000 }));

interface Scope { checks: readonly GradedCheck[]; current: readonly string[]; nearby: ReadonlySet<string>; open: readonly string[] }
/**
 * The check a message refers to ("the transfer check", "it's not a or b", "איזו אפשרות"), scored
 * over this lesson's and the neighbouring lessons' checks: its distinctive words and the item's
 * id words, Core's kind words in English or Hebrew, two or more numbers shared with the item, and
 * whether what it proposes fits the item (an option letter needs options, a value a numeric key).
 * An open attempt and this lesson break ties. With no evidence at all, or more than two equally
 * good items, it is unresolved: every candidate is coached and verified, none assumed.
 */
function referenced(intent: AnswerIntent, folded: string, message: Bag, scope: Scope): { matches: CheckMatch[]; weak: boolean } {
  const byId = new Map(scope.checks.map(check => [check.id, check]));
  const pool = [...new Set([...scope.current, ...scope.nearby])].flatMap(id => { const check = byId.get(id); return check ? [check] : []; });
  if (!pool.length) return { matches: [], weak: true };
  const kinds = KIND_WORDS.filter(kind => kind.pattern.test(folded)), numbers = digitsIn(folded);
  const highest = intent.labels.length ? Math.max(...intent.labels) : -1;
  const rows = pool.flatMap(check => {
    // An option letter never names an item without that many options.
    if (intent.labels.length && check.options.length <= highest) return [];
    const words = wordsOfCheck(check);
    const distinctive = words.distinctive.filter(token => message.set.has(token)).length + (kinds.some(kind => kind.fits(check)) ? 1 : 0)
      + (shared(words.numbers, numbers) >= 2 ? 1 : 0);
    const typed = intent.kind === 'option' ? check.options.length >= 2
      : intent.kind === 'value' ? check.keys.some(key => key.kind === 'number') || check.type === 'numeric' || check.type === 'prediction' : false;
    const open = scope.open.includes(check.id), lesson = scope.current.includes(check.id);
    return [{ check, distinctive, evidence: distinctive > 0 || typed || open, score: 4 * distinctive + 2 * Number(typed) + 2 * Number(open) + Number(lesson), lesson }];
  });
  const evidenced = rows.filter(row => row.evidence);
  if (evidenced.length) {
    const best = Math.max(...evidenced.map(row => row.score)), top = evidenced.filter(row => row.score === best);
    // Only what the message itself says about the item (its words, kind or numbers, or an open
    // attempt) is strong; a fit by option letters or a value alone yields to an earlier message.
    const weak = top.every(row => row.distinctive === 0 && !scope.open.includes(row.check.id));
    if (top.length <= 2) return { matches: top.map(row => ({ check: row.check, how: 'referenced' as const, score: row.score })), weak };
    return { matches: top.slice(0, MAX_CANDIDATES).map(row => ({ check: row.check, how: 'unresolved' as const, score: row.score })), weak: true };
  }
  const lesson = rows.filter(row => row.lesson);
  return { matches: (lesson.length ? lesson : rows).slice(0, MAX_CANDIDATES).map(row => ({ check: row.check, how: 'unresolved' as const, score: 0 })), weak: true };
}
/** Whether a matched item can be what an intent proposes: option letters need that many options. */
const fits = (intent: AnswerIntent, check: GradedCheck) => !intent.labels.length || check.options.length > Math.max(...intent.labels);
/** One message on its own: a pasted check (anywhere in the course), then, when the message asks for
 * or tests an answer, a check it describes (nearby, or anywhere when it also names a check) or
 * refers to. `earlier`: an earlier message of the learner, where a description alone counts. */
function matchOne(text: string, scope: Scope, courseText: string | undefined, earlier: boolean): { matches: CheckMatch[]; weak: boolean } {
  const own = ownSentences(text, courseText), folded = own.join('\n'), message = bag(folded);
  const scored = scope.checks.map(check => score(check, message));
  const pasted = scored.filter(quoted).map((s): Row => ({ scored: s, how: 'quoted' }));
  if (pasted.length) return { matches: ranked(pasted), weak: false };
  const intent = answerIntent(folded), directed = intent.asks || intent.tests;
  if (!directed && !earlier) return { matches: [], weak: true };
  const anywhere = directed && intent.reference;
  const describedRows = scored.filter(s => (anywhere || scope.nearby.has(s.check.id)) && described(s)).map((s): Row => ({ scored: s, how: 'described' }));
  if (describedRows.length) return { matches: ranked(strongest(describedRows)), weak: false };
  if (directed && (intent.reference || intent.labels.length)) return referenced(intent, folded, message, scope);
  return { matches: [], weak: true };
}
/** Words a short follow-up about an answer may use without having a topic of its own. */
const FOLLOW_UP_WORDS = new Set(['tell', 'giv', 'hint', 'look', 'sure', 'think', 'guess', 'mean', 'wait', 'actually', 'mayb', 'instead', 'should', 'rul', 'cross', 'eliminat',
  'confirm', 'wrong', 'one', 'letter', 'pleas', 'okay', 'ok', 'realli', 'still', 'again', 'thank', 'thanks', 'enter', 'put', 'writ', 'typ', 'submit', 'need', 'want', 'full',
  'whol', 'point', 'focu', 'go', 'then', 'now', 'sorry', 'hmm', 'yes', 'yeah', 'true', 'fals', 'instead', 'other', 'els', 'same', 'agre', 'sur', 'know']);
/**
 * The graded checks a learner's message is about (at most three, strongest first; up to four
 * candidates when unresolved), or none. Check mode starts only from what the CURRENT message does:
 * it pastes a check, or asks for or tests an answer of one. `current` lists this lesson's checks in
 * reading order (checks with an open attempt first); `nearby` adds the neighbouring lessons';
 * `open` the items with an open attempt. `earlier` are the learner's own earlier messages in this
 * lesson, oldest first: a follow-up that asks for or tests an answer without a topic of its own
 * ("is it 3?", "so it's c, right?", "what's the answer then?") inherits their check; any other
 * question after a paste is tutored normally.
 */
export function matchGradedChecks(input: { question: string; earlier?: readonly string[]; checks: readonly GradedCheck[]; current: readonly string[]; nearby: ReadonlySet<string>;
  open?: readonly string[];
  /** The course's own lesson text (courseText): text copied from a lesson is neither a check nor
   * the learner asking for an answer. */
  courseText?: string }): CheckMatch[] {
  const scope: Scope = { checks: input.checks, current: input.current, nearby: input.nearby, open: input.open ?? [] };
  const direct = matchOne(input.question, scope, input.courseText, false);
  if (direct.matches.length && !direct.weak) return direct.matches;
  const own = ownSentences(input.question, input.courseText).join('\n'), intent = answerIntent(own);
  if (input.question.length > 300 || !(intent.asks || intent.tests)) return direct.matches;
  for (const earlier of [...(input.earlier ?? [])].slice(-3).reverse()) {
    const found = matchOne(earlier, scope, input.courseText, true).matches.filter(m => fits(intent, m.check));
    if (!found.length) continue;
    // A follow-up with a topic of its own ("is it 3 because the optimizer reads the log?") is a new question.
    const words = new Set(found.flatMap(m => [...wordsOfCheck(m.check).all]));
    const topic = contentTokens(own).filter(token => !GENERIC.has(token) && !FOLLOW_UP_WORDS.has(token) && !/^\p{N}/u.test(token) && token.length > 1 && !words.has(token));
    if (topic.length > 4) return direct.matches;
    return found.map(m => ({ ...m, how: m.how === 'unresolved' ? 'unresolved' as const : 'earlier_message' as const }));
  }
  return direct.matches;
}

/** The model-facing view of the matched checks: prompts and options, never a key. */
export function checkCoachingView(matches: readonly CheckMatch[]): CheckCoaching | undefined {
  if (!matches.length) return undefined;
  return { note: matches.some(match => match.how === 'unresolved') ? UNRESOLVED_NOTE : COACHING_NOTE,
    items: matches.map(({ check, how }) => ({ checkId: check.id, type: check.type, prompt: check.prompt.slice(0, 400),
      ...(check.options.length ? { options: check.options.map(text => text.slice(0, 160)) } : {}), match: how })) };
}

// ---------------------------------------------------------------------------
// Verification (deterministic, high precision)
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
/** The value a number token at the start of `rest` stands for (digits, "minus 3", a number word), or null. */
function numberAt(rest: string): number | null {
  const digits = /^(-\s?)?(\d+(?:\.\d+)?)(?![\p{L}\p{N}_]|\.\d)/u.exec(rest);
  if (digits) return (digits[1] ? -1 : 1) * Number(digits[2]);
  const minus = /^(?:minus|negative|מינוס)\s+(\d+(?:\.\d+)?)/u.exec(rest);
  if (minus) return -Number(minus[1]);
  const word = /^[והבלמשכ]{0,2}(\p{L}+)/u.exec(rest)?.[1];
  if (!word) return null;
  const en = EN_NUMBER_WORDS.indexOf(word);
  if (en >= 0 && en !== 1) return en;
  return HE_NUMBER_WORDS.find(([w]) => w === word)?.[1] ?? null;
}
/** What a check's question asks for: its single-letter variables ("What is the current value of
 * w?") and the noun it asks about ("What is the measured increase...?" -> increase, "How many
 * leaves...?" -> leaves), as a reply would name them when it states the answer. */
function askedVariables(check: GradedCheck): string[] {
  const questions = sentencesOf(fold(`${check.prompt}\n${check.steps.join('\n')}`)).filter(sentence => /\?$|^(?:what|which|how|find|compute|calculate|מה|כמה|איזה|מצאו|חשבו)\b/u.test(sentence));
  const found = new Set<string>();
  for (const sentence of questions) {
    for (const match of sentence.matchAll(/(?:value\s+of|ערך\s+(?:של\s+)?|is|does|of)\s+([a-z][a-z0-9]?)(?![\p{L}\p{N}])/gu)) if (!STOP.has(match[1]!)) found.add(match[1]!);
    for (const match of sentence.matchAll(/(?<![\p{L}\p{N}'])([b-hj-z])(?![\p{L}\p{N}'])/gu)) found.add(match[1]!);
    const noun = /^(?:what|which)\s+(?:is|was|are|were)\s+(?:the|its|their)\s+([a-z][a-z -]{0,60}?)\s*(?:\b(?:in|of|for|on|after|between|from|at|when|if)\b|\?|,|$)/u.exec(sentence)
      ?? /^(?:what|which)\s+([a-z]+)\b/u.exec(sentence) ?? /^how\s+(?:many|much)\s+([a-z]+)\b/u.exec(sentence);
    const head = noun?.[1]?.trim().split(/[\s-]+/).at(-1);
    if (head && head.length > 2 && !STOP.has(head)) found.add(head);
  }
  return [...found].slice(0, 8);
}
/** An arithmetic result over the check's own numbers ("10 - 6 = 4"): the check worked through. */
function workedResults(folded: string, check: GradedCheck): number[] {
  const own = wordsOfCheck(check).numbers, values: number[] = [];
  for (const match of folded.matchAll(/((?:-?\d+(?:\.\d+)?\s*[-+*/×÷x]\s*)+-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)(?![\d.])/gu)) {
    const operands = (match[1]!.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (operands.filter(value => own.has(value)).length >= 2) values.push(Number(match[2]));
  }
  return values;
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Numbers a reply asserts as an answer: the reply (or its first line) is the number, or it follows
 * "the answer is", "it's", "= ", or one of the variables the check asks about ("w stays 3"). */
export function assertedNumbers(folded: string, check?: GradedCheck): number[] {
  const values: number[] = [];
  const whole = /^\s*(-?\d+(?:\.\d+)?)\s*[.!]?\s*(?:\n|$)/u.exec(folded);
  if (whole) values.push(Number(whole[1]));
  const variables = check ? askedVariables(check).map(escape) : [];
  const subjects = [String.raw`(?:the\s+)?(?:final\s+|correct\s+|right\s+)?(?:answer|result|solution)`, 'it', 'that', ...variables.map(v => `(?<![\\p{L}\\p{N}_])${v}`)].join('|');
  const anchors = [
    new RegExp(String.raw`(?:${subjects})\s*(?:'s|is|was|=|equals|is\s+equal\s+to|would\s+be|will\s+be|must\s+be|stays(?:\s+at)?|remains(?:\s+at)?|is\s+still|still|becomes|ends\s+up(?:\s+at|\s+as|\s+being)?|comes\s+to|gives|:)\s*(?:still\s+|exactly\s+|just\s+|only\s+|at\s+)?`, 'gu'),
    new RegExp(String.raw`(?<!\p{L})(?:התשובה|התוצאה|הפתרון|${variables.length ? `${variables.join('|')}` : '(?!)'})\s*(?:היא|הוא|יהיה|תהיה|נשאר(?:ת|ים)?|עדיין|שווה(?:\s+ל-?)?|=|יוצא|יצא|:)\s*(?:עדיין\s+|בדיוק\s+|רק\s+)?`, 'gu'),
  ];
  for (const anchor of anchors) for (const match of folded.matchAll(anchor)) {
    const value = numberAt(folded.slice(match.index + match[0].length));
    if (value !== null) values.push(value);
  }
  if (check) values.push(...workedResults(folded, check));
  return values;
}
function phraseIn(folded: string, phrase: string) {
  const value = phrase.trim().replace(/[.!?;:,]+$/, '').replace(/\s+/g, ' ');
  return value.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, 'u').test(folded.replace(/\s+/g, ' '));
}
/** Share of an option's words found in `text` (0 for an option of fewer than `least` words). */
function wordsOf(option: string, text: string, least: number) {
  const words = new Set(contentTokens(option));
  return words.size < least ? 0 : shared(words, new Set(contentTokens(text))) / words.size;
}
/** The correct option's own wording: verbatim, or most of its words in one sentence. A translation
 * or paraphrase of it is the judge's to find (companion-check-judge.ts). */
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
 * count only when the reply speaks of options or the label is followed by that option's words, and
 * never right after a noun that enumerates something else ("stage a'", "שלב א'", "step (b)"). */
const MARKED_LABELS = [/(?:^|[\s,;:/])(?=[(\[](?:[a-h]|[א-ח])[)\]](?:$|[\s,.;:!?]))/gmu, /^[ \t>•-]*(?=(?:[a-h]|[א-ח])[.)]\s)/gmu,
  /(?:^|[\s(,;:])(?=[א-ח]['׳](?:$|[\s,.;:!?)]))/gmu];
const ENUMERATING_NOUN = /(?:\b(?:stage|step|part|phase|layer|case|example|row|column|point|model|scenario|figure|panel|version|group|team|plant|pot|route|line)s?|(?<!\p{L})[והבלמשכ]{0,2}(?:שלב|שלבים|חלק|מקרה|שכבה|דוגמה|שורה|עמודה|נקודה|מודל|תרחיש|גרסה|קבוצה|צוות|מסלול|קו|עציץ))\s*$/u;
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
    if (ENUMERATING_NOUN.test(folded.slice(Math.max(0, at - 24), at))) continue;
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
  /^\s*(?:(?:yes|yeah|yep|yup|correct|right|exactly|indeed|absolutely|definitely|precisely|no|nope|incorrect|wrong|close)(?=\s*(?:[,.!:;–—-]|$))|not quite\b|not exactly\b)/,
  /^\s*(?:כן|נכון|בדיוק|אכן|צודק|צודקת|צדקת|ממש לא|לא בדיוק|לא נכון|לא|טעות|כמעט)(?=\s*(?:[,.!:;–—-]|$))/u,
];
const VERDICT_ANYWHERE = [
  /\b(?:that'?s|that is|it'?s|it is|you(?:'re| are)|you were)\s+(?:absolutely\s+|exactly\s+|not\s+)?(?:right|correct|wrong|incorrect)\b/,
  /\b(?:exactly|absolutely|quite) right\b/,
  /\byou got it\b|\bspot on\b|\bwell done\b/,
  /\b(?:is|isn'?t|is not)\s+the\s+(?:right|correct)\s+(?:answer|option|choice)\b/,
  /(?:זה|זו|התשובה|הבחירה)\s+(?:לא\s+)?(?:נכונה|נכון|שגויה|שגוי)(?![\p{L}])|צדקת/u,
];
function verdict(folded: string) { return anyOf(VERDICT_OPENING, folded) || anyOf(VERDICT_ANYWHERE, folded); }

/** What the verifier knows about the turn besides the reply: the lesson's own text, whose numbers
 * a reply may repeat (the lesson's own example) unless it asserts one as the answer. */
export interface LeakScope { lessonText?: string; lessonNumbers?: readonly number[] }
/** The numbers a lesson's text uses (bounded), as the verifier scopes them. */
export function lessonNumbers(text: string): number[] { return [...new Set(statedNumbers(fold(text)))].slice(0, 400); }
/**
 * Whether a reply gives away the answer of one of the matched checks, and how. High-precision
 * patterns only; a paraphrase is the judge's. `question` is the learner's message: a yes/no verdict
 * counts only when it proposed or eliminated an answer ("is it 3?", "it's not a, right?"), never
 * for an ordinary "...right?". A number the lesson itself uses counts only when the reply asserts
 * it as the answer ("the answer is 3", "w stays 3", or the reply is the number).
 */
export function findCheckAnswerLeak(reply: string, checks: readonly GradedCheck[], question = '', scope: LeakScope = {}): CheckLeak | null {
  const folded = fold(reply), numbers = statedNumbers(folded), confirming = answerIntent(question).tests;
  const lesson = scope.lessonNumbers ?? (scope.lessonText ? lessonNumbers(scope.lessonText) : []);
  for (const check of checks) {
    for (const key of check.keys) {
      if (key.kind === 'number') {
        const near = (value: number) => Math.abs(value - key.value) <= key.tolerance;
        if (numbers.some(near) && (!lesson.some(near) || assertedNumbers(folded, check).some(near))) return { reason: 'check_answer_stated', checkId: check.id };
      }
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
/** The semantic judge's verdict on one reply (companion-check-judge.ts). */
export type JudgeVerdict = { verdict: 'kept' } | { verdict: 'leak'; findings: string[] } | { verdict: 'unavailable'; code: string };
/** Runs the judge for a reply in check-coaching mode; it never throws (a failure is `unavailable`). */
export type CheckReplyJudge = (input: { checks: readonly GradedCheck[]; reply: string; question: string }) => Promise<JudgeVerdict>;
/** The companion strategy's output in check-coaching mode (agent-strategies.ts). */
interface CoachedReply { kind: 'companion_text'; text: string; episodeId?: string; cutShort?: true;
  checkCoaching: { checkIds: string[]; lessonNumbers?: number[]; withheld?: WithheldReason } }
const coachedIds = (content: unknown): string[] | null => {
  const ids = record(record(content)?.checkCoaching)?.checkIds;
  return Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string') ? ids as string[] : null;
};
/**
 * The gateway's check before a companion reply is stored or its (hidden) draft completed. A reply
 * in check-coaching mode is checked by the deterministic patterns (scoped to the lesson's own
 * numbers), then, when they find nothing, by the semantic judge. A reply that gives an answer away,
 * or that could not be judged (fail closed), is replaced by the coaching message (`withheld` names
 * why); every other output is returned unchanged, with the lesson numbers the check used recorded
 * on its check-coaching mark so the companion verifier repeats the same check. When the matched
 * checks cannot be read back, nothing can be verified and the reply is withheld as well.
 */
export async function guardCompanionReply(db: Sql, scope: { workspaceId: string; courseReleaseId: string; lessonText?: string }, question: string, content: unknown,
  judge: CheckReplyJudge): Promise<{ content: unknown; withheld: WithheldReason | null; judged: JudgeVerdict | null }> {
  const ids = coachedIds(content), value = record(content);
  if (!ids || value?.kind !== 'companion_text' || typeof value.text !== 'string') return { content, withheld: null, judged: null };
  const checks = await releaseChecks(db, scope.workspaceId, scope.courseReleaseId, ids);
  const numbers = scope.lessonText ? lessonNumbers(scope.lessonText) : [];
  const complete = checks.length === new Set(ids).size;
  const leak = complete ? findCheckAnswerLeak(value.text, checks, question, { lessonNumbers: numbers }) : null;
  let judged: JudgeVerdict | null = null;
  if (complete && !leak) judged = await judge({ checks, reply: value.text, question });
  const withheld: WithheldReason | null = !complete ? 'check_keys_unavailable' : leak ? leak.reason
    : judged?.verdict === 'leak' ? 'check_answer_judged' : judged?.verdict === 'unavailable' ? 'check_judge_unavailable' : null;
  const mark = { checkIds: ids, ...(numbers.length ? { lessonNumbers: numbers } : {}) };
  if (!withheld) return { content: { ...value, checkCoaching: mark }, withheld: null, judged };
  const reply: CoachedReply = { kind: 'companion_text', text: checkCoachingMessage(question, checks),
    ...(typeof value.episodeId === 'string' ? { episodeId: value.episodeId } : {}), checkCoaching: { ...mark, withheld } };
  return { content: reply, withheld, judged };
}
/**
 * The companion verifier's re-check of a stored reply (companion-verifier.ts): when the job's
 * dispatch ran in check-coaching mode, the reply must not give away a matched check's answer by the
 * deterministic patterns, scoped as the gateway scoped them. A reply Core already put in place of a
 * withheld one (`withheld`) is its own coaching text. The semantic judge ran in the gateway; a
 * reply that reached storage some other way still meets the deterministic check here.
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
  const recorded = record(record(dispatch?.candidate)?.checkCoaching)?.lessonNumbers;
  const numbers = Array.isArray(recorded) ? recorded.filter(finite).slice(0, 400) : [];
  return !findCheckAnswerLeak(text, checks, question, { lessonNumbers: numbers });
}
