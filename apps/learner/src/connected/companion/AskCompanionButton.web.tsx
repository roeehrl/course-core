import React, { forwardRef, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";
import { ASK_BUTTON_CLASS, askButtonPosition, type AskCandidate } from "./selectionAttach";

/**
 * The floating "Ask companion" button beside a selection (final design §3.9, M18): 32 px (44 with
 * a coarse pointer), the menu shadow, `sparkle` and the label, placed 8 px below the selection's
 * end (selectionAttach.ts). It lives in `document.body`, so no lesson box clips it; pressing it
 * keeps the selection (the pointer press does not move focus or clear it).
 */
export const AskCompanionButton = forwardRef<
  HTMLButtonElement,
  {
    candidate: AskCandidate;
    onPress: (event: React.MouseEvent<HTMLButtonElement>) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
    onFocus?: (event: React.FocusEvent<HTMLButtonElement>) => void;
    onBlur?: (event: React.FocusEvent<HTMLButtonElement>) => void;
  }
>(function AskCompanionButton({ candidate, onPress, onKeyDown, onFocus, onBlur }, ref) {
  const t = useT();
  const own = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const node = own.current;
    if (!node) return;
    const { top, left } = askButtonPosition(
      candidate.end,
      { width: node.offsetWidth, height: node.offsetHeight },
      candidate.direction,
      { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight },
    );
    // A fixed box is placed in its containing block: measure where 0,0 lands and correct for it.
    node.style.top = "0px";
    node.style.left = "0px";
    const origin = node.getBoundingClientRect();
    node.style.top = `${top - origin.top}px`;
    node.style.left = `${left - origin.left}px`;
    node.style.visibility = "";
  }, [candidate]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <button
      ref={(node) => {
        own.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      type="button"
      className={ASK_BUTTON_CLASS}
      data-kind={candidate.kind}
      aria-keyshortcuts="Control+Shift+Period Meta+Shift+Period"
      style={{ visibility: "hidden" }}
      // Keep the selection and the focus where they are: the press is about them.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <Icon name="sparkle" size={16} />
      <span>{t("askCompanionButton.label")}</span>
    </button>,
    document.body,
  );
});
