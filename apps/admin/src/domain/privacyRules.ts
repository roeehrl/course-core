import type { AdminTranslator, MessageKey } from "../i18n";

/**
 * A learner-privacy rule (services/api/src/learner-privacy.ts) in the reader's language, by its
 * id. The server keeps English text on each rule for exported documents; the app shows its own
 * wording and falls back to the server's text for a rule it does not know yet.
 */
export function privacyRuleText(
  i18n: Pick<AdminTranslator, "t" | "has">,
  rule: { id: string; label: string; reason: string },
) {
  const text = (part: "label" | "reason") => {
    const key =
      `privacyRules.rule.${[rule.id.replaceAll("-", "_"), part].join(".")}` as MessageKey;
    return i18n.has(key) ? i18n.t(key) : rule[part];
  };
  return { label: text("label"), reason: text("reason") };
}
