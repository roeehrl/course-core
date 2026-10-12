import React, { useState } from "react";
import { Text, View } from "react-native";
import type { Step } from "../domain/types";
import { Badge, Button, colors, Field, styles } from "./ui";

export function Companion({
  step,
  lessonTitle,
  note,
  onNoteChange,
  mode,
}: {
  step?: Step;
  lessonTitle?: string;
  note: string;
  onNoteChange: (value: string) => void;
  mode: "demo" | "connected";
}) {
  const [hint, setHint] = useState(false);
  return (
    <View style={{ gap: 20 }}>
      <View style={styles.row}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 15,
            borderBottomLeftRadius: 5,
            backgroundColor: colors.lilac,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: colors.purple, fontSize: 24 }}>✧</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={styles.heading}>
            Your companion
          </Text>
          <Text style={styles.small}>A little help, right here.</Text>
        </View>
      </View>
      <Badge
        label={mode === "demo" ? "Demo · authored guidance" : "Course guidance"}
        tone="lilac"
      />
      <View
        style={{
          padding: 18,
          gap: 10,
          backgroundColor: colors.lilac,
          borderRadius: 16,
          borderTopLeftRadius: 4,
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 24 }}>
          {step?.companion.idea ??
            "One clear path, at your pace. Open a lesson when you’re ready. Optional side paths are always your choice."}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={styles.eyebrow}>Following your place</Text>
        <Text style={styles.small}>
          {lessonTitle
            ? `${lessonTitle} / ${step?.title}`
            : "Your course roadmap"}
        </Text>
      </View>
      {step && (
        <>
          <Button
            label={hint ? "Hide hint" : "Show a hint ↗"}
            onPress={() => setHint((value) => !value)}
            kind="secondary"
          />
          {hint && (
            <Text accessibilityLiveRegion="polite" style={styles.body}>
              {step.companion.hint}
            </Text>
          )}
        </>
      )}
      <View style={styles.divider} />
      <Field
        label="Notes to yourself"
        multiline
        value={note}
        onChangeText={onNoteChange}
        placeholder="A question, an idea, something to revisit…"
        maxLength={4000}
      />
      <Text style={styles.small}>
        Saved on this device.{" "}
        {mode === "demo"
          ? "This companion uses written guidance. No live AI is connected."
          : "These notes are not sent to a companion service."}
      </Text>
    </View>
  );
}
