/**
 * The one list of locales Course Core supports. The API, the admin app and the
 * learner app all read it from here. Adding a locale starts with this file
 * (docs/i18n.md, "Adding a locale").
 */
export type Direction = 'ltr' | 'rtl';

export interface LocaleInfo {
  /** BCP 47 tag used for `lang`, Intl and catalog folder names. */
  readonly code: string;
  readonly dir: Direction;
  /** The language's own name for itself. Shown in the switcher in every UI locale. */
  readonly nativeName: string;
}

export const SUPPORTED_LOCALES = ['en', 'he'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LOCALES: { readonly [L in SupportedLocale]: LocaleInfo & { readonly code: L } } = {
  en: { code: 'en', dir: 'ltr', nativeName: 'English' },
  he: { code: 'he', dir: 'rtl', nativeName: 'עברית' },
};

/**
 * Pseudo-locales for development and tests only. They render the English
 * catalog transformed, so any string that is not transformed is hardcoded.
 * `en-XA` accents and expands; `ar-XB` additionally runs right-to-left.
 */
export const PSEUDO_LOCALES = ['en-XA', 'ar-XB'] as const;
export type PseudoLocale = (typeof PSEUDO_LOCALES)[number];

export const PSEUDO_LOCALE_INFO: { readonly [L in PseudoLocale]: LocaleInfo & { readonly code: L } } = {
  'en-XA': { code: 'en-XA', dir: 'ltr', nativeName: '[Ƥšéûðö Éñĝļîšĥ]' },
  'ar-XB': { code: 'ar-XB', dir: 'rtl', nativeName: '[Ƥšéûðö ŔŢĻ]' },
};

/** Any locale a UI can run in: a supported locale or, in dev/test, a pseudo-locale. */
export type AppLocale = SupportedLocale | PseudoLocale;

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
export function isPseudoLocale(value: unknown): value is PseudoLocale {
  return typeof value === 'string' && (PSEUDO_LOCALES as readonly string[]).includes(value);
}
export function isAppLocale(value: unknown): value is AppLocale {
  return isSupportedLocale(value) || isPseudoLocale(value);
}
export function localeInfo(locale: AppLocale): LocaleInfo {
  return isPseudoLocale(locale) ? PSEUDO_LOCALE_INFO[locale] : LOCALES[locale];
}
/** UI direction of an app locale. For arbitrary content language tags use `languageDirection`. */
export function localeDirection(locale: AppLocale): Direction {
  return localeInfo(locale).dir;
}
/** The catalog a locale reads from. Pseudo-locales transform the English catalog. */
export function catalogLocale(locale: AppLocale): SupportedLocale {
  return isPseudoLocale(locale) ? DEFAULT_LOCALE : locale;
}
/** The locale passed to Intl formatters. Pseudo-locales format like English. */
export function formatLocale(locale: AppLocale): string {
  return catalogLocale(locale);
}
