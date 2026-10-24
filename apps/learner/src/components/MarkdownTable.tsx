import React from "react";
import { ScrollView, Text, View } from "react-native";
import { useT } from "../i18n";
import { colors } from "./ui";
import type { Align, Inline } from "./markdown";

const textAlign = (align: Align) => (align === "center" ? "center" : align === "end" ? "right" : "auto");

/** A Markdown table on native: equal columns in a frame that scrolls sideways on a narrow screen
 * (the web app uses a real table, MarkdownTable.web.tsx). */
export function MarkdownTable({
  align,
  header,
  rows,
  renderInline,
}: {
  align: Align[];
  header: Inline[][];
  rows: Inline[][][];
  renderInline: (nodes: Inline[], key: string) => React.ReactNode;
}) {
  const t = useT();
  const width = Math.max(header.length * 120, 280);
  const row = (cells: Inline[][], key: string, head: boolean) => (
    <View key={key} role="row" style={{ flexDirection: "row", borderTopWidth: head || key === "r0" ? 0 : 1, borderColor: colors.line, backgroundColor: head ? colors.mint : colors.white }}>
      {cells.map((cell, index) => (
        <Text key={index} role={head ? "columnheader" : "cell"} style={{ flex: 1, padding: 10, color: head ? colors.ink : colors.muted, fontWeight: head ? "600" : "400", textAlign: textAlign(align[index] ?? null) }}>
          {renderInline(cell, `${key}c${index}`)}
        </Text>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal accessibilityLabel={t("markdownContent.tableRegion")} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 12 }}>
      <View role="table" style={{ minWidth: width }}>
        {row(header, "h", true)}
        {rows.map((cells, index) => row(cells, `r${index}`, false))}
      </View>
    </ScrollView>
  );
}
