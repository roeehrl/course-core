import { MAX_CODE_BYTES } from "./code";
import { randomId } from "../client/webCrypto";
const MAX_DRAFT_PAYLOAD = 1_100_000;
const MAX_DRAFTS = 256;
const draftLimit = (scope: string) =>
  scope.includes(":code-answer:") ? MAX_CODE_BYTES : 4000;
export type BrowserStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One version of a draft: who wrote it (this browser and tab) and when. */
export interface DraftVersion {
  value: string;
  updatedAt: number;
  deviceId: string;
}
interface DraftEntry extends DraftVersion {
  /** `updatedAt` of the version the writer had seen; a write from an older base
   * than the stored version is a conflicting edit, not a continuation. */
  basedOn?: number;
  /** Written by an explicit choice between two versions. */
  resolved?: boolean;
  /** The other version, kept until the learner chooses. */
  conflict?: DraftVersion;
}

/** This browser profile (kept in local storage) plus this page load. A page
 * load, not the tab's session storage, identifies the writer: a duplicated tab
 * copies session storage but is a separate editor. */
export function draftWriterId(): string {
  const random = () => randomId().slice(0, 8);
  let device = "";
  try {
    device = window.localStorage.getItem("course:draft-device") ?? "";
    if (!/^[a-z0-9-]{4,40}$/i.test(device)) {
      device = random();
      window.localStorage.setItem("course:draft-device", device);
    }
  } catch {
    device ||= random();
  }
  return `${device}/${random()}`;
}

function version(value: unknown, scope: string): DraftVersion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (
    typeof row.value !== "string" ||
    row.value.length > draftLimit(scope) ||
    typeof row.updatedAt !== "number" ||
    !Number.isFinite(row.updatedAt) ||
    typeof row.deviceId !== "string" ||
    row.deviceId.length > 100
  )
    return;
  return { value: row.value, updatedAt: row.updatedAt, deviceId: row.deviceId };
}
function entry(value: unknown, scope: string): DraftEntry | undefined {
  // Drafts saved before versions existed were plain strings.
  if (typeof value === "string")
    return value.length <= draftLimit(scope)
      ? { value, updatedAt: 0, deviceId: "earlier" }
      : undefined;
  const base = version(value, scope);
  if (!base) return;
  const row = value as Record<string, unknown>;
  const conflict = version(row.conflict, scope);
  return {
    ...base,
    ...(typeof row.basedOn === "number" && Number.isFinite(row.basedOn)
      ? { basedOn: row.basedOn }
      : {}),
    ...(row.resolved === true ? { resolved: true } : {}),
    ...(conflict ? { conflict } : {}),
  };
}
const plain = ({ value, updatedAt, deviceId }: DraftVersion): DraftVersion => ({
  value,
  updatedAt,
  deviceId,
});

/** Account-scoped draft preferences, never progression or evidence.
 *
 * Drafts survive a closed tab. Every saved version records its writer and time.
 * When two tabs or windows edit the same draft from the same starting point,
 * neither edit is dropped: the shown version stays and the other one is kept
 * beside it until the learner chooses. */
export function createConnectedDraftStore(
  accountId: string,
  storage?: BrowserStore,
  writer: string = draftWriterId(),
) {
  const key = `course:learner-drafts:${encodeURIComponent(accountId)}`;
  const listeners = new Set<() => void>();
  let unavailable = !storage,
    revision = 0,
    values: Record<string, DraftEntry> = {};
  /** Parse the stored drafts; another tab may have written since we last read. */
  function load(): Record<string, DraftEntry> {
    const loaded: Record<string, DraftEntry> = {};
    const raw = storage?.getItem(key);
    if (raw && raw.length > MAX_DRAFT_PAYLOAD)
      throw Error("Draft storage exceeds limit");
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data))
        for (const [k, v] of Object.entries(data)) {
          const parsed = k.length <= 1024 ? entry(v, k) : undefined;
          if (parsed && Object.keys(loaded).length < MAX_DRAFTS)
            Object.defineProperty(loaded, k, {
              value: parsed,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        }
    }
    return loaded;
  }
  function set(
    target: Record<string, DraftEntry>,
    scope: string,
    value: DraftEntry,
  ) {
    Object.defineProperty(target, scope, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  /** True when `theirs` replaced an edit of ours that its writer had not seen. */
  function overwroteUs(mine: DraftEntry | undefined, theirs: DraftEntry) {
    return Boolean(
      mine &&
      mine.deviceId === writer &&
      theirs.deviceId !== writer &&
      theirs.value !== mine.value &&
      !theirs.resolved &&
      theirs.basedOn !== mine.updatedAt,
    );
  }
  /** Merge freshly loaded drafts into this tab's view. */
  function merge(stored: Record<string, DraftEntry>) {
    const next: Record<string, DraftEntry> = {};
    for (const [scope, theirs] of Object.entries(stored)) {
      const mine = Object.hasOwn(values, scope) ? values[scope] : undefined;
      set(
        next,
        scope,
        overwroteUs(mine, theirs)
          ? { ...mine!, conflict: plain(theirs) }
          : theirs,
      );
    }
    values = next;
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
  function persist() {
    try {
      const serialized = JSON.stringify(values);
      if (serialized.length > MAX_DRAFT_PAYLOAD)
        throw Error("Draft storage capacity reached");
      storage?.setItem(key, serialized);
    } catch {
      unavailable = true;
    }
  }
  function save(
    scope: string,
    value: string,
    options: { resolved?: boolean; keepConflict?: boolean } = {},
  ) {
    if (scope.length > 1024) return;
    const shown = Object.hasOwn(values, scope) ? values[scope] : undefined;
    // Merge with what other tabs stored, so this tab never erases their drafts.
    if (!unavailable)
      try {
        const stored = load();
        merge(stored);
      } catch {
        unavailable = true;
      }
    const current = Object.hasOwn(values, scope) ? values[scope] : undefined;
    // Someone else wrote this draft from an older base than the one shown here.
    const concurrent =
      current &&
      current.updatedAt !== shown?.updatedAt &&
      current.deviceId !== writer &&
      current.value !== value &&
      !current.resolved
        ? plain(current)
        : undefined;
    const conflict =
      options.keepConflict === false
        ? undefined
        : (concurrent ?? current?.conflict ?? shown?.conflict);
    if (!current && Object.keys(values).length >= MAX_DRAFTS)
      delete values[Object.keys(values)[0]!];
    set(values, scope, {
      value: value.slice(0, draftLimit(scope)),
      updatedAt: Math.max(
        Date.now(),
        Math.max(current?.updatedAt ?? 0, shown?.updatedAt ?? 0) + 1,
      ),
      deviceId: writer,
      // The version this tab was showing when the learner typed, not whatever
      // another tab stored meanwhile.
      ...(shown ? { basedOn: shown.updatedAt } : {}),
      ...(options.resolved ? { resolved: true } : {}),
      ...(conflict && conflict.value !== value ? { conflict } : {}),
    });
    persist();
    notify();
  }
  return {
    getSnapshot: () => revision,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      // Pick up drafts written in another tab of the same account.
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key || unavailable) return;
        try {
          merge(load());
          notify();
        } catch {
          unavailable = true;
        }
      };
      if (typeof window !== "undefined")
        window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined")
          window.removeEventListener("storage", onStorage);
      };
    },
    has: (scope: string) => Object.hasOwn(values, scope),
    read: (scope: string) =>
      Object.hasOwn(values, scope) ? values[scope]!.value : "",
    /** The shown version with its writer and time, if any. */
    version: (scope: string): DraftVersion | undefined =>
      Object.hasOwn(values, scope) ? plain(values[scope]!) : undefined,
    /** The other version of a draft that two tabs or windows edited at once. */
    conflict: (scope: string): DraftVersion | undefined =>
      Object.hasOwn(values, scope) ? values[scope]!.conflict : undefined,
    write: (scope: string, value: string) => save(scope, value),
    /** Keep one of two conflicting versions; the other is discarded only now. */
    resolve: (scope: string, keep: "shown" | "other") => {
      if (!Object.hasOwn(values, scope)) return;
      const current = values[scope]!;
      const chosen =
        keep === "other" && current.conflict
          ? current.conflict.value
          : current.value;
      save(scope, chosen, { resolved: true, keepConflict: false });
    },
    get writer() {
      return writer;
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
export type ConnectedDraftStore = ReturnType<typeof createConnectedDraftStore>;
