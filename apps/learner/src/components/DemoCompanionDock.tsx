import React from "react";

/** Native: the demo keeps its companion in the page and in a dialog (LearnerApp.tsx); the docked
 * panel and the sheet are the web's (DemoCompanionDock.web.tsx). */
export function DemoCompanionSlot(_: { onSlot: (element: HTMLElement | null) => void }) {
  return null;
}

export interface DemoCompanionDockProps {
  width: number;
  height: number;
  headerSlot: HTMLElement | null;
  lessonTitle?: string;
  /** The page's header, drawn full width above the page and the panel (web; null on native,
   * where the page keeps it). */
  header?: React.ReactNode;
  /** The companion, on the web (null while the course loads). */
  companion: React.ReactNode;
  /** The page. */
  children: React.ReactNode;
}

export function DemoCompanionDock({ children }: DemoCompanionDockProps) {
  return <>{children}</>;
}
