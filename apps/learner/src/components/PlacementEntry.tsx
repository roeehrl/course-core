import React, { useState } from "react";
import { Text, View } from "react-native";
import type { Course, MutationResult } from "../domain/types";
import { Badge, Button, ChoiceList, Notice, styles } from "./ui";

export function PlacementEntry({
  placement,
  pending,
  feedback,
  error,
  onSubmit,
  onClose,
  demo,
}: {
  placement: NonNullable<Course["placement"]>;
  pending: boolean;
  feedback?: MutationResult["feedback"];
  error?: string;
  onSubmit: (answer: string) => void;
  onClose: () => void;
  demo: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const accepted = feedback?.outcome === "accepted";
  return (
    <View style={{ gap: 22, paddingTop: 24 }}>
      <Badge label="Optional placement" tone="lilac" />
      <Text accessibilityRole="header" style={styles.title}>
        {placement.title}
      </Text>
      <Text style={styles.body}>{placement.description}</Text>
      {demo && (
        <Notice>
          This is a local demo check. It grants no real course credit.
        </Notice>
      )}
      <Text accessibilityRole="header" style={styles.heading}>
        {placement.question}
      </Text>
      <ChoiceList
        label={placement.question}
        options={placement.options}
        value={answer}
        onChange={setAnswer}
        disabled={pending || accepted}
      />
      {feedback && (
        <Notice error={feedback.outcome === "retry"}>{feedback.message}</Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      <Button
        label={
          accepted
            ? "Return to my path →"
            : pending
              ? "Checking…"
              : "Check placement"
        }
        kind="primary"
        disabled={pending || (!answer && !accepted)}
        onPress={accepted ? onClose : () => onSubmit(answer)}
      />
      {!accepted && (
        <Button
          label="Skip placement, start learning"
          kind="quiet"
          onPress={onClose}
          disabled={pending}
        />
      )}
    </View>
  );
}
