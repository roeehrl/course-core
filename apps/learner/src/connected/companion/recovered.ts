import { useSyncExternalStore } from "react";
import type { Translate } from "../../i18n";

/**
 * A companion message saved on this device before a reload or a lost connection, recovered and
 * sent when the page loaded again. The companion says so once, as a banner above its composer
 * ("Your last message was recovered…", final design §3.13), so the learner looks before asking
 * again; never as the page's notice. In memory only.
 */
let recovered = false;
const listeners = new Set<() => void>();
const publish = (value: boolean) => {
  if (recovered === value) return;
  recovered = value;
  for (const listener of listeners) listener();
};

/** Called by the host's refresh when the API replayed a saved companion message. The host's
 * `setNotice` is no longer used: the banner belongs to the companion. */
export function recoveredCompanionRequest(_host: { setNotice: (notice: { render: (t: Translate) => string }) => void }) {
  publish(true);
}

/** The learner has seen it (the banner's "Show it", or the conversation moved on). */
export function dismissRecovered() {
  publish(false);
}

export function useRecoveredMessage(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => recovered,
    () => false,
  );
}
