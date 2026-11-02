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
export const englishTranslator = () =>
  (english ??= createAdminTranslator("en"));

export const { I18nProvider, useI18n, useT } = createI18nBindings<MessageKey>({
  // Unit tests may render one component without the app root: English.
  fallback: englishTranslator,
});

/**
 * Locale-aware replacements for the old `money` and `when` helpers in components/ui.tsx.
 * Times are shown in the viewer's own time zone (the browser's), with the zone's short name;
 * `whenUtc` keeps UTC where the time is defined in UTC (a deadline policy's settings), and is
 * also the tooltip of a <When> time. `whenExact` adds the seconds, for events that can fall in
 * the same minute (two AI calls, say). `day` is a calendar date, read in UTC so a date-only
 * value ("2026-10-12") never shifts a day.
 */
export function useFormatters() {
  const i18n = useI18n();
  // Intl rejects dateStyle/timeStyle together with timeZoneName, so name the fields. No
  // timeZone: Intl uses the browser's own.
  const local = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  } as const;
  const utc = { ...local, timeZone: "UTC" } as const;
  return {
    money: (cents: number, currency = "USD") =>
      i18n.currency(cents / 100, currency),
    when: (iso: string) => i18n.dateTime(iso, local),
    whenUtc: (iso: string) => i18n.dateTime(iso, utc),
    /** The calendar day alone (UTC), for dates where the time adds nothing (joined on …). */
    day: (iso: string) =>
      i18n.dateTime(iso, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    whenExact: (iso: string) =>
      i18n.dateTime(iso, { ...local, second: "2-digit" }),
    whenExactUtc: (iso: string) =>
      i18n.dateTime(iso, { ...utc, second: "2-digit" }),
  };
}
