import React from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "../../theme/colors";

export interface PreparingDotsProps {
  /** Spoken instead of the dots, when the dots stand alone. */
  label?: string;
  className?: string;
}

/** Three 6 px dots for work in progress. React Native: static dots. */
export function PreparingDots({ label }: PreparingDotsProps) {
  return (
    <View accessibilityLabel={label} accessible={!!label} style={styles.row}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.dot} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.inkMuted, opacity: 0.6 },
});
