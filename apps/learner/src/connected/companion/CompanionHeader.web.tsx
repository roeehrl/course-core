import React from "react";
import { useT } from "../../i18n";
import { Icon } from "../../components/icons/Icon.web";
import { IconButton } from "../ui/IconButton.web";
import { PanelHeader } from "../ui/PanelHeader.web";
import { AboutCompanion } from "./AboutCompanion.web";
import { DetentToggle, SheetHandle } from "./CompanionSheet.web";
import type { CompanionDetent } from "./openState";
import type { SheetKind } from "./sheetDetents";

/**
 * The companion's header (final design §3.2), one row for each way it shows:
 * - beside the lesson (48 px): the glyph and "Companion", then About, Expand and Close;
 * - focus view (48 px, the window's width): the glyph, "Companion" and the lesson's title (from
 *   1024 px), then About, "Show lesson beside" and Close;
 * - a sheet (56 px): the handle at its top, the glyph and "Companion", then the height toggle (not
 *   on a short window, which has one height besides Collapsed) and Close.
 * Its bottom hairline shows only while the conversation is scrolled away from its top (layout.css).
 * The class `connected-dock-title` names it for the conversation's scrolling.
 */
export function CompanionHeader({
  variant,
  lessonTitle,
  sheet,
  detent,
  onClose,
  onExpand,
  onBeside,
}: {
  variant: "panel" | "focus" | "sheet";
  lessonTitle?: string;
  sheet?: SheetKind | null;
  detent: CompanionDetent;
  onClose: () => void;
  onExpand: () => void;
  onBeside: () => void;
}) {
  const t = useT();
  const about = <AboutCompanion label={t("companionHeader.about")} />;
  const close = (
    <IconButton icon="x" label={t("companionDock.close")} className="cc-shell-header-button" data-companion-control="" onClick={onClose} />
  );
  const end =
    variant === "focus" ? (
      <>
        {about}
        <button type="button" className="cc-shell-beside" data-companion-control="" onClick={onBeside}>
          <Icon name="panel-right" size={20} />
          <span>{t("companionHeader.beside")}</span>
        </button>
        {close}
      </>
    ) : variant === "sheet" ? (
      <>
        {sheet !== "short" && <DetentToggle detent={detent} />}
        {close}
      </>
    ) : (
      <>
        {about}
        <button
          type="button"
          className="cc-ui-icon-button cc-shell-header-button"
          aria-label={t("companionHeader.expand")}
          title={t("companionHeader.expand.tooltip")}
          data-companion-control=""
          data-companion-expand=""
          onClick={onExpand}
        >
          <Icon name="maximize-2" size={20} />
        </button>
        {close}
      </>
    );
  return (
    <div className={`cc-shell-header is-${variant}`}>
      {variant === "sheet" && sheet && <SheetHandle kind={sheet} detent={detent} />}
      <PanelHeader
        className="connected-dock-title"
        title={t("companionHeader.title")}
        subtitle={variant === "focus" && lessonTitle ? <bdi>{lessonTitle}</bdi> : undefined}
        glyph={<Icon name="sparkle" size={20} />}
        end={end}
      />
    </div>
  );
}
