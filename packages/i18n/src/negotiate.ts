import {
  DEFAULT_LOCALE,
  PSEUDO_LOCALES,
  SUPPORTED_LOCALES,
  isAppLocale,
  type AppLocale,
  type SupportedLocale,
} from './locales.ts';

const TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
/** Legacy or alternate primary subtags that mean a supported language. */
const ALIASES: Readonly<Record<string, SupportedLocale>> = { iw: 'he' };

/**
 * Parses an HTTP Accept-Language header into tags ordered by preference.
 * Invalid entries and q=0 are dropped; the result is bounded.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (typeof header !== 'string' || !header || header.length > 2000) return [];
  const entries: { tag: string; q: number; index: number }[] = [];
  for (const [index, part] of header.split(',').slice(0, 30).entries()) {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim() ?? '';
    if (tag !== '*' && !TAG.test(tag)) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/.exec(param);
      if (match) q = Number(match[1]);
    }
    if (q > 0 && q <= 1) entries.push({ tag, q, index });
  }
  return entries.sort((a, b) => b.q - a.q || a.index - b.index).map((entry) => entry.tag);
}

/**
 * The first candidate tag that maps to an app locale: an exact match (case-insensitive),
 * then by primary language subtag (`he-IL` → `he`). Pseudo-locales match only when allowed.
 */
export function negotiateLocale(
  candidates: readonly (string | null | undefined)[],
  options: { allowPseudo?: boolean } = {},
): AppLocale | undefined {
  const allowed: readonly string[] = options.allowPseudo ? [...SUPPORTED_LOCALES, ...PSEUDO_LOCALES] : SUPPORTED_LOCALES;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !TAG.test(candidate)) continue;
    const exact = allowed.find((locale) => locale.toLowerCase() === candidate.toLowerCase());
    if (exact && isAppLocale(exact)) return exact;
    const primary = candidate.split('-')[0]!.toLowerCase();
    const aliased = ALIASES[primary] ?? primary;
    const byLanguage = SUPPORTED_LOCALES.find((locale) => locale === aliased);
    if (byLanguage) return byLanguage;
  }
  return undefined;
}

export type LocaleSource = 'user' | 'request' | 'workspace' | 'default';

/**
 * The documented fallback order: the user's saved preference, then the request's
 * languages (Accept-Language or navigator.languages), then the workspace default,
 * then English.
 */
export function resolveLocale(input: {
  user?: string | null | undefined;
  requested?: readonly string[] | undefined;
  workspace?: string | null | undefined;
  allowPseudo?: boolean;
}): { locale: AppLocale; source: LocaleSource } {
  const options = { allowPseudo: input.allowPseudo === true };
  const user = negotiateLocale([input.user], options);
  if (user) return { locale: user, source: 'user' };
  const requested = negotiateLocale(input.requested ?? [], options);
  if (requested) return { locale: requested, source: 'request' };
  const workspace = negotiateLocale([input.workspace]);
  if (workspace) return { locale: workspace, source: 'workspace' };
  return { locale: DEFAULT_LOCALE, source: 'default' };
}
