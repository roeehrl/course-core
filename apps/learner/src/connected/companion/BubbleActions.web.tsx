import React, { useState } from "react";
import { Text, View } from "react-native";
import type { CompanionMessage } from "../../client/companionClient";
import { Button, styles } from "../../components/ui";
import { useT } from "../../i18n";

export interface BubbleActionsProps {
  /** One of the learner's messages. */
  message: CompanionMessage;
  /** This is the learner's newest message. */
  latest: boolean;
  /** A change to this message is being saved. */
  inProgress: boolean;
  /** Deletes the question and its answer; rejects when it could not (the caller says why). */
  onDelete?: (messageId: string) => Promise<void>;
  /** Puts the question back in the message box to change and send again. */
  onEditResend?: (message: CompanionMessage) => void;
  /** Stop (or resume) using the message as context. */
  onExclude?: (messageId: string, excluded: boolean) => void;
}

/** Beside a learner's message: whether it is still used as context, and deleting it. */
export function BubbleActions({ message, inProgress, onDelete }: BubbleActionsProps) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  if (message.role !== "learner") return null;
  return (
    <>
      {message.excluded && <Text style={styles.small}>{t("bubbleActions.excluded")}</Text>}
      {message.content !== "[deleted]" &&
        onDelete &&
        (confirm ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.small}>{t("bubbleActions.delete.confirm")}</Text>
            <Button label={t("bubbleActions.delete.no")} kind="quiet" onPress={() => setConfirm(false)} />
            <Button
              label={t("bubbleActions.delete.yes")}
              kind="primary"
              disabled={inProgress}
              onPress={() =>
                void onDelete(message.id).then(
                  () => setConfirm(false),
                  () => undefined,
                )
              }
            />
          </View>
        ) : (
          <Button label={t("bubbleActions.delete.start")} kind="quiet" onPress={() => setConfirm(true)} />
        ))}
    </>
  );
}
