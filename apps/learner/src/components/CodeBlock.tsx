import React from "react";
import { ScrollView, Text, View } from "react-native";
import { useT } from "../i18n";
import { colors } from "../theme/colors";

export interface CodeBlockProps {
  /** The fence's language, or "" (then it is called an example). */
  language: string;
  code: string;
}

/** A fenced code block in lesson text or a companion reply. React Native: the language and the
 * code in a frame that scrolls sideways (the web app adds a Copy button, CodeBlock.web.tsx). */
export function CodeBlock({ language, code }: CodeBlockProps) {
  const t = useT();
  return (
    <View style={{ backgroundColor: colors.surface2, borderRadius: 12, overflow: "hidden" }}>
      <Text style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 20, paddingHorizontal: 12, paddingTop: 6 }}>{language || t("codeBlock.example")}</Text>
      {/* Wide code scrolls sideways on narrow screens; keyboard users must be able to focus the
          region to scroll it. */}
      <ScrollView
        horizontal
        focusable
        accessibilityLabel={language ? t("codeBlock.region", { language }) : t("codeBlock.exampleRegion")}
      >
        <Text selectable {...({ dir: "ltr" } as object)} style={{ color: colors.ink, fontFamily: "monospace", writingDirection: "ltr", fontSize: 14, lineHeight: 22, padding: 12 }}>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}
