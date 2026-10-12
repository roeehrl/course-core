import React from "react";
import { Text, View } from "react-native";
import { styles } from "./components/ui";
import type { ContextualCompanionClient } from "./client/companionClient";
export interface ConnectedHostProps {
  companionClient?: ContextualCompanionClient;
}
/** Native host/auth transport is reserved for a later app build. */
export function ConnectedHost(_props: ConnectedHostProps = {}) {
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Connected learning</Text>
      <Text style={styles.body}>
        Use the web learner while native account transport is being integrated.
      </Text>
    </View>
  );
}
