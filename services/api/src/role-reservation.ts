import type { ModelPricing } from "@course-core/providers";

/** Margin over the priced ceiling: tokenizers differ from character counts, and protocol framing adds input. */
export const RESERVATION_MARGIN = 1.25;
/** Input tokens a request may add beyond its prompt characters (protocol framing, schema). */
export const RESERVATION_INPUT_OVERHEAD_TOKENS = 1024;
/** Roles whose reservation is sized from their limits: one priced text call per round. Research
 * (provider-run searches billed per request) and media (per image or second) keep the policy allowance. */
export const SIZED_ROLES = ["companion", "supervisor", "reviewer"] as const;

export interface RoleLimits { maxInputCharacters: number; maxOutputTokens: number; maxToolRounds?: number | undefined }
/**
 * The most one run of a role can cost, from its configured limits and the price in force, with a
 * margin, never above the workspace job allowance:
 *   rounds × ((maxInputCharacters + overhead) × input price + maxOutputTokens × output price) × margin
 * Characters bound input tokens from above for ordinary text, and the output limit includes any
 * thinking. The token reservation is the role's own token bound (configurationTokenBounds), which
 * the gateway checks before sending. Null when the price cannot bound the call (no token prices),
 * so the policy allowance stays in force.
 */
export function roleReservation(limits: RoleLimits, pricing: ModelPricing | null, policy: { microUsd: number; tokens: number }) {
  if (!pricing || pricing.inputMicroUsdPerMillionTokens === null || pricing.outputMicroUsdPerMillionTokens === null) return null;
  const rounds = limits.maxToolRounds ?? 1;
  const tokens = rounds * (limits.maxInputCharacters * 4 + limits.maxOutputTokens + 4096);
  const perRound = (limits.maxInputCharacters + RESERVATION_INPUT_OVERHEAD_TOKENS) * pricing.inputMicroUsdPerMillionTokens
    + limits.maxOutputTokens * pricing.outputMicroUsdPerMillionTokens;
  const microUsd = Math.ceil((rounds * perRound * RESERVATION_MARGIN) / 1_000_000) + rounds * (pricing.microUsdPerRequest ?? 0);
  if (!Number.isSafeInteger(microUsd) || microUsd < 1) return null;
  return { microUsd: Math.min(policy.microUsd, microUsd), tokens: Math.min(policy.tokens, tokens) };
}

/** The most one check-judge call can cost (companion-check-judge.ts): its request's UTF-8 bytes
 * bound its input tokens from above, plus framing, and its output limit, with the margin. Null when
 * the price cannot bound it. */
export function judgeCeilingMicroUsd(requestBytes: number, maxOutputTokens: number, pricing: ModelPricing): number | null {
  if (pricing.inputMicroUsdPerMillionTokens === null || pricing.outputMicroUsdPerMillionTokens === null) return null;
  const raw = (requestBytes + RESERVATION_INPUT_OVERHEAD_TOKENS) * pricing.inputMicroUsdPerMillionTokens + maxOutputTokens * pricing.outputMicroUsdPerMillionTokens;
  const microUsd = Math.ceil((raw * RESERVATION_MARGIN) / 1_000_000) + (pricing.microUsdPerRequest ?? 0);
  return Number.isSafeInteger(microUsd) ? microUsd : null;
}
/**
 * The companion's reservation with its check judge (companion-check-judge.ts): one companion call
 * and, when a judge role is bound and priced, one judge call at the judge's input and output limits
 * and its own price, together never above the workspace job allowance. A turn in check-coaching
 * mode calls both; an ordinary turn releases the judge's part when it settles. Null when the
 * companion's own price cannot bound its call (the policy allowance stays in force); without a
 * priced judge it is the companion's own reservation, and the gateway fails a judge without room
 * closed rather than exceed it.
 */
export function companionReservation(companion: RoleLimits, pricing: ModelPricing | null, judge: { limits: RoleLimits; pricing: ModelPricing | null } | null,
  policy: { microUsd: number; tokens: number }) {
  const unbounded = { microUsd: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER };
  const own = roleReservation(companion, pricing, unbounded);
  if (!own) return null;
  const extra = judge ? roleReservation(judge.limits, judge.pricing, unbounded) : null;
  const microUsd = own.microUsd + (extra?.microUsd ?? 0), tokens = own.tokens + (extra?.tokens ?? 0);
  if (!Number.isSafeInteger(microUsd) || !Number.isSafeInteger(tokens)) return null;
  return { microUsd: Math.min(policy.microUsd, microUsd), tokens: Math.min(policy.tokens, tokens) };
}
