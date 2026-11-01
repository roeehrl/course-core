import React from "react";
import { View } from "react-native";
import { Overlay } from "./Overlay";
import { Button, styles } from "./ui";
import { useT } from "../i18n";
import type { CompanionLayout } from "../domain/companionLayout";
import { companionOpen, useCompanionOpenState } from "../connected/companion/openState";
export interface CompanionDockProps {
  /** Where the companion goes in this window (domain/companionLayout.ts): docked beside the
   * lesson, or a sheet. Whether it is open comes from connected/companion/openState.ts. */
  layout: CompanionLayout;
  /** Web: beside the lesson, the element (in the header) the show-companion button is drawn in,
   * so it never floats over the lesson. Without one it floats at the window's end. */
  headerSlot?: HTMLElement | null;
  /** Web: the lesson's title, shown in focus view's header from 1024 px (read from the lesson's
   * heading when not given). */
  lessonTitle?: string;
  children: React.ReactNode;
}
/** Portable presentation fallback; native connected auth/media are still deferred. */
export function CompanionDock({ layout, children }: CompanionDockProps) {
  const t = useT();
  const state = useCompanionOpenState();
  const wide = layout.placement === "docked";
  if (wide && !state.paneOpen)
    return <Button label={t("companionDock.open")} onPress={() => companionOpen.setPaneOpen(true)} />;
  return wide ? (
    <View style={styles.card}>{children}</View>
  ) : (
    <>
      <Button label={t("companionDock.open")} onPress={() => companionOpen.setSheetOpen(true)} />
      {state.sheetOpen && (
        <Overlay title={t("companionDock.sheetTitle")} onClose={() => companionOpen.setSheetOpen(false)}>
          {children}
        </Overlay>
      )}
    </>
  );
}
