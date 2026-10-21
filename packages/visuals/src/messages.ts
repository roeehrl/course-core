import { englishVisualMessages } from "./i18n/messages/en.js";
import type {
  DescribableError,
  VisualMessages,
} from "./i18n/messages/visual-messages.js";

export type { DescribableError, VisualMessages };

export { englishVisualMessages };

/** English with the host's overrides; each missing entry falls back to English. */
export function visualMessages(
  overrides?: Partial<VisualMessages>,
): VisualMessages {
  return overrides
    ? { ...englishVisualMessages, ...overrides }
    : englishVisualMessages;
}

/** Number formatting for displayed values (no grouping, as values are short). */
export function formatNumber(
  locale: string | undefined,
  value: number,
  fractionDigits: { min?: number; max: number },
): string {
  try {
    return new Intl.NumberFormat(locale ?? "en", {
      minimumFractionDigits: fractionDigits.min ?? 0,
      maximumFractionDigits: fractionDigits.max,
      useGrouping: false,
    }).format(value);
  } catch {
    return value.toFixed(fractionDigits.max);
  }
}
