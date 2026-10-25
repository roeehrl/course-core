/** A small, non-executable Markdown reader for course prose and companion replies: headings,
 * paragraphs, bullet and numbered lists (nested), quotes, tables, fenced code, rules, emphasis,
 * inline code, links and TeX math. It returns a tree that MarkdownContent draws with ordinary
 * text elements; raw HTML is never interpreted and always shows as the text it is.
 *
 * `streaming` reads a reply that is still arriving: an emphasis, code span or code block that is
 * not closed yet is shown closed, and an unfinished formula or table row is held back until it
 * completes, so the learner never sees raw `**`, `$` or `|` flash by. */
import { splitMath } from "./mathText";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; label: string; href: string }
  | { kind: "math"; tex: string; display: boolean }
  | { kind: "pending" }
  | { kind: "break" };
export type Align = "start" | "center" | "end" | null;
export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "code"; language: string; code: string }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: "math"; tex: string }
  | { kind: "pending" }
  | { kind: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const DISPLAY_OPEN = /^\s*(\$\$|\\\[)(.*)$/;

interface Options {
  streaming?: boolean;
}

export function parseMarkdown(source: string, options: Options = {}): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return blocks(lines, options);
}

const indentOf = (line: string) => /^ */.exec(line)![0].length;
const blank = (line: string | undefined) => line === undefined || !line.trim();
const pipeCells = (line: string) => splitCells(line).length;
function startsBlock(line: string, next: string | undefined) {
  return (
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) ||
    DISPLAY_OPEN.test(line) || (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("-"))
  );
}

function blocks(lines: string[], options: Options): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!, code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[j]!)) code.push(lines[j++]!);
      out.push({ kind: "code", language: fence[2] ?? "", code: code.join("\n").replace(/\s+$/, "") });
      i = j + 1;
      continue;
    }
    const display = DISPLAY_OPEN.exec(line);
    if (display) {
      const close = display[1] === "$$" ? "$$" : "\\]";
      const rest = display[2]!;
      const collected: string[] = [];
      let j = i, closed = false, after = "";
      let current = rest;
      while (true) {
        const end = current.indexOf(close);
        if (end >= 0) {
          collected.push(current.slice(0, end));
          after = current.slice(end + close.length);
          closed = true;
          break;
        }
        collected.push(current);
        j++;
        if (j >= lines.length) break;
        current = lines[j]!;
      }
      if (closed && !after.trim()) {
        out.push({ kind: "math", tex: collected.join("\n").trim() });
        i = j + 1;
        continue;
      }
      if (!closed && options.streaming && j >= lines.length) {
        // The formula is still being written: hold it back rather than show raw TeX.
        out.push({ kind: "pending" });
        break;
      }
      // Display math in the middle of a sentence, or never closed: an ordinary paragraph.
    }
    const heading = HEADING.exec(line);
    if (heading && (heading[2] || /^ {0,3}#{1,6}\s*$/.test(line))) {
      out.push({ kind: "heading", level: heading[1]!.length, inline: inlines(heading[2] ?? "", options) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]!) || !startsBlock(lines[i]!, lines[i + 1]))) {
        quoted.push(QUOTE.exec(lines[i]!)?.[1] ?? lines[i]!.trim());
        i++;
      }
      out.push({ kind: "quote", blocks: blocks(quoted, options) });
      continue;
    }
    if (line.includes("|") && lines[i + 1] !== undefined && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const header = splitCells(line);
      const align = splitCells(lines[i + 1]!).map((cell): Align => {
        const left = cell.startsWith(":"), right = cell.endsWith(":");
        return left && right ? "center" : right ? "end" : left ? "start" : null;
      });
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && !blank(lines[j]) && lines[j]!.includes("|")) rows.push(splitCells(lines[j++]!));
      const width = header.length;
      const fit = (cells: string[]) => Array.from({ length: width }, (_, index) => cells[index] ?? "");
      out.push({
        kind: "table",
        align: fit(align.map((value) => value ?? "")).map((_, index) => align[index] ?? null),
        header: fit(header).map((cell) => inlines(cell, options)),
        rows: rows.map((cells) => fit(cells).map((cell) => inlines(cell, options))),
      });
      i = j;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const [list, next] = listAt(lines, i, options);
      out.push(list);
      i = next;
      continue;
    }
    // A paragraph runs to a blank line or the start of another block.
    const paragraph: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (paragraph.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) {
      paragraph.push(lines[i]!.trim());
      i++;
    }
    // While streaming, rows of a table whose separator has not arrived yet are held back.
    if (options.streaming && i >= lines.length) {
      let held = paragraph.length;
      while (held > 0 && paragraph[held - 1]!.startsWith("|")) held--;
      if (held < paragraph.length && pipeCells(paragraph[held]!) > 1) {
        if (held > 0) out.push({ kind: "paragraph", inline: inlines(paragraph.slice(0, held).join("\n"), options) });
        out.push({ kind: "pending" });
        continue;
      }
    }
    out.push({ kind: "paragraph", inline: inlines(paragraph.join("\n"), options) });
  }
  return out;
}

/** A list from line `start`: its items, each item's lines read as blocks of their own. */
function listAt(lines: string[], start: number, options: Options): [Block, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length, ordered = /\d/.test(first[2]!);
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]!);
    if (!match || match[1]!.length !== indent || /\d/.test(match[2]!) !== ordered) break;
    const content = indent + match[2]!.length + Math.min(Math.max(match[3]!.length, 1), 4);
    const body: string[] = [match[4] ?? ""];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (blank(line)) {
        // A blank line continues the item only when what follows is indented under it.
        let k = i;
        while (k < lines.length && blank(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]!) > indent && !(LIST_ITEM.test(lines[k]!) && indentOf(lines[k]!) === indent)) {
          body.push(...lines.slice(i, k).map(() => ""));
          i = k;
          continue;
        }
        break;
      }
      const nested = LIST_ITEM.exec(line);
      if (nested && nested[1]!.length <= indent) break;
      if (indentOf(line) > indent) {
        body.push(line.slice(Math.min(indentOf(line), content)));
        i++;
        continue;
      }
      // A lazy continuation line of the item's paragraph.
      if (startsBlock(line, lines[i + 1])) break;
      body.push(line.trim());
      i++;
    }
    items.push(blocks(body, options));
    // Blank lines between items keep one list.
    let k = i;
    while (k < lines.length && blank(lines[k])) k++;
    const after = k < lines.length ? LIST_ITEM.exec(lines[k]!) : null;
    if (after && after[1]!.length === indent && /\d/.test(after[2]!) === ordered) i = k;
  }
  return [{ kind: "list", ordered, start: ordered ? Math.min(Number.parseInt(first[2]!, 10), 1e9) : 1, items }, i];
}

function splitCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "", code = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && text[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (c === "`") code = !code;
    if (c === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

/* ---------- Inline ---------- */

const PUNCTUATION = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const SAFE_LINK = /^\[([^\]\n]+)\]\(([^\s)]+)\)/;

type Token =
  | { kind: "node"; node: Inline }
  | { kind: "delim"; char: "*" | "_" | "~"; count: number; open: boolean; close: boolean; original: number };

export function inlines(source: string, options: Options = {}): Inline[] {
  const out: Inline[] = [];
  const segments = splitMath(source);
  segments.forEach((segment, index) => {
    if (segment.kind === "math") {
      out.push({ kind: "math", tex: segment.tex, display: segment.display });
      return;
    }
    const text = segment.value;
    if (options.streaming && index === segments.length - 1) {
      // An opening `$` whose formula has not finished arriving: hold the rest back.
      const open = /(?<![\\$\w])\$\$?(?=\S)(?=[^$]*[\\^_{])[^$]*$/.exec(text) ?? /\\[([](?![\s\S]*\\[)\]])[\s\S]*$/.exec(text);
      if (open) {
        out.push(...spans(text.slice(0, open.index), options));
        out.push({ kind: "pending" });
        return;
      }
    }
    out.push(...spans(text, options));
  });
  return merge(out);
}

function spans(source: string, options: Options): Inline[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "node", node: { kind: "text", text } });
    text = "";
  };
  for (let i = 0; i < source.length; ) {
    const c = source[i]!;
    if (c === "\\" && ESCAPABLE.test(source[i + 1] ?? "")) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      tokens.push({ kind: "node", node: { kind: "break" } });
      i++;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(source.slice(i))![0];
      const end = source.indexOf(run, i + run.length);
      if (end >= 0 || options.streaming) {
        flush();
        const inner = source.slice(i + run.length, end >= 0 ? end : source.length);
        tokens.push({ kind: "node", node: { kind: "code", text: inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ") ? inner.slice(1, -1) : inner } });
        i = end >= 0 ? end + run.length : source.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (c === "[") {
      const link = SAFE_LINK.exec(source.slice(i));
      if (link) {
        flush();
        tokens.push({ kind: "node", node: { kind: "link", label: link[1]!, href: link[2]! } });
        i += link[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || (c === "~" && source[i + 1] === "~")) {
      const run = new RegExp(`^\\${c}+`).exec(source.slice(i))![0];
      const before = source[i - 1] ?? " ", after = source[i + run.length] ?? " ";
      const leftFlanking = !WHITESPACE.test(after) && (!PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before));
      const rightFlanking = !WHITESPACE.test(before) && (!PUNCTUATION.test(before) || WHITESPACE.test(after) || PUNCTUATION.test(after));
      // `snake_case_names` stay as written: an underscore inside a word never emphasises.
      // Nor does a `*` between digits ("2*3*4" is a product, not emphasis).
      const numeric = c === "*" && /\d/.test(before) && /\d/.test(after);
      const open = !numeric && (c === "_" ? leftFlanking && (!rightFlanking || PUNCTUATION.test(before)) : leftFlanking);
      const close = !numeric && (c === "_" ? rightFlanking && (!leftFlanking || PUNCTUATION.test(after)) : rightFlanking);
      if (c === "~" && run.length !== 2) {
        text += run;
        i += run.length;
        continue;
      }
      flush();
      tokens.push({ kind: "delim", char: c as "*" | "_" | "~", count: run.length, open, close, original: run.length });
      i += run.length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return resolveEmphasis(tokens, options);
}

/** CommonMark's delimiter matching, simplified: each closer pairs with the nearest opener of the
 * same character; delimiters left between them are plain text. */
function resolveEmphasis(tokens: Token[], options: Options): Inline[] {
  type Wrap = { kind: "wrap"; wrap: "strong" | "em" | "del"; children: Item[] };
  type Item = Token | Wrap;
  const items: Item[] = [...tokens];
  const asText = (item: Item): Item => (item.kind === "delim" ? literal(item) : item);
  let index = 0;
  while (index < items.length) {
    const token = items[index]!;
    if (token.kind !== "delim" || !token.close || token.count === 0) {
      index++;
      continue;
    }
    let opener = index - 1;
    for (; opener >= 0; opener--) {
      const candidate = items[opener]!;
      if (candidate.kind !== "delim" || candidate.char !== token.char || !candidate.open || candidate.count === 0) continue;
      // `*a**` does not pair a single with a double (the "multiple of 3" rule).
      const both = candidate.close || token.open;
      if (both && (candidate.original + token.original) % 3 === 0 && !(candidate.original % 3 === 0 && token.original % 3 === 0)) continue;
      break;
    }
    if (opener < 0) {
      index++;
      continue;
    }
    const candidate = items[opener] as Extract<Token, { kind: "delim" }>;
    const use = token.char === "~" ? 2 : Math.min(candidate.count, token.count) >= 2 ? 2 : 1;
    const wrap: Wrap = { kind: "wrap", wrap: token.char === "~" ? "del" : use === 2 ? "strong" : "em", children: items.slice(opener + 1, index).map(asText) };
    candidate.count -= use;
    token.count -= use;
    const left: Item[] = candidate.count ? [candidate] : [];
    items.splice(opener, index - opener + 1, ...left, wrap, token);
    index = opener + left.length + 1;
    if (token.count === 0) items.splice(index, 1);
  }
  if (options.streaming) {
    // A reply still arriving: an opening `**`, `__` or `~~` (or a `*`/`_` after a space) runs to the end.
    for (let at = items.length - 1; at >= 0; at--) {
      const item = items[at]!;
      if (item.kind !== "delim" || !item.open || item.count === 0 || (item.count < 2 && item.close)) continue;
      const wrap: Wrap = { kind: "wrap", wrap: item.char === "~" ? "del" : item.count >= 2 ? "strong" : "em", children: items.slice(at + 1).map(asText) };
      items.splice(at, items.length - at, wrap);
    }
  }
  const toInline = (item: Item): Inline[] =>
    item.kind === "wrap" ? [{ kind: item.wrap, children: merge(item.children.flatMap(toInline)) }]
    : item.kind === "delim" ? (item.count ? [literal(item).node] : [])
    : [item.node];
  return merge(items.flatMap(toInline));
}
const literal = (token: Extract<Token, { kind: "delim" }>): { kind: "node"; node: Inline } => ({
  kind: "node",
  node: { kind: "text", text: token.char.repeat(token.count) },
});
function merge(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (node.kind === "text" && !node.text) continue;
    if (node.kind === "text" && last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + node.text };
    else out.push(node);
  }
  return out;
}

/** The plain text of inline nodes (for direction detection and labels). */
export function plainText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) =>
      node.kind === "text" || node.kind === "code" ? node.text
      : node.kind === "link" ? node.label
      : node.kind === "break" ? "\n"
      : node.kind === "strong" || node.kind === "em" || node.kind === "del" ? plainText(node.children)
      : "",
    )
    .join("");
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const STRONG = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-ࣿיִ-﷿ﹰ-﻿]/;
/** The direction of text by its first strong letter, as `dir="auto"` decides it. */
export function textDirection(text: string): "rtl" | "ltr" | undefined {
  const first = STRONG.exec(text)?.[0];
  return first === undefined ? undefined : RTL.test(first) ? "rtl" : "ltr";
}
/** Whether text mixes right-to-left letters into it, so Latin runs need isolating. */
export const hasRightToLeft = (text: string) => RTL.test(text);
const LATIN = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
/** An operation between numbers ("2+2=4", "0.1·6"): a formula even without a letter. */
const FORMULA = /\d\s*[=+\-*/^<>×÷·≤≥≠]\s*[\d(]/;
const PAIRS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}", "“": "”", "‘": "’", "«": "»", '"': '"' };
const CLOSERS = new Map(Object.entries(PAIRS).map(([open, close]) => [close, open]));
/** Words with more than two of them, or an operator: a phrase or formula of its own, whose closing
 * punctuation ("…value of w?") is its own, not the sentence around it. */
const phrase = (run: string) => /\S\s+\S+\s+\S/.test(run) || /[\w)]\s*[=*^<>+×÷]\s*[\w(]/.test(run);
/**
 * Splits text into runs to isolate left to right and the rest, so text in a left-to-right script
 * inside Hebrew keeps its own order: a term ("(fine-tuning)" never wraps as "(-fine"), a pasted
 * English sentence or formula ("For prediction=w*x, use w=3, x=2", which read
 * "2=x ,3=use w ,x*w=For prediction" in the live 0.1.58 test), or a calculation ("2+2=4"). A run is
 * a stretch without right-to-left letters that has a Latin, Greek or Cyrillic letter or an
 * operation between numbers. What only joins it to the sentence stays outside: spaces, a maqaf
 * after a Hebrew prefix ("ב-forward"), separating commas and colons, a bracket or quotation mark
 * it does not close, and the full stop of a Hebrew sentence that ends on a single term.
 */
export function latinRuns(text: string): { text: string; latin: boolean }[] {
  const out: { text: string; latin: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(/[^\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\n]+/g)) {
    const span = match[0];
    if (!LATIN.test(span) && !FORMULA.test(span)) continue;
    let start = 0, end = span.length;
    for (let changed = true; changed && start < end; ) {
      changed = false;
      while (start < end && /[\s,;:.!?\-–—·/]/.test(span[start]!)) { start++; changed = true; }
      while (end > start && /[\s,;:\-–—·]/.test(span[end - 1]!)) { end--; changed = true; }
      const run = span.slice(start, end), first = run[0]!, final = run.at(-1)!;
      // A closing mark at the start, or an opening one at the end, encloses nothing of the run.
      if ((CLOSERS.has(first) && first !== '"') || (PAIRS[first] && !run.slice(1).includes(PAIRS[first]!))) { start++; changed = true; continue; }
      if ((PAIRS[final] && final !== '"') || (CLOSERS.has(final) && !run.slice(0, -1).includes(CLOSERS.get(final)!))) { end--; changed = true; continue; }
      if (/[.!?…]/.test(final) && !(LATIN.test(run) && phrase(run))) { end--; changed = true; }
    }
    const run = span.slice(start, end);
    if (!run || (!LATIN.test(run) && !FORMULA.test(run))) continue;
    const index = match.index! + start;
    if (index > last) out.push({ text: text.slice(last, index), latin: false });
    out.push({ text: run, latin: true });
    last = index + run.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), latin: false });
  return out;
}
