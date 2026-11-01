import React, { createContext, useContext, useMemo } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import { styles } from "./ui";
import { colors } from "../theme/colors";
import { InlineReference } from "./InlineReference";
import { MathFormula } from "./MathFormula";
import { MarkdownTable } from "./MarkdownTable";
import { CodeBlock } from "./CodeBlock";
import { hasRightToLeft, latinRuns, parseMarkdown, plainText, splitClosingQuestion, textDirection, type Block, type Inline } from "./markdown";

export interface MarkdownOptions {
  /** A reply still arriving: unfinished constructs are closed or held back, never shown raw. */
  streaming?: boolean;
  /** `reply`: a companion reply in the chat type (16/26, 18/30 in the focus view; headings 16/26
   * 600; paragraphs 8 apart). `lesson` (default): course text. */
  variant?: "lesson" | "reply";
  /**
   * The reply ends by asking the learner something (final design §3.3, G2): its closing question
   * is set at weight 600, followed inline by `tag` ("Your turn") when it is the learner's turn.
   */
  closingQuestion?: { tag?: React.ReactNode };
  /** The streaming caret after the last character (M6): `live` pulses while frames arrive,
   * `still` once they stop. */
  caret?: "live" | "still";
}

/** Non-executable prose renderer for course text and companion replies: Markdown blocks and
 * emphasis, tables, code blocks (with their language and Copy on the web) and TeX math
 * (markdown.ts, mathText.ts). HTML and remote embeds always show as the text they are. With
 * `streaming`, a reply still arriving is drawn the same way, with unfinished constructs closed or
 * held back instead of shown raw. */
export function MarkdownContent({ markdown, streaming = false, variant = "lesson", closingQuestion, caret }: { markdown: string } & MarkdownOptions) {
  const blocks = useMemo(() => parseMarkdown(markdown, { streaming }), [markdown, streaming]);
  const last = blocks.length - 1;
  const ending = blocks[last];
  // The caret and the question's emphasis go into the last paragraph or heading; after any other
  // block the caret is a line of its own.
  const inlineEnd = ending?.kind === "paragraph" || ending?.kind === "heading";
  return (
    <RenderContext.Provider value={variant}>
      <View style={{ gap: variant === "reply" ? 8 : 14 }}>
        {blocks.map((block, index) => (
          <BlockView
            key={index}
            block={block}
            depth={0}
            {...(index === last && inlineEnd ? { end: { question: closingQuestion, caret } } : {})}
          />
        ))}
        {caret && !inlineEnd && (
          <Text>
            <Caret state={caret} />
          </Text>
        )}
      </View>
    </RenderContext.Provider>
  );
}

const RenderContext = createContext<"lesson" | "reply">("lesson");
/** Web: a size the stylesheet can change (the focus view sets reading type, §2.2). */
const cssSize = (property: string, fallback: number) =>
  (Platform.OS === "web" ? `var(${property}, ${fallback}px)` : fallback) as unknown as number;
const replyText = (): TextStyle => ({ color: colors.ink, fontSize: cssSize("--cc-prose-size", 16), lineHeight: cssSize("--cc-prose-line", 26) });
const headingStyle = (level: number, variant: "lesson" | "reply"): TextStyle =>
  variant === "reply"
    ? { color: colors.ink, fontSize: cssSize("--cc-prose-size", 16), lineHeight: cssSize("--cc-prose-line", 26), fontWeight: "600" }
    : level <= 2
      ? { color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: "700" }
      : level === 3
        ? { color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: "600" }
        : { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "700" };
const BULLETS = ["•", "◦", "▪"];
/** `dir` on a react-native-web element (an HTML attribute; native ignores it). */
const dirProp = (dir: "rtl" | "ltr" | undefined) => (dir ? ({ dir } as object) : {});
/** `data-*` attributes on a react-native-web element. */
const dataProp = (data: Record<string, string>) => ({ dataSet: data } as object);
const blockText = (blocks: readonly Block[]): string =>
  blocks
    .map((block) =>
      block.kind === "paragraph" || block.kind === "heading" ? plainText(block.inline)
      : block.kind === "list" ? block.items.map(blockText).join(" ")
      : block.kind === "quote" ? blockText(block.blocks)
      : "",
    )
    .join(" ");

/** The streaming caret (M6): 2 × 18 px, drawn by the stylesheet (markdown.css). */
function Caret({ state }: { state: "live" | "still" }) {
  return <Text aria-hidden {...dataProp({ ccCaret: state })} />;
}

type BlockEnd = { question?: { tag?: React.ReactNode }; caret?: "live" | "still" };

function BlockView({ block, depth, end }: { block: Block; depth: number; end?: BlockEnd }) {
  const variant = useContext(RenderContext);
  switch (block.kind) {
    case "paragraph": {
      const rtl = hasRightToLeft(plainText(block.inline));
      // Each block takes its direction from its first strong letter (RTL-2), in a reply.
      const dir = variant === "reply" ? dirProp(textDirection(plainText(block.inline))) : {};
      const split = end?.question ? splitClosingQuestion(block.inline) : undefined;
      return (
        <Text selectable {...dir} style={variant === "reply" ? [styles.body, replyText()] : styles.body}>
          {split && split.question.length ? (
            <>
              {renderInline(split.lead, "p", rtl)}
              <Text {...dataProp({ ccQuestion: "" })} style={{ fontWeight: "600", color: colors.ink }}>{renderInline(split.question, "q", rtl)}</Text>
            </>
          ) : (
            renderInline(block.inline, "p", rtl)
          )}
          {end?.caret && <Caret state={end.caret} />}
          {end?.question?.tag}
        </Text>
      );
    }
    case "heading":
      return (
        <Text
          accessibilityRole="header"
          {...({ "aria-level": Math.min(block.level + 2, 6) } as object)}
          {...(variant === "reply" ? dirProp(textDirection(plainText(block.inline))) : {})}
          selectable
          style={headingStyle(block.level, variant)}
        >
          {renderInline(block.inline, "h", hasRightToLeft(plainText(block.inline)))}
          {end?.caret && <Caret state={end.caret} />}
        </Text>
      );
    case "code":
      return <CodeBlock language={block.language} code={block.code} />;
    case "list":
      return (
        <View role="list" {...dirProp(textDirection(blockText([block])))} style={{ gap: 8 }}>
          {block.items.map((item, index) => (
            <View key={index} role="listitem" style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
              <Text
                aria-hidden
                style={[
                  styles.body,
                  variant === "reply" ? replyText() : null,
                  block.ordered
                    ? { minWidth: 22, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] }
                    : { width: 14, color: colors.accent, fontWeight: "700", textAlign: "center" },
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
          // A 2 px rule at the start marks a quotation (the only rule allowed, §3.3).
          style={{ borderStartWidth: 2, borderColor: colors.line, paddingStart: 14, gap: variant === "reply" ? 8 : 10 }}
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
    <Text aria-hidden style={{ color: colors.inkMuted, letterSpacing: 2 }}>
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
        const runs = latinRuns(text);
        const single = (run: { text: string; latin: boolean } | undefined) => Boolean(run?.latin && !/\s/.test(run.text) && run.text.length <= 30);
        return isolate ? (
          <React.Fragment key={id}>
            {runs.map((run, part) => {
              if (!run.latin) {
                // A Hebrew prefix and its maqaf ("ב-", "כש-") stay on the line of the single term
                // they attach to: the line broke after the hyphen ("ב-" | "forward").
                const prefix = single(runs[part + 1]) ? /[\u05D0-\u05EA]+[-\u05BE]$/.exec(run.text)?.[0] : undefined;
                return prefix ? run.text.slice(0, -prefix.length) : run.text;
              }
              const before = single(run) ? /[\u05D0-\u05EA]+[-\u05BE]$/.exec(runs[part - 1]?.text ?? "")?.[0] : undefined;
              // A single term ("fine-tuning") never breaks at its hyphen inside right-to-left text;
              // a long one may, rather than run out of its box.
              const term = (
                <Text key={part} {...dirProp("ltr")} style={single(run) ? ({ whiteSpace: "nowrap" } as object) : undefined}>
                  {run.text}
                </Text>
              );
              return before ? (
                <Text key={part} style={{ whiteSpace: "nowrap" } as object}>
                  {before}
                  {term}
                </Text>
              ) : (
                term
              );
            })}
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
            style={{ fontFamily: "monospace", fontSize: 14, writingDirection: "ltr", color: colors.ink, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 3 }}
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
