import { useEffect } from "react";
import { isCompanionShortcut, isMac } from "../ui/keys";
import { isEditable } from "../layoutViewport";
import { companionBridge } from "./bridge";
import { companionOpen } from "./openState";

/**
 * The companion's keyboard shortcut (final design §3.1, §5, Q8): Ctrl+Shift+. on Windows and
 * Linux, ⌘⇧. on a Mac, read from the physical key (`event.code` "Period"), so it works on a Hebrew
 * or any other layout. Never with Alt (Alt+Shift switches the keyboard layout on Windows), and
 * never while typing in a field, where the keys belong to the field. It opens or closes the
 * companion; with lesson text selected it attaches the selection and opens it. The collision check
 * is in docs/accessibility.md.
 */
export interface ShortcutEventLike {
  code?: string;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

/** The value for `aria-keyshortcuts` (ARIA names keys by their `KeyboardEvent.key` values). */
export function shortcutAria(mac = isMac()): string {
  return mac ? "Meta+Shift+." : "Control+Shift+."; // i18n-ignore: aria-keyshortcuts syntax, not shown
}
/** The keys as people read them, for a tooltip. Key names stay in Latin script in every language. */
export function shortcutLabel(mac = isMac()): string {
  return mac ? "⌘⇧." : "Ctrl+Shift+."; // i18n-ignore: key names, the same in every language
}

/** Lesson text is selected (not text inside a field, which the field owns). */
export function lessonSelection(doc: Document = document): boolean {
  const selection = doc.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return false;
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest(".connected-main"));
}

/** What the shortcut does for a key event: nothing (`null`), open with the selection attached, or
 * toggle the companion. */
export function shortcutAction(event: ShortcutEventLike, selected: boolean): "attach" | "toggle" | null {
  if (event.defaultPrevented || event.repeat || !isCompanionShortcut(event)) return null;
  if (event.target instanceof Element && isEditable(event.target)) return null;
  return selected ? "attach" : "toggle";
}

/** Acts on one key event; true when the event was the companion's. */
export function handleCompanionShortcut(event: KeyboardEvent): boolean {
  const action = shortcutAction(event, lessonSelection());
  if (!action) return false;
  event.preventDefault();
  if (action === "attach" && companionBridge.attachSelection()) companionOpen.open("shortcut");
  else companionOpen.toggle("shortcut");
  return true;
}

/** Listens for the shortcut on the whole page while the companion is offered. */
export function useCompanionShortcut(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onKey = (event: KeyboardEvent) => void handleCompanionShortcut(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
