/**
 * Suggested prices for well-known Google and Anthropic models, copied by hand from the providers'
 * official pricing pages on the date below. The admin page prefills its price fields from this
 * table and says where the numbers came from; nothing is priced until an owner or administrator
 * confirms and saves them, and the saved price is the workspace's own price version.
 *
 * Amounts are integer micro-USD per million tokens, paid tier, standard (not batch) rates, for
 * text. Where a model has a long-prompt tier, the table holds the rate for prompts up to that
 * size and says so (`tier`). A `change` is a price change the provider has announced.
 *
 * Review the table whenever a provider changes its prices, and at least every 90 days; update
 * PRICE_TABLE_CHECKED and the tests in test/price-table.test.ts with it.
 */
export const PRICE_TABLE_CHECKED = "2026-10-21";
export const PRICE_SOURCES = {
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
} as const;
export type PriceService = keyof typeof PRICE_SOURCES;
export interface TableRates {
  inputMicroUsdPerMillionTokens: number;
  outputMicroUsdPerMillionTokens: number;
  cachedInputMicroUsdPerMillionTokens: number | null;
}
export interface TableEntry {
  service: PriceService;
  model: string;
  rates: TableRates;
  /** The rates apply to prompts up to this many tokens; longer prompts cost more. */
  tier?: { promptTokensUpTo: number };
  /** An announced change: from this UTC date on, these rates apply. */
  change?: { from: string; rates: TableRates };
}
const usd = (input: number, output: number, cached: number | null): TableRates => ({
  inputMicroUsdPerMillionTokens: Math.round(input * 1_000_000),
  outputMicroUsdPerMillionTokens: Math.round(output * 1_000_000),
  cachedInputMicroUsdPerMillionTokens: cached === null ? null : Math.round(cached * 1_000_000),
});
const google = (model: string, rates: TableRates, extra: Partial<TableEntry> = {}): TableEntry => ({ service: "google", model, rates, ...extra });
const anthropic = (model: string, rates: TableRates, extra: Partial<TableEntry> = {}): TableEntry => ({ service: "anthropic", model, rates, ...extra });

export const PRICE_TABLE: readonly TableEntry[] = Object.freeze([
  // Google Gemini API, "Last updated 2026-10-19 UTC" on the page.
  google("gemini-4-argon", usd(2, 10, 0.1), { change: { from: "2026-12-01", rates: usd(4, 20, 0.2) } }),
  google("gemini-3.8-flash", usd(0.75, 3.75, 0.075), { change: { from: "2027-01-01", rates: usd(1.5, 7.5, 0.15) } }),
  google("gemini-3.6-flash", usd(0.75, 3.75, 0.075), { change: { from: "2027-01-01", rates: usd(1.5, 7.5, 0.15) } }),
  google("gemini-3.5-flash-lite", usd(0.3, 2.5, 0.03)),
  google("gemini-3.1-flash-lite", usd(0.25, 1.5, 0.025)),
  google("gemini-3.1-pro-preview", usd(2, 12, 0.2), { tier: { promptTokensUpTo: 200_000 } }),
  google("gemini-3-flash-preview", usd(0.5, 3, 0.05)),
  google("gemini-2.5-pro", usd(1.25, 10, 0.125), { tier: { promptTokensUpTo: 200_000 } }),
  google("gemini-2.5-flash", usd(0.3, 2.5, 0.03)),
  google("gemini-2.5-flash-lite", usd(0.1, 0.4, 0.01)),
  // Anthropic Claude API. Cached input is the "cache hits and refreshes" rate.
  anthropic("claude-fable-5-1", usd(10, 50, 0.25)),
  anthropic("claude-opus-5-5", usd(4, 20, 0.2)),
  anthropic("claude-sonnet-5-5", usd(2, 10, 0.1)),
  anthropic("claude-haiku-5-5", usd(0.1, 0.5, 0.01), { tier: { promptTokensUpTo: 100_000 } }),
  anthropic("claude-opus-5", usd(5, 25, 0.5)),
  anthropic("claude-sonnet-5", usd(2, 10, 0.2)),
  anthropic("claude-opus-4-8", usd(5, 25, 0.5)),
  anthropic("claude-opus-4-7", usd(5, 25, 0.5)),
  anthropic("claude-opus-4-6", usd(5, 25, 0.5)),
  anthropic("claude-sonnet-4-6", usd(3, 15, 0.3)),
  anthropic("claude-haiku-4-5", usd(1, 5, 0.1)),
]);

/** The table entry for a provider kind and model name as the provider lists it, if any. */
export function tablePrice(kind: string, remoteModel: string): TableEntry | undefined {
  const name = remoteModel.toLowerCase().replace(/^models\//, "");
  return PRICE_TABLE.find((entry) => entry.service === kind && entry.model === name);
}

/** The suggestion the admin page shows for one model at `now`: rates in force on that date. */
export function suggestedPrice(kind: string, remoteModel: string, now: Date) {
  const entry = tablePrice(kind, remoteModel);
  if (!entry) return null;
  const changed = entry.change && Date.parse(`${entry.change.from}T00:00:00Z`) <= now.getTime();
  return {
    service: entry.service,
    model: entry.model,
    checkedOn: PRICE_TABLE_CHECKED,
    url: PRICE_SOURCES[entry.service],
    ...(changed ? entry.change!.rates : entry.rates),
    promptTokensUpTo: entry.tier?.promptTokensUpTo ?? null,
    change: entry.change && !changed ? { from: entry.change.from, ...entry.change.rates } : null,
  };
}
