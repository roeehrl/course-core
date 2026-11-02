import React from "react";
import { StyleSheet, Text } from "react-native";
import type { IconName } from "../../components/icons/icons";
import { colors } from "../../theme/colors";

export interface TagProps {
  label: string;
  /** `accent`: "Your turn" (accent-soft fill); `muted`: a status ("Solution viewed"); `outline`: "Personal". */
  variant?: "accent" | "muted" | "outline";
  icon?: IconName;
  className?: string;
}

/** A small pill naming a state. React Native: text in a rounded box (no icon). */
export function Tag({ label, variant = "muted" }: TagProps) {
  return <Text style={[styles.tag, variant === "accent" ? styles.accent : variant === "outline" ? styles.outline : styles.muted]}>{label}</Text>;
}

const styles = StyleSheet.create({
  tag: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontSize: 12, lineHeight: 16, fontWeight: "600", color: colors.ink },
  accent: { backgroundColor: colors.accentSoft },
  muted: { backgroundColor: colors.surface2, color: colors.inkMuted },
  outline: { borderWidth: 1, borderColor: colors.lineStrong },
});
