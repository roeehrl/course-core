import { useSyncExternalStore } from "react";

/**
 * A question the learner saved for after the check ("Save for after the question", final design
 * §3.11): its text and the counted questions it would have made practice. One per enrollment (an
 * account in a course) and lesson. Kept in memory and on this device (`localStorage`, which may be
 * unavailable: then in memory only), and cleared once it is sent.
 */
export interface DeferredQuestion {
  text: string;
  /** The open counted questions in scope when it was saved; it can be sent once none still counts. */
  challengeIds: string[];
  savedAt: number;
}

const PREFIX = "course:learner-deferred-question:";
const memory = new Map<string, DeferredQuestion | null>();
const listeners = new Set<() => void>();
const keyOf = (enrollmentId: string, episodeId: string) => `${PREFIX}${enrollmentId}:${episodeId}`;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
function parse(raw: string | null): DeferredQuestion | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DeferredQuestion>;
    return typeof value.text === "string" && value.text.trim() && Array.isArray(value.challengeIds) && value.challengeIds.every((id) => typeof id === "string")
      ? { text: value.text, challengeIds: value.challengeIds, savedAt: typeof value.savedAt === "number" ? value.savedAt : 0 }
      : null;
  } catch {
    return null;
  }
}
function publish() {
  for (const listener of listeners) listener();
}

export const deferredQuestion = {
  get(enrollmentId: string, episodeId: string): DeferredQuestion | null {
    const key = keyOf(enrollmentId, episodeId);
    if (!memory.has(key)) {
      let raw: string | null = null;
      try {
        raw = storage()?.getItem(key) ?? null;
      } catch {
        raw = null;
      }
      memory.set(key, parse(raw));
    }
    return memory.get(key) ?? null;
  },
  save(enrollmentId: string, episodeId: string, text: string, challengeIds: readonly string[], now = Date.now()) {
    if (!text.trim()) return;
    const key = keyOf(enrollmentId, episodeId), value = { text, challengeIds: [...challengeIds], savedAt: now };
    memory.set(key, value);
    try {
      storage()?.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the question stays saved in this tab.
    }
    publish();
  },
  clear(enrollmentId: string, episodeId: string) {
    const key = keyOf(enrollmentId, episodeId);
    memory.set(key, null);
    try {
      storage()?.removeItem(key);
    } catch {
      // Nothing to remove where storage is unavailable.
    }
    publish();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Tests: forget what is held in memory (storage is left as it is). */
  resetMemory() {
    memory.clear();
    publish();
  },
};

/** The question saved for after the check in this lesson, if any; updates when it changes. */
export function useDeferredQuestion(enrollmentId: string | undefined, episodeId: string | undefined): DeferredQuestion | null {
  return useSyncExternalStore(
    deferredQuestion.subscribe,
    () => (enrollmentId && episodeId ? deferredQuestion.get(enrollmentId, episodeId) : null),
    () => null,
  );
}

/** Whether a saved question can be sent now: none of the questions it was saved for still counts. */
export function deferredSendable(saved: DeferredQuestion, open: readonly { challengeId: string; independentEligible: boolean }[]): boolean {
  return !open.some((item) => item.independentEligible && saved.challengeIds.includes(item.challengeId));
}
