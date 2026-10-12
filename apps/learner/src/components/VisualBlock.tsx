import React from "react";
import type { VisualExperience } from "@course-core/sdk";
import { Text, View } from "react-native";
import { styles } from "./ui";
export interface VisualBlockProps {
  experience?: VisualExperience;
}
export function VisualBlock({ experience }: VisualBlockProps) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.heading}>Illustration · text equivalent</Text>
      <Text style={styles.body}>
        {experience?.accessibility.description ||
          "This illustration is unavailable. Ask your course team for its explanation."}
      </Text>
      <Text style={styles.small}>
        The interactive renderer is available in the web learner. Native
        rendering is not yet connected.
      </Text>
    </View>
  );
}
