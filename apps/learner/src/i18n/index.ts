import {
  createTranslator,
  type AppLocale,
  type CatalogKey,
  type MissingEvent,
} from "@course-core/i18n";
import { createI18nBindings } from "@course-core/i18n/react";
import { catalogs, en } from "./catalog";

/** Every learner message key (`namespace.key`); a misspelled or missing key is a type error. */
export type MessageKey = CatalogKey<typeof en>;

declare const __DEV__: boolean | undefined;
/** Development builds (Metro `__DEV__`) and tests report missing translations; production does not. */
export const reportsMissing = () =>
  (typeof __DEV__ !== "undefined" && __DEV__ === true) ||
  (typeof process !== "undefined" && process.env?.NODE_ENV === "test");

const reported = new Set<string>();
export function reportMissing(event: MissingEvent) {
  if (!reportsMissing()) return;
  const id = `${event.kind}:${event.locale}:${event.key}:${event.argument ?? ""}`;
  if (reported.has(id)) return;
  reported.add(id);
  console.warn(
    `[i18n] ${event.kind} ${event.locale} ${event.key}${event.argument ? ` {${event.argument}}` : ""}`,
  );
}

export function createLearnerTranslator(locale: AppLocale) {
  return createTranslator({ locale, catalogs, onMissing: reportMissing });
}
export type LearnerTranslator = ReturnType<typeof createLearnerTranslator>;
export type Translate = LearnerTranslator["t"];

let english: LearnerTranslator | undefined;
/** English, for pure helpers called outside React before they receive a translator. */
export const englishTranslator = () =>
  (english ??= createLearnerTranslator("en"));

export const { I18nProvider, useI18n, useT } = createI18nBindings<MessageKey>({
  // Unit tests may render one component without the app root: English.
  fallback: englishTranslator,
});
