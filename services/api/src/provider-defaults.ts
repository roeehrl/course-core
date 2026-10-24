import type { z } from "zod";
import { GEMINI_ROLE_OUTPUT_TOKENS, geminiRoleThinking, geminiThinkingFamily } from "./google-model-setup.js";
import type { providerConfigurationSchema } from "./provider-composition.js";

type Configuration = z.infer<typeof providerConfigurationSchema>;
type ThinkingRole = keyof typeof GEMINI_ROLE_OUTPUT_TOKENS;
const THINKING_ROLES: readonly ThinkingRole[] = ["companion", "supervisor", "reviewer", "research"];
/** The output limit the setup guide gave every Gemini text role before it knew about thinking. */
export const LEGACY_GEMINI_OUTPUT_TOKENS = 1000;

/**
 * Brings a Gemini text role that the setup guide drafted before Core configured thinking up to
 * the current defaults, when the configuration is read (provider-setup.ts) and before a new
 * version is saved. Such a role sent no thinking setting, so a thinking model used its own default
 * level and its thoughts used most of the 1000-token output limit: replies were cut off and refused.
 *
 * Only what the guide itself produced is changed, never an operator's own choice:
 * - a Gemini thinking model (2.5 or later) bound to exactly one text role and without a thinking
 *   setting gets the role's setting (geminiRoleThinking: low for the companion);
 * - an output limit still at the guide's old 1000 is raised to the role's new limit, on the model
 *   and the role, when the role's token reservation bound still fits the job token allowance;
 *   when it does not fit, the limit stays and the role thinks at the low level instead.
 * Idempotent: an upgraded or newer configuration comes back unchanged (same object).
 *
 * The role's revision digest changes with it (agent-evals/revision.ts), like any change to what a
 * role sends. There is no runtime gate, so the role keeps running; a saved version compares the
 * upgraded previous configuration with the upgraded new one, so saving does not ask for new
 * evidence for an untouched role. The quality-check status shows the role as needing a check.
 */
export function upgradeLegacyProviderConfiguration<T extends Configuration>(configuration: T, tokenAllowance?: number): T {
  const registry = (configuration as { registry?: unknown } | null)?.registry as { revision?: unknown; models?: unknown } | null | undefined;
  if (!registry || !Array.isArray(registry.models) || !Array.isArray(configuration.adapters)
    || !configuration.roles || typeof configuration.roles !== "object") return configuration;
  let changed = false;
  const roles = structuredClone(configuration.roles);
  const models = (registry.models as Record<string, unknown>[]).map((raw) => {
    const model = raw as { id?: unknown; providerId?: unknown; remoteModel?: unknown; capabilities?: unknown; providerConfig?: Record<string, unknown>; limits?: Record<string, unknown> };
    const adapter = configuration.adapters.find((a) => a.id === model.providerId);
    const config = model.providerConfig;
    if (adapter?.kind !== "google" || typeof model.remoteModel !== "string" || !config || config.transport !== "generate_content"
      || config.thinking !== undefined || !geminiThinkingFamily(model.remoteModel)) return raw;
    const bound = (Object.entries(roles) as [string, NonNullable<Configuration["roles"][keyof Configuration["roles"]]>][])
      .filter(([, binding]) => binding?.modelId === model.id);
    if (bound.length !== 1 || !(THINKING_ROLES as readonly string[]).includes(bound[0]![0])) return raw;
    const [role, binding] = bound[0]! as [ThinkingRole, (typeof bound)[number][1]];
    const next = structuredClone(raw) as typeof model;
    const raise = GEMINI_ROLE_OUTPUT_TOKENS[role];
    const roleBound = (binding.maxToolRounds ?? 1) * (binding.maxInputCharacters * 4 + raise + 4096);
    const legacyLimit = model.limits?.maxOutputTokens === LEGACY_GEMINI_OUTPUT_TOKENS && binding.maxOutputTokens === LEGACY_GEMINI_OUTPUT_TOKENS;
    const raised = legacyLimit && (tokenAllowance === undefined || roleBound <= tokenAllowance);
    if (raised) {
      next.limits = { ...model.limits, maxOutputTokens: raise };
      roles[role] = { ...binding, maxOutputTokens: raise };
    }
    // A role left at the old 1000-token limit (its larger bound would not fit the job token
    // allowance) thinks at the companion's low level, so its answer still fits.
    const thinking = geminiRoleThinking(legacyLimit && !raised ? "companion" : role, model.remoteModel);
    if (thinking) next.providerConfig = { ...config, thinking };
    if (JSON.stringify(next) === JSON.stringify(raw)) return raw;
    changed = true;
    return next as Record<string, unknown>;
  });
  if (!changed) return configuration;
  return { ...configuration, registry: { ...registry, models }, roles };
}
