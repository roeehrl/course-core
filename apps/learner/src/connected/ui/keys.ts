/**
 * Keyboard rules shared by the composers and the companion shortcut (final design §3.6, §5).
 *
 * An input method editor (Japanese, Chinese, Korean and others) commits its text with Enter;
 * that Enter must never send. Browsers mark it with `isComposing` or keyCode 229, and Safari
 * sends one more Enter right after `compositionend`, so a key within 50 ms of the end of a
 * composition still counts as composing.
 */
export const SAFARI_LATE_ENTER_MS = 50;

interface KeyLike {
  key?: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export interface CompositionTracker {
  /** True while text is being composed, for an IME's own key, or just after a composition ended. */
  isComposing(event?: KeyLike): boolean;
  dispose(): void;
}

/** Follows composition on `target` (a field, or the document) for `isComposing`. */
export function createCompositionTracker(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null | undefined,
  now: () => number = () => Date.now(),
): CompositionTracker {
  let composing = false;
  let endedAt = -Infinity;
  const start = () => {
    composing = true;
  };
  const end = () => {
    composing = false;
    endedAt = now();
  };
  target?.addEventListener("compositionstart", start, true);
  target?.addEventListener("compositionend", end, true);
  return {
    isComposing(event) {
      if (composing) return true;
      if (event) {
        const native = event.nativeEvent ?? event;
        if (event.isComposing || native.isComposing || event.keyCode === 229 || native.keyCode === 229) return true;
      }
      return now() - endedAt < SAFARI_LATE_ENTER_MS;
    },
    dispose() {
      target?.removeEventListener("compositionstart", start, true);
      target?.removeEventListener("compositionend", end, true);
    },
  };
}

/**
 * Whether a key sends the message: Cmd/Ctrl+Enter always; plain Enter (no Shift, Alt, Cmd or
 * Ctrl) on a fine pointer. On a touch keyboard Enter makes a new line and the Send button sends.
 * Callers check composition first (`createCompositionTracker`).
 */
export function isSendKey(event: KeyLike, { touch = false }: { touch?: boolean } = {}): boolean {
  if (event.key !== "Enter") return false;
  if (event.altKey) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !touch && !event.shiftKey;
}

/** Cmd/Ctrl+Enter only: the long-answer composer, where Enter is a new line. */
export function isSubmitChord(event: KeyLike): boolean {
  return event.key === "Enter" && !event.altKey && !event.shiftKey && (event.metaKey === true || event.ctrlKey === true);
}

/** Apple platforms name the command key ⌘; others say Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * The companion shortcut: Ctrl+Shift+. (⌘⇧. on a Mac), read from the physical key
 * (`event.code === "Period"`, so it works on every layout), never with Alt.
 */
export function isCompanionShortcut(event: KeyLike): boolean {
  return event.code === "Period" && event.shiftKey === true && (event.ctrlKey === true || event.metaKey === true) && !event.altKey;
}
