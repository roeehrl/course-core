import React from "react";
import type { MediaResource } from "@course-core/sdk";
import { Text, View } from "react-native";
import { MarkdownContent } from "./MarkdownContent";
import { styles } from "./ui";
export interface ReviewedMediaProps {
  media?: MediaResource;
  accessClosed?: boolean;
  now?: number;
  required?: boolean;
}
export function ReviewedMedia({ media }: ReviewedMediaProps) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.heading}>Media · text alternative</Text>
      <MarkdownContent
        markdown={
          media?.alternativeMarkdown ||
          "A text alternative is not available. Contact your course team."
        }
      />
      <Text style={styles.small}>Native media playback is not connected.</Text>
    </View>
  );
}
