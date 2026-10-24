import { z } from "zod";
import { requireCondition } from "./errors.js";
import type { ModelDraftInput } from "./google-model-setup.js";
import { providerConfigurationSchema } from "./provider-composition.js";

// Literal method names reported by the Anthropic metadata adapter (see provider-metadata.ts).
const MESSAGES = "messages",
  STRUCTURED = "structured_outputs",
  WEB_SEARCH = "web_search",
  EFFORT_LOW = "effort_low",
  THINKING_DISABLED = "thinking_disabled";
const roleMethod = {
  companion: MESSAGES,
  supervisor: STRUCTURED,
  research: WEB_SEARCH,
  reviewer: STRUCTURED,
} as const;

/** Messages API draft for text roles only. The Messages API has no image or video
 * generation, so a media assignment is refused and media stays on its current connection.
 * Metadata establishes no live structured-output, search or teaching quality. */
export function anthropicModelDraft({
  configuration,
  adapterId,
  catalog,
  assignments,
}: ModelDraftInput) {
  const parsed = providerConfigurationSchema.parse(configuration),
    registry = z
      .object({
        revision: z.string(),
        models: z.array(z.record(z.string(), z.unknown())),
      })
      .parse(parsed.registry),
    adapter = parsed.adapters.find((a) => a.id === adapterId);
  requireCondition(
    adapter?.kind === "anthropic",
    "PROVIDER_GUIDE_UNSUPPORTED",
    409,
  );
  const roles = structuredClone(parsed.roles),
    models = structuredClone(registry.models);
  for (const role of [
    "companion",
    "supervisor",
    "research",
    "reviewer",
    "media",
  ] as const) {
    const selection = assignments[role];
    if (selection === undefined) continue;
    if (selection === null) {
      delete roles[role];
      continue;
    }
    requireCondition(
      role !== "media" && typeof selection === "string",
      "PROVIDER_GUIDE_ROLE_UNSUPPORTED",
      409,
    );
    const remoteModel = selection as string,
      m = catalog.models.find((m) => m.remoteModel === remoteModel);
    requireCondition(m, "PROVIDER_GUIDE_MODEL_UNAVAILABLE", 409);
    requireCondition(
      m.methods.includes(MESSAGES) && m.methods.includes(roleMethod[role]),
      "PROVIDER_GUIDE_METHOD_UNSUPPORTED",
      409,
    );
    // Thinking tokens count toward max_tokens (and `output_tokens`). Current models think
    // adaptively; a fixed thinking budget (`budget_tokens`) is deprecated or refused there, so depth
    // is set with `effort` (low) and the output limit leaves room for thinking and the answer.
    // With thinking off, the whole limit is the visible answer.
    const thinkingOff = m.methods.includes(THINKING_DISABLED),
      maxInputCharacters = Math.min(
        role === "supervisor" ? 30000 : role === "reviewer" ? 20000 : 12000,
        Math.floor(Math.max(0, (m.inputTokenLimit ?? 0) - 4096) / 4),
      ),
      maxOutputTokens = Math.min(
        thinkingOff ? 2048 : role === "companion" ? 4096 : 8192,
        m.outputTokenLimit ?? 0,
      );
    requireCondition(
      maxInputCharacters >= 2000 && maxOutputTokens >= 1,
      "PROVIDER_GUIDE_LIMITS_UNKNOWN",
      409,
    );
    requireCondition(
      role !== "supervisor" || maxInputCharacters >= 20000,
      "PROVIDER_GUIDE_CONTEXT_TOO_SMALL",
      409,
    );
    const modelId = adapterId + ":" + role,
      capability =
        role === "companion"
          ? "tutoring"
          : role === "research"
            ? "research"
            : "structured_assessment",
      model = {
        id: modelId,
        providerId: adapterId,
        remoteModel,
        enabled: true,
        capabilities: [capability],
        tools: role === "research" ? ["web_search"] : [],
        providerConfig: {
          transport: "messages",
          apiVersion: "2023-06-01",
          maxResponseBytes: 1048576,
          ...(m.methods.includes(EFFORT_LOW) ? { effort: "low" } : {}),
          ...(thinkingOff ? { thinking: "disabled" } : {}),
          ...(role === "research"
            ? { webSearch: { toolType: "web_search_20250305", maxUses: 5 } }
            : {}),
        },
        limits: { maxInputCharacters, maxOutputTokens },
      },
      index = models.findIndex((m) => m.id === modelId);
    if (index < 0) models.push(model);
    else models[index] = model;
    roles[role] = {
      modelId,
      maxInputCharacters,
      maxOutputTokens,
      ...(role === "supervisor" ? { maxToolRounds: 4 } : {}),
    };
  }
  return {
    registry: { revision: registry.revision, models },
    adapters: parsed.adapters,
    roles,
  };
}
