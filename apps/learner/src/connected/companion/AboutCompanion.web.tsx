import React, { useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { IconButton } from "../ui/IconButton.web";
import { Popover } from "../ui/Popover.web";
import { companionBridge } from "./bridge";

/**
 * The ⓘ in the companion's header and its popover (final design §3.2, First-run-consent panel 2):
 * its title (which names the dialog), what the companion sees and the rule for counted checks, and
 * a link to the learner's data and choices on their profile. Esc or a click outside closes it, and
 * focus goes back to the ⓘ.
 */
export function AboutCompanion({ label }: { label: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  return (
    <>
      <IconButton
        ref={anchor}
        icon="info"
        label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="cc-shell-header-button"
        data-companion-control=""
        onClick={() => setOpen((value) => !value)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} labelledBy={titleId} width={320} className="cc-shell-about">
        <h3 id={titleId} className="cc-shell-about-title">
          {label}
        </h3>
        <p className="cc-shell-about-policy">{t("aboutCompanion.policy")}</p>
        <button
          type="button"
          className="cc-ui-text-button cc-shell-about-link"
          onClick={() => {
            setOpen(false);
            companionBridge.navigate({ to: "profile" });
          }}
        >
          {t("aboutCompanion.data")}
        </button>
      </Popover>
    </>
  );
}
