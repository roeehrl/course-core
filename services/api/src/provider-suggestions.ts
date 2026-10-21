import type { ModelCatalog } from "./provider-metadata.js";

/**
 * Suggested model per job for the admin "AI services" page. These are naming rules over the
 * model list the provider reports for the operator's own key; they are not prices, quality
 * claims or vendor data beyond names. The operator can choose any listed model instead.
 *
 * Last reviewed: 2026-10-21. When a provider changes its naming, update the rules and the
 * tests in test/provider-suggestions.test.ts.
 */
export const SUGGESTION_RULES_REVIEWED = "2026-10-21";
export const SUGGESTION_ROLES = [
  "companion",
  "supervisor",
  "research",
  "reviewer",
  "media",
] as const;
export type SuggestionRole = (typeof SUGGESTION_ROLES)[number];
/** Jobs every course uses: the learner tutor and the lesson planner. */
export const NEEDED_ROLES: readonly SuggestionRole[] = [
  "companion",
  "supervisor",
];

interface Rule {
  include: RegExp;
  exclude?: RegExp;
}
const RULES: Record<string, Partial<Record<SuggestionRole, Rule>>> = {
  google: {
    companion: { include: /flash/, exclude: /lite/ },
    supervisor: { include: /flash/, exclude: /lite/ },
    research: { include: /flash/ },
    reviewer: { include: /pro/ },
  },
  anthropic: {
    companion: { include: /sonnet/ },
    supervisor: { include: /sonnet/ },
    research: { include: /haiku/ },
    reviewer: { include: /sonnet/ },
  },
};
/** Previews, experiments and dated snapshots of a preview are never suggested. */
const UNSTABLE = /preview|experimental|(^|[-.])exp([-.]|$)|latest|tts|audio|image|embedding|live|thinking/;

/** Version numbers in a model id, for "newest first": gemini-2.5-flash > gemini-2.0-flash. */
function versionKey(id: string) {
  return (id.match(/\d+/g) ?? []).map(Number);
}
function newer(a: string, b: string) {
  const x = versionKey(a),
    y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  // Same version numbers: the shorter (undated, canonical) id first.
  return b.length - a.length;
}

/** The suggested model for one job, or null when no listed model matches the rule. */
export function suggestModel(
  kind: string,
  role: SuggestionRole,
  catalog: Pick<ModelCatalog, "models">,
  method: string | null,
) {
  const rule = RULES[kind]?.[role];
  if (!rule || !method) return null;
  const candidates = catalog.models
    .filter((m) => m.methods.includes(method))
    .map((m) => m.remoteModel)
    .filter(
      (id) =>
        rule.include.test(id.toLowerCase()) &&
        !rule.exclude?.test(id.toLowerCase()) &&
        !UNSTABLE.test(id.toLowerCase()),
    )
    .sort((a, b) => newer(b, a));
  return candidates[0] ?? null;
}
