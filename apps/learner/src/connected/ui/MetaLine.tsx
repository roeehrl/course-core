import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { LivePressable } from "../../components/LivePressable";
import type { IconName } from "../../components/icons/icons";
import { colors } from "../../theme/colors";

export interface MetaLineProps {
  children: React.ReactNode;
  icon?: IconName;
  /** A `--line` rule from the text to the inline end (dividers). */
  rule?: boolean;
  action?: { label: string; onPress: () => void };
  className?: string;
}

/** A start-aligned meta line (dividers, system lines, credit lines). React Native: muted text. */
export function MetaLine({ children, rule, action }: MetaLineProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.text}>{children}</Text>
      {rule && <View style={styles.rule} />}
      {action && (
        <LivePressable accessibilityRole="button" onPress={action.onPress} style={styles.action}>
          <Text style={styles.actionText}>{action.label}</Text>
        </LivePressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  text: { color: colors.inkMuted, fontSize: 13, lineHeight: 20 },
  rule: { flex: 1, height: 1, backgroundColor: colors.line },
  action: { minHeight: 44, justifyContent: "center" },
  actionText: { color: colors.accent, fontSize: 13, lineHeight: 20, fontWeight: "600" },
});
