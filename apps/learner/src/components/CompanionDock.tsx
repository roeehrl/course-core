import React from "react";
import { View } from "react-native";
import { Overlay } from "./Overlay";
import { Button, styles } from "./ui";
import { useT } from "../i18n";
export interface CompanionDockProps {
  /** The companion sits beside the lesson (medium and expanded windows of
   * sufficient height). Otherwise it is a full-height sheet. */
  wide: boolean;
  /** Whether the sheet is open (ignored beside the lesson). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Beside the lesson the pane can be collapsed to give the lesson the width. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  children: React.ReactNode;
}
/** Portable presentation fallback; native connected auth/media are still deferred. */
export function CompanionDock({
  wide,
  open,
  onOpenChange,
  collapsed = false,
  onCollapsedChange,
  children,
}: CompanionDockProps) {
  const t = useT();
  if (wide && collapsed)
    return <Button label={t("companionDock.open")} onPress={() => onCollapsedChange?.(false)} />;
  return wide ? (
    <View style={styles.card}>{children}</View>
  ) : (
    <>
      <Button label={t("companionDock.open")} onPress={() => onOpenChange(true)} />
      {open && (
        <Overlay title={t("companionDock.sheetTitle")} onClose={() => onOpenChange(false)}>
          {children}
        </Overlay>
      )}
    </>
  );
}
