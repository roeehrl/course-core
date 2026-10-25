import React, { useMemo } from "react";
import { ScrollView, Text, View, type TextStyle } from "react-native";
import { useT } from "../i18n";
import { colors, styles } from "./ui";
import { InlineReference } from "./InlineReference";
import { MathFormula } from "./MathFormula";
import { MarkdownTable } from "./MarkdownTable";
import { hasRightToLeft, latinRuns, parseMarkdown, plainText, textDirection, type Block, type Inline } from "./markdown";

/** Non-executable prose renderer for course text and companion replies: Markdown blocks and
 * emphasis, tables and TeX math (markdown.ts, mathText.ts). HTML and remote embeds always show
 * as the text they are. With `streaming`, a reply still arriving is drawn the same way, with
 * unfinished constructs closed or held back instead of shown raw. */
export function MarkdownContent({ markdown, streaming = false }: { markdown: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(markdown, { streaming }), [markdown, streaming]);
  return (
    <View style={{ gap: 14 }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} depth={0} />
      ))}
    </View>
  );
}

const headingStyle = (level: number): TextStyle =>
  level <= 2
    ? { color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: "700" }
    : level === 3
      ? { color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: "600" }
      : { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "700" };
const BULLETS = ["•", "◦", "▪"];
/** `dir` on a react-native-web element (an HTML attribute; native ignores it). */
const dirProp = (dir: "rtl" | "ltr" | undefined) => (dir ? ({ dir } as object) : {});
const blockText = (blocks: readonly Block[]): string =>
  blocks
    .map((block) =>
      block.kind === "paragraph" || block.kind === "heading" ? plainText(block.inline)
      : block.kind === "list" ? block.items.map(blockText).join(" ")
      : block.kind === "quote" ? blockText(block.blocks)
      : "",
    )
    .join(" ");

function BlockView({ block, depth }: { block: Block; depth: number }) {
  const t = useT();
  switch (block.kind) {
    case "paragraph":
      return (
        <Text selectable style={styles.body}>
          {renderInline(block.inline, "p", hasRightToLeft(plainText(block.inline)))}
        </Text>
      );
    case "heading":
      return (
        <Text
          accessibilityRole="header"
          {...({ "aria-level": Math.min(block.level + 2, 6) } as object)}
          selectable
          style={headingStyle(block.level)}
        >
          {renderInline(block.inline, "h", hasRightToLeft(plainText(block.inline)))}
        </Text>
      );
    case "code":
      return (
        <View style={{ backgroundColor: colors.stage, borderRadius: 16, padding: 18, gap: 10 }}>
          <Text style={{ color: "#B3DFD3", fontSize: 12 }}>{block.language || t("markdownContent.example")}</Text>
          {/* Wide code scrolls sideways on narrow screens; keyboard users must be able to focus the
              region to scroll it. */}
          <ScrollView
            horizontal
            focusable
            accessibilityLabel={block.language ? t("markdownContent.codeRegion", { language: block.language }) : t("markdownContent.exampleRegion")}
          >
            <Text selectable {...dirProp("ltr")} style={{ color: "#EFF8F5", fontFamily: "monospace", writingDirection: "ltr", fontSize: 14, lineHeight: 22 }}>
              {block.code}
            </Text>
          </ScrollView>
        </View>
      );
    case "list":
      return (
        <View role="list" {...dirProp(textDirection(blockText([block])))} style={{ gap: 8 }}>
          {block.items.map((item, index) => (
            <View key={index} role="listitem" style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
              <Text
                aria-hidden
                style={[
                  styles.body,
                  block.ordered
                    ? { minWidth: 22, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] }
                    : { width: 14, color: colors.teal, fontWeight: "700", textAlign: "center" },
                ]}
              >
                {block.ordered ? `${block.start + index}.` : BULLETS[Math.min(depth, BULLETS.length - 1)]}
              </Text>
              <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
                {item.map((child, childIndex) => (
                  <BlockView key={childIndex} block={child} depth={child.kind === "list" ? depth + 1 : depth} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    case "quote":
      return (
        <View
          {...({ role: "blockquote" } as object)}
          {...dirProp(textDirection(blockText(block.blocks)))}
          style={{ borderStartWidth: 3, borderColor: colors.line, paddingStart: 14, gap: 10 }}
        >
          {block.blocks.map((child, index) => (
            <BlockView key={index} block={child} depth={depth} />
          ))}
        </View>
      );
    case "table":
      return <MarkdownTable align={block.align} header={block.header} rows={block.rows} renderInline={(nodes, key) => renderInline(nodes, key, hasRightToLeft(plainText(nodes)))} />;
    case "math":
      return <MathFormula tex={block.tex} display />;
    case "rule":
      return <View role="separator" style={{ height: 1, backgroundColor: colors.line, marginVertical: 4 }} />;
    case "pending":
      return <Pending />;
  }
}

/** Something still being written (a formula or table row): a quiet mark until it completes. */
function Pending() {
  return (
    <Text aria-hidden style={{ color: colors.muted, letterSpacing: 2 }}>
      {"…"}
    </Text>
  );
}

/** Inline nodes as nested text. In text that mixes right-to-left letters, each Latin run (and
 * every code span and formula) is isolated left to right, so mixed Hebrew and English keeps its
 * word order and punctuation. */
function renderInline(nodes: readonly Inline[], key: string, isolate: boolean): React.ReactNode[] {
  // Punctuation right after an inline formula is drawn with it, so it never wraps onto a line of
  // its own. In right-to-left text it stays outside, where the sentence direction places it.
  const trailing = nodes.map((node, index) => {
    const next = nodes[index + 1];
    return node.kind === "math" && !node.display && !isolate && next?.kind === "text" ? (/^[.,;:!?)\]]+/.exec(next.text)?.[0] ?? "") : "";
  });
  return nodes.map((node, index) => {
    const id = `${key}.${index}`;
    switch (node.kind) {
      case "text": {
        const text = node.text.slice(trailing[index - 1]?.length ?? 0);
        return isolate ? (
          <React.Fragment key={id}>
            {latinRuns(text).map((run, part) =>
              run.latin ? (
                // A single term ("fine-tuning") never breaks at its hyphen inside right-to-left text;
                // a long one may, rather than run out of its box.
                <Text key={part} {...dirProp("ltr")} style={/\s/.test(run.text) || run.text.length > 30 ? undefined : ({ whiteSpace: "nowrap" } as object)}>
                  {run.text}
                </Text>
              ) : (
                run.text
              ),
            )}
          </React.Fragment>
        ) : (
          text
        );
      }
      case "code":
        return (
          <Text
            key={id}
            {...dirProp("ltr")}
            style={{ fontFamily: "monospace", fontSize: 14, writingDirection: "ltr", color: colors.ink, backgroundColor: colors.mint, borderRadius: 4, paddingHorizontal: 3 }}
          >
            {node.text}
          </Text>
        );
      case "strong":
        return (
          <Text key={id} style={{ fontWeight: "700", color: colors.ink }}>
            {renderInline(node.children, id, isolate)}
          </Text>
        );
      case "em":
        return (
          <Text key={id} style={{ fontStyle: "italic" }}>
            {renderInline(node.children, id, isolate)}
          </Text>
        );
      case "del":
        return (
          <Text key={id} style={{ textDecorationLine: "line-through" }}>
            {renderInline(node.children, id, isolate)}
          </Text>
        );
      case "link":
        return <InlineReference key={id} label={node.label} href={node.href} />;
      case "math":
        return <MathFormula key={id} tex={node.tex} display={node.display} rtl={isolate} {...(trailing[index] ? { trailing: trailing[index] } : {})} />;
      case "break":
        return "\n";
      case "pending":
        return <Pending key={id} />;
    }
  });
}
