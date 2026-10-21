import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MEMORY_ACCESSIBILITY, MEMORY_DEPTH, MEMORY_EXPERIENCE, type MemoryProfile } from "../client/memoryClient";
import { ChoiceList, Field, Notice, styles } from "./ui";
import { useT, type MessageKey } from "../i18n";

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
/** Parses "en, he" into language tags; null when any entry is not a tag or there are too many. */
export function parseLanguages(text: string): string[] | null {
  const tags = text.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > 5 || tags.some((tag) => !LANGUAGE.test(tag)) || new Set(tags).size !== tags.length) return null;
  return tags;
}
/** Parses a weekly time budget in minutes; null when outside 15 to 1200. */
export function parseMinutes(text: string): number | null | undefined {
  if (!text.trim()) return undefined;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value >= 15 && value <= 1200 ? value : null;
}
/**
 * The declared facts and preferences of design §5 beyond pace, style and goal (requirement C01):
 * languages, experience, depth, a weekly time budget and accessibility needs. What the learner
 * states here is a preference or a need, never a diagnosis, and it overrides anything inferred.
 */
export function DeclaredProfileFields({ draft, disabled, onChange, onValidity }: {
  draft: MemoryProfile;
  disabled: boolean;
  onChange: (next: MemoryProfile) => void;
  onValidity: (valid: boolean) => void;
}) {
  const t = useT();
  const prefs = draft.preferences;
  const [languages, setLanguages] = useState((prefs.languages ?? []).join(", "));
  const [minutes, setMinutes] = useState(prefs.weeklyMinutes === undefined ? "" : String(prefs.weeklyMinutes));
  const languagesValid = parseLanguages(languages) !== null, minutesValid = parseMinutes(minutes) !== null;
  const set = (patch: Partial<MemoryProfile["preferences"]>) => {
    const preferences = { ...prefs, ...patch };
    for (const key of Object.keys(patch) as (keyof typeof preferences)[]) if (preferences[key] === undefined) delete preferences[key];
    onChange({ ...draft, preferences });
  };
  const choice = (key: "experience" | "depth", ids: readonly string[]) => (
    <ChoiceList
      label={t(`profileDetails.${key}.label` as MessageKey)}
      options={[{ id: "", label: t("profileDetails.none") }, ...ids.map((id) => ({ id, label: t(`profileDetails.${key}.${id}` as MessageKey) }))]}
      value={prefs[key] ?? ""}
      disabled={disabled}
      onChange={(value) => set({ [key]: value || undefined } as Partial<MemoryProfile["preferences"]>)}
    />
  );
  const needs = prefs.accessibility ?? [];
  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={styles.heading}>{t("profileDetails.heading")}</Text>
      <Text style={styles.small}>{t("profileDetails.note")}</Text>
      <Field
        label={t("profileDetails.languages.label")}
        value={languages}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={(text) => {
          setLanguages(text);
          const parsed = parseLanguages(text);
          onValidity(parsed !== null && parseMinutes(minutes) !== null);
          if (parsed) set({ languages: parsed.length ? parsed : undefined });
        }}
      />
      <Text style={styles.small}>{t("profileDetails.languages.hint")}</Text>
      {!languagesValid && <Notice error>{t("profileDetails.languages.invalid")}</Notice>}
      {choice("experience", MEMORY_EXPERIENCE)}
      {choice("depth", MEMORY_DEPTH)}
      <Field
        label={t("profileDetails.minutes.label")}
        value={minutes}
        editable={!disabled}
        keyboardType="number-pad"
        inputMode="numeric"
        onChangeText={(text) => {
          setMinutes(text);
          const parsed = parseMinutes(text);
          onValidity(parsed !== null && parseLanguages(languages) !== null);
          if (parsed !== null) set({ weeklyMinutes: parsed });
        }}
      />
      {!minutesValid && <Notice error>{t("profileDetails.minutes.invalid")}</Notice>}
      <Text style={styles.small}>{t("profileDetails.accessibility.label")}</Text>
      <View style={{ gap: 8 }}>
        {MEMORY_ACCESSIBILITY.map((need) => {
          const checked = needs.includes(need);
          return (
            <Pressable
              key={need}
              accessibilityRole="checkbox"
              accessibilityLabel={t(`profileDetails.accessibility.${need}` as MessageKey)}
              accessibilityState={{ checked, disabled }}
              aria-checked={checked}
              disabled={disabled}
              onPress={() => {
                const next = checked ? needs.filter((n) => n !== need) : [...needs, need];
                set({ accessibility: next.length ? next : undefined });
              }}
              style={{ flexDirection: "row", gap: 8, alignItems: "center", minHeight: 44 }}
            >
              <Text aria-hidden style={styles.body}>{checked ? "☑" : "☐"}</Text>
              <Text style={styles.body}>{t(`profileDetails.accessibility.${need}` as MessageKey)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
