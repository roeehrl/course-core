import { z } from 'zod';
import type { Operation, UsageReceipt } from './contracts.js';

/**
 * Operator-entered prices for one model, as one immutable version. This package ships no
 * rate card: every number comes from the host, which stores who entered it, when it takes
 * effect and where it was read. Money is integer micro-USD; there are no floats.
 *
 * Token prices are per million tokens, so one token can cost a fraction of a micro-USD
 * (for example 75,000 micro-USD per million is 0.075 micro-USD per token).
 */
const rate = (max: number) => z.number().int().min(0).max(max).nullable();
export const MAX_MICRO_USD_PER_MILLION_TOKENS = 1_000_000_000;
export const MAX_MICRO_USD_PER_UNIT = 100_000_000;
export const modelPricingSchema = z.strictObject({
  versionId: z.string().min(1).max(128),
  currency: z.literal('USD'),
  inputMicroUsdPerMillionTokens: rate(MAX_MICRO_USD_PER_MILLION_TOKENS),
  outputMicroUsdPerMillionTokens: rate(MAX_MICRO_USD_PER_MILLION_TOKENS),
  /** Price of input tokens served from the provider's context cache; absent means the input price. */
  cachedInputMicroUsdPerMillionTokens: rate(MAX_MICRO_USD_PER_MILLION_TOKENS),
  microUsdPerRequest: rate(MAX_MICRO_USD_PER_UNIT),
  /** Generated media, charged on the requested output duration (no actual duration is reported). */
  microUsdPerOutputSecond: rate(MAX_MICRO_USD_PER_UNIT),
  /** Provider-run server tool requests (for example one web search) that the provider reports and
   * bills per request, separately from tokens. Absent means no such price was entered. */
  microUsdPerServerToolRequest: rate(MAX_MICRO_USD_PER_UNIT).optional(),
}).superRefine((p, ctx) => {
  if ((p.inputMicroUsdPerMillionTokens === null) !== (p.outputMicroUsdPerMillionTokens === null))
    ctx.addIssue({ code: 'custom', message: 'input_and_output_prices_together' });
  if (p.cachedInputMicroUsdPerMillionTokens !== null && p.inputMicroUsdPerMillionTokens === null)
    ctx.addIssue({ code: 'custom', message: 'cached_price_needs_input_price' });
  if (p.inputMicroUsdPerMillionTokens === null && p.microUsdPerRequest === null && p.microUsdPerOutputSecond === null)
    ctx.addIssue({ code: 'custom', message: 'no_price' });
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;

/** What a receipt was charged for, as counted from the provider's own usage report. */
export interface ReceiptCost {
  currency: 'USD';
  microUsd: number;
  pricingVersionId: string;
  basis: 'reported_usage';
  billable: { inputTokens: number; cachedInputTokens: number; outputTokens: number; requests: number; outputSeconds: number;
    /** Present only when the provider reported server tool requests. */
    serverToolRequests?: number };
}
export type PricingResult = { cost: ReceiptCost; reason: null }
  | { cost: null; reason: 'usage_unknown' | 'pricing_incomplete' };

const MEDIA_SECONDS: readonly Operation[] = ['video_submit'];
const VIDEO: readonly Operation[] = ['video_submit', 'video_poll'];

/** Whether a pricing version can price this kind of call at all. Used for admission. */
export function pricingCovers(pricing: ModelPricing, kind: 'tokens' | 'video'): boolean {
  const p = modelPricingSchema.parse(pricing);
  return kind === 'video' ? p.microUsdPerOutputSecond !== null || p.microUsdPerRequest !== null
    : p.inputMicroUsdPerMillionTokens !== null || p.microUsdPerRequest !== null;
}

/**
 * Prices a receipt from what the provider reported. Rules:
 * - A rejected attempt (the provider refused it before work) is not billed.
 * - An attempt whose outcome is unknown may have been billed for an unknown amount, so the
 *   whole receipt is unpriced and the host keeps its conservative reservation.
 * - Input tokens include cached tokens (the provider reports cached as a subset of input);
 *   cached tokens use the cached price, or the input price when none is set. Tool-use prompt
 *   tokens are input. Thinking tokens are output. Any reported total above those parts is
 *   charged at the output price, so an unexplained count never lowers the charge.
 * - Input tokens written to a provider prompt cache are billed above the input rate by some
 *   providers and no price version records that rate, so any reported cache write leaves the
 *   receipt unpriced rather than undercharged. (The built-in adapters never request caching.)
 * - Reported server tool requests (for example web searches) are charged at the per-server-tool
 *   price; without one the receipt is unpriced rather than undercharged.
 * - Token cost is rounded up to a whole micro-USD once per receipt, then per-request,
 *   per-server-tool and per-second charges (already whole micro-USD) are added.
 */
export function priceUsage(receipt: UsageReceipt, raw: ModelPricing): PricingResult {
  const pricing = modelPricingSchema.parse(raw);
  const video = VIDEO.includes(receipt.operation);
  const tokenPriced = !video && pricing.inputMicroUsdPerMillionTokens !== null;
  if (video ? pricing.microUsdPerOutputSecond === null && pricing.microUsdPerRequest === null
    : !tokenPriced && pricing.microUsdPerRequest === null) return { cost: null, reason: 'pricing_incomplete' };
  if (MEDIA_SECONDS.includes(receipt.operation) && pricing.microUsdPerOutputSecond !== null && receipt.requestedVideoSeconds === null)
    return { cost: null, reason: 'usage_unknown' };
  let input = 0n, cached = 0n, output = 0n, requests = 0n, serverTools = 0n;
  for (const attempt of receipt.attempts) {
    if (attempt.outcome === 'rejected') continue;
    if (attempt.outcome !== 'response') return { cost: null, reason: 'usage_unknown' };
    requests += 1n;
    const t = attempt.tokens;
    if ((t.cacheWriteInput ?? 0) > 0) return { cost: null, reason: 'pricing_incomplete' };
    if (t.serverToolRequests === null) return { cost: null, reason: 'usage_unknown' };
    serverTools += BigInt(t.serverToolRequests ?? 0);
    if (!tokenPriced) continue;
    if (t.input === null || (t.output === null && t.total === null)) return { cost: null, reason: 'usage_unknown' };
    const cachedHere = BigInt(t.cachedInput ?? 0), inputHere = BigInt(t.input) + BigInt(t.toolInput ?? 0);
    if (cachedHere > BigInt(t.input)) return { cost: null, reason: 'usage_unknown' };
    let outputHere = BigInt(t.output ?? 0) + BigInt(t.thoughts ?? 0);
    if (t.total !== null) {
      const residual = BigInt(t.total) - inputHere - outputHere;
      if (residual > 0n) outputHere += residual;
    }
    input += inputHere - cachedHere; cached += cachedHere; output += outputHere;
  }
  const toolRate = pricing.microUsdPerServerToolRequest ?? null;
  if (serverTools > 0n && toolRate === null) return { cost: null, reason: 'pricing_incomplete' };
  const seconds = MEDIA_SECONDS.includes(receipt.operation) && pricing.microUsdPerOutputSecond !== null ? BigInt(receipt.requestedVideoSeconds!) * requests : 0n;
  let micro = 0n;
  if (tokenPriced) {
    const inputRate = BigInt(pricing.inputMicroUsdPerMillionTokens!), outputRate = BigInt(pricing.outputMicroUsdPerMillionTokens!);
    const cachedRate = pricing.cachedInputMicroUsdPerMillionTokens === null ? inputRate : BigInt(pricing.cachedInputMicroUsdPerMillionTokens);
    const numerator = input * inputRate + cached * cachedRate + output * outputRate;
    micro += (numerator + 999_999n) / 1_000_000n;
  }
  if (pricing.microUsdPerRequest !== null && receipt.operation !== 'video_poll') micro += requests * BigInt(pricing.microUsdPerRequest);
  micro += seconds * BigInt(pricing.microUsdPerOutputSecond ?? 0);
  micro += serverTools * BigInt(toolRate ?? 0);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) return { cost: null, reason: 'usage_unknown' };
  return { reason: null, cost: { currency: 'USD', microUsd: Number(micro), pricingVersionId: pricing.versionId, basis: 'reported_usage',
    billable: { inputTokens: Number(input), cachedInputTokens: Number(cached), outputTokens: Number(output),
      requests: receipt.operation === 'video_poll' ? 0 : Number(requests), outputSeconds: Number(seconds),
      ...(serverTools > 0n ? { serverToolRequests: Number(serverTools) } : {}) } } };
}
