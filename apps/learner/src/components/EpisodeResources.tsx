import React, { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { EpisodeResource, ResourcesClient } from "../client/resourcesClient";
import { styles } from "./ui";

export interface EpisodeResourcesProps {
  client?: ResourcesClient;
  enrollmentId: string;
  episodeId: string;
}
/** Native rendering keeps the same optional, non-credit semantics. Embedded
 * players are not used natively; links open in the system browser. */
export function EpisodeResources({ client, enrollmentId, episodeId }: EpisodeResourcesProps) {
  const [items, setItems] = useState<EpisodeResource[]>([]);
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    client
      .episode(enrollmentId, episodeId, controller.signal)
      .then((value) => !controller.signal.aborted && setItems(value))
      .catch(() => !controller.signal.aborted && setItems([]));
    return () => controller.abort();
  }, [client, enrollmentId, episodeId]);
  if (!items.length) return null;
  return (
    <View style={{ gap: 12 }} accessibilityRole="summary">
      <Text style={styles.heading}>Optional help · reviewed resources</Text>
      <Text style={styles.small}>Optional. Does not count toward progress or checks.</Text>
      {items.map((item) => (
        <View key={item.id} style={{ gap: 6 }}>
          <Text style={styles.body}>{item.title}</Text>
          <Text style={styles.small}>{item.whyUseful}</Text>
          {item.youtube && <Text style={styles.small}>{item.youtube.fallbackText}</Text>}
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(item.url)}>
            <Text style={styles.small}>Open source</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
