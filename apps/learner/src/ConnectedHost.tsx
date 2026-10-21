import React from "react";
import { Text, View } from "react-native";
import { styles } from "./components/ui";
import { useT } from "./i18n";
import type { ContextualCompanionClient } from "./client/companionClient";
export interface ConnectedHostProps {
  companionClient?: ContextualCompanionClient;
}
/** Native host/auth transport is reserved for a later app build. */
export function ConnectedHost(_props: ConnectedHostProps = {}) {
  const t = useT();
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{t("connectedHost.native.title")}</Text>
      <Text style={styles.body}>{t("connectedHost.native.body")}</Text>
    </View>
  );
}
