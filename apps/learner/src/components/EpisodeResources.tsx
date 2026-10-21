import React, { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { EpisodeResource, GeneratedMedia, ResourcesClient } from "../client/resourcesClient";
import { useT } from "../i18n";
import { styles } from "./ui";

export interface EpisodeResourcesProps {
  client?: ResourcesClient;
  enrollmentId: string;
  episodeId: string;
}
/** Native rendering keeps the same optional, non-credit semantics. Embedded
 * players are not used natively; links open in the system browser. */
export function EpisodeResources({ client, enrollmentId, episodeId }: EpisodeResourcesProps) {
  const t = useT();
  const [items, setItems] = useState<EpisodeResource[]>([]);
  const [clips, setClips] = useState<GeneratedMedia[]>([]);
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    client
      .episode(enrollmentId, episodeId, controller.signal)
      .then((value) => !controller.signal.aborted && setItems(value))
      .catch(() => !controller.signal.aborted && setItems([]));
    client
      .media(enrollmentId, episodeId, controller.signal)
      .then((value) => !controller.signal.aborted && setClips(value))
      .catch(() => !controller.signal.aborted && setClips([]));
    return () => controller.abort();
  }, [client, enrollmentId, episodeId]);
  if (!items.length && !clips.length) return null;
  return (
    <View style={{ gap: 12 }} accessibilityRole="summary">
      <Text style={styles.heading}>{t("episodeResources.native.heading")}</Text>
      <Text style={styles.small}>{t("episodeResources.native.optional")}</Text>
      {clips.map((clip) => (
        <View key={clip.id} style={{ gap: 6 }}>
          <Text style={styles.body}>{t("episodeResources.native.clipTitle", { title: clip.title })}</Text>
          <Text style={styles.small}>{t("episodeResources.native.noPlayback")}</Text>
          <Text style={styles.small}>{clip.transcript}</Text>
        </View>
      ))}
      {items.map((item) => (
        <View key={item.id} style={{ gap: 6 }}>
          <Text style={styles.body}>{item.title}</Text>
          <Text style={styles.small}>{item.whyUseful}</Text>
          {item.youtube && <Text style={styles.small}>{item.youtube.fallbackText}</Text>}
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(item.url)}>
            <Text style={styles.small}>{t("episodeResources.native.openSource")}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
