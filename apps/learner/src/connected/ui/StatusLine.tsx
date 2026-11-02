import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { LivePressable } from "../../components/LivePressable";
import type { IconName } from "../../components/icons/icons";
import { colors } from "../../theme/colors";

export interface StatusLineProps {
  text: string;
  /** `muted` for waiting and progress, `ink` for what needs attention, `error` (ink with `alert-circle`, never red). */
  tone?: "muted" | "ink" | "error";
  icon?: IconName;
  /** At most one action. */
  action?: { label: string; onPress: () => void };
  className?: string;
}

/** One status sentence with an optional action. React Native: text and a text button. */
export function StatusLine({ text, tone = "muted", action }: StatusLineProps) {
  return (
    <View style={styles.row}>
      <Text style={[styles.text, tone !== "muted" && styles.ink]}>{text}</Text>
      {action && (
        <LivePressable accessibilityRole="button" onPress={action.onPress} style={styles.action}>
          <Text style={styles.actionText}>{action.label}</Text>
        </LivePressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  text: { color: colors.inkMuted, fontSize: 13, lineHeight: 20 },
  ink: { color: colors.ink },
  action: { minHeight: 44, justifyContent: "center" },
  actionText: { color: colors.accent, fontSize: 14, lineHeight: 20, fontWeight: "600" },
});
