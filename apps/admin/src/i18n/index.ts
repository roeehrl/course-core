import {
  createTranslator,
  type AppLocale,
  type CatalogKey,
  type MissingEvent,
} from "@course-core/i18n";
import { createI18nBindings } from "@course-core/i18n/react";
import { catalogs, en } from "./catalog";

/** Every admin message key (`namespace.key`); a misspelled or missing key is a type error. */
export type MessageKey = CatalogKey<typeof en>;

const reported = new Set<string>();
/** Missing translations are reported once each in development and tests, never in production. */
export function reportMissing(event: MissingEvent) {
  if (!import.meta.env.DEV && import.meta.env.MODE !== "test") return;
  const id = `${event.kind}:${event.locale}:${event.key}:${event.argument ?? ""}`;
  if (reported.has(id)) return;
  reported.add(id);
  console.warn(
    `[i18n] ${event.kind} ${event.locale} ${event.key}${event.argument ? ` {${event.argument}}` : ""}`,
  );
}

export function createAdminTranslator(locale: AppLocale) {
  return createTranslator({ locale, catalogs, onMissing: reportMissing });
}
export type AdminTranslator = ReturnType<typeof createAdminTranslator>;
export type Translate = AdminTranslator["t"];

let english: AdminTranslator | undefined;
/** English, for pure helpers called outside React before they receive a translator. */
export const englishTranslator = () => (english ??= createAdminTranslator("en"));

export const { I18nProvider, useI18n, useT } = createI18nBindings<MessageKey>({
  // Unit tests may render one component without the app root: English.
  fallback: englishTranslator,
});

/**
 * Locale-aware replacements for the old `money` and `when` helpers in components/ui.tsx.
 * Server times are shown in UTC, with the zone name in the active locale.
 */
export function useFormatters() {
  const i18n = useI18n();
  return {
    money: (cents: number, currency = "USD") =>
      i18n.currency(cents / 100, currency),
    when: (iso: string) =>
      i18n.dateTime(iso, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
        timeZoneName: "short",
      }),
  };
}
