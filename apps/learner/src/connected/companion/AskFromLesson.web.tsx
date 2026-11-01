import React, { useEffect, useRef } from "react";
import { useLessonSelection } from "../../hooks/useLessonSelection";
import { useT } from "../../i18n";
import { Announcer, useAnnounce } from "../ui/Announcer.web";
import { useCoarsePointer } from "../ui/media";
import { AskCompanionButton } from "./AskCompanionButton.web";
import { companionBridge, useCompanionAvailable } from "./bridge";
import { attachCandidate, focusAfterAsk, tabbableNeighbour, type AskCandidate } from "./selectionAttach";

/** Where Tab belongs to the control that has focus, not to a selection in the lesson text. */
const OUTSIDE_TEXT = "input,textarea,select,[contenteditable]:not([contenteditable='false']),#connected-companion";

/**
 * Asking the companion about a selection in the lesson (final design §3.9): the floating "Ask
 * companion" button after a stable selection of lesson text or code lines, the keyboard path (the
 * status region names the shortcut once, Tab from the selection reaches the button, and the
 * companion shortcut attaches the selection through the bridge), and nothing at all while the
 * companion is not offered (§4.16). Rendered once by the companion region.
 */
export function AskFromLesson({ episodeId }: { episodeId?: string }) {
  const available = useCompanionAvailable();
  return (
    <Announcer className="cc-ask-status">
      <AskFromSelection enabled={available} episodeId={episodeId} />
    </Announcer>
  );
}

function AskFromSelection({ enabled, episodeId }: { enabled: boolean; episodeId?: string }) {
  const t = useT();
  const announce = useAnnounce();
  const coarse = useCoarsePointer();
  const { candidate, viaKeyboard, current, dismiss } = useLessonSelection(enabled);
  const button = useRef<HTMLButtonElement | null>(null);
  const attach = (target: AskCandidate, focus: boolean) => {
    dismiss();
    // On a touch screen a tap keeps the keyboard down, so the sheet opens at Half.
    attachCandidate(target, { focus });
  };
  const attachRef = useRef(attach);
  attachRef.current = attach;

  // A selection belongs to the lesson it was made in.
  useEffect(() => dismiss, [episodeId, dismiss]);

  // The companion shortcut attaches the selection being made, shown yet or not.
  useEffect(() => {
    if (!enabled) return;
    return companionBridge.registerSelection(() => {
      const target = current();
      if (!target) return false;
      // The shortcut is a key press: the message box takes focus.
      attachRef.current(target, true);
      return true;
    });
  }, [enabled, current]);

  // Said once for a selection made with the keyboard; a new selection may say it again.
  const said = useRef(false);
  useEffect(() => {
    if (!candidate) return;
    if (viaKeyboard && !said.current) {
      said.current = true;
      announce(t("askFromLesson.available"));
    }
  }, [candidate, viaKeyboard, announce, t]);
  useEffect(() => {
    if (candidate || current()) return;
    said.current = false;
    announce("");
  }, [candidate, current, announce]);

  // Tab from the end of the selection reaches the button first.
  useEffect(() => {
    if (!candidate) return;
    // Focus has not moved since the selection was offered: Tab starts from the selection.
    const focusedThen = document.activeElement;
    const tab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.shiftKey || event.defaultPrevented || !button.current) return;
      const active = document.activeElement;
      const fromSelection =
        candidate.kind === "code"
          ? active === candidate.origin
          : !active ||
            active === document.body ||
            active.contains(candidate.endNode) ||
            (active === focusedThen && !active.closest(OUTSIDE_TEXT));
      if (!fromSelection) return;
      event.preventDefault();
      button.current.focus();
    };
    document.addEventListener("keydown", tab, true);
    return () => document.removeEventListener("keydown", tab, true);
  }, [candidate]);

  if (!candidate) return null;
  return (
    <AskCompanionButton
      ref={button}
      candidate={candidate}
      onPress={(event) => attach(candidate, focusAfterAsk(event, coarse))}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        // From the button, Tab carries on after the selection (Shift+Tab goes back to it).
        const next =
          event.shiftKey && candidate.kind === "code"
            ? candidate.origin
            : tabbableNeighbour(candidate.endNode, !event.shiftKey);
        if (!next) return;
        event.preventDefault();
        next.focus();
      }}
    />
  );
}
