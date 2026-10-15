import { useEffect } from "react";
import { companionFocus, focusExcerpt } from "../client/companionFocus";

/** Captures text the learner selects in the open lesson (not in fields, and not
 * in the companion panel) as the selection for their next companion message.
 * A collapsed selection keeps the earlier one: clicking into the message field
 * must not drop what the learner chose. */
export function useLessonSelection(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const capture = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const node = selection.getRangeAt(0).commonAncestorContainer;
      const element =
        node instanceof Element ? node : (node.parentElement as Element | null);
      if (
        !element?.closest(".connected-lesson") ||
        element.closest("textarea,input,[contenteditable='true']")
      )
        return;
      const excerpt = focusExcerpt(selection.toString());
      if (excerpt.length >= 2)
        companionFocus.setSelection({ kind: "text", excerpt });
    };
    // Captured on every change (cheap): a later collapse, such as pressing the
    // companion button, must not cancel a selection that was already made.
    document.addEventListener("selectionchange", capture);
    capture();
    return () => document.removeEventListener("selectionchange", capture);
  }, [enabled]);
}
