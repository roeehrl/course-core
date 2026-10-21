import React, { useState } from "react";
import { Text, View } from "react-native";
import { validateProfile } from "../domain/profile";
import type { Profile } from "../domain/types";
import { useT } from "../i18n";
import { Badge, Button, ChoiceList, Field, Notice, styles } from "./ui";

export function ProfileEditor({
  profile,
  onSave,
  pending,
  error,
  saved,
  demo,
  identityOnly = false,
}: {
  profile: Profile;
  onSave: (profile: Profile) => void;
  pending: boolean;
  error?: string;
  saved: boolean;
  demo: boolean;
  identityOnly?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = useState(profile);
  const [validation, setValidation] = useState<string>();
  const [edited, setEdited] = useState(false);
  function change(patch: Partial<Profile>) {
    setDraft((current) => ({ ...current, ...patch }));
    setEdited(true);
    setValidation(undefined);
  }
  return (
    <View style={{ gap: 22, paddingTop: 24 }}>
      <Badge
        label={demo ? t("profileEditor.badge.demo") : t("profileEditor.badge.yours")}
        tone="lilac"
      />
      <Text accessibilityRole="header" style={styles.title}>
        {identityOnly ? t("profileEditor.title.identity") : t("profileEditor.title.full")}
      </Text>
      <Text style={styles.body}>
        {identityOnly ? t("profileEditor.intro.identity") : t("profileEditor.intro.full")}
      </Text>
      <Field
        label={t("profileEditor.displayName")}
        value={draft.displayName}
        onChangeText={(displayName) => change({ displayName })}
        maxLength={60}
        editable={!pending}
        autoComplete="nickname"
      />
      {!identityOnly && <>
      <Field
        label={t("profileEditor.goal")}
        value={draft.goal}
        onChangeText={(goal) => change({ goal })}
        multiline
        maxLength={280}
        placeholder={t("profileEditor.goalPlaceholder")}
        editable={!pending}
      />
      <Text style={styles.small}>{t("profileEditor.pace.label")}</Text>
      <ChoiceList
        label={t("profileEditor.pace.label")}
        options={[
          { id: "gentle", label: t("profileEditor.pace.gentle") },
          { id: "steady", label: t("profileEditor.pace.steady") },
          { id: "focused", label: t("profileEditor.pace.focused") },
        ]}
        value={draft.pace}
        disabled={pending}
        onChange={(pace) => change({ pace: pace as Profile["pace"] })}
      />
      </>}
      {!demo && (
        <Text style={styles.small}>
          {identityOnly
            ? t("profileEditor.visibility.identity")
            : t("profileEditor.visibility.full")}
        </Text>
      )}
      {(validation || error) && <Notice error>{validation ?? error}</Notice>}
      {saved && !edited && (
        <Notice>{demo ? t("profileEditor.savedOnDevice") : t("profileEditor.saved")}</Notice>
      )}
      <Button
        label={pending ? t("profileEditor.saving") : t("profileEditor.save")}
        kind="primary"
        disabled={pending}
        onPress={() => {
          const candidate = identityOnly ? { ...profile, displayName: draft.displayName } : draft;
          const message = validateProfile(identityOnly ? { ...candidate, goal: '' } : candidate, t);
          if (message) {
            setValidation(message);
            return;
          }
          setEdited(false);
          onSave(candidate);
        }}
      />
      <Text style={styles.small}>
        {t("profileEditor.paceNote")}
      </Text>
    </View>
  );
}
