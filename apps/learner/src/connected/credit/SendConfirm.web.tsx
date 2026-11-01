import React from "react";
import { Text, View } from "react-native";
import type { ServerSnapshot } from "../../client/apiClient";
import { Button, styles } from "../../components/ui";
import { useT } from "../../i18n";

export interface SendConfirmProps {
  server?: ServerSnapshot;
  episodeId?: string;
  now: number;
  /** A request is in flight: no choice can be made. */
  pending: boolean;
  /** Sending is not possible now (an empty message, or the companion is unavailable). */
  sendDisabled?: boolean;
  onSendAsPractice: () => void;
  onKeep: () => void;
  /** Keep the message to send after the question. Not offered yet. */
  onSaveForLater?: () => void;
}

/** Asked before a message that would turn an open check into practice. */
export function SendConfirm({ pending, sendDisabled, onSendAsPractice, onKeep }: SendConfirmProps) {
  const t = useT();
  return (
    <View style={[styles.card, { padding: 16, backgroundColor: "#FCF3DF" }]}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t("sendConfirm.title")}
      </Text>
      <Text style={styles.body}>{t("sendConfirm.body")}</Text>
      <Button label={t("sendConfirm.keep")} disabled={pending} onPress={onKeep} />
      <Button label={t("sendConfirm.switch")} kind="primary" disabled={pending || sendDisabled} onPress={onSendAsPractice} />
    </View>
  );
}
