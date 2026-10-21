import React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useT } from "../i18n";
import { Button, colors } from "./ui";
export interface OverlayProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}
export function Overlay({ title, onClose, children }: OverlayProps) {
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
            <ScrollView keyboardShouldPersistTaps="handled">
              <Button label={t("overlay.close", { title })} onPress={onClose} kind="quiet" />
              {children}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
