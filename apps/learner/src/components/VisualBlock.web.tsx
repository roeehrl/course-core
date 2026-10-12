import React, { useMemo } from "react";
import { fromVisualExperience } from "@course-core/visuals/headless";
import { VisualPlayer } from "@course-core/visuals/react";
import "@course-core/visuals/styles.css";
import type { VisualBlockProps } from "./VisualBlock";
import { Text, View } from "react-native";
import { styles } from "./ui";
export function VisualBlock({ experience }: VisualBlockProps) {
  // Server refreshes recreate JSON objects. Equal scene data must retain runtime identity.
  const data = useMemo(() => {
    try {
      return experience ? JSON.stringify(experience) : undefined;
    } catch {
      return undefined;
    }
  }, [experience]);
  const scene = useMemo(() => {
    try {
      return data ? fromVisualExperience(JSON.parse(data)) : undefined;
    } catch {
      return undefined;
    }
  }, [data]);
  const description =
    typeof experience?.accessibility?.description === "string" &&
    experience.accessibility.description.trim()
      ? experience.accessibility.description
      : "This illustration is unavailable. Ask your course team for its explanation.";
  const fallback = (
    <View style={{ gap: 12 }}>
      <Text style={styles.heading}>Illustration · text equivalent</Text>
      <Text style={styles.body}>{description}</Text>
      <Text style={styles.small}>
        This renderer is unavailable here. The course explanation remains
        available.
      </Text>
    </View>
  );
  return scene ? <VisualPlayer scene={scene} fallback={fallback} /> : fallback;
}
