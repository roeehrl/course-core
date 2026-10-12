import React from "react";
import type { SourceReference } from "@course-core/sdk";
import { Text, View } from "react-native";
import { styles } from "./ui";
export interface SourceLinksProps {
  sources: readonly SourceReference[];
  sourceIds?: readonly string[];
}
/** Native intentionally keeps a readable reference list until link handling is qualified. */
export function SourceLinks({ sources, sourceIds }: SourceLinksProps) {
  const selected = sourceIds
    ? sources.filter((source) => sourceIds.includes(source.id))
    : sources;
  return selected.length ? (
    <View style={{ gap: 8 }}>
      <Text style={styles.eyebrow}>Sources</Text>
      {selected.map((source) => (
        <Text key={source.id} style={styles.small}>
          {source.title}
        </Text>
      ))}
    </View>
  ) : null;
}
