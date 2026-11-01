import React, { useRef, useState } from "react";
import { useT } from "../../i18n";
import { IconButton } from "../ui/IconButton.web";
import { Popover } from "../ui/Popover.web";

/**
 * The ⓘ after the credit line: one paragraph on how questions count, in a 280 px popover that
 * opens by click or keyboard and returns focus to the button when it closes.
 */
export function CreditInfo() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={anchor}
        icon="info"
        iconSize={16}
        label={t("creditInfo.label")}
        className="cc-credit-info is-small"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={t("creditInfo.label")} className="cc-credit-popover">
        <p className="cc-credit-popover-text">
          {t("creditInfo.body")}
        </p>
      </Popover>
    </>
  );
}
