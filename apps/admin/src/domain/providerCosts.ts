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
  /** Older servers do not report it; absent is no price. */
  microUsdPerServerToolRequest: micro.optional(),
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
        coverage: z.array(
          z.object({
            role: z.string(),
            priced: z.boolean(),
            /** The bound model may report per-request server tools (web search) without a price for them. */
            serverToolsUnpriced: z.boolean().optional(),
          }),
        ),
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
  byEnrollment: z
    .array(sums.extend({ enrollmentId: z.string().uuid() }))
    .max(100),
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
  microUsdPerServerToolRequest: number | null;
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
