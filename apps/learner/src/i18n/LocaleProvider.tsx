import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import {
  PSEUDO_LOCALES,
  SUPPORTED_LOCALES,
  initialClientLocale,
  isSupportedLocale,
  reconcileServerLocale,
  type AppLocale,
  type ClientLocaleSource,
  type SupportedLocale,
} from "@course-core/i18n";
import { I18nProvider, createLearnerTranslator, reportsMissing } from "./index";
import { LocaleRoot } from "./LocaleRoot";

export const LOCALE_STORAGE_KEY = "course-core:locale";

interface LocaleControl {
  locale: AppLocale;
  source: ClientLocaleSource;
  /** Locales the switcher offers. */
  available: readonly AppLocale[];
  /** An explicit choice: applied now and remembered on this device. */
  choose(locale: AppLocale): void;
  /** Applies the server's answer after sign-in; returns a device choice to save on the server. */
  adoptServer(server: { preference: string | null; locale: string }): SupportedLocale | undefined;
}
const LocaleControlContext = createContext<LocaleControl | null>(null);

const web = Platform.OS === "web" && typeof window !== "undefined";
function readStored(): string | null {
  try {
    return web ? window.localStorage.getItem(LOCALE_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}
function writeStored(locale: AppLocale) {
  try {
    if (web) window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}
function startingLocale() {
  const stored = readStored();
  const languages =
    typeof navigator !== "undefined" && Array.isArray(navigator.languages) ? navigator.languages : [];
  return initialClientLocale({
    override: web ? new URLSearchParams(window.location.search).get("locale") : null,
    stored: reportsMissing() || isSupportedLocale(stored) ? stored : null,
    languages,
    allowPseudo: true,
  });
}

/**
 * Owns the learner UI locale and provides the translator. Direction is applied per
 * tree, never with I18nManager.forceRTL (which needs an app restart): on the web
 * `<html lang dir>` follows the locale; on native the root View sets `direction`.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(startingLocale);
  const translator = useMemo(() => createLearnerTranslator(state.locale), [state.locale]);
  const choose = useCallback((locale: AppLocale) => {
    writeStored(locale);
    setState({ locale, source: "stored" });
  }, []);
  const adoptServer = useCallback(
    (server: { preference: string | null; locale: string }) => {
      const result = reconcileServerLocale({ server, client: state });
      if (result.locale !== state.locale) setState({ locale: result.locale, source: state.source });
      return result.save;
    },
    [state],
  );
  const control = useMemo<LocaleControl>(
    () => ({
      locale: state.locale,
      source: state.source,
      available: [
        ...SUPPORTED_LOCALES,
        ...(reportsMissing() || state.source === "override" ? PSEUDO_LOCALES : []),
      ],
      choose,
      adoptServer,
    }),
    [state, choose, adoptServer],
  );
  return (
    <LocaleControlContext.Provider value={control}>
      <I18nProvider value={translator}>
        <LocaleRoot lang={translator.lang} dir={translator.dir}>
          {children}
        </LocaleRoot>
      </I18nProvider>
    </LocaleControlContext.Provider>
  );
}

/** Outside LocaleProvider (unit tests of one component): English, and choices are ignored. */
const detached: LocaleControl = {
  locale: "en",
  source: "default",
  available: SUPPORTED_LOCALES,
  choose: () => {},
  adoptServer: () => undefined,
};
export function useLocaleControl(): LocaleControl {
  return useContext(LocaleControlContext) ?? detached;
}
