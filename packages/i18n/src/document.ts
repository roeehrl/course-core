import type { Direction } from './locales.ts';

/** The parts of a DOM document this package touches; keeps the core free of DOM typings. */
export interface DocumentLike {
  readonly documentElement: { lang: string; dir: string };
}

/**
 * Sets `<html lang dir>` for the active UI locale. Call it whenever the locale
 * changes; the element then sets the default direction for the whole page.
 */
export function applyDocumentLocale(document: DocumentLike | undefined, locale: { lang: string; dir: Direction }): void {
  if (!document) return;
  if (document.documentElement.lang !== locale.lang) document.documentElement.lang = locale.lang;
  if (document.documentElement.dir !== locale.dir) document.documentElement.dir = locale.dir;
}
