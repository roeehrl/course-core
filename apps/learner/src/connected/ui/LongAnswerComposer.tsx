import React from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { LivePressable } from "../../components/LivePressable";
import { colors } from "../../theme/colors";

export interface LongAnswerComposerProps {
  /** The visible label above the field. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  placeholder?: string;
  disabled?: boolean;
  /** The submit button is shown busy and does nothing. */
  busy?: boolean;
  id?: string;
  className?: string;
  describedBy?: string;
}

/**
 * A field for a long answer (quick checks, reviewer replies, the gate review, demo notes): Enter
 * makes a new line and the button submits. React Native: a multiline field and a button.
 */
export function LongAnswerComposer({ label, value, onChange, onSubmit, submitLabel, placeholder, disabled, busy }: LongAnswerComposerProps) {
  const off = disabled || busy || !value.trim();
  return (
    <View style={styles.box}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        multiline
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        editable={!disabled}
        style={styles.field}
      />
      <LivePressable accessibilityRole="button" aria-disabled={off || undefined} disabled={off} onPress={onSubmit} style={styles.submit}>
        <Text style={styles.submitText}>{submitLabel}</Text>
      </LivePressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  field: { minHeight: 112, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 16, padding: 12, color: colors.ink, fontSize: 16, lineHeight: 26, backgroundColor: colors.surface },
  submit: { alignSelf: "flex-end", minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  submitText: { color: colors.accent, fontSize: 14, lineHeight: 20, fontWeight: "600" },
});
