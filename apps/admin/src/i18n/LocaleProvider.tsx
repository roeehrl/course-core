import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  PSEUDO_LOCALES,
  SUPPORTED_LOCALES,
  applyDocumentLocale,
  initialClientLocale,
  isSupportedLocale,
  reconcileServerLocale,
  type AppLocale,
  type ClientLocaleSource,
  type SupportedLocale,
} from "@course-core/i18n";
import { I18nProvider, createAdminTranslator } from "./index";

export const LOCALE_STORAGE_KEY = "course-core:locale";
/** Pseudo-locales are offered in development and tests; `?locale=en-XA` works in any build. */
const pseudoAllowed = import.meta.env.DEV || import.meta.env.MODE === "test";

interface LocaleControl {
  locale: AppLocale;
  source: ClientLocaleSource;
  /** Locales the switcher offers. */
  available: readonly AppLocale[];
  /** An explicit choice: applied now and remembered on this device. */
  choose(locale: AppLocale): void;
  /** Applies the server's answer after sign-in; returns a device choice to save on the server. */
  adoptServer(server: {
    preference: string | null;
    locale: string;
  }): SupportedLocale | undefined;
}
const LocaleControlContext = createContext<LocaleControl | null>(null);

function readStored(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeStored(locale: AppLocale) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}
function startingLocale() {
  const stored = readStored();
  return initialClientLocale({
    override: new URLSearchParams(window.location.search).get("locale"),
    stored: pseudoAllowed || isSupportedLocale(stored) ? stored : null,
    languages: navigator.languages,
    allowPseudo: true,
  });
}

/** Owns the admin UI locale, keeps `<html lang dir>` in sync and provides the translator. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(startingLocale);
  const translator = useMemo(
    () => createAdminTranslator(state.locale),
    [state.locale],
  );
  useLayoutEffect(
    () => applyDocumentLocale(document, translator),
    [translator],
  );
  const choose = useCallback((locale: AppLocale) => {
    writeStored(locale);
    setState({ locale, source: "stored" });
  }, []);
  const adoptServer = useCallback(
    (server: { preference: string | null; locale: string }) => {
      const result = reconcileServerLocale({ server, client: state });
      if (result.locale !== state.locale)
        setState({ locale: result.locale, source: state.source });
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
        ...(pseudoAllowed || state.source === "override" ? PSEUDO_LOCALES : []),
      ],
      choose,
      adoptServer,
    }),
    [state, choose, adoptServer],
  );
  return (
    <LocaleControlContext.Provider value={control}>
      <I18nProvider value={translator}>{children}</I18nProvider>
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
