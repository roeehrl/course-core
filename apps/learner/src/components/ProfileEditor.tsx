import React, { useState } from "react";
import { Text, View } from "react-native";
import { validateProfile } from "../domain/profile";
import type { Profile } from "../domain/types";
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
        label={demo ? "Demo profile · this device" : "Your profile"}
        tone="lilac"
      />
      <Text accessibilityRole="header" style={styles.title}>
        {identityOnly ? 'How should we address you?' : 'Make room for learning.'}
      </Text>
      <Text style={styles.body}>
        {identityOnly ? 'Your learning preferences and memory are editable below.' : 'A name to go by, a reason to begin, and a pace that feels right.'}
      </Text>
      <Field
        label="Display name"
        value={draft.displayName}
        onChangeText={(displayName) => change({ displayName })}
        maxLength={60}
        editable={!pending}
        autoComplete="nickname"
      />
      {!identityOnly && <>
      <Field
        label="My learning goal (optional)"
        value={draft.goal}
        onChangeText={(goal) => change({ goal })}
        multiline
        maxLength={280}
        placeholder="What would you like to feel more confident doing?"
        editable={!pending}
      />
      <Text style={styles.small}>Preferred pace</Text>
      <ChoiceList
        label="Preferred pace"
        options={[
          { id: "gentle", label: "Gentle · one small step" },
          { id: "steady", label: "Steady · a little every day" },
          { id: "focused", label: "Focused · make some room" },
        ]}
        value={draft.pace}
        disabled={pending}
        onChange={(pace) => change({ pace: pace as Profile["pace"] })}
      />
      </>}
      {!demo && (
        <Text style={styles.small}>
          {identityOnly
            ? "Course staff who can see your enrollment see your display name."
            : "Course staff who can see your enrollment see your display name, learning goal and pace."}
        </Text>
      )}
      {(validation || error) && <Notice error>{validation ?? error}</Notice>}
      {saved && !edited && (
        <Notice>Profile saved{demo ? " on this device" : ""}.</Notice>
      )}
      <Button
        label={pending ? "Saving…" : "Save profile"}
        kind="primary"
        disabled={pending}
        onPress={() => {
          const candidate = identityOnly ? { ...profile, displayName: draft.displayName } : draft;
          const message = validateProfile(identityOnly ? { ...candidate, goal: '' } : candidate);
          if (message) {
            setValidation(message);
            return;
          }
          setEdited(false);
          onSave(candidate);
        }}
      />
      <Text style={styles.small}>
        Your pace is a preference. It does not change course requirements.
      </Text>
    </View>
  );
}
