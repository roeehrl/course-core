import React, { type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { Direction } from "@course-core/i18n";

/**
 * Native: the locale's direction applies to this subtree through Yoga's `direction`
 * style, so switching language needs no I18nManager.forceRTL and no app restart.
 * Use start/end style properties (marginStart, paddingEnd, start/end) so layouts
 * mirror; `left`/`right` do not.
 */
export function LocaleRoot({ dir, children }: { lang: string; dir: Direction; children: ReactNode }) {
  return <View style={[styles.root, { direction: dir }]}>{children}</View>;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
