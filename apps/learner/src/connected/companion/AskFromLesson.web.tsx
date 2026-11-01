import React, { useEffect, useRef } from "react";
import { useLessonSelection } from "../../hooks/useLessonSelection";
import { useT } from "../../i18n";
import { Announcer, useAnnounce } from "../ui/Announcer.web";
import { isCompanionShortcut } from "../ui/keys";
import { useCoarsePointer } from "../ui/media";
import { AskCompanionButton } from "./AskCompanionButton.web";
import { companionBridge, useCompanionAvailable } from "./bridge";
import {
  attachCandidate,
  focusAfterAsk,
  focusSelectionEnd,
  tabbableNeighbour,
  type AskCandidate,
} from "./selectionAttach";

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
  /** While the button has focus: the selection it stands for and where focus came from. */
  const focusedFrom = useRef<{ candidate: AskCandidate; element: HTMLElement | null } | null>(null);
  const attach = (target: AskCandidate, focus: boolean) => {
    focusedFrom.current = null;
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

  // A code field is an editable field, where the shell leaves the shortcut alone: with lines
  // selected there, the shortcut attaches them here.
  useEffect(() => {
    if (!enabled) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isCompanionShortcut(event)) return;
      const target = current();
      if (target?.kind !== "code" || document.activeElement !== target.origin) return;
      event.preventDefault();
      attachRef.current(target, true);
    };
    document.addEventListener("keydown", shortcut, true);
    return () => document.removeEventListener("keydown", shortcut, true);
  }, [enabled, current]);

  // The button went away while it had focus (Esc, a scroll): focus goes back to where it came
  // from, or to the selection, so Tab carries on from there and not from the top of the page.
  useEffect(() => {
    if (candidate) return;
    const from = focusedFrom.current;
    focusedFrom.current = null;
    if (!from || (document.activeElement && document.activeElement !== document.body)) return;
    if (from.element?.isConnected && from.element !== document.body) from.element.focus({ preventScroll: true });
    else focusSelectionEnd(from.candidate);
  }, [candidate]);

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
      onFocus={(event) => {
        focusedFrom.current = { candidate, element: event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null };
      }}
      onBlur={() => {
        focusedFrom.current = null;
      }}
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
