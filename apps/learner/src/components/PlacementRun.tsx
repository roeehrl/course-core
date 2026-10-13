import React from "react";
import { Text, View } from "react-native";
import type { CourseApi } from "../client/apiClient";
import { styles } from "./ui";

export interface PlacementRunProps {
  api: Pick<CourseApi, "request">;
  command: <T>(action: string, data: Record<string, unknown>) => Promise<T>;
  enrollmentId: string;
  firstEpisodeId: string;
  onFinished: () => void;
}
/** Native placement uses the same server contract; until the native item UI is
 * qualified, learners are told placement is available on the web app. */
export function PlacementRun(_props: PlacementRunProps) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.heading}>Optional placement</Text>
      <Text style={styles.small}>Find your starting point from the web version of this course.</Text>
    </View>
  );
}
