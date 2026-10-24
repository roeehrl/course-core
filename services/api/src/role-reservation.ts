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
