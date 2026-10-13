import React from "react";
import { Text, View } from "react-native";
import type { CourseApi } from "../client/apiClient";
import { styles } from "./ui";

export interface YourDataPanelProps {
  api: Pick<CourseApi, "request">;
  enrollmentId: string;
  courseTitle: string;
  onErased: () => void;
}
/** Native builds route export/erasure through the web account page until a
 * native file-save adapter exists; the server contract is identical. */
export function YourDataPanel(_props: YourDataPanelProps) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.heading}>Your data</Text>
      <Text style={styles.small}>Export and erasure are available from the web version of your account.</Text>
    </View>
  );
}
