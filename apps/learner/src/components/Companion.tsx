import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Step } from "../domain/types";
import { Chip } from "../connected/ui/Chip";
import { LongAnswerComposer } from "../connected/ui/LongAnswerComposer";
import { useI18n } from "../i18n";
import { colors } from "../theme/colors";

export interface CompanionProps {
  step?: Step;
  lessonTitle?: string;
  note: string;
  onNoteChange: (value: string) => void;
  mode: "demo" | "connected";
}

/** The longest note kept. */
const NOTE_MAX = 4000;

/**
 * The demo's companion (final design §4.19). React Native: the same parts as the web panel
 * (`Companion.web.tsx`) drawn with the app's tokens: the title, the line that says no AI is
 * connected, the course's authored guidance as plain companion text under its label, "Show a
 * hint" as a chip and the notes field. No avatar tile or bubble: the companion's words are text.
 */
export function Companion({ step, lessonTitle, note, onNoteChange, mode }: CompanionProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const [hint, setHint] = useState(false);
  // Meta lines carry meaning: 14 px at least in Hebrew (final design §1.2).
  const meta = i18n.locale === "he" ? [styles.meta, styles.metaHe] : styles.meta;
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>
        {t("companion.title")}
      </Text>
      <Text style={meta}>{t(mode === "demo" ? "companion.intro.demo" : "companion.intro.course")}</Text>
      {lessonTitle && step && <Text style={meta}>{t("companion.placeLesson", { lesson: lessonTitle, step: step.title })}</Text>}
      <View style={styles.turn}>
        <Text style={meta}>{t("companionTurnFrame.label")}</Text>
        <Text style={styles.prose}>{step?.companion.idea ?? t("companion.idea")}</Text>
        {step && (
          <View style={styles.chips}>
            <Chip label={t(hint ? "companion.hint.hide" : "companion.hint.show")} onPress={() => setHint((value) => !value)} />
          </View>
        )}
        {step && hint && (
          <Text accessibilityLiveRegion="polite" style={styles.prose}>
            {step.companion.hint}
          </Text>
        )}
      </View>
      <LongAnswerComposer
        label={t("companion.notes.label")}
        value={note}
        onChange={(value) => onNoteChange(value.slice(0, NOTE_MAX))}
        onSubmit={() => onNoteChange(note)}
        submitLabel={t("companion.notes.save")}
        placeholder={t("companion.notes.placeholder")}
      />
      <Text style={meta}>{t("companion.notes.saved")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 16 },
  title: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "600" },
  meta: { color: colors.inkMuted, fontSize: 13, lineHeight: 20 },
  metaHe: { fontSize: 14, lineHeight: 22 },
  turn: { gap: 8 },
  prose: { color: colors.ink, fontSize: 16, lineHeight: 26 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
