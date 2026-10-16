import React from "react";
import { Text, View } from "react-native";
import type { CourseApi } from "../client/apiClient";
import { styles } from "./ui";

export interface ConnectedAgentsPanelProps {
  api: Pick<CourseApi, "request">;
  enrollmentId: string;
  courseTitle: string;
}
/** Native builds manage agent grants from the web version of the profile until a
 * native secure-copy flow exists; the server contract is identical. */
export function ConnectedAgentsPanel(_props: ConnectedAgentsPanelProps) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.heading}>Connected agents</Text>
      <Text style={styles.small}>Connect or disconnect your own AI agents from the web version of your profile.</Text>
    </View>
  );
}
