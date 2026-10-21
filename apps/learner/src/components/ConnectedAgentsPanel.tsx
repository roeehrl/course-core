import React from "react";
import { Text, View } from "react-native";
import type { CourseApi } from "../client/apiClient";
import { styles } from "./ui";
import { useT } from "../i18n";

export interface ConnectedAgentsPanelProps {
  api: Pick<CourseApi, "request">;
  enrollmentId: string;
  courseTitle: string;
}
/** Native builds manage agent grants from the web version of the profile until a
 * native secure-copy flow exists; the server contract is identical. */
export function ConnectedAgentsPanel(_props: ConnectedAgentsPanelProps) {
  const t = useT();
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.heading}>{t("connectedAgentsPanel.title")}</Text>
      <Text style={styles.small}>{t("connectedAgentsPanel.native.body")}</Text>
    </View>
  );
}
