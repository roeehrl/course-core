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
}: {
  profile: Profile;
  onSave: (profile: Profile) => void;
  pending: boolean;
  error?: string;
  saved: boolean;
  demo: boolean;
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
        Make room for learning.
      </Text>
      <Text style={styles.body}>
        A name to go by, a reason to begin, and a pace that feels right.
      </Text>
      <Field
        label="Display name"
        value={draft.displayName}
        onChangeText={(displayName) => change({ displayName })}
        maxLength={60}
        editable={!pending}
        autoComplete="nickname"
      />
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
      {(validation || error) && <Notice error>{validation ?? error}</Notice>}
      {saved && !edited && (
        <Notice>Profile saved{demo ? " on this device" : ""}.</Notice>
      )}
      <Button
        label={pending ? "Saving…" : "Save profile"}
        kind="primary"
        disabled={pending}
        onPress={() => {
          const message = validateProfile(draft);
          if (message) {
            setValidation(message);
            return;
          }
          setEdited(false);
          onSave(draft);
        }}
      />
      <Text style={styles.small}>
        Your pace is a preference. It does not change course requirements.
      </Text>
    </View>
  );
}
