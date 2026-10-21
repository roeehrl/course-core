import type { Direction } from './locales.ts';

/** Unicode directional isolates (UAX #9). Use them where markup (`<bdi>`, `dir`) is unavailable. */
export const FSI = '⁨';
export const LRI = '⁦';
export const RLI = '⁧';
export const PDI = '⁩';

/** Isolates text whose direction is unknown (user or course text) inside a plain string. */
export function isolate(text: string): string {
  return `${FSI}${text}${PDI}`;
}
/** Forces left-to-right for ids, codes, digests, URLs and versions inside right-to-left text. */
export function isolateLtr(text: string): string {
  return `${LRI}${text}${PDI}`;
}
/** Removes isolate and embedding controls, for comparisons and tests. */
export function stripBidiControls(text: string): string {
  return text.replace(/[‎‏‪-‮⁦-⁩]/g, '');
}

const RTL_SCRIPTS = new Set(['arab', 'hebr', 'syrc', 'thaa', 'nkoo', 'adlm', 'rohg', 'mand', 'samr', 'yezi']);
const RTL_LANGUAGES = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'yi', 'ji', 'ps', 'dv', 'sd', 'ug', 'ckb', 'syr', 'arc', 'prs', 'pnb', 'mzn', 'glk', 'lrc', 'azb', 'nqo']);

/**
 * Writing direction of any BCP 47 language tag, such as a course's declared
 * language. Returns undefined when the tag is missing or malformed; callers then
 * use `dir="auto"`.
 */
export function languageDirection(tag: string | null | undefined): Direction | undefined {
  if (typeof tag !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) return undefined;
  const [language, ...rest] = tag.toLowerCase().split('-');
  const script = rest.find((part) => part.length === 4 && /^[a-z]{4}$/.test(part));
  if (script) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  return RTL_LANGUAGES.has(language!) ? 'rtl' : 'ltr';
}

/**
 * `lang`/`dir` attributes for a container of course content. Course content renders
 * in the course's declared language, independent of the UI locale. Without a valid
 * declared language the browser decides per paragraph (`dir="auto"`).
 */
export function contentAttributes(language: string | null | undefined): { lang?: string; dir: Direction | 'auto' } {
  const dir = languageDirection(language);
  return dir ? { lang: language!, dir } : { dir: 'auto' };
}
