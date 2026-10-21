import { describe, expect, it } from "vitest";
import { PRICE_SOURCES, PRICE_TABLE, PRICE_TABLE_CHECKED, suggestedPrice, tablePrice } from "../src/price-table.js";

// The bundled table only suggests prices for the admin page to prefill; these tests pin the values
// copied from the official pages on PRICE_TABLE_CHECKED, so a change to them is a reviewed change.
describe("bundled price table", () => {
  it("is dated, sourced from the official pages, and holds whole micro-USD per million tokens", () => {
    expect(PRICE_TABLE_CHECKED).toBe("2026-10-21");
    expect(PRICE_SOURCES).toEqual({ google: "https://ai.google.dev/gemini-api/docs/pricing",
      anthropic: "https://platform.claude.com/docs/en/about-claude/pricing" });
    expect(new Set(PRICE_TABLE.map((e) => `${e.service}/${e.model}`)).size).toBe(PRICE_TABLE.length);
    for (const entry of PRICE_TABLE)
      for (const rates of [entry.rates, entry.change?.rates].filter(Boolean))
        for (const value of Object.values(rates!)) if (value !== null) expect(Number.isSafeInteger(value) && value > 0).toBe(true);
  });

  it("knows gemini-3.8-flash at $0.75 / $3.75 through 2026 and $1.50 / $7.50 from 1 January 2027", () => {
    const before = suggestedPrice("google", "models/gemini-3.8-flash", new Date("2026-10-21T12:00:00Z"));
    expect(before).toMatchObject({ service: "google", model: "gemini-3.8-flash", checkedOn: "2026-10-21",
      inputMicroUsdPerMillionTokens: 750_000, outputMicroUsdPerMillionTokens: 3_750_000, cachedInputMicroUsdPerMillionTokens: 75_000,
      change: { from: "2027-01-01", inputMicroUsdPerMillionTokens: 1_500_000, outputMicroUsdPerMillionTokens: 7_500_000 } });
    const after = suggestedPrice("google", "gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"));
    expect(after).toMatchObject({ inputMicroUsdPerMillionTokens: 1_500_000, outputMicroUsdPerMillionTokens: 7_500_000, change: null });
  });

  it("marks long-prompt tiers and announced changes", () => {
    expect(suggestedPrice("google", "gemini-2.5-pro", new Date("2026-10-21"))).toMatchObject({
      inputMicroUsdPerMillionTokens: 1_250_000, outputMicroUsdPerMillionTokens: 10_000_000, promptTokensUpTo: 200_000, change: null });
    expect(tablePrice("google", "gemini-4-argon")?.change?.from).toBe("2026-12-01");
    expect(suggestedPrice("anthropic", "claude-sonnet-5-5", new Date("2026-10-21"))).toMatchObject({
      inputMicroUsdPerMillionTokens: 2_000_000, outputMicroUsdPerMillionTokens: 10_000_000, cachedInputMicroUsdPerMillionTokens: 100_000 });
    expect(suggestedPrice("anthropic", "claude-haiku-5-5", new Date("2026-10-21"))?.promptTokensUpTo).toBe(100_000);
  });

  it("suggests nothing for unknown models or another service's model", () => {
    expect(suggestedPrice("google", "gemini-9.0-flash", new Date())).toBeNull();
    expect(suggestedPrice("anthropic", "gemini-2.5-pro", new Date())).toBeNull();
    expect(suggestedPrice("openai-compatible", "gemini-2.5-pro", new Date())).toBeNull();
  });
});
