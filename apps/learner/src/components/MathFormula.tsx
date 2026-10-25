import React from "react";
import { Text } from "react-native";
import { useI18n } from "../i18n";
import { colors } from "./ui";
import { mathSpoken, mathText, parseTex } from "./mathText";

/** A formula as readable text (the web app draws it with MathML, MathFormula.web.tsx). Screen
 * readers hear the spoken form in the learner's language, never raw TeX. */
export function MathFormula({ tex, display, trailing }: { tex: string; display: boolean; trailing?: string; rtl?: boolean }) {
  const i18n = useI18n();
  const tree = parseTex(tex);
  return (
    <Text
      role="math"
      aria-label={mathSpoken(tree, i18n.t)}
      {...({ lang: i18n.lang } as object)}
      style={{
        // i18n-ignore: CSS font stack, not text
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontStyle: "italic",
        color: colors.ink,
        writingDirection: "ltr",
        ...(display ? { textAlign: "center", paddingVertical: 6 } : {}),
      }}
    >
      {mathText(tree)}
      {trailing}
    </Text>
  );
}
