import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { LivePressable } from "../../components/LivePressable";
import type { IconName } from "../../components/icons/icons";
import { useT } from "../../i18n";
import { colors } from "../../theme/colors";

export interface ChipProps {
  label: string;
  /**
   * `send`: pressing it acts at once (no icon). `fill`: it puts its text into the message box
   * (pencil icon, described by "Fills in the message box"). `removable`: an attachment with its
   * own remove button named `removeLabel`.
   */
  variant?: "send" | "fill" | "removable";
  onPress?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  icon?: IconName;
  size?: 28 | 32;
  className?: string;
}

/** A chip. React Native: a rounded button (and a remove button for an attachment), no icons. */
export function Chip({ label, variant = "send", onPress, onRemove, removeLabel }: ChipProps) {
  const t = useT();
  if (variant === "removable")
    return (
      <View style={[styles.chip, styles.row]}>
        <Text style={styles.label}>{label}</Text>
        {onRemove && (
          <LivePressable accessibilityRole="button" accessibilityLabel={removeLabel} onPress={onRemove} style={styles.remove}>
            <Text style={styles.label}>×</Text>
          </LivePressable>
        )}
      </View>
    );
  return (
    <LivePressable
      accessibilityRole="button"
      accessibilityHint={variant === "fill" ? t("chip.fillsIn") : undefined}
      onPress={onPress ?? (() => {})}
      style={styles.chip}
    >
      <Text style={styles.label}>{label}</Text>
    </LivePressable>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong, paddingHorizontal: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  remove: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
});
