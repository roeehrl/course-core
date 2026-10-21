import React, { useLayoutEffect, type ReactNode } from "react";
import { applyDocumentLocale, type Direction } from "@course-core/i18n";

/** Web: `<html lang dir>` follows the UI locale; the whole page inherits its direction. */
export function LocaleRoot({ lang, dir, children }: { lang: string; dir: Direction; children: ReactNode }) {
  useLayoutEffect(() => {
    if (typeof document !== "undefined") applyDocumentLocale(document, { lang, dir });
  }, [lang, dir]);
  return <>{children}</>;
}
