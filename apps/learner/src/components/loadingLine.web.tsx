import React from "react";
import { useT } from "../i18n";

/** A muted "Checking…" line that takes the space of the line it will most
 * likely become (`reserve`), so a short read does not change the height. The
 * reserved text is invisible and hidden from assistive technology. */
export function LoadingLine({ reserve }: { reserve: string }) {
  const t = useT();
  return (
    <p className="connected-muted connected-loading-line">
      <span aria-hidden="true" className="connected-loading-reserve">{reserve}</span>
      <span className="connected-loading-text">{t("loadingLine.checking")}</span>
    </p>
  );
}
