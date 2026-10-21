import React from "react";
import { Text, View } from "react-native";
import type { CourseApi } from "../client/apiClient";
import { styles } from "./ui";
import { useT } from "../i18n";

export interface YourDataPanelProps {
  api: Pick<CourseApi, "request">;
  enrollmentId: string;
  courseTitle: string;
  onErased: () => void;
}
/** Native builds route export/erasure through the web account page until a
 * native file-save adapter exists; the server contract is identical. */
export function YourDataPanel(_props: YourDataPanelProps) {
  const t = useT();
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.heading}>{t("yourDataPanel.title")}</Text>
      <Text style={styles.small}>{t("yourDataPanel.nativeNote")}</Text>
    </View>
  );
}
