import { useCallback, useEffect, useRef, useState } from "react";
import {
  ASK_STABLE_MS,
  codeCandidate,
  codeSelection,
  isAskButton,
  textCandidate,
  type AskCandidate,
} from "../connected/companion/selectionAttach";
import type { LessonSelection } from "./useLessonSelection";

export type { LessonSelection } from "./useLessonSelection";

const COMPANION = "#connected-companion";

/**
 * Follows what the learner selects in the open lesson (text, or lines of their own code) and
 * offers it for the floating "Ask companion" button. Nothing is attached here (no silent capture):
 * the button or the companion shortcut attaches it (selectionAttach.ts).
 *
 * The offer appears once the selection has not changed for 300 ms and no pointer is pressed
 * (M18), and goes away when the selection is cleared, on Esc, on a scroll of the page (not of the
 * companion) and when the window is resized. A selection that was dismissed or attached stays
 * hidden until the learner selects something else.
 */
export function useLessonSelection(enabled: boolean): LessonSelection {
  const [shown, setShown] = useState<AskCandidate | null>(null);
  const [viaKeyboard, setViaKeyboard] = useState(false);
  const shownRef = useRef<AskCandidate | null>(null);
  const settled = useRef<string | null>(null);
  const keyboard = useRef(false);
  const show = useCallback((candidate: AskCandidate | null) => {
    shownRef.current = candidate;
    setShown(candidate);
  }, []);
  /** The selection the learner could ask about now: the focused code field's lines, else lesson text. */
  const current = useCallback((): AskCandidate | null => {
    if (!enabled || typeof document === "undefined") return null;
    const active = document.activeElement;
    // While the button has focus it stands for the selection it was shown for (focusing it may
    // move the page's selection).
    if (isAskButton(active) && shownRef.current) return shownRef.current;
    const offered = codeSelection.current();
    if (offered && (active === offered.origin || isAskButton(active))) {
      // Read again: the field's selection may have moved since it was offered.
      return active === offered.origin ? codeCandidate(offered.origin as HTMLTextAreaElement) : offered;
    }
    return textCandidate(document.getSelection());
  }, [enabled]);
  const dismiss = useCallback(() => {
    const candidate = shownRef.current;
    if (candidate) settled.current = candidate.key;
    show(null);
  }, [show]);
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pressed = false;
    const settle = () => {
      timer = undefined;
      if (pressed) return;
      const candidate = current();
      if (!candidate || candidate.key === settled.current) return;
      setViaKeyboard(keyboard.current);
      show(candidate);
    };
    const changed = () => {
      const candidate = current();
      if (!candidate) {
        settled.current = null;
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (shownRef.current) show(null);
        return;
      }
      if (candidate.key === shownRef.current?.key) return;
      if (shownRef.current) show(null);
      if (timer) clearTimeout(timer);
      timer = setTimeout(settle, ASK_STABLE_MS);
    };
    const down = (event: PointerEvent) => {
      if (isAskButton(event.target)) return;
      pressed = true;
      keyboard.current = false;
    };
    const up = () => {
      if (!pressed) return;
      pressed = false;
      // The selection a drag made counts from the moment the pointer is let go.
      const candidate = current();
      if (!candidate || candidate.key === shownRef.current?.key || candidate.key === settled.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(settle, ASK_STABLE_MS);
    };
    const key = (event: KeyboardEvent) => {
      if (!["Tab", "Escape", "Shift", "Control", "Meta", "Alt"].includes(event.key)) keyboard.current = true;
    };
    // After the page's own Esc handlers (a menu or the companion that took it comes first).
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !shownRef.current) return;
      event.preventDefault();
      dismiss();
    };
    const scrolled = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(COMPANION)) return;
      if (shownRef.current) dismiss();
    };
    const resized = () => {
      if (shownRef.current) dismiss();
    };
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    window.addEventListener("resize", resized);
    const unsubscribe = codeSelection.subscribe(changed);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
      unsubscribe();
      show(null);
    };
  }, [enabled, current, dismiss, show]);
  return { candidate: shown, viaKeyboard, current, dismiss };
}
