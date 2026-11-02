import React, { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { IconButton } from "../ui/IconButton.web";
import { Popover } from "../ui/Popover.web";
import { useOwnEscape } from "./ownEscape";

/**
 * The ⓘ after the credit line: one paragraph on how questions count, in a 280 px popover that
 * opens by click or keyboard and returns focus to the button when it closes. The popover is placed
 * under the whole credit line (`line`), so it lines up with the line inside the companion instead
 * of running past its edge from the ⓘ at the line's end.
 */
export function CreditInfo({ line }: { line?: React.RefObject<HTMLElement | null> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Closed with focus left nowhere (Esc, the popover's own content gone): back to the ⓘ, which the
  // popover itself returns to only when it is the anchor.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if ((!active || active === document.body) && button.current?.isConnected) button.current.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useOwnEscape(open, () => document.querySelector(".cc-credit-popover"), () => setOpen(false));
  return (
    <>
      <IconButton
        ref={button}
        icon="info"
        iconSize={16}
        label={t("creditInfo.label")}
        className="cc-credit-info is-small"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchor={line ?? button} label={t("creditInfo.label")} className="cc-credit-popover">
        <p className="cc-credit-popover-text">{t("creditInfo.body")}</p>
      </Popover>
    </>
  );
}
