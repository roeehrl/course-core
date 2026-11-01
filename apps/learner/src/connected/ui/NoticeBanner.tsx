import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { LivePressable } from "../../components/LivePressable";
import type { IconName } from "../../components/icons/icons";
import { colors } from "../../theme/colors";

export interface NoticeBannerProps {
  text: string;
  icon?: IconName;
  action?: { label: string; onPress: () => void };
  /** An ⓘ button (named `label`) that shows one more line. */
  info?: { label: string; text: string };
  className?: string;
}

/** A limitation or detour notice on `--surface-2`. React Native: text, the action and the extra line. */
export function NoticeBanner({ text, action, info }: NoticeBannerProps) {
  const [more, setMore] = useState(false);
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>{text}</Text>
      {info && (
        <LivePressable accessibilityRole="button" accessibilityLabel={info.label} aria-pressed={more} onPress={() => setMore((v) => !v)} style={styles.action}>
          <Text style={styles.actionText}>ⓘ</Text>
        </LivePressable>
      )}
      {more && info && <Text style={styles.text}>{info.text}</Text>}
      {action && (
        <LivePressable accessibilityRole="button" onPress={action.onPress} style={styles.action}>
          <Text style={styles.actionText}>{action.label}</Text>
        </LivePressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.surface2, borderRadius: 12, padding: 12, gap: 4 },
  text: { color: colors.ink, fontSize: 13, lineHeight: 20 },
  action: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  actionText: { color: colors.accent, fontSize: 14, lineHeight: 20, fontWeight: "600" },
});
