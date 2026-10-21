import { createContext, createElement, useContext, type Context, type ReactNode } from 'react';
import type { Translator } from './translator.ts';

export interface I18nBindings<Key extends string> {
  readonly I18nContext: Context<Translator<Key> | null>;
  /** Provides a translator to a subtree. Create a new translator when the locale changes. */
  I18nProvider(props: { value: Translator<Key>; children?: ReactNode }): ReactNode;
  /** The active translator: `t`, `rich`, formatters, `locale`, `lang` and `dir`. */
  useI18n(): Translator<Key>;
  useT(): Translator<Key>['t'];
}

/**
 * React context and hooks typed with one surface's keys. Works in React DOM and
 * React Native; it imports nothing but `react`. Each app calls this once.
 *
 * `fallback` serves components rendered outside a provider (unit tests of a single
 * component); without it the hooks throw there.
 */
export function createI18nBindings<Key extends string>(options: { fallback?: () => Translator<Key> } = {}): I18nBindings<Key> {
  const I18nContext = createContext<Translator<Key> | null>(null);
  let fallback: Translator<Key> | undefined;
  I18nContext.displayName = 'I18nContext';
  function useI18n(): Translator<Key> {
    const value = useContext(I18nContext);
    if (value) return value;
    if (options.fallback) return (fallback ??= options.fallback());
    throw new Error('useI18n must be used inside I18nProvider');
  }
  return {
    I18nContext,
    I18nProvider: ({ value, children }) => createElement(I18nContext.Provider, { value }, children),
    useI18n,
    useT: () => useI18n().t,
  };
}
