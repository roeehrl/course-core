import { finite, VisualError } from "./expression.js";
import type { EquationLayout } from "./types.js";
import { sanitizeMarkup } from "./markup.js";
import type { MarkupElement } from "./markup.js";

/**
 * A constrained TeX subset, parsed and laid out here without a third-party math engine.
 * The output is data (positioned glyph strings, rules and stroke paths) that the SVG
 * builder turns into ordinary text/rect/path elements, so no markup, URL, script, font
 * file or style sheet ever comes from the author's TeX. Anything outside the subset is
 * refused: unknown macros (EQUATION_MACRO), macros that can define commands or emit
 * links/markup such as \href, \url, \html… and \def (EQUATION_UNSAFE), and characters
 * outside the allowlist (EQUATION_CHAR).
 *
 * Glyph widths are estimates. Each glyph carries its advance width and renders with
 * textLength, so the layout is identical whatever math font the viewer has.
 */
export const EQUATION_LIMITS = Object.freeze({
  chars: 512,
  depth: 8,
  atoms: 256,
  text: 128,
  /** Rows and columns of one matrix or environment (0.5). */
  rows: 16,
  columns: 16,
});

type Style = "italic" | "normal" | "bold";
type Cls = "ord" | "op" | "bin" | "rel" | "open" | "close" | "punct";
type Accent = "hat" | "bar" | "vec" | "tilde" | "dot";
/** Environments (0.5): matrices with their delimiters, cases, and aligned equations. */
export type Environment =
  | "matrix"
  | "pmatrix"
  | "bmatrix"
  | "Bmatrix"
  | "vmatrix"
  | "Vmatrix"
  | "cases"
  | "aligned";
const ENVIRONMENTS = new Set<Environment>([
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "cases",
  "aligned",
]);
/** Left and right delimiters of each environment. */
const FENCES: Record<Environment, [string, string]> = {
  matrix: ["", ""],
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
  cases: ["{", ""],
  aligned: ["", ""],
};
export type MathNode =
  | {
      t: "atom";
      text: string;
      cls: Cls;
      style: Style;
      tag: "mi" | "mn" | "mo";
      large?: boolean;
    }
  | { t: "row"; items: MathNode[] }
  | { t: "scripts"; base: MathNode; sup?: MathNode; sub?: MathNode }
  | { t: "frac"; num: MathNode; den: MathNode }
  | { t: "sqrt"; body: MathNode }
  | { t: "text"; text: string }
  | { t: "space"; em: number }
  | { t: "accent"; body: MathNode; accent: Accent }
  | { t: "table"; env: Environment; rows: MathNode[][] };

const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
};
const GREEK_UPPER: Record<string, string> = {
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};
const BIN: Record<string, string> = {
  cdot: "⋅",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  cup: "∪",
  cap: "∩",
  circ: "∘",
  ast: "∗",
  oplus: "⊕",
  otimes: "⊗",
};
const REL: Record<string, string> = {
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  simeq: "≃",
  propto: "∝",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  iff: "⟺",
  mapsto: "↦",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  ll: "≪",
  gg: "≫",
  perp: "⊥",
  mid: "∣",
};
const ORD: Record<string, string> = {
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  emptyset: "∅",
  ell: "ℓ",
  hbar: "ℏ",
  prime: "′",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  neg: "¬",
};
const LARGE: Record<string, string> = {
  sum: "∑",
  prod: "∏",
  int: "∫",
  oint: "∮",
};
const FUNCTIONS = new Set([
  "sin",
  "cos",
  "tan",
  "log",
  "ln",
  "exp",
  "max",
  "min",
  "lim",
  "det",
  "arg",
  "sup",
  "inf",
  "Pr",
]);
const ACCENTS = new Set<Accent>(["hat", "bar", "vec", "tilde", "dot"]);
const SPACES: Record<string, number> = {
  ",": 0.167,
  ":": 0.222,
  ";": 0.278,
  "!": -0.167,
  " ": 0.25,
};
/** Macros that define commands, read files or emit links/markup in TeX engines. */
const UNSAFE =
  /^(?:href|url|html[A-Za-z]*|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|input|include[A-Za-z]*|write|immediate|openin|openout|catcode|csname|special|char|verb|class|style|data|mathchoice|expandafter)$/;
const CHARS: Record<string, [string, Cls]> = {
  "+": ["+", "bin"],
  "-": ["−", "bin"],
  "*": ["∗", "bin"],
  "/": ["/", "ord"],
  "=": ["=", "rel"],
  "<": ["<", "rel"],
  ">": [">", "rel"],
  ":": [":", "rel"],
  "(": ["(", "open"],
  "[": ["[", "open"],
  ")": [")", "close"],
  "]": ["]", "close"],
  "|": ["|", "ord"],
  ",": [",", "punct"],
  ";": [";", "punct"],
  ".": [".", "ord"],
  "!": ["!", "close"],
  "?": ["?", "close"],
  "'": ["′", "ord"],
};
const DELIMITERS: Record<string, [string, Cls]> = {
  "(": ["(", "open"],
  ")": [")", "close"],
  "[": ["[", "open"],
  "]": ["]", "close"],
  "|": ["|", "ord"],
  "\\{": ["{", "open"],
  "\\}": ["}", "close"],
  "\\|": ["‖", "ord"],
};

class Parser {
  private i = 0;
  private atoms = 0;
  private style: Style | undefined;
  constructor(private readonly s: string) {}
  private fail(code: string, message: string): never {
    throw new VisualError(code, `Equation: ${message}`);
  }
  private skip() {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
  }
  private atom(
    text: string,
    cls: Cls,
    tag: "mi" | "mn" | "mo",
    style: Style = "normal",
    large = false,
  ): MathNode {
    if (++this.atoms > EQUATION_LIMITS.atoms)
      this.fail("EQUATION_LIMIT", "too many symbols");
    return {
      t: "atom",
      text,
      cls,
      tag,
      style: this.style && tag !== "mo" ? this.style : style,
      ...(large ? { large } : {}),
    };
  }
  parse(): MathNode {
    const row = this.row(0, false);
    if (this.i < this.s.length) this.fail("EQUATION_SYNTAX", "unbalanced }");
    return row;
  }
  /** `closed`: inside braces; "cell": an environment cell, ended by &, \\\\ or \\end. */
  private row(depth: number, closed: boolean | "cell"): MathNode {
    if (depth > EQUATION_LIMITS.depth)
      this.fail("EQUATION_LIMIT", "nesting exceeds limit");
    const items: MathNode[] = [];
    for (;;) {
      this.skip();
      const c = this.s[this.i];
      if (c === undefined) {
        if (closed === "cell") this.fail("EQUATION_SYNTAX", "missing \\end");
        if (closed) this.fail("EQUATION_SYNTAX", "missing }");
        break;
      }
      if (c === "}") {
        if (closed !== true) this.fail("EQUATION_SYNTAX", "unbalanced }");
        break;
      }
      if (
        closed === "cell" &&
        (c === "&" ||
          this.s.startsWith("\\\\", this.i) ||
          /^\\end(?![A-Za-z])/.test(this.s.slice(this.i, this.i + 5)))
      )
        break;
      if (c === "&")
        this.fail(
          "EQUATION_CHAR",
          "& separates columns only inside a matrix or environment",
        );
      if (c === "^" || c === "_") {
        this.i++;
        const argument = this.argument(depth + 1);
        let last = items.pop() ?? { t: "row", items: [] };
        if (last.t !== "scripts") last = { t: "scripts", base: last };
        const slot = c === "^" ? "sup" : "sub";
        if (last[slot]) this.fail("EQUATION_SYNTAX", `double ${c}`);
        last[slot] = argument;
        items.push(last);
        continue;
      }
      items.push(this.item(depth));
    }
    return { t: "row", items };
  }
  /** A braced group or one token (TeX argument rules). */
  private argument(depth: number): MathNode {
    this.skip();
    const c = this.s[this.i];
    if (c === undefined || c === "}" || c === "^" || c === "_")
      this.fail("EQUATION_SYNTAX", "missing argument");
    if (c === "{") return this.group(depth);
    if (/[0-9]/.test(c!)) {
      this.i++;
      return this.atom(c!, "ord", "mn");
    }
    return this.item(depth);
  }
  private group(depth: number): MathNode {
    this.i++;
    const row = this.row(depth + 1, true);
    this.i++;
    return row;
  }
  private item(depth: number): MathNode {
    const c = this.s[this.i]!;
    if (c === "{") return this.group(depth);
    if (c === "\\") return this.macro(depth);
    if (/[0-9]/.test(c)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/.exec(this.s.slice(this.i))![0];
      this.i += match.length;
      return this.atom(match, "ord", "mn");
    }
    if (/[A-Za-z]/.test(c)) {
      this.i++;
      return this.atom(c, "ord", "mi", "italic");
    }
    const known = CHARS[c];
    if (!known)
      this.fail("EQUATION_CHAR", `unsupported character ${JSON.stringify(c)}`);
    this.i++;
    return this.atom(known[0], known[1], "mo");
  }
  private name(): string {
    this.i++;
    const letters = /^[A-Za-z]+/.exec(this.s.slice(this.i))?.[0];
    const name = letters ?? this.s[this.i] ?? "";
    if (!name) this.fail("EQUATION_SYNTAX", "trailing backslash");
    this.i += name.length;
    return name;
  }
  private braced(): string {
    this.skip();
    if (this.s[this.i] !== "{") this.fail("EQUATION_SYNTAX", "expected {");
    const end = this.s.indexOf("}", this.i);
    if (end < 0) this.fail("EQUATION_SYNTAX", "missing }");
    const text = this.s.slice(this.i + 1, end);
    if (/[{\\]/.test(text))
      this.fail("EQUATION_SYNTAX", "text may not contain braces or macros");
    if (text.length > EQUATION_LIMITS.text)
      this.fail("EQUATION_LIMIT", "text too long");
    this.i = end + 1;
    return text;
  }
  private macro(depth: number): MathNode {
    const name = this.name();
    if (UNSAFE.test(name))
      this.fail("EQUATION_UNSAFE", `\\${name} is not allowed`);
    if (Object.hasOwn(SPACES, name)) return { t: "space", em: SPACES[name]! };
    if (name === "quad" || name === "qquad")
      return { t: "space", em: name === "quad" ? 1 : 2 };
    if (name === "{" || name === "}")
      return this.atom(name, name === "{" ? "open" : "close", "mo");
    if (name === "|") return this.atom("‖", "ord", "mo");
    if (Object.hasOwn(GREEK, name))
      return this.atom(GREEK[name]!, "ord", "mi", "italic");
    if (Object.hasOwn(GREEK_UPPER, name))
      return this.atom(GREEK_UPPER[name]!, "ord", "mi");
    if (Object.hasOwn(BIN, name)) return this.atom(BIN[name]!, "bin", "mo");
    if (Object.hasOwn(REL, name)) return this.atom(REL[name]!, "rel", "mo");
    if (Object.hasOwn(ORD, name)) return this.atom(ORD[name]!, "ord", "mo");
    if (Object.hasOwn(LARGE, name))
      return this.atom(LARGE[name]!, "op", "mo", "normal", true);
    if (FUNCTIONS.has(name)) return this.atom(name, "op", "mi");
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const num = this.argument(depth + 1);
      return { t: "frac", num, den: this.argument(depth + 1) };
    }
    if (name === "sqrt") {
      this.skip();
      if (this.s[this.i] === "[")
        this.fail("EQUATION_MACRO", "\\sqrt with an index is not supported");
      return { t: "sqrt", body: this.argument(depth + 1) };
    }
    if (ACCENTS.has(name as Accent))
      return {
        t: "accent",
        accent: name as Accent,
        body: this.argument(depth + 1),
      };
    if (name === "text") {
      const text = this.braced();
      if (++this.atoms > EQUATION_LIMITS.atoms)
        this.fail("EQUATION_LIMIT", "too many symbols");
      return { t: "text", text };
    }
    if (name === "operatorname") {
      const text = this.braced();
      if (!/^[A-Za-z]{1,32}$/.test(text))
        this.fail("EQUATION_SYNTAX", "operator names are letters only");
      return this.atom(text, "op", "mi");
    }
    if (name === "mathrm" || name === "mathbf" || name === "mathit") {
      const previous = this.style;
      this.style =
        name === "mathrm" ? "normal" : name === "mathbf" ? "bold" : "italic";
      const body = this.argument(depth + 1);
      this.style = previous;
      return body;
    }
    if (name === "begin") return this.environment(depth);
    if (name === "\\" || name === "end")
      this.fail(
        "EQUATION_SYNTAX",
        `\\${name} belongs inside \\begin{…} … \\end{…}`,
      );
    if (name === "left" || name === "right") {
      this.skip();
      const next =
        this.s[this.i] === "\\"
          ? this.s.slice(this.i, this.i + 2)
          : (this.s[this.i] ?? "");
      if (next === ".") {
        this.i++;
        return { t: "row", items: [] };
      }
      const delimiter = DELIMITERS[next];
      if (!delimiter)
        this.fail("EQUATION_SYNTAX", `\\${name} needs a delimiter`);
      this.i += next.length;
      return this.atom(delimiter[0], delimiter[1], "mo");
    }
    return this.fail("EQUATION_MACRO", `unsupported macro \\${name}`);
  }
  /** \\begin{env} cells separated by & and rows by \\\\, up to \\end{env}. */
  private environment(depth: number): MathNode {
    const env = this.braced() as Environment;
    if (!ENVIRONMENTS.has(env))
      this.fail("EQUATION_MACRO", `unsupported environment ${env}`);
    if (depth + 1 > EQUATION_LIMITS.depth)
      this.fail("EQUATION_LIMIT", "nesting exceeds limit");
    const rows: MathNode[][] = [[]];
    for (;;) {
      rows.at(-1)!.push(this.row(depth + 1, "cell"));
      if (rows.at(-1)!.length > EQUATION_LIMITS.columns)
        this.fail("EQUATION_LIMIT", "too many columns");
      if (this.s[this.i] === "&") {
        this.i++;
        continue;
      }
      if (this.s.startsWith("\\\\", this.i)) {
        this.i += 2;
        rows.push([]);
        // One more than the limit: a trailing \\\\ leaves an empty last row, dropped below.
        if (rows.length > EQUATION_LIMITS.rows + 1)
          this.fail("EQUATION_LIMIT", "too many rows");
        continue;
      }
      // \\end{env}
      this.i += 4;
      if (this.braced() !== env)
        this.fail("EQUATION_SYNTAX", `\\begin{${env}} ends with another \\end`);
      break;
    }
    const empty = (cell: MathNode) => cell.t === "row" && !cell.items.length;
    if (rows.length > 1 && rows.at(-1)!.every(empty)) rows.pop();
    if (rows.length > EQUATION_LIMITS.rows)
      this.fail("EQUATION_LIMIT", "too many rows");
    if (env === "cases" && rows.some((r) => r.length > 2))
      this.fail("EQUATION_SYNTAX", "cases rows have at most two columns");
    return { t: "table", env, rows };
  }
}

/** Parses the supported TeX subset. Throws VisualError for anything else. */
export function parseTex(tex: string): MathNode {
  if (typeof tex !== "string" || !tex.trim())
    throw new VisualError("EQUATION_SYNTAX", "Equation: empty");
  if (tex.length > EQUATION_LIMITS.chars)
    throw new VisualError("EQUATION_LIMIT", "Equation: too long");
  if (/[^\x20-\x7e\n\t]/.test(tex))
    throw new VisualError(
      "EQUATION_CHAR",
      "Equation: use ASCII TeX; write symbols as macros",
    );
  if (/[$#%~"`@]/.test(tex))
    throw new VisualError("EQUATION_CHAR", "Equation: unsupported character");
  return new Parser(tex).parse();
}

// Layout, in em units of the node's font size; baseline at y = 0, y grows downwards.
interface Box {
  w: number;
  a: number;
  d: number;
  glyphs: EquationLayout["glyphs"];
  rules: EquationLayout["rules"];
  strokes: { path: (string | number)[]; width: number }[];
}
const empty = (): Box => ({
  w: 0,
  a: 0,
  d: 0,
  glyphs: [],
  rules: [],
  strokes: [],
});
function charWidth(ch: string): number {
  if (/[0-9]/.test(ch)) return 0.5;
  if (/[fijlt]/.test(ch)) return 0.3;
  if (/[mw]/.test(ch)) return 0.72;
  if (/[a-z]/.test(ch)) return 0.5;
  if (/[IJ]/.test(ch)) return 0.4;
  if (/[MW]/.test(ch)) return 0.9;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[α-ω]|[ϵϑϕ]/.test(ch)) return 0.55;
  if (/[Α-Ω]/.test(ch)) return 0.68;
  if (ch === " ") return 0.25;
  if (/[()[\]]/.test(ch)) return 0.34;
  if (/[{}]/.test(ch)) return 0.48;
  if (/[|∣]/.test(ch)) return 0.22;
  if (/[,.;:′'!]/.test(ch)) return 0.28;
  if (/[?/]/.test(ch)) return 0.44;
  if (/[→←⇒⇐↦…⋯∞]/.test(ch)) return 1;
  if (ch === "⟺") return 1.4;
  if (/[∑∏]/.test(ch)) return 0.9;
  if (/[∫∮]/.test(ch)) return 0.5;
  return 0.62;
}
const textWidth = (text: string) =>
  [...text].reduce((sum, ch) => sum + charWidth(ch), 0);
function shift(target: Box, box: Box, dx: number, dy: number) {
  for (const g of box.glyphs)
    target.glyphs.push({ ...g, x: g.x + dx, y: g.y + dy });
  for (const r of box.rules)
    target.rules.push({ ...r, x: r.x + dx, y: r.y + dy });
  for (const s of box.strokes)
    target.strokes.push({
      width: s.width,
      path: s.path.map((v, i) => {
        if (typeof v === "string") return v;
        // Coordinates alternate x, y after each command letter.
        let k = i - 1;
        while (typeof s.path[k] !== "string") k--;
        return (i - k) % 2 === 1 ? v + dx : v + dy;
      }),
    });
}
const classOf = (n: MathNode): Cls | "space" =>
  n.t === "atom"
    ? n.cls
    : n.t === "scripts"
      ? classOf(n.base)
      : n.t === "space"
        ? "space"
        : "ord";
function spacing(left: Cls, right: Cls): number {
  if ((left === "rel") !== (right === "rel")) return 0.278;
  if (left === "rel") return 0;
  if (left === "bin" || right === "bin") return 0.222;
  if (left === "punct") return 0.167;
  if (left === "op" && (right === "ord" || right === "op")) return 0.167;
  if (right === "op" && (left === "ord" || left === "close")) return 0.167;
  return 0;
}
function layout(node: MathNode, s: number): Box {
  switch (node.t) {
    case "atom": {
      const size = node.large ? s * 1.25 : s;
      const width = textWidth(node.text) * size;
      return {
        w: width,
        a: (node.large ? 0.9 : 0.72) * s,
        d: (node.large ? 0.32 : 0.22) * s,
        glyphs: [
          { x: 0, y: 0, text: node.text, size, width, style: node.style },
        ],
        rules: [],
        strokes: [],
      };
    }
    case "text": {
      const width = textWidth(node.text) * s;
      return {
        w: width,
        a: 0.72 * s,
        d: 0.22 * s,
        rules: [],
        strokes: [],
        glyphs: node.text
          ? [{ x: 0, y: 0, text: node.text, size: s, width, style: "normal" }]
          : [],
      };
    }
    case "space":
      return { ...empty(), w: node.em * s };
    case "row": {
      const box = empty();
      const classes = node.items.map(classOf);
      // A binary operator with no left operand (or no right one) is an ordinary symbol.
      classes.forEach((c, i) => {
        if (c !== "bin") return;
        const before = classes
          .slice(0, i)
          .filter((k) => k !== "space")
          .at(-1);
        const after = classes.slice(i + 1).find((k) => k !== "space");
        if (
          !before ||
          ["bin", "op", "rel", "open", "punct"].includes(before) ||
          !after ||
          ["rel", "close", "punct"].includes(after)
        )
          classes[i] = "ord";
      });
      let previous: Cls | undefined;
      node.items.forEach((item, i) => {
        const cls = classes[i]!;
        const child = layout(item, s);
        if (cls !== "space" && previous) {
          const gap = spacing(previous, cls);
          // Scripts keep only thin operator spacing, as in TeX's script styles.
          box.w +=
            s < 1 &&
            (previous === "bin" ||
              previous === "rel" ||
              cls === "bin" ||
              cls === "rel")
              ? 0
              : gap * s;
        }
        shift(box, child, box.w, 0);
        box.w += child.w;
        box.a = Math.max(box.a, child.a);
        box.d = Math.max(box.d, child.d);
        if (cls !== "space") previous = cls;
      });
      return box;
    }
    case "scripts": {
      const base = layout(node.base, s),
        box = empty(),
        small = Math.max(0.5, s * 0.7);
      shift(box, base, 0, 0);
      const sup = node.sup && layout(node.sup, small),
        sub = node.sub && layout(node.sub, small);
      let supY = sup ? -Math.max(0.4 * s, base.a - 0.3 * s) : 0;
      let subY = sub ? Math.max(0.18 * s, base.d + 0.08 * s) : 0;
      if (sup && sub) {
        const gap = subY - sub.a - (supY + sup.d);
        if (gap < 0.1 * s) subY += 0.1 * s - gap;
      }
      if (sup) shift(box, sup, base.w + 0.04 * s, supY);
      if (sub) shift(box, sub, base.w + 0.02 * s, subY);
      box.w =
        base.w +
        Math.max(sup ? sup.w + 0.04 * s : 0, sub ? sub.w + 0.02 * s : 0) +
        0.04 * s;
      box.a = Math.max(base.a, sup ? -supY + sup.a : 0);
      box.d = Math.max(base.d, sub ? subY + sub.d : 0);
      return box;
    }
    case "frac": {
      const inner = s >= 1 ? 0.85 * s : Math.max(0.5, 0.75 * s);
      const num = layout(node.num, inner),
        den = layout(node.den, inner),
        box = empty();
      const axis = 0.25 * s,
        t = 0.05 * s,
        gap = 0.12 * s;
      box.w = Math.max(num.w, den.w) + 0.2 * s;
      const numY = -(axis + t / 2 + gap + num.d),
        denY = -axis + t / 2 + gap + den.a;
      shift(box, num, (box.w - num.w) / 2, numY);
      shift(box, den, (box.w - den.w) / 2, denY);
      box.rules.push({
        x: 0.05 * s,
        y: -(axis + t / 2),
        width: box.w - 0.1 * s,
        height: t,
      });
      box.a = -numY + num.a;
      box.d = denY + den.d;
      return box;
    }
    case "sqrt": {
      const body = layout(node.body, s),
        box = empty();
      const top = Math.max(body.a, 0.7 * s) + 0.12 * s,
        bottom = Math.max(body.d, 0.2 * s),
        sign = 0.55 * s;
      shift(box, body, sign + 0.06 * s, 0);
      box.w = sign + body.w + 0.16 * s;
      box.strokes.push({
        width: 0.055 * s,
        path: [
          "M",
          0,
          -0.24 * s,
          "L",
          0.12 * s,
          -0.3 * s,
          "L",
          0.28 * s,
          bottom,
          "L",
          sign,
          -top,
          "L",
          box.w - 0.02 * s,
          -top,
        ],
      });
      box.a = top + 0.06 * s;
      box.d = bottom + 0.04 * s;
      return box;
    }
    case "accent": {
      const body = layout(node.body, s),
        box = empty();
      shift(box, body, 0, 0);
      box.w = Math.max(body.w, 0.4 * s);
      const cx = box.w / 2,
        y = -(Math.max(body.a, 0.5 * s) + 0.1 * s),
        width = 0.05 * s;
      if (node.accent === "bar")
        box.rules.push({
          x: 0.04 * s,
          y: y - width / 2,
          width: box.w - 0.08 * s,
          height: width,
        });
      else if (node.accent === "hat")
        box.strokes.push({
          width,
          path: [
            "M",
            cx - 0.17 * s,
            y + 0.02 * s,
            "L",
            cx,
            y - 0.12 * s,
            "L",
            cx + 0.17 * s,
            y + 0.02 * s,
          ],
        });
      else if (node.accent === "vec")
        box.strokes.push({
          width,
          path: [
            "M",
            0.04 * s,
            y,
            "L",
            box.w - 0.04 * s,
            y,
            "M",
            box.w - 0.16 * s,
            y - 0.08 * s,
            "L",
            box.w - 0.04 * s,
            y,
            "L",
            box.w - 0.16 * s,
            y + 0.08 * s,
          ],
        });
      else if (node.accent === "tilde")
        box.strokes.push({
          width,
          path: [
            "M",
            cx - 0.2 * s,
            y + 0.02 * s,
            "Q",
            cx - 0.1 * s,
            y - 0.12 * s,
            cx,
            y,
            "Q",
            cx + 0.1 * s,
            y + 0.12 * s,
            cx + 0.2 * s,
            y - 0.02 * s,
          ],
        });
      else
        box.rules.push({
          x: cx - 0.045 * s,
          y: y - 0.045 * s,
          width: 0.09 * s,
          height: 0.09 * s,
        });
      box.a = -y + 0.14 * s;
      box.d = body.d;
      return box;
    }
    case "table":
      return table(node, s);
  }
}
/** Column alignment of an environment: centred matrices, left cases, right/left pairs. */
function columnAlign(
  env: Environment,
  columns: number,
): ("left" | "center" | "right")[] {
  return Array.from({ length: columns }, (_, j) =>
    env === "cases"
      ? "left"
      : env === "aligned"
        ? j % 2
          ? "left"
          : "right"
        : "center",
  );
}
/** A delimiter drawn as a stroke from top to bottom, `width` wide, in local x. */
function fence(
  ch: string,
  right: boolean,
  width: number,
  top: number,
  bottom: number,
  s: number,
): (string | number)[] {
  const x = (v: number) => (right ? width - v : v);
  const mid = (top + bottom) / 2,
    q = Math.min(0.12 * s, (bottom - top) / 4);
  switch (ch) {
    case "(":
    case ")":
      return ["M", x(0.3 * s), top, "Q", x(-0.04 * s), mid, x(0.3 * s), bottom];
    case "[":
    case "]":
      return [
        "M",
        x(0.3 * s),
        top,
        "L",
        x(0.1 * s),
        top,
        "L",
        x(0.1 * s),
        bottom,
        "L",
        x(0.3 * s),
        bottom,
      ];
    case "|":
      return ["M", x(0.17 * s), top, "L", x(0.17 * s), bottom];
    case "‖":
      return [
        "M",
        x(0.1 * s),
        top,
        "L",
        x(0.1 * s),
        bottom,
        "M",
        x(0.24 * s),
        top,
        "L",
        x(0.24 * s),
        bottom,
      ];
    default:
      // { and }
      return [
        "M",
        x(0.32 * s),
        top,
        "Q",
        x(0.17 * s),
        top,
        x(0.17 * s),
        top + q,
        "L",
        x(0.17 * s),
        mid - q,
        "Q",
        x(0.17 * s),
        mid,
        x(0.04 * s),
        mid,
        "Q",
        x(0.17 * s),
        mid,
        x(0.17 * s),
        mid + q,
        "L",
        x(0.17 * s),
        bottom - q,
        "Q",
        x(0.17 * s),
        bottom,
        x(0.32 * s),
        bottom,
      ];
  }
}
function table(node: Extract<MathNode, { t: "table" }>, s: number): Box {
  const cells = node.rows.map((row) => row.map((cell) => layout(cell, s)));
  const columns = Math.max(...node.rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, j) =>
    Math.max(0, ...cells.map((row) => row[j]?.w ?? 0)),
  );
  const align = columnAlign(node.env, columns);
  // Gaps between columns: a quad in matrices and cases; aligned pairs sit together.
  const gap = (j: number) =>
    node.env === "aligned" ? (j % 2 ? 0.278 * s : 1.5 * s) : 1 * s;
  const starts: number[] = [];
  let x = 0;
  widths.forEach((w, j) => {
    if (j) x += gap(j);
    starts.push(x);
    x += w;
  });
  const [left, right] = FENCES[node.env];
  const fenceWidth = 0.36 * s,
    padLeft = left ? fenceWidth + 0.1 * s : 0,
    padRight = right ? fenceWidth + 0.1 * s : 0;
  const rows = cells.map((row) => ({
    a: Math.max(0.72 * s, ...row.map((c) => c.a)),
    d: Math.max(0.22 * s, ...row.map((c) => c.d)),
  }));
  const rowGap = 0.3 * s;
  const height =
    rows.reduce((sum, r) => sum + r.a + r.d, 0) + rowGap * (rows.length - 1);
  const axis = 0.25 * s,
    top = -(axis + height / 2);
  const box = empty();
  let y = top;
  cells.forEach((row, i) => {
    const baseline = y + rows[i]!.a;
    row.forEach((cell, j) => {
      const free = widths[j]! - cell.w;
      const dx =
        align[j] === "center" ? free / 2 : align[j] === "right" ? free : 0;
      shift(box, cell, padLeft + starts[j]! + dx, baseline);
    });
    y = baseline + rows[i]!.d + rowGap;
  });
  box.w = padLeft + x + padRight;
  const fenceTop = top - 0.1 * s,
    fenceBottom = top + height + 0.1 * s;
  if (left)
    box.strokes.push({
      width: 0.06 * s,
      path: fence(left, false, fenceWidth, fenceTop, fenceBottom, s),
    });
  if (right) {
    const stroke = {
      width: 0.06 * s,
      path: fence(right, true, fenceWidth, fenceTop, fenceBottom, s),
    };
    const placed = empty();
    placed.strokes.push(stroke);
    shift(box, placed, box.w - fenceWidth, 0);
  }
  box.a = -fenceTop;
  box.d = fenceBottom;
  return box;
}

const parsed = new Map<string, { node: MathNode; box: Box }>();
function prepared(tex: string) {
  let entry = parsed.get(tex);
  if (!entry) {
    const node = parseTex(tex);
    entry = { node, box: layout(node, 1) };
    if (parsed.size >= 256) parsed.delete(parsed.keys().next().value!);
    parsed.set(tex, entry);
  }
  return entry;
}
const round = (n: number) => Math.round(finite(n, "equation") * 1e4) / 1e4;
const fmt = (n: number) => String(round(n));

/** Lays out `tex` at `fontSize` pixels, anchored like SVG text (start/middle/end). */
export function layoutEquation(
  tex: string,
  fontSize: number,
  align: "start" | "middle" | "end" = "start",
): EquationLayout {
  const { box } = prepared(tex),
    k = fontSize;
  const offset = align === "middle" ? -box.w / 2 : align === "end" ? -box.w : 0;
  return {
    tex,
    width: round(box.w * k),
    ascent: round(box.a * k),
    descent: round(box.d * k),
    offset: round(offset * k),
    glyphs: box.glyphs.map((g) => ({
      ...g,
      x: round((g.x + offset) * k),
      y: round(g.y * k),
      size: round(g.size * k),
      width: round(g.width * k),
    })),
    rules: box.rules.map((r) => ({
      x: round((r.x + offset) * k),
      y: round(r.y * k),
      width: round(r.width * k),
      height: round(r.height * k),
    })),
    strokes: box.strokes.map((s) => ({
      width: round(s.width * k),
      d: s.path
        .map((v, i) => {
          if (typeof v === "string") return v;
          let c = i - 1;
          while (typeof s.path[c] !== "string") c--;
          return fmt(((i - c) % 2 === 1 ? v + offset : v) * k);
        })
        .join(" "),
    })),
  };
}

/** Validates `tex` (throws VisualError) without laying it out for a size. */
export function checkEquation(tex: string): void {
  prepared(tex);
}

/** MathML for the equation, as a sanitized element tree (MarkupView / serializeMarkup render it). */
export function equationMathML(tex: string, label: string): MarkupElement {
  const { node } = prepared(tex);
  const el = (
    tag: string,
    children: MarkupElement["children"],
    attrs: MarkupElement["attrs"] = {},
  ): MarkupElement => ({ tag, attrs, children });
  const accents: Record<Accent, string> = {
    hat: "^",
    bar: "¯",
    vec: "→",
    tilde: "~",
    dot: "˙",
  };
  function build(n: MathNode): MarkupElement {
    switch (n.t) {
      case "atom":
        return el(
          n.tag,
          [n.text],
          n.style === "bold"
            ? { mathvariant: "bold" }
            : n.tag === "mi" && n.style === "normal" && [...n.text].length === 1
              ? { mathvariant: "normal" }
              : {},
        );
      case "text":
        return el("mtext", [n.text]);
      case "space":
        return el("mspace", [], { width: `${n.em}em` });
      case "row":
        return el("mrow", n.items.map(build));
      case "scripts": {
        const base = build(n.base);
        if (n.sup && n.sub)
          return el("msubsup", [base, build(n.sub), build(n.sup)]);
        return n.sup
          ? el("msup", [base, build(n.sup)])
          : el("msub", [base, build(n.sub!)]);
      }
      case "frac":
        return el("mfrac", [build(n.num), build(n.den)]);
      case "sqrt":
        return el("msqrt", [build(n.body)]);
      case "accent":
        return el("mover", [build(n.body), el("mo", [accents[n.accent]])], {
          accent: "true",
        });
      case "table": {
        const [left, right] = FENCES[n.env];
        const columns = Math.max(...n.rows.map((row) => row.length));
        const table = el(
          "mtable",
          n.rows.map((row) =>
            el(
              "mtr",
              row.map((cell) => el("mtd", [build(cell)])),
            ),
          ),
          n.env === "cases" || n.env === "aligned"
            ? { columnalign: columnAlign(n.env, columns).join(" ") }
            : {},
        );
        return el("mrow", [
          ...(left ? [el("mo", [left])] : []),
          table,
          ...(right ? [el("mo", [right])] : []),
        ]);
      }
    }
  }
  return sanitizeMarkup(
    el("math", [build(node)], { display: "inline", alttext: label }),
  );
}
