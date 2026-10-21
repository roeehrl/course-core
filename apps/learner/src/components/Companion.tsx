import React, { useState } from "react";
import { Text, View } from "react-native";
import type { Step } from "../domain/types";
import { Badge, Button, colors, Field, styles } from "./ui";
import { useT } from "../i18n";

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
  const t = useT();
  const [hint, setHint] = useState(false);
  return (
    <View style={{ gap: 20 }}>
      <View style={styles.row}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 15,
            borderBottomStartRadius: 5,
            backgroundColor: colors.lilac,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: colors.purple, fontSize: 24 }}>✧</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={styles.heading}>
            {t("companion.title")}
          </Text>
          <Text style={styles.small}>{t("companion.subtitle")}</Text>
        </View>
      </View>
      <Badge
        label={t(mode === "demo" ? "companion.badge.demo" : "companion.badge.course")}
        tone="lilac"
      />
      <View
        style={{
          padding: 18,
          gap: 10,
          backgroundColor: colors.lilac,
          borderRadius: 16,
          borderTopStartRadius: 4,
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 24 }}>
          {step?.companion.idea ??
            t("companion.idea")}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={styles.eyebrow}>{t("companion.place")}</Text>
        <Text style={styles.small}>
          {lessonTitle
            ? t("companion.placeLesson", { lesson: lessonTitle, step: step?.title ?? "" })
            : t("companion.roadmap")}
        </Text>
      </View>
      {step && (
        <>
          <Button
            label={t(hint ? "companion.hint.hide" : "companion.hint.show")}
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
        label={t("companion.notes.label")}
        multiline
        value={note}
        onChangeText={onNoteChange}
        placeholder={t("companion.notes.placeholder")}
        maxLength={4000}
      />
      <Text style={styles.small}>
        {t(mode === "demo" ? "companion.notes.savedDemo" : "companion.notes.savedConnected")}
      </Text>
    </View>
  );
}
