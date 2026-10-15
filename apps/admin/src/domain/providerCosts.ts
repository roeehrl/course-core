import { z } from "zod";

/** Operator-entered model pricing and reserved-versus-actual spend. Money is integer
 * micro-USD on the wire; this module converts to and from exact decimal USD strings. */
const micro = z.number().int().nonnegative().nullable();
export const priceVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(["active", "withdrawn"]),
  currency: z.literal("USD"),
  inputMicroUsdPerMillionTokens: micro,
  outputMicroUsdPerMillionTokens: micro,
  cachedInputMicroUsdPerMillionTokens: micro,
  microUsdPerRequest: micro,
  microUsdPerOutputSecond: micro,
  effectiveFrom: z.string(),
  sourceNote: z.string().max(500),
  createdAt: z.string(),
});
export type PriceVersion = z.infer<typeof priceVersionSchema>;
export const pricingViewSchema = z.object({
  requirePricing: z.boolean(),
  settingsRevision: z.number().int().nonnegative(),
  currency: z.literal("USD"),
  builtInPrices: z.literal(false),
  models: z
    .array(
      z.object({
        modelId: z.string().max(2048),
        configured: z.boolean(),
        roles: z.array(z.string().max(32)).max(8),
        inForce: priceVersionSchema.nullable(),
        latestVersion: z.number().int().nonnegative(),
        coverage: z.array(z.object({ role: z.string(), priced: z.boolean() })),
        history: z.array(priceVersionSchema).max(20),
      }),
    )
    .max(50),
});
export type PricingView = z.infer<typeof pricingViewSchema>;
export const priceReceiptSchema = z.object({
  id: z.string().uuid(),
  modelId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["active", "withdrawn"]),
  effectiveFrom: z.string(),
  inForceNow: z.boolean(),
  appliesToCallsAlreadyAdmitted: z.literal(false),
});
export const costSettingsReceiptSchema = z.object({
  revision: z.number().int().positive(),
  requirePricing: z.boolean(),
  budgetsChanged: z.literal(false),
});
const amount = z.string().regex(/^\d+$/);
const sums = z.object({
  calls: z.number().int().nonnegative(),
  reserved: amount,
  charged: amount,
  actual: amount,
  released: amount,
  held: amount,
  unpriced: amount,
  uncertain: z.number().int().nonnegative(),
});
export type SpendSums = z.infer<typeof sums>;
export const spendViewSchema = z.object({
  period: z.enum(["day", "month"]),
  from: z.string(),
  to: z.string(),
  timeZone: z.literal("UTC"),
  currency: z.literal("USD"),
  totals: sums,
  byRole: z.array(sums.extend({ role: z.string().max(32) })).max(8),
  byEnrollment: z.array(sums.extend({ enrollmentId: z.string().uuid() })).max(100),
  byPeriod: z.array(sums.extend({ period: z.string().max(10) })).max(400),
});
export type SpendView = z.infer<typeof spendViewSchema>;
export interface PriceInput {
  idempotencyKey: string;
  modelId: string;
  expectedVersion: number;
  status: "active" | "withdrawn";
  currency: "USD";
  inputMicroUsdPerMillionTokens: number | null;
  outputMicroUsdPerMillionTokens: number | null;
  cachedInputMicroUsdPerMillionTokens: number | null;
  microUsdPerRequest: number | null;
  microUsdPerOutputSecond: number | null;
  effectiveFrom: string;
  sourceNote: string;
}
export interface ProviderCostPort {
  pricing(workspace: string, signal?: AbortSignal): Promise<PricingView>;
  savePrice(
    workspace: string,
    input: PriceInput,
  ): Promise<z.infer<typeof priceReceiptSchema>>;
  saveSettings(
    workspace: string,
    input: {
      idempotencyKey: string;
      expectedRevision: number;
      requirePricing: boolean;
      acknowledgeConservativeCharge?: boolean;
    },
  ): Promise<z.infer<typeof costSettingsReceiptSchema>>;
  spend(
    workspace: string,
    period: "day" | "month",
    signal?: AbortSignal,
  ): Promise<SpendView>;
}
export class ProviderCostError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderCostError";
  }
}
const messages: Record<string, string> = {
  PROVIDER_PRICING_INVALID:
    "Check the prices: input and output go together, cached needs an input price, and at least one price is required.",
  PROVIDER_PRICING_EFFECTIVE_DATE_INVALID:
    "The effective time cannot be earlier than the version it replaces or more than a year ahead.",
  PROVIDER_PRICING_UNKNOWN_MODEL:
    "This model is not in the saved configuration.",
  STALE_PROVIDER_PRICING_VERSION:
    "Prices for this model changed. Reload and review before saving again.",
  STALE_PROVIDER_COST_SETTINGS:
    "The pricing rule changed. Reload and review before saving again.",
  PROVIDER_UNPRICED_ACKNOWLEDGEMENT_REQUIRED:
    "Confirm that unpriced calls keep the full per-job allowance as their charge.",
  IDEMPOTENCY_CONFLICT:
    "This request conflicts with an earlier one. Reload and try again.",
  FORBIDDEN: "Only workspace owners and administrators can change pricing.",
};
export function costErrorMessage(error: unknown): string {
  const code = error instanceof ProviderCostError ? error.code : "";
  return (
    messages[code] ??
    "The pricing service is unavailable or rejected the request. Nothing was changed; try again."
  );
}
/** Whether a failure is final (safe to forget the request) or unconfirmed (retry it unchanged). */
export function isDefinitive(error: unknown) {
  return error instanceof ProviderCostError && error.code !== "UNAVAILABLE" && error.code !== "INVALID_RESPONSE";
}

/** Exact decimal USD (up to six places) to integer micro-USD. Empty means "not priced". */
export function usdField(value: string, max: number): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{1,4}(?:\.\d{1,6})?$/.test(text))
    throw Error("Enter USD amounts with up to six decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const units = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if (units > BigInt(max)) throw Error(`The largest amount here is ${usd(max)} USD.`);
  return Number(units);
}
export function usd(value: number | string | null | undefined) {
  if (value === null || value === undefined) return "";
  const units = BigInt(value);
  return `${units / 1000000n}.${String(units % 1000000n).padStart(6, "0")}`;
}
/** A datetime-local value (viewer's clock) as an absolute ISO instant. */
export function localToIso(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw Error("Choose when this price takes effect.");
  return date.toISOString();
}
export function isoToLocal(iso: string) {
  const d = new Date(iso), pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
