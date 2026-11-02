/**
 * The answer-leak rules shared by the `hint_leakage` grader (agent-evals/graders.ts) and the
 * companion's answer guard (companion-answer-guard.ts), so a quality check and a learner's turn
 * read a reply the same way.
 *
 * A protected answer is a pattern: the grader's come from a dialogue's fixture, the guard's from
 * the answer keys of the graded checks in scope (`keyAnswerPatterns`). A pattern that is only a
 * number counts where the reply states it as a result ("= 2", "you end at 2", "the answer is two",
 * or the number alone in its sentence), never where it is an operand or a start of a worked example
 * ("start at 2", "2 - 5 = -3"), and never with its own sign ("-2" is not 2). So a number the
 * lesson uses is still explained; it is a leak only where the reply arrives at it.
 *
 * Pure functions, no imports: the same text always gets the same answer on every machine.
 */

/** LaTeX commands models write in maths, as the plain characters a pattern can match. */
const LATEX: Record<string, string> = { times: "×", cdot: "×", div: "÷", dots: "...", ldots: "...", cdots: "...", gt: ">", lt: "<", ge: "≥", geq: "≥", le: "≤", leq: "≤", to: "→", rightarrow: "→", ne: "≠", neq: "≠", quad: " ", qquad: " ",
  left: "", right: "", big: "", Big: "", bigl: "", bigr: "", lvert: "|", rvert: "|", vert: "|" };
/** Typography-insensitive form for matching: smart quotes, the minus sign, Markdown emphasis, LaTeX
 * maths delimiters and common commands ($-1$ reads as -1, \times as ×, \left| as |), whitespace,
 * and the padding inside absolute-value bars ($| \text{b} - a |$ reads as |b - a|). */
/** A numbered list's markers ("1. ", "2) " starting a line, two or more of them) are numbering, not numbers the reply states. */
const LIST_MARKER = /^[ \t]*\d{1,2}[.)][ \t]+(?=\S)/gmu;
const dropListMarkers = (text: string) => ((text.match(LIST_MARKER)?.length ?? 0) >= 2 ? text.replace(LIST_MARKER, "") : text);
export function normalize(text: string) {
  return dropListMarkers(text.normalize("NFKC")).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[−–]/g, "-")
    .replace(/\\(?:text|mathrm|mathit|mathbf|textbf|textit|operatorname)\{([^{}]*)\}/g, "$1").replace(/\\([a-z]+)\b/gi, (all, name: string) => LATEX[name] ?? LATEX[name.toLowerCase()] ?? all)
    .replace(/\\[()[\],;:! ]|\$/g, "")
    .replace(/[*_`]/g, "").replace(/\s+/g, " ").replace(/\|\s*([^|]{1,60}?)\s*\|/g, "|$1|").trim();
}
export const allMatches = (source: string, text: string) => [...text.matchAll(new RegExp(source, "giu"))].filter((m) => m[0].length > 0);

const NUMBER_WORDS = String.raw`zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|אפס|אחת|אחד|שתיים|שניים|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה`;
/** A match that is only a number (in digits or words, with its sign), which may as well be an operand as an answer. */
const BARE_NUMBER = new RegExp(String.raw`^(?:[+-]\s?)?\d+(?:[.,]\d+)?$|^(?:(?:negative|minus|מינוס)\s+)?(?:${NUMBER_WORDS})$`, "iu");
/** Characters around a number in maths that say nothing about its role. */
const trimEnd = (text: string) => text.replace(/[\s()[\]{}"'«»]+$/u, ""), trimStart = (text: string) => text.replace(/^[\s()[\]{}"'«»]+/u, "");
/** Immediately before a number: it is the result of something (=, "is", "gives", "to", "ל-"). */
const RESULT_BEFORE = new RegExp(String.raw`(?:[=≈→:]|->|\b(?:is|are|was|were|be|equals?|equal to|gives?|giving|gets?|got|getting|makes?|become(?:s)?|comes? (?:out )?to|total of|to|at|answer|result)|(?<!\p{L})(?:שווה(?:\s+ל-?)?|יוצא|יצא|נקבל|מקבלים|מקבל|התשובה(?:\s+היא)?|התוצאה(?:\s+היא)?|היא|הוא|ל-?))$`, "iu");
/** Immediately before a number: where a move arrives ("lands at", "נעצרים ב-"), which wins over a start marker. */
const ARRIVAL_BEFORE = new RegExp(String.raw`(?:\b(?:reach(?:es|ed|ing)?|arriv(?:e|es|ed|ing) at|land(?:s|ed|ing)?(?: up)?(?: at| on)?|end(?:s|ed|ing)?(?: up)?(?: at| on)?|finish(?:es|ed|ing)?(?: at| on)?|stop(?:s|ped|ping)?(?: at| on)?)|(?<!\p{L})(?:מגיע|נגיע|נעצר|נוחת|מסיימ|נגמר)\p{L}*\s+(?:ל|ב)-?)$`, "iu");
/** Immediately before a number: it is where a worked example starts ("start at 2", "מתחילים ב-2"). */
const START_BEFORE = new RegExp(String.raw`(?:\b(?:start(?:s|ed|ing)?|begin(?:s|ning)?|began)(?: (?:at|from|on|with))?|\bfrom|(?<!\p{L})(?:מתחיל\p{L}*|מתחילה|התחלה|נקודת התחלה)(?:\s+(?:ב|מ)-?)?|(?<!\p{L})(?:ב|מ)-?)$`, "iu");
/** Immediately after a number: it is an operand (another term follows) or it is stated as the answer. */
const OPERAND_AFTER = /^[+\-×*/÷·]\s*[-(]?\s*\d/u;
const RESULT_AFTER = /^(?:(?:units?|steps?|cm|mm)\s+)?(?:in total|in all|altogether|overall|total\b|is (?:the |your )?(?:answer|result|correct|right)\b|(?<!\p{L})(?:בסך הכול|סך הכול|זו התשובה|היא התשובה))/iu;
/** Whether a numeric match states a result: after =, "is", "lands at" or the like, or alone in its
 * sentence. A number that starts a worked example or is an operand in one ("2 - 5 = -3") is not. */
function statedAsResult(text: string, index: number, length: number) {
  const before = trimEnd(text.slice(Math.max(0, index - 60), index)), after = trimStart(text.slice(index + length));
  if (/[=≈]$/u.test(before)) return true;
  if (OPERAND_AFTER.test(after)) return false;
  if (RESULT_AFTER.test(after)) return true;
  if (ARRIVAL_BEFORE.test(before)) return true;
  if (START_BEFORE.test(before)) return false;
  if (RESULT_BEFORE.test(before)) return true;
  // Alone in its sentence: the whole reply or a line that is just the number.
  return (before === "" || /[.!?](?!\d)$/u.test(before)) && /^(?:[.!?](?!\d)|$)/u.test(after);
}
/** Immediately before an unsigned number: its own sign (a minus after no operand, as in "= -2" or
 * "ל--2", or the word), so the number is a different, negative one. Subtraction ("5 - 2", "x-2") is not. */
const SIGN_BEFORE = /(?:(?:^|[^\p{L}\p{N})\]\s])\s*-\s?|(?<!\p{L})(?:minus|negative|מינוס)\s+)$/iu;
const negated = (text: string, m: RegExpMatchArray) => !/^[+-]|^(?:minus|negative|מינוס)\b/iu.test(m[0].trim()) && SIGN_BEFORE.test(text.slice(Math.max(0, m.index! - 20), m.index));
/** The first match of a protected-answer pattern that reveals it. A bare number counts only where it
 * is stated as a result and with its own sign; a pattern with its own context (a unit, a phrase) always counts. */
export function revealingMatch(source: string, text: string): string | null {
  return allMatches(source, text).find((m) => !BARE_NUMBER.test(m[0].trim()) || (!negated(text, m) && statedAsResult(text, m.index, m[0].length)))?.[0] ?? null;
}
/** Patterns that each match one item, for `revealingMatch`: the indices of those a reply reveals. */
export function revealedPatterns(patterns: readonly string[], normalizedText: string): number[] {
  return patterns.flatMap((p, i) => (revealingMatch(p, normalizedText) !== null ? [i] : []));
}

/** A number key's words: English to twenty ("one" is left out: "one more step" is too common) and
 * Hebrew to ten, both genders ("אחת"/"אחד" left out for the same reason). */
const EN_WORDS = ["zero", "", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty"];
const HE_WORDS: readonly (readonly string[])[] = [["אפס"], [], ["שתיים", "שניים"], ["שלוש", "שלושה"], ["ארבע", "ארבעה"], ["חמש", "חמישה"], ["שש", "שישה"], ["שבע", "שבעה"],
  ["שמונה"], ["תשע", "תשעה"], ["עשר", "עשרה"]];
/** A Hebrew word alone or after one prefix letter ("לשתיים", "בשלוש"), never inside a longer word. */
const hebrewWord = (word: string) => String.raw`(?<!\p{L}\p{L})(?<![^\P{L}ולבהמשכ])${word}(?!\p{L})`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The protected-answer patterns of one graded check's keys, in the form a dialogue's fixture writes
 * them (see companion.adversarial.pasted-check-hebrew): a numeric key as digits with its own sign
 * and as English and Hebrew number words. A choice or text key adds none: Core's check verifier
 * (companion-check-integrity.ts `findCheckAnswerLeak`) reads those, for the guard and the grader alike.
 */
export function keyAnswerPatterns(keys: readonly ({ kind: string; value?: unknown })[]): string[] {
  const patterns: string[] = [];
  for (const key of keys) {
    if (key.kind !== "number" || typeof key.value !== "number" || !Number.isFinite(key.value)) continue;
    const value = key.value, magnitude = Math.abs(value), digits = escape(String(magnitude));
    // A positive value is never matched right after a minus sign of its own ("-2"); a Hebrew prefix
    // hyphen ("ל-2", "to 2") is not a sign. A negative value needs its sign.
    patterns.push(value >= 0 ? String.raw`(?<![\d.])(?<!(?<!\p{L})-)${digits}(?!\d|\.\d)` : String.raw`(?<![\d.])-\s?${digits}(?!\d|\.\d)`);
    if (!Number.isInteger(magnitude) || magnitude === 1 || (value < 0 && magnitude === 0)) continue;
    const en = EN_WORDS[magnitude], he = HE_WORDS[magnitude] ?? [];
    if (value >= 0) {
      if (en) patterns.push(String.raw`\b${en}\b`);
      for (const word of he) patterns.push(hebrewWord(word));
    } else {
      if (en) patterns.push(String.raw`\b(?:negative|minus)\s+${en}\b`);
      for (const word of he) patterns.push(String.raw`(?<!\p{L})מינוס\s+${word}(?!\p{L})`);
    }
  }
  return [...new Set(patterns)];
}
