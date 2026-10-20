import React from "react";
import { Text, TextInput, View } from "react-native";
import {
  CODE_PROTOCOL,
  MAX_CODE_BYTES,
  codeSubmissionError,
  utf8Bytes,
} from "../connected/code";
import { styles, colors } from "./ui";
export interface CodeEditorProps {
  language: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Web only: offer browser practice runs (never graded) when the server provides them. */
  practice?: boolean;
}
/** Portable text-entry fallback; native connected execution remains unqualified. */
export function CodeEditor({
  language,
  value,
  onChange,
  disabled,
}: CodeEditorProps) {
  const error = codeSubmissionError(language, value);
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.heading}>Your code</Text>
      <Text style={styles.small}>{CODE_PROTOCOL}</Text>
      <TextInput
        accessibilityLabel="Your code"
        multiline
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        maxLength={MAX_CODE_BYTES}
        textAlignVertical="top"
        style={{
          minHeight: 280,
          padding: 16,
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: 12,
          fontFamily: "monospace",
          fontSize: 16,
          lineHeight: 24,
          color: colors.ink,
          backgroundColor: colors.white,
        }}
      />
      <Text style={styles.small}>
        {utf8Bytes(value)} / {MAX_CODE_BYTES} UTF-8 bytes
      </Text>
      {error && <Text style={styles.small}>{error}</Text>}
    </View>
  );
}
