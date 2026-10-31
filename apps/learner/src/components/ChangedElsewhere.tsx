import React from "react";
import { Text, View } from "react-native";
import { useT } from "../i18n";
import { Button, colors, styles } from "./ui";

/** Shown when the saved version of a form changes while it has unsaved edits: the learner
 * chooses to see the saved version (dropping the edits) or to keep editing and save over it. */
export function ChangedElsewhere({
  onShowSaved,
  onKeep,
  disabled,
}: {
  onShowSaved: () => void;
  onKeep: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <View
      accessibilityLiveRegion="polite"
      aria-live="polite"
      style={{ padding: 16, borderRadius: 12, gap: 10, backgroundColor: colors.sand }}
    >
      <Text style={[styles.small, { color: colors.gold, fontWeight: "600" }]}>
        {t("changedElsewhere.title")}
      </Text>
      <Text style={[styles.small, { color: colors.gold }]}>{t("changedElsewhere.body")}</Text>
      <View style={styles.row}>
        <Button label={t("changedElsewhere.keep")} kind="quiet" onPress={onKeep} disabled={disabled} />
        <Button label={t("changedElsewhere.showSaved")} onPress={onShowSaved} disabled={disabled} />
      </View>
    </View>
  );
}
