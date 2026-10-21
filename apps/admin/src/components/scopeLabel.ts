import type { ScopePolicy } from "../domain/policy";
import { useI18n, type MessageKey } from "../i18n";

/** A policy scope's name: the course, chapter or episode title, or the level's name for the
 * organization and enrollment levels (which have no title of their own). */
export function useScopeLabel() {
  const i18n = useI18n();
  const level = (kind: string) => {
    const key = `scopeLabel.level.${kind}` as MessageKey;
    return i18n.has(key) ? i18n.t(key) : kind;
  };
  const name = (
    scope: Pick<ScopePolicy, "label" | "kind"> | undefined,
    fallback: string,
  ) => (scope ? (scope.label ?? level(scope.kind)) : fallback);
  return {
    /** The name of one scope. */
    name,
    /** The name of a scope by ID within a list of scopes. */
    byId: (scopes: readonly ScopePolicy[], scopeId: string) =>
      name(
        scopes.find((s) => s.scopeId === scopeId),
        scopeId,
      ),
    /** The level a binding constraint comes from, in words. */
    level,
  };
}
