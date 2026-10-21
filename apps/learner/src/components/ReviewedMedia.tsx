import React from "react";
import type { MediaResource } from "@course-core/sdk";
import { Text, View } from "react-native";
import { MarkdownContent } from "./MarkdownContent";
import { useT } from "../i18n";
import { styles } from "./ui";
export interface ReviewedMediaProps {
  media?: MediaResource;
  accessClosed?: boolean;
  now?: number;
  required?: boolean;
  /** False when the learner's research-study version has no companion: no control points at it. */
  companionAvailable?: boolean;
}
export function ReviewedMedia({ media }: ReviewedMediaProps) {
  const t = useT();
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.heading}>{t("reviewedMedia.native.heading")}</Text>
      <MarkdownContent
        markdown={
          media?.alternativeMarkdown || t("reviewedMedia.noAlternative")
        }
      />
      <Text style={styles.small}>{t("reviewedMedia.native.noPlayback")}</Text>
    </View>
  );
}
