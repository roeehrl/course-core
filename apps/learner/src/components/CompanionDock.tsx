import React from "react";
import { View } from "react-native";
import { Overlay } from "./Overlay";
import { Button, styles } from "./ui";
export interface CompanionDockProps {
  wide: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}
/** Portable presentation fallback; native connected auth/media are still deferred. */
export function CompanionDock({
  wide,
  open,
  onOpenChange,
  children,
}: CompanionDockProps) {
  return wide ? (
    <View style={styles.card}>{children}</View>
  ) : (
    <>
      <Button label="Companion" onPress={() => onOpenChange(true)} />
      {open && (
        <Overlay title="companion" onClose={() => onOpenChange(false)}>
          {children}
        </Overlay>
      )}
    </>
  );
}
