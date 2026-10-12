import React from "react";
import { ScrollView, Text, View } from "react-native";
import { colors, styles } from "./ui";
import { InlineReference } from "./InlineReference";

/** Non-executable prose renderer. HTML and remote embeds are always displayed as text. */
export function MarkdownContent({ markdown }: { markdown: string }) {
  const parts = markdown.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return (
    <View style={{ gap: 18 }}>
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          const firstLine = part.indexOf("\n"),
            language = part.slice(3, firstLine).trim(),
            code = part.slice(firstLine + 1, -3).trimEnd();
          return (
            <View
              key={index}
              style={{
                backgroundColor: colors.stage,
                borderRadius: 16,
                padding: 18,
                gap: 10,
              }}
            >
              <Text style={{ color: "#B3DFD3", fontSize: 12 }}>
                {language || "Example"}
              </Text>
              <ScrollView horizontal>
                <Text
                  selectable
                  style={{
                    color: "#EFF8F5",
                    fontFamily: "monospace",
                    fontSize: 14,
                    lineHeight: 22,
                  }}
                >
                  {code}
                </Text>
              </ScrollView>
            </View>
          );
        }
        return (
          <View key={index} style={{ gap: 16 }}>
            {part
              .trim()
              .split(/\n\s*\n/)
              .filter(Boolean)
              .map((paragraph, i) => {
                const heading = /^#{1,4}\s/.test(paragraph);
                return (
                  <Text
                    key={i}
                    accessibilityRole={heading ? "header" : undefined}
                    selectable
                    style={heading ? styles.heading : styles.body}
                  >
                    {paragraph
                      .replace(/^#{1,4}\s/, "")
                      .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/)
                      .map((span, j) =>
                        /^\[[^\]]+\]\([^\s)]+\)$/.test(span) ? (
                          <InlineReference
                            key={j}
                            label={span.slice(1, span.indexOf("]("))}
                            href={span.slice(span.indexOf("](") + 2, -1)}
                          />
                        ) : span.startsWith("`") ? (
                          <Text
                            key={j}
                            style={{
                              fontFamily: "monospace",
                              color: colors.ink,
                              backgroundColor: colors.mint,
                            }}
                          >
                            {span.slice(1, -1)}
                          </Text>
                        ) : span.startsWith("**") ? (
                          <Text
                            key={j}
                            style={{ fontWeight: "700", color: colors.ink }}
                          >
                            {span.slice(2, -2)}
                          </Text>
                        ) : (
                          span
                        ),
                      )}
                  </Text>
                );
              })}
          </View>
        );
      })}
    </View>
  );
}
