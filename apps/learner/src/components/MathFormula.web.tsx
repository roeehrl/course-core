import React, { useRef } from "react";
import { useI18n } from "../i18n";
import { mathSpoken, mathText, parseTex, type MathNode } from "./mathText";
import { useSidewaysOverflow } from "./useSidewaysOverflow.web";

/** A formula drawn as MathML elements built from the parsed tree: real fractions, roots and
 * scripts, never injected markup. Screen readers hear the spoken form in the learner's language
 * (the label, marked with that language); the drawing itself is hidden from them so it is not
 * read twice. Formulas are always left to right, isolated from right-to-left prose around them. */
export function MathFormula({ tex, display, trailing, rtl = false }: { tex: string; display: boolean; trailing?: string; rtl?: boolean }) {
  const i18n = useI18n();
  const tree = parseTex(tex);
  const label = mathSpoken(tree, i18n.t);
  const frame = useRef<HTMLSpanElement>(null);
  const overflowing = useSidewaysOverflow(frame, display);
  // MathML does not wrap lines inside a formula. A long inline formula is drawn as pieces that
  // end after a top-level relation or operation ("w = 2 − 0.1 × 6 ="), so it wraps there. A short
  // one stays whole: "h =" never ends a line before "w₁ · x". Inside right-to-left text a split
  // left-to-right formula would read in the wrong order across lines, so there only a formula too
  // long for a line is split.
  const pieces = display || mathText(tree).length <= (rtl ? WRAP_RTL : WRAP_LTR) ? [tree] : breakable(tree);
  const formula = (
    <span
      ref={frame}
      role="math"
      aria-label={label}
      lang={i18n.lang}
      dir="ltr"
      data-math-display={display ? "block" : "inline"}
      // A wide display formula scrolls sideways on a phone; keyboard users can focus it to scroll.
      tabIndex={display ? 0 : undefined}
      className={`math-formula ${display ? "is-display" : ""} ${display && overflowing ? "is-overflowing" : ""}`}
      style={{ ...(display ? displayStyle : inlineStyle), ...fontStyle(display) }}
    >
      {pieces.map((piece, index) => {
        const math = React.createElement("math", { "aria-hidden": "true", display: display ? "block" : "inline" }, draw(piece, display, `m${index}`));
        return (
          <React.Fragment key={index}>
            {index > 0 && "\u200b"}
            {/* Punctuation right after the formula stays on its last line. */}
            {trailing && index === pieces.length - 1 ? <span style={{ whiteSpace: "nowrap" }}>{math}{trailing}</span> : math}
          </React.Fragment>
        );
      })}
    </span>
  );
  if (!display) return formula;
  // A display formula wider than its space scrolls sideways, with a visible scrollbar and a line
  // saying so.
  return (
    <span className="markdown-wide">
      {formula}
      {overflowing && <span className="markdown-scroll-hint" data-toward="right" aria-hidden="true">{i18n.t("markdownContent.scrollHint")}</span>}
    </span>
  );
}
/** Visible characters up to which an inline formula is never split (left to right, right to left). */
const WRAP_LTR = 24, WRAP_RTL = 40;

/** Where an inline formula may wrap: after each top-level relation or binary operation. */
function breakable(tree: MathNode): MathNode[] {
  if (tree.kind !== "row" || tree.children.length < 4) return [tree];
  const pieces: MathNode[][] = [[]];
  tree.children.forEach((child, index) => {
    const last = pieces.at(-1)!;
    // An operator that ends a piece keeps its spacing on both sides (as explicit space: engines
    // differ on spacing an operator that ends its row).
    if (child.kind === "mo" && child.binary && index < tree.children.length - 1)
      last.push({ kind: "space", em: OPERATOR_SPACE }, { ...child, infix: true }, { kind: "space", em: OPERATOR_SPACE });
    else last.push(child);
    if (child.kind === "mo" && child.binary && index < tree.children.length - 1) pieces.push([]);
  });
  return pieces.map((children) => (children.length === 1 ? children[0]! : { kind: "row", children }));
}

const OPERATOR_SPACE = 5 / 18;
const inlineStyle: React.CSSProperties = { unicodeBidi: "isolate" };
const displayStyle: React.CSSProperties = {
  display: "block",
  unicodeBidi: "isolate",
  overflowX: "auto",
  overflowY: "hidden",
  maxWidth: "100%",
  padding: "6px 2px",
  textAlign: "center",
};
// i18n-ignore: CSS font stack, not text
const MATH_FONTS = "math, 'STIX Two Math', 'Cambria Math', 'Latin Modern Math', 'Times New Roman', serif";
// MathML elements take no inline style in every DOM (jsdom has none); the wrapper sets the font,
// and connected.css styles the few classes below.
const fontStyle = (display: boolean): React.CSSProperties => ({ fontFamily: MATH_FONTS, fontSize: display ? "1.12em" : "1.06em" });

const COMBINING: Partial<Record<string, string>> = { hat: "\u0302", bar: "\u0304", tilde: "\u0303", vec: "\u20d7", dot: "\u0307", ddot: "\u0308" };
/** The mathematical italic form of a Latin or Greek letter (what MathML draws a lone letter as). */
function italic(letter: string): string {
  const code = letter.codePointAt(0)!;
  if (letter === "h") return "\u210e";
  if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(0x1d44e + code - 0x61);
  if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(0x1d434 + code - 0x41);
  if (code >= 0x3b1 && code <= 0x3c9) return String.fromCodePoint(0x1d6fc + code - 0x3b1);
  return letter;
}
const h = (tag: string, props: Record<string, unknown> | null, ...children: React.ReactNode[]) =>
  React.createElement(tag, props, ...children);
/** One child element: MathML layout elements take exactly their positional arguments. */
const one = (node: MathNode, display: boolean, key: string) =>
  node.kind === "row" ? h("mrow", { key }, ...node.children.map((child, index) => draw(child, display, `${key}.${index}`))) : draw(node, display, key);

function draw(node: MathNode, display: boolean, key: string): React.ReactNode {
  switch (node.kind) {
    case "row":
      return h("mrow", { key }, ...node.children.map((child, index) => draw(child, display, `${key}.${index}`)));
    case "mi":
      return h(
        "mi",
        {
          key,
          ...(node.variant === "normal" ? { mathvariant: "normal" } : {}),
          ...(node.variant === "bold" ? { className: "is-bold" } : {}),
        },
        node.text,
      );
    case "mn":
      return h("mn", { key }, node.text);
    case "mtext":
      return h("mtext", { key }, node.text);
    case "mo":
      return h(
        "mo",
        {
          key,
          ...(node.largeop ? { largeop: "true", movablelimits: "true" } : {}),
          ...(node.prefix ? { form: "prefix" } : node.infix ? { form: "infix", lspace: "0", rspace: "0" } : {}),
          ...(node.limits && !node.largeop ? { movablelimits: "true" } : {}),
          stretchy: "false",
        },
        node.text,
      );
    case "space":
      return h("mspace", { key, width: `${node.em.toFixed(3)}em` });
    case "frac":
      return node.binomial
        ? h("mrow", { key }, h("mo", null, "("), h("mfrac", { linethickness: "0" }, one(node.numerator, display, `${key}n`), one(node.denominator, display, `${key}d`)), h("mo", null, ")"))
        : h("mfrac", { key }, one(node.numerator, display, `${key}n`), one(node.denominator, display, `${key}d`));
    case "root":
      return node.index
        ? h("mroot", { key }, one(node.radicand, display, `${key}r`), one(node.index, display, `${key}i`))
        : h("msqrt", { key }, one(node.radicand, display, `${key}r`));
    case "script": {
      const base = one(node.base, display, `${key}b`);
      const under = node.sub && one(node.sub, display, `${key}s`);
      const over = node.sup && one(node.sup, display, `${key}p`);
      // Limits of a large operator or `lim` go below and above it in display math.
      const limits = display && node.base.kind === "mo" && Boolean(node.base.limits);
      if (under && over) return h(limits ? "munderover" : "msubsup", { key }, base, under, over);
      if (under) return h(limits ? "munder" : "msub", { key }, base, under);
      return h(limits ? "mover" : "msup", { key }, base, over);
    }
    case "accent": {
      // Over one letter, the font places a combining mark best in every engine (MathML accents
      // overlap their base in some); the letter is set from the italic math alphabet.
      const letter = node.base.kind === "mi" && [...node.base.text].length === 1 ? node.base : undefined;
      if (letter && COMBINING[node.name])
        return h("mi", { key, ...(letter.variant === "bold" ? { className: "is-bold" } : {}) }, `${letter.variant ? letter.text : italic(letter.text)}${COMBINING[node.name]}`);
      return node.under
        ? h("munder", { key }, one(node.base, display, `${key}b`), h("mo", { stretchy: "true" }, node.mark))
        : h("mover", { key }, one(node.base, display, `${key}b`), h("mo", { stretchy: node.name === "bar" ? "true" : "false" }, node.mark));
    }
    case "stack": {
      const base = one(node.base, display, `${key}b`);
      if (node.over) return h("mover", { key }, base, one(node.over, display, `${key}o`));
      return h("munder", { key }, base, one(node.under ?? { kind: "row", children: [] }, display, `${key}u`));
    }
    case "fenced":
      return h(
        "mrow",
        { key },
        node.open ? h("mo", { fence: "true", stretchy: "true", form: "prefix" }, node.open) : null,
        one(node.body, display, `${key}b`),
        node.close ? h("mo", { fence: "true", stretchy: "true", form: "postfix" }, node.close) : null,
      );
    case "table": {
      const left = node.say === "cases" || node.say === "lines";
      const table = h(
        "mtable",
        { key: `${key}t` },
        ...node.rows.map((cells, r) =>
          h("mtr", { key: `${key}r${r}` }, ...cells.map((cell, c) => h("mtd", { key: `${key}r${r}c${c}`, ...(left ? { className: "is-start" } : {}) }, one(cell, display, `${key}r${r}c${c}x`)))),
        ),
      );
      return h(
        "mrow",
        { key },
        node.open ? h("mo", { fence: "true", stretchy: "true", form: "prefix" }, node.open) : null,
        table,
        node.close ? h("mo", { fence: "true", stretchy: "true", form: "postfix" }, node.close) : null,
      );
    }
  }
}
