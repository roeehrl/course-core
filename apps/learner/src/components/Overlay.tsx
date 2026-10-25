import React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useT } from "../i18n";
import { colors, styles } from "./ui";
export interface OverlayProps {
  title: string;
  /** Shows the title as the sheet's heading (the content then has no heading of its own). */
  titleVisible?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}
export function Overlay({ title, titleVisible = false, onClose, children }: OverlayProps) {
  const t = useT();
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: "#18323766",
          justifyContent: "flex-end",
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ maxHeight: "95%" }}
        >
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: colors.paper,
              borderTopStartRadius: 24,
              borderTopEndRadius: 24,
              padding: 20,
            }}
          >
            {/* The head stays put: the title (when shown) and a close button that shows an icon only. */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 }}>
              {titleVisible && (
                <Text accessibilityRole="header" style={[styles.heading, { flex: 1 }]}>
                  {title}
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("overlay.close", { title })}
                onPress={onClose}
                hitSlop={8}
                style={{
                  marginStart: "auto",
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text aria-hidden style={{ color: colors.ink, fontSize: 24, lineHeight: 26 }}>
                  ×
                </Text>
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
