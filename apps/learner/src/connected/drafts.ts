import { MAX_CODE_BYTES } from "./code";
const MAX_DRAFT_PAYLOAD = 1_100_000;
const draftLimit = (scope: string) =>
  scope.includes(":code-answer:") ? MAX_CODE_BYTES : 4000;
export type BrowserStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Account-scoped draft preferences, never progression or evidence. */
export function createConnectedDraftStore(
  accountId: string,
  storage?: BrowserStore,
) {
  const key = `course:learner-drafts:${encodeURIComponent(accountId)}`;
  const listeners = new Set<() => void>();
  let unavailable = !storage,
    revision = 0,
    values: Record<string, string> = {};
  /** Parse the stored drafts; another tab may have written since we last read. */
  function load(): Record<string, string> {
    const loaded: Record<string, string> = {};
    const raw = storage?.getItem(key);
    if (raw && raw.length > MAX_DRAFT_PAYLOAD)
      throw Error("Draft storage exceeds limit");
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data))
        for (const [k, v] of Object.entries(data))
          if (
            k.length <= 1024 &&
            typeof v === "string" &&
            v.length <= draftLimit(k) &&
            Object.keys(loaded).length < 256
          )
            Object.defineProperty(loaded, k, {
              value: v,
              enumerable: true,
              writable: true,
              configurable: true,
            });
    }
    return loaded;
  }
  try {
    values = load();
  } catch {
    unavailable = true;
  }
  const notify = () => {
    revision++;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => revision,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      // Pick up drafts written in another tab of the same account.
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key || unavailable) return;
        try {
          values = load();
          notify();
        } catch {
          unavailable = true;
        }
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
    has: (scope: string) => Object.hasOwn(values, scope),
    read: (scope: string) =>
      Object.hasOwn(values, scope) ? values[scope]! : "",
    write: (scope: string, value: string) => {
      if (scope.length > 1024) return;
      // Merge with what other tabs stored, so this tab never erases their drafts.
      if (!unavailable)
        try {
          values = load();
        } catch {
          unavailable = true;
        }
      if (!Object.hasOwn(values, scope) && Object.keys(values).length >= 256)
        delete values[Object.keys(values)[0]!];
      Object.defineProperty(values, scope, {
        value: value.slice(0, draftLimit(scope)),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      try {
        const serialized = JSON.stringify(values);
        if (serialized.length > MAX_DRAFT_PAYLOAD)
          throw Error("Draft storage capacity reached");
        storage?.setItem(key, serialized);
      } catch {
        unavailable = true;
      }
      notify();
    },
    get unavailable() {
      return unavailable;
    },
    clear: () => {
      values = {};
      try {
        storage?.removeItem(key);
      } catch {
        unavailable = true;
      }
      notify();
    },
  };
}
