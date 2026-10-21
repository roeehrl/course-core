import { createContext, useCallback, useContext, useEffect, useState } from "react";

/* The course page is built from panels that each read their own state after the
 * enrollment loads (study, placement, retention, pacing). Each one can add a card
 * above the roadmap's "Continue learning". Shown as they arrive, a late card pushes
 * that button down while the learner is pressing it: the press starts on the button,
 * ends on whatever moved under the pointer, and is lost (a CI run caught exactly
 * this). So the page stays hidden, with a loading indicator, until every panel has
 * finished its first read, and then appears at once. */

type Report = (key: string) => void;
const FirstLoadContext = createContext<Report | null>(null);
export const FirstLoadProvider = FirstLoadContext.Provider;

/** A panel calls this with `done` once its first read succeeded or failed. */
export function useFirstLoadDone(key: string, done: boolean) {
  const report = useContext(FirstLoadContext);
  useEffect(() => {
    if (done) report?.(key);
  }, [done, key, report]);
}

/** Longest the page waits for a panel that never answers before showing what it has. */
export const FIRST_LOAD_LIMIT_MS = 8_000;

/** Tracks the first reads of `keys` for one scope (the enrollment). Settled stays true for
 * the scope once reached, so later refreshes never hide the page again. */
export function useFirstLoad(scope: string | undefined, keys: readonly string[], limitMs = FIRST_LOAD_LIMIT_MS) {
  const [state, setState] = useState<{ scope?: string; done: ReadonlySet<string>; timedOut: boolean }>({
    done: new Set(),
    timedOut: false,
  });
  const current = state.scope === scope ? state : { scope, done: new Set<string>(), timedOut: false };
  const report = useCallback(
    (key: string) =>
      setState((prior) => {
        const base = prior.scope === scope ? prior : { scope, done: new Set<string>(), timedOut: false };
        if (base.done.has(key)) return base;
        return { ...base, done: new Set([...base.done, key]) };
      }),
    [scope],
  );
  const settled = !!scope && (current.timedOut || keys.every((key) => current.done.has(key)));
  useEffect(() => {
    if (!scope || settled) return;
    const timer = setTimeout(
      () => setState((prior) => (prior.scope === scope ? { ...prior, timedOut: true } : { scope, done: new Set(), timedOut: true })),
      limitMs,
    );
    return () => clearTimeout(timer);
  }, [scope, settled, limitMs]);
  return { settled, report };
}
