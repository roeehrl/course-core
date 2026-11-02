import React from "react";
import { StyleSheet, Text } from "react-native";
import { LivePressable } from "../../components/LivePressable";
import type { IconName } from "../../components/icons/icons";
import { colors } from "../../theme/colors";

export interface PillButtonProps {
  label: string;
  onPress: () => void;
  /** `outline` (1 px `--line-strong`) or `accent` (filled). */
  variant?: "outline" | "accent";
  /** Height in px; 44 under a coarse pointer whatever the size. */
  size?: 32 | 36 | 40;
  startIcon?: IconName;
  endIcon?: IconName;
  disabled?: boolean;
  className?: string;
  describedBy?: string;
}

/** A rounded text button (Ask again, Try question 1, Get a fresh check). React Native: no icons. */
export function PillButton({ label, onPress, variant = "outline", size = 36, disabled }: PillButtonProps) {
  return (
    <LivePressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onPress={onPress}
      style={[styles.pill, { minHeight: Math.max(size, 44) }, variant === "accent" ? styles.accent : styles.outline]}
    >
      <Text style={[styles.label, variant === "accent" && styles.onAccent]}>{label}</Text>
    </LivePressable>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  outline: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  accent: { backgroundColor: colors.accent },
  label: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  onAccent: { color: colors.onAccent },
});
