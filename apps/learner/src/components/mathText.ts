/** The TeX that course prose and companion replies use (`$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` on their own), read into a small formula tree. Nothing is executed and no markup is
 * injected: the web app draws the tree as MathML elements (MathFormula.web.tsx), the native app
 * shows its readable text, and screen readers hear the spoken form in the learner's language
 * ("x squared", not "x caret 2"). Unknown commands show their name; they never fail the text. */
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/** What a screen reader says for a symbol: a catalog word, or the symbol itself. */
export type Say = { key: MessageKey } | { literal: string };
export type MathNode =
  | { kind: "row"; children: MathNode[] }
  | { kind: "mi"; text: string; variant?: "normal" | "bold"; say?: Say }
  | { kind: "mn"; text: string }
  | { kind: "mo"; text: string; say?: Say; largeop?: boolean; limits?: "limit" | "operator"; binary?: boolean; prefix?: boolean; infix?: boolean }
  | { kind: "mtext"; text: string }
  | { kind: "frac"; numerator: MathNode; denominator: MathNode; binomial?: boolean }
  | { kind: "root"; radicand: MathNode; index?: MathNode }
  | { kind: "script"; base: MathNode; sub?: MathNode; sup?: MathNode }
  | { kind: "accent"; base: MathNode; mark: string; name: AccentName; under?: boolean }
  | { kind: "stack"; base: MathNode; over?: MathNode; under?: MathNode }
  | { kind: "fenced"; open: string; close: string; body: MathNode }
  | { kind: "table"; rows: MathNode[][]; open: string; close: string; say: "matrix" | "cases" | "lines" }
  | { kind: "space"; em: number };
type AccentName = "hat" | "bar" | "tilde" | "vec" | "dot" | "ddot" | "underline";

const sayKey = (key: string): Say => ({ key: key as MessageKey });
// i18n-ignore: TeX command names and the glyphs they draw, not text for people
const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ",
  varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
/** Operators, relations and other symbols: glyph and the catalog word a screen reader says. */
// i18n-ignore: TeX command names, glyphs and catalog key suffixes, not text for people
const OPERATORS: Record<string, [glyph: string, say?: string, binary?: boolean]> = {
  cdot: ["·", "times", true], times: ["×", "times", true], div: ["÷", "dividedBy", true], ast: ["∗", "times", true],
  pm: ["±", "plusMinus", true], mp: ["∓", undefined, true], circ: ["∘", undefined, true], bullet: ["•", undefined, true], star: ["⋆", undefined, true],
  le: ["≤", "lessOrEqual", true], leq: ["≤", "lessOrEqual", true], ge: ["≥", "greaterOrEqual", true], geq: ["≥", "greaterOrEqual", true],
  ne: ["≠", "notEqual", true], neq: ["≠", "notEqual", true], approx: ["≈", "approx", true], equiv: ["≡", "equiv", true],
  sim: ["∼", "sim", true], simeq: ["≃", "approx", true], propto: ["∝", "proportional", true], ll: ["≪", undefined, true], gg: ["≫", undefined, true],
  to: ["→", "to", true], rightarrow: ["→", "to", true], leftarrow: ["←", undefined, true], gets: ["←", undefined, true],
  Rightarrow: ["⇒", "implies", true], implies: ["⟹", "implies", true], Leftarrow: ["⇐", undefined, true],
  iff: ["⟺", "iff", true], Leftrightarrow: ["⇔", "iff", true], leftrightarrow: ["↔", undefined, true], mapsto: ["↦", "mapsTo", true],
  longrightarrow: ["⟶", "to", true], uparrow: ["↑"], downarrow: ["↓"],
  in: ["∈", "in", true], notin: ["∉", "notIn", true], ni: ["∋", undefined, true], subset: ["⊂", "subset", true], subseteq: ["⊆", "subsetEq", true],
  supset: ["⊃", undefined, true], supseteq: ["⊇", undefined, true], cup: ["∪", "union", true], cap: ["∩", "intersection", true],
  setminus: ["∖", undefined, true], land: ["∧", undefined, true], wedge: ["∧", undefined, true], lor: ["∨", undefined, true], vee: ["∨", undefined, true],
  neg: ["¬"], lnot: ["¬"], forall: ["∀", "forAll"], exists: ["∃", "exists"], mid: ["∣", undefined, true], parallel: ["∥", undefined, true],
  perp: ["⊥", undefined, true], oplus: ["⊕", undefined, true], otimes: ["⊗", undefined, true], odot: ["⊙", undefined, true],
  colon: [":"], vert: ["|", "bar"], Vert: ["‖", "norm"], "|": ["‖", "norm"], lvert: ["|", "bar"], rvert: ["|", "bar"], lVert: ["‖", "norm"], rVert: ["‖", "norm"],
  langle: ["⟨"], rangle: ["⟩"], lfloor: ["⌊"], rfloor: ["⌋"], lceil: ["⌈"], rceil: ["⌉"], lbrace: ["{", "openBrace"], rbrace: ["}", "closeBrace"],
  lbrack: ["[", "openBracket"], rbrack: ["]", "closeBracket"], backslash: ["∖"],
  ldots: ["…", "dots"], dots: ["…", "dots"], cdots: ["⋯", "dots"], vdots: ["⋮", "dots"], ddots: ["⋱", "dots"], dotsc: ["…", "dots"], dotsb: ["⋯", "dots"],
  prime: ["′", "prime"], angle: ["∠"], triangle: ["△"], degree: ["°", "degrees"],
};
/** Symbols that read as identifiers. */
// i18n-ignore: TeX command names, glyphs and catalog key suffixes, not text for people
const IDENTIFIERS: Record<string, [glyph: string, say?: string]> = {
  infty: ["∞", "infinity"], partial: ["∂", "partial"], nabla: ["∇", "nabla"], emptyset: ["∅"], varnothing: ["∅"],
  ell: ["ℓ"], hbar: ["ℏ"], Re: ["ℜ"], Im: ["ℑ"], aleph: ["ℵ"], top: ["⊤", "transpose"], bot: ["⊥"], imath: ["ı"], jmath: ["ȷ"],
};
/** Large operators: their limits go under and over in display math. */
// i18n-ignore: TeX command names, glyphs and catalog key suffixes, not text for people
const LARGE: Record<string, [glyph: string, say?: string]> = {
  sum: ["∑", "sum"], prod: ["∏", "product"], coprod: ["∐"], int: ["∫", "integral"], iint: ["∬", "integral"], iiint: ["∭", "integral"],
  oint: ["∮", "integral"], bigcup: ["⋃", "union"], bigcap: ["⋂", "intersection"], bigoplus: ["⨁"], bigotimes: ["⨂"],
};
/** Named functions, set upright; `lim`, `max` and friends take limits like a large operator. */
// i18n-ignore: TeX function names and catalog key suffixes, not text for people
const FUNCTIONS: Record<string, [say?: string, limits?: boolean]> = {
  log: ["log"], ln: ["ln"], exp: ["exp"], sin: ["sin"], cos: ["cos"], tan: ["tan"], sec: [], csc: [], cot: [], arcsin: [], arccos: [], arctan: [],
  sinh: [], cosh: [], tanh: [], lg: [], det: [, true], dim: [], ker: [], deg: [], gcd: [, true], arg: [], Pr: [, true],
  max: ["max", true], min: ["min", true], sup: [, true], inf: [, true], lim: ["limit", true], limsup: [, true], liminf: [, true],
  argmax: [, true], argmin: [, true],
};
// i18n-ignore: plain characters TeX draws as operators, and catalog key suffixes
const PLAIN_OPERATORS: Record<string, [glyph: string, say?: string, binary?: boolean]> = {
  "=": ["=", "equals", true], "+": ["+", "plus", true], "-": ["−", "minus", true], "<": ["<", "lessThan", true], ">": [">", "greaterThan", true],
  "/": ["/", "dividedBy"], "*": ["×", "times", true], "(": ["(", "openParen"], ")": [")", "closeParen"], "[": ["[", "openBracket"],
  "]": ["]", "closeBracket"], "|": ["|", "bar"], "!": ["!", "factorial"], "'": ["′", "prime"], ",": [","], ";": [";"], ":": [":"], ".": ["."],
  "?": ["?"], "×": ["×", "times", true], "·": ["·", "times", true], "−": ["−", "minus", true], "≤": ["≤", "lessOrEqual", true],
  "≥": ["≥", "greaterOrEqual", true], "≠": ["≠", "notEqual", true], "≈": ["≈", "approx", true], "→": ["→", "to", true], "±": ["±", "plusMinus", true],
};
const DELIMITERS: Record<string, string> = {
  "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", ".": "", "/": "/", "<": "⟨", ">": "⟩",
  "\\{": "{", "\\}": "}", "\\lbrace": "{", "\\rbrace": "}", "\\|": "‖", "\\vert": "|", "\\Vert": "‖", "\\lvert": "|", "\\rvert": "|",
  "\\lVert": "‖", "\\rVert": "‖", "\\langle": "⟨", "\\rangle": "⟩", "\\lfloor": "⌊", "\\rfloor": "⌋", "\\lceil": "⌈", "\\rceil": "⌉",
  "\\lbrack": "[", "\\rbrack": "]", "\\uparrow": "↑", "\\downarrow": "↓", "\\backslash": "∖",
};
const ACCENTS: Record<string, [mark: string, name: AccentName, under?: boolean]> = {
  hat: ["ˆ", "hat"], widehat: ["ˆ", "hat"], bar: ["‾", "bar"], overline: ["‾", "bar"], tilde: ["˜", "tilde"], widetilde: ["˜", "tilde"],
  vec: ["→", "vec"], overrightarrow: ["→", "vec"], dot: ["˙", "dot"], ddot: ["¨", "ddot"], underline: ["‾", "underline", true],
};
const SPACES: Record<string, number> = { ",": 3 / 18, ":": 4 / 18, ">": 4 / 18, ";": 5 / 18, " ": 1 / 3, quad: 1, qquad: 2, enspace: 0.5, thinspace: 3 / 18, medspace: 4 / 18, thickspace: 5 / 18 };
const SIZING = /^(?:big|Big|bigg|Bigg)(?:l|r|m)?$/;
const IGNORED = new Set(["displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits", "nonumber", "notag", "left", "right", "middle", "!", "negthinspace", "allowbreak", "nobreak", "strut"]);
const SKIP_ARGUMENT = new Set(["label", "tag", "color", "hspace", "vspace", "phantom", "hphantom", "vphantom"]);
const TEXT_COMMANDS = new Set(["text", "textrm", "textit", "textbf", "textsf", "texttt", "textnormal", "mbox", "hbox", "textup", "emph"]);
const ESCAPES: Record<string, string> = { _: "_", "%": "%", "&": "&", "#": "#", $: "$", "{": "{", "}": "}", " ": " ", ",": " ", ";": " ", ":": " ", "\\": "\\", "~": "~", "^": "^" };
const DOUBLE_STRUCK: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", E: "𝔼", P: "ℙ", H: "ℍ" };
const SCRIPT_LETTERS: Record<string, string> = { L: "ℒ", F: "ℱ", H: "ℋ", B: "ℬ", E: "ℰ", M: "ℳ", R: "ℛ", I: "ℐ", A: "𝒜", C: "𝒞", D: "𝒟", N: "𝒩", O: "𝒪", P: "𝒫", S: "𝒮", T: "𝒯", X: "𝒳", Y: "𝒴", Z: "𝒵", G: "𝒢", K: "𝒦", U: "𝒰", V: "𝒱", W: "𝒲", Q: "𝒬", J: "𝒥" };
const MAX_DEPTH = 40;

/** Whether a node can be the left operand of a binary operator. */
const operand = (node: MathNode | undefined) =>
  node !== undefined && !(node.kind === "mo" && !node.limits && ![")", "]", "}", "!", "′", "|", "‖"].includes(node.text)) && node.kind !== "space";
const row = (children: MathNode[]): MathNode => (children.length === 1 ? children[0]! : { kind: "row", children });
const operator = (glyph: string, say?: string, binary?: boolean): MathNode => ({ kind: "mo", text: glyph, ...(say ? { say: sayKey(`mathText.say.${say}`) } : {}), ...(binary ? { binary } : {}) });

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly source: string) {}

  parse(): MathNode {
    const children: MathNode[] = [];
    while (this.i < this.source.length) {
      children.push(...this.list(() => false));
      if (this.peek() === "}") this.i++; // an unmatched brace is dropped, not the rest
    }
    return row(children);
  }
  private peek() {
    return this.source[this.i];
  }
  private skipSpace() {
    while (this.i < this.source.length && /\s/.test(this.source[this.i]!)) this.i++;
  }
  /** `\name` or `\c` at the cursor, without moving it. */
  private commandAt(at = this.i) {
    if (this.source[at] !== "\\") return undefined;
    return /^\\(?:[a-zA-Z]+\*?|.)/.exec(this.source.slice(at))?.[0];
  }
  private readCommand() {
    const command = this.commandAt()!;
    this.i += command.length;
    return command.slice(1);
  }
  /** Atoms until `stop` says so, a closing brace or the end; `^`/`_` attach to the atom before. */
  private list(stop: () => boolean): MathNode[] {
    const out: MathNode[] = [];
    this.depth++;
    try {
      while (true) {
        this.skipSpace();
        if (this.i >= this.source.length || this.peek() === "}" || stop()) break;
        if (this.depth > MAX_DEPTH) {
          out.push({ kind: "mtext", text: this.source.slice(this.i) });
          this.i = this.source.length;
          break;
        }
        const c = this.peek()!;
        if (c === "^" || c === "_") {
          this.i++;
          const last = out.pop() ?? { kind: "mi", text: "" };
          out.push(this.attach(last, c, this.argument()));
          continue;
        }
        if (c === "'") {
          this.i++;
          out.push(this.attach(out.pop() ?? { kind: "mi", text: "" }, "^", operator("′", "prime")));
          continue;
        }
        let atom = this.atom();
        // A minus or plus with nothing to its left is a sign, not a binary operation.
        if (atom?.kind === "mo" && atom.binary && (atom.text === "−" || atom.text === "+" || atom.text === "±") && !operand(out.at(-1)))
          atom = { ...atom, binary: false, prefix: true };
        if (atom) out.push(atom);
      }
    } finally {
      this.depth--;
    }
    return out;
  }
  private attach(base: MathNode, mark: "^" | "_", value: MathNode): MathNode {
    if (base.kind === "script" && !(mark === "^" ? base.sup : base.sub))
      return { ...base, [mark === "^" ? "sup" : "sub"]: value };
    return { kind: "script", base, [mark === "^" ? "sup" : "sub"]: value };
  }
  /** One argument: a braced group, a command atom or a single character. */
  private argument(): MathNode {
    this.skipSpace();
    if (this.peek() === "{") return this.group();
    if (this.peek() === "\\") return this.atom() ?? { kind: "row", children: [] };
    const c = this.source[this.i] ?? "";
    this.i += c ? 1 : 0;
    if (!c) return { kind: "row", children: [] };
    return /[0-9]/.test(c) ? { kind: "mn", text: c } : this.character(c);
  }
  private group(): MathNode {
    this.i++; // {
    const children = this.list(() => false);
    if (this.peek() === "}") this.i++;
    return row(children);
  }
  /** The raw text of a braced group, with its braces balanced. */
  private rawGroup(): string {
    this.skipSpace();
    if (this.peek() !== "{") {
      const command = this.commandAt();
      if (command) {
        this.i += command.length;
        return command;
      }
      return this.source[this.i++] ?? "";
    }
    let depth = 0;
    const start = this.i;
    for (; this.i < this.source.length; this.i++) {
      const c = this.source[this.i];
      if (c === "\\") {
        this.i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        this.i++;
        return this.source.slice(start + 1, this.i - 1);
      }
    }
    return this.source.slice(start + 1);
  }
  private optional(): string | undefined {
    this.skipSpace();
    if (this.peek() !== "[") return undefined;
    const end = this.source.indexOf("]", this.i);
    if (end < 0) return undefined;
    const value = this.source.slice(this.i + 1, end);
    this.i = end + 1;
    return value;
  }
  private character(c: string): MathNode {
    const plain = PLAIN_OPERATORS[c];
    if (plain) return operator(...plain);
    return { kind: "mi", text: c };
  }
  private delimiter(): string {
    this.skipSpace();
    const command = this.commandAt();
    if (command) {
      this.i += command.length;
      return DELIMITERS[command] ?? command.slice(1);
    }
    const c = this.source[this.i] ?? "";
    this.i += c ? 1 : 0;
    return DELIMITERS[c] ?? c;
  }
  private atom(): MathNode | undefined {
    const c = this.peek()!;
    if (c === "{") return this.group();
    if (c === "&") {
      this.i++;
      return undefined;
    }
    if (c === "~") {
      this.i++;
      return { kind: "space", em: 1 / 3 };
    }
    if (/[0-9]/.test(c)) {
      const number = /^[0-9]+(?:\.[0-9]+)?/.exec(this.source.slice(this.i))![0];
      this.i += number.length;
      return { kind: "mn", text: number };
    }
    if (c !== "\\") {
      const character = String.fromCodePoint(this.source.codePointAt(this.i)!);
      this.i += character.length;
      return this.character(character);
    }
    const name = this.readCommand();
    if (name === "\\") return { kind: "space", em: 0.5 };
    if (ESCAPES[name] !== undefined && !/[a-zA-Z]/.test(name)) {
      if (SPACES[name] !== undefined) return { kind: "space", em: SPACES[name]! };
      return name === "{" || name === "}" ? operator(name, name === "{" ? "openBrace" : "closeBrace") : { kind: "mi", text: ESCAPES[name]! };
    }
    if (SPACES[name] !== undefined) return { kind: "space", em: SPACES[name]! };
    if (name === "left") {
      const open = this.delimiter();
      const body = this.list(() => this.commandAt() === "\\right");
      if (this.commandAt() === "\\right") this.i += 6;
      const close = this.delimiter();
      return { kind: "fenced", open, close, body: row(body) };
    }
    if (name === "middle") return operator(this.delimiter());
    if (name === "right") return operator(this.delimiter());
    if (SIZING.test(name) || IGNORED.has(name)) return undefined;
    if (SKIP_ARGUMENT.has(name)) {
      this.rawGroup();
      return name === "hspace" ? { kind: "space", em: 0.5 } : undefined;
    }
    if (name === "textcolor") {
      this.rawGroup();
      return this.argument();
    }
    if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac")
      return { kind: "frac", numerator: this.argument(), denominator: this.argument() };
    if (name === "binom" || name === "dbinom" || name === "tbinom")
      return { kind: "frac", numerator: this.argument(), denominator: this.argument(), binomial: true };
    if (name === "sqrt") {
      const index = this.optional();
      return { kind: "root", radicand: this.argument(), ...(index ? { index: new Parser(index).parse() } : {}) };
    }
    if (TEXT_COMMANDS.has(name)) return { kind: "mtext", text: unescapeText(this.rawGroup()) };
    if (name === "operatorname" || name === "operatorname*") {
      const text = unescapeText(this.rawGroup()).replace(/\s+/g, "");
      return { kind: "mo", text, ...(name.endsWith("*") ? { limits: "operator" as const } : {}), say: { literal: text } };
    }
    if (name === "mathrm" || name === "mathup" || name === "rm") return restyle(this.argument(), "normal");
    if (name === "mathbf" || name === "boldsymbol" || name === "bm" || name === "mathbfit") return restyle(this.argument(), "bold");
    if (name === "mathit" || name === "mathsf" || name === "mathtt") return this.argument();
    if (name === "mathbb" || name === "mathcal" || name === "mathscr" || name === "mathfrak") {
      const table = name === "mathbb" ? DOUBLE_STRUCK : SCRIPT_LETTERS;
      const raw = this.rawGroup();
      return row([...raw.replace(/\s+/g, "")].map((letter) => ({ kind: "mi", text: table[letter] ?? letter, say: { literal: letter } })));
    }
    if (ACCENTS[name]) {
      const [mark, accent, under] = ACCENTS[name]!;
      return { kind: "accent", base: this.argument(), mark, name: accent, ...(under ? { under } : {}) };
    }
    if (name === "overset" || name === "stackrel") {
      const over = this.argument();
      return { kind: "stack", base: this.argument(), over };
    }
    if (name === "underset") {
      const under = this.argument();
      return { kind: "stack", base: this.argument(), under };
    }
    if (name === "overbrace" || name === "underbrace") return this.argument();
    if (name === "not") {
      this.skipSpace();
      const next = this.atom();
      if (next?.kind === "mo") {
        const negated: Record<string, [string, string]> = { "=": ["≠", "notEqual"], "∈": ["∉", "notIn"] };
        const known = negated[next.text];
        return known ? operator(known[0], known[1], true) : { ...next, text: `${next.text}̸` };
      }
      return next;
    }
    if (name === "pmod" || name === "bmod" || name === "mod") {
      if (name === "bmod") return { kind: "mo", text: "mod", binary: true, say: { literal: "mod" } };
      const value = this.argument();
      const mod: MathNode = { kind: "mo", text: "mod", say: { literal: "mod" } };
      return name === "pmod"
        ? { kind: "fenced", open: "(", close: ")", body: row([mod, { kind: "space", em: 1 / 3 }, value]) }
        : row([mod, { kind: "space", em: 1 / 3 }, value]);
    }
    if (name === "begin") return this.environment(this.rawGroup());
    if (name === "end") {
      this.rawGroup();
      return undefined;
    }
    if (GREEK[name]) return { kind: "mi", text: GREEK[name]!, say: name[0] === name[0]!.toUpperCase() ? sayKey(`mathText.say.capital${name}`) : sayKey(`mathText.say.${name.replace(/^var/, "")}`) };
    if (LARGE[name]) {
      const [glyph, say] = LARGE[name]!;
      return { kind: "mo", text: glyph, largeop: true, limits: "operator", ...(say ? { say: sayKey(`mathText.say.${say}`) } : { say: { literal: glyph } }) };
    }
    if (FUNCTIONS[name]) {
      const [say, limits] = FUNCTIONS[name]!;
      return { kind: "mo", text: name, ...(limits ? { limits: name === "lim" ? ("limit" as const) : ("operator" as const) } : {}), say: say ? sayKey(`mathText.say.${say}`) : { literal: name } };
    }
    if (IDENTIFIERS[name]) {
      const [glyph, say] = IDENTIFIERS[name]!;
      return { kind: "mi", text: glyph, ...(say ? { say: sayKey(`mathText.say.${say}`) } : {}) };
    }
    if (OPERATORS[name]) {
      const [glyph, say, binary] = OPERATORS[name]!;
      return operator(glyph, say, binary);
    }
    // An unknown command: its name, upright, rather than a backslash and raw TeX.
    return { kind: "mtext", text: name };
  }
  private environment(name: string): MathNode | undefined {
    const bare = name.replace(/\*$/, "");
    if (bare === "array") this.rawGroup();
    const end = `\\end{${name}}`;
    const rows: MathNode[][] = [];
    let cells: MathNode[] = [];
    while (this.i < this.source.length) {
      const children = this.list(() => this.peek() === "&" || this.commandAt() === "\\\\" || this.source.startsWith(end, this.i));
      cells.push(row(children));
      if (this.peek() === "&") {
        this.i++;
        continue;
      }
      if (this.commandAt() === "\\\\") {
        this.i += 2;
        rows.push(cells);
        cells = [];
        continue;
      }
      if (this.source.startsWith(end, this.i)) this.i += end.length;
      else if (this.peek() === "}") this.i++;
      break;
    }
    if (cells.some((cell) => cell.kind !== "row" || cell.children.length)) rows.push(cells);
    const fences: Record<string, [string, string]> = { pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], cases: ["{", ""], dcases: ["{", ""] };
    const [open, close] = fences[bare] ?? ["", ""];
    const say = bare.endsWith("matrix") || bare === "array" ? "matrix" : bare.endsWith("cases") ? "cases" : "lines";
    return { kind: "table", rows, open, close, say };
  }
}

function restyle(node: MathNode, variant: "normal" | "bold"): MathNode {
  if (node.kind === "mi") return { ...node, variant };
  if (node.kind === "row") return { kind: "row", children: node.children.map((child) => restyle(child, variant)) };
  if (node.kind === "script") return { ...node, base: restyle(node.base, variant) };
  return node;
}
/** `\text{w\_new}` shows "w_new": TeX escapes inside text are the characters they stand for. */
function unescapeText(raw: string): string {
  return raw
    .replace(/\\([_%&#${}~^\\ ,;:])/g, (_, c: string) => ESCAPES[c] ?? c)
    .replace(/\\(?:textbf|textit|emph|text|mathrm)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\$/g, "")
    .replace(/~/g, " ");
}

export function parseTex(tex: string): MathNode {
  return new Parser(tex.trim().slice(0, 2000)).parse();
}

/* ---------- Readable text (the native app, and the plain form of the web formula). ---------- */

const SUPERSCRIPT: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "−": "⁻", n: "ⁿ", i: "ⁱ", T: "ᵀ", "⊤": "ᵀ", "′": "′" };
const SUBSCRIPT: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "−": "₋", i: "ᵢ", j: "ⱼ", n: "ₙ", t: "ₜ", k: "ₖ", m: "ₘ", x: "ₓ", a: "ₐ", e: "ₑ", o: "ₒ", r: "ᵣ", s: "ₛ", u: "ᵤ", v: "ᵥ", l: "ₗ", h: "ₕ", p: "ₚ" };
const atomic = (text: string) => /^[\p{L}\p{N}.′]*$/u.test(text) || /^\(.*\)$/.test(text);

export function mathText(node: MathNode): string {
  return textOf(node).replace(/\s+/g, " ").trim();
}
function textOf(node: MathNode): string {
  switch (node.kind) {
    case "row": {
      let out = "";
      node.children.forEach((child, index) => {
        const text = textOf(child);
        if (child.kind === "mo" && child.binary && index > 0) out += ` ${text} `;
        else if (child.kind === "mo" && (child.text === "," || child.text === ";")) out += `${text} `;
        else if (functionLike(child) && index < node.children.length - 1) out += `${text} `;
        else out += text;
      });
      return out;
    }
    case "mi":
    case "mn":
    case "mtext":
      return node.text;
    case "mo":
      return node.text;
    case "space":
      return node.em >= 0.3 ? " " : "";
    case "frac": {
      const top = mathText(node.numerator), bottom = mathText(node.denominator);
      if (node.binomial) return `C(${top}, ${bottom})`;
      return `${atomic(top) ? top : `(${top})`}/${atomic(bottom) ? bottom : `(${bottom})`}`;
    }
    case "root": {
      const inner = mathText(node.radicand);
      const index = node.index ? mathText(node.index) : "";
      const prefix = index === "3" ? "∛" : index === "4" ? "∜" : index ? `${scriptText(index, SUPERSCRIPT, "^")}√` : "√";
      return `${prefix}${atomic(inner) && inner.length < 4 ? inner : `(${inner})`}`;
    }
    case "script": {
      const base = textOf(node.base);
      const sub = node.sub ? scriptText(mathText(node.sub), SUBSCRIPT, "_") : "";
      const sup = node.sup ? scriptText(mathText(node.sup), SUPERSCRIPT, "^") : "";
      return `${base}${sub}${sup}`;
    }
    case "accent":
      return `${mathText(node.base)}${node.name === "hat" ? "̂" : node.name === "bar" ? "̄" : node.name === "tilde" ? "̃" : node.name === "vec" ? "⃗" : node.name === "dot" ? "̇" : node.name === "ddot" ? "̈" : ""}`;
    case "stack":
      return mathText(node.base);
    case "fenced":
      return `${node.open}${mathText(node.body)}${node.close}`;
    case "table": {
      const lines = node.rows.map((cells) => cells.map(mathText).join(node.say === "lines" ? " " : ", "));
      return `${node.open}${lines.join("; ")}${node.close}`;
    }
  }
}
/** A named function or large operator, alone or with its scripts: text after it needs a space. */
function functionLike(node: MathNode): boolean {
  if (node.kind === "script") return functionLike(node.base);
  return node.kind === "mo" && (Boolean(node.limits) || Boolean(node.largeop) || /^[a-zA-Z]{2,}$/.test(node.text));
}
function scriptText(value: string, table: Record<string, string>, marker: string) {
  const compact = value.replace(/\s+/g, "");
  if (compact && [...compact].every((c) => table[c])) return [...compact].map((c) => table[c]).join("");
  // A word below the line reads plainly ("w_new"); anything else keeps its extent in parentheses.
  return marker === "_" && /^[\p{L}\p{N}]+$/u.test(compact) ? `_${compact}` : `${marker}(${compact})`;
}

/* ---------- Spoken form, in the learner's language. ---------- */

const phrase = (t: Translate, key: string, values?: Record<string, string>) => t(key as MessageKey, values);
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
function sayOf(say: Say | undefined, fallback: string, t: Translate) {
  if (!say) return fallback;
  return "key" in say ? t(say.key) : say.literal;
}
export function mathSpoken(node: MathNode, t: Translate = englishTranslator().t): string {
  return clean(spoken(node, t));
}
function spoken(node: MathNode, t: Translate): string {
  switch (node.kind) {
    case "row": {
      const parts: string[] = [];
      let word = "";
      const flush = () => {
        if (word) parts.push(word);
        word = "";
      };
      for (let index = 0; index < node.children.length; index++) {
        const child = node.children[index]!;
        // Letters and digits written together read as one word: "dL", "2x", "w".
        if ((child.kind === "mi" && !child.say && child.variant !== "bold") || child.kind === "mn") {
          word += child.text;
          continue;
        }
        flush();
        if (child.kind === "mo" && child.limits) {
          // A large operator or limit with no scripts: "the sum of …".
          parts.push(phrase(t, "mathText.limits.none", { operator: sayOf(child.say, child.text, t) }));
          continue;
        }
        if (child.kind === "script" && child.base.kind === "mo" && child.base.limits) {
          parts.push(limitsPhrase(child, t));
          continue;
        }
        parts.push(spoken(child, t));
      }
      flush();
      return parts.filter(Boolean).join(" ");
    }
    case "mi":
    case "mo":
      return sayOf(node.say, node.text, t);
    case "mn":
    case "mtext":
      return node.text;
    case "space":
      return "";
    case "frac":
      return node.binomial
        ? phrase(t, "mathText.binomial", { n: mathSpoken(node.numerator, t), k: mathSpoken(node.denominator, t) })
        : phrase(t, "mathText.fraction", { numerator: mathSpoken(node.numerator, t), denominator: mathSpoken(node.denominator, t) });
    case "root":
      return node.index
        ? phrase(t, "mathText.root.index", { index: mathSpoken(node.index, t), radicand: mathSpoken(node.radicand, t) })
        : phrase(t, "mathText.root.square", { radicand: mathSpoken(node.radicand, t) });
    case "script": {
      if (node.base.kind === "mo" && node.base.limits) return limitsPhrase(node, t);
      let out = mathSpoken(node.base, t);
      if (node.sub) out = phrase(t, "mathText.sub", { base: out, sub: mathSpoken(node.sub, t) });
      if (node.sup) {
        const power = mathSpoken(node.sup, t), raw = mathText(node.sup);
        out =
          raw === "2" ? phrase(t, "mathText.squared", { base: out })
          : raw === "3" ? phrase(t, "mathText.cubed", { base: out })
          : raw === "⊤" || raw === "T" ? phrase(t, "mathText.transpose", { base: out })
          : raw === "′" || raw === "′′" ? `${out} ${power}`
          : raw === "∘" ? phrase(t, "mathText.degrees", { base: out })
          : phrase(t, "mathText.power", { base: out, power });
      }
      return out;
    }
    case "accent":
      return node.name === "underline" ? mathSpoken(node.base, t) : phrase(t, `mathText.accent.${node.name}`, { base: mathSpoken(node.base, t) });
    case "stack":
      return [node.over && mathSpoken(node.over, t), mathSpoken(node.base, t), node.under && mathSpoken(node.under, t)].filter(Boolean).join(" ");
    case "fenced":
      return [delimiterSay(node.open, true, t), mathSpoken(node.body, t), delimiterSay(node.close, false, t)].filter(Boolean).join(" ");
    case "table": {
      const rows = node.rows.map((cells, index) =>
        node.say === "lines" ? cells.map((cell) => mathSpoken(cell, t)).join(" ")
        : phrase(t, "mathText.row", { number: String(index + 1), cells: cells.map((cell) => mathSpoken(cell, t)).join(", ") }),
      );
      if (node.say === "lines") return rows.join("; ");
      return phrase(t, node.say === "cases" ? "mathText.cases" : "mathText.matrix", { rows: rows.join("; ") });
    }
  }
}
function limitsPhrase(node: Extract<MathNode, { kind: "script" }>, t: Translate) {
  const base = node.base as Extract<MathNode, { kind: "mo" }>;
  const operatorWords = sayOf(base.say, base.text, t);
  const from = node.sub ? mathSpoken(node.sub, t) : "", to = node.sup ? mathSpoken(node.sup, t) : "";
  if (base.limits === "limit" && from) return phrase(t, "mathText.limits.as", { operator: operatorWords, from });
  if (from && to) return phrase(t, "mathText.limits.both", { operator: operatorWords, from, to });
  if (from) return phrase(t, "mathText.limits.over", { operator: operatorWords, over: from });
  return phrase(t, "mathText.limits.none", { operator: operatorWords });
}
function delimiterSay(glyph: string, open: boolean, t: Translate) {
  const keys: Record<string, string> = { "(": "openParen", ")": "closeParen", "[": "openBracket", "]": "closeBracket", "{": "openBrace", "}": "closeBrace", "|": "bar", "‖": "norm" };
  if (!glyph) return "";
  const key = keys[glyph];
  void open;
  return key ? t(`mathText.say.${key}` as MessageKey) : glyph;
}

/** The readable text and the spoken words for one formula. */
export function mathAlternative(tex: string, t: Translate = englishTranslator().t): { text: string; spoken: string } {
  const tree = parseTex(tex);
  return { text: mathText(tree), spoken: mathSpoken(tree, t) };
}

export type ProseSegment = { kind: "text"; value: string } | { kind: "math"; tex: string; display: boolean };
/** Splits prose into text and math segments. A `$` needs a closing `$` in the same paragraph and
 * no space just inside it, so "$5 and $10" stays prose; `\(…\)` and `\[…\]` are math too. */
export function splitMath(text: string): ProseSegment[] {
  const parts: ProseSegment[] = [];
  const pattern = /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?=\S)([^$\n]+?)(?<=[^\s\\])\$(?![\w$])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) parts.push({ kind: "text", value: text.slice(last, match.index) });
    const display = match[1] !== undefined || match[2] !== undefined;
    parts.push({ kind: "math", tex: (match[1] ?? match[2] ?? match[3] ?? match[4]!).trim(), display });
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}
