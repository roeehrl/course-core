import React, { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { EpisodeResource, GeneratedMedia, ResourcesClient } from "../client/resourcesClient";
import { useT } from "../i18n";
import { styles } from "./ui";
import { colors } from "../theme/colors";
import { Tag } from "../connected/ui/Tag";

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
      <Text style={styles.heading}>{t("episodeResources.summary")}</Text>
      <Text style={styles.small}>{t("episodeResources.count", { total: items.length + clips.length })}</Text>
      <Text style={styles.small}>{t("episodeResources.intro")}</Text>
      {clips.map((clip) => (
        <View key={clip.id} style={local.row}>
          <Text style={local.title}>{clip.title}</Text>
          <Text style={styles.small}>{t("episodeResources.generated")}</Text>
          <Text style={styles.small}>{t("episodeResources.native.noPlayback")}</Text>
          <Text style={styles.small}>{clip.transcript}</Text>
        </View>
      ))}
      {items.map((item) => (
        <View key={item.id} style={local.row}>
          <Text style={local.title}>{item.title}</Text>
          {item.suggestedFor.length > 0 && <Tag label={t("episodeResources.suggested")} />}
          <Text style={styles.small}>{t("episodeResources.whyHelp", { why: item.whyUseful })}</Text>
          {item.youtube && <Text style={styles.small}>{item.youtube.fallbackText}</Text>}
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(item.url)} style={local.link}>
            <Text style={[styles.small, { color: colors.accent, fontWeight: "600" }]}>{t("episodeResources.native.openSource")}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const local = StyleSheet.create({
  row: { gap: 6, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line, minHeight: 44 },
  title: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  link: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
});
