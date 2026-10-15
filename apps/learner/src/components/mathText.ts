/** Plain-text and spoken alternatives for the small TeX subset course prose
 * uses (`$…$` inline, `$$…$$` on its own). Nothing is executed or rendered as
 * HTML: the visible form is readable text, and the spoken form is what screen
 * readers announce instead of raw TeX ("x squared", not "x caret 2"). */

const SYMBOLS: Record<string, [text: string, spoken: string]> = {
  alpha: ["α", "alpha"],
  beta: ["β", "beta"],
  gamma: ["γ", "gamma"],
  delta: ["δ", "delta"],
  epsilon: ["ε", "epsilon"],
  eta: ["η", "eta"],
  theta: ["θ", "theta"],
  lambda: ["λ", "lambda"],
  mu: ["μ", "mu"],
  pi: ["π", "pi"],
  sigma: ["σ", "sigma"],
  tau: ["τ", "tau"],
  phi: ["φ", "phi"],
  omega: ["ω", "omega"],
  Delta: ["Δ", "capital delta"],
  Sigma: ["Σ", "capital sigma"],
  sum: ["Σ", "the sum of"],
  prod: ["Π", "the product of"],
  infty: ["∞", "infinity"],
  cdot: ["·", "times"],
  times: ["×", "times"],
  div: ["÷", "divided by"],
  pm: ["±", "plus or minus"],
  le: ["≤", "is less than or equal to"],
  leq: ["≤", "is less than or equal to"],
  ge: ["≥", "is greater than or equal to"],
  geq: ["≥", "is greater than or equal to"],
  ne: ["≠", "is not equal to"],
  neq: ["≠", "is not equal to"],
  approx: ["≈", "is approximately"],
  to: ["→", "to"],
  rightarrow: ["→", "to"],
  in: ["∈", "in"],
  partial: ["∂", "partial"],
  nabla: ["∇", "nabla"],
  log: ["log", "log"],
  ln: ["ln", "natural log"],
  exp: ["exp", "exp"],
  max: ["max", "max"],
  min: ["min", "min"],
};
const OPERATORS: Record<string, string> = {
  "=": "equals",
  "+": "plus",
  "-": "minus",
  "<": "is less than",
  ">": "is greater than",
  "/": "divided by",
  "*": "times",
};
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  n: "ⁿ",
  i: "ⁱ",
  T: "ᵀ",
};
const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "−": "₋",
  i: "ᵢ",
  j: "ⱼ",
  n: "ₙ",
  t: "ₜ",
};

interface Parsed {
  text: string;
  spoken: string;
}

/** Reads one group: `{…}` or a single token. */
function group(source: string, at: number): [string, number] {
  if (source[at] === "{") {
    let depth = 0;
    for (let i = at; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0)
        return [source.slice(at + 1, i), i + 1];
    }
    return [source.slice(at + 1), source.length];
  }
  if (source[at] === "\\") {
    const match = /^\\[a-zA-Z]+/.exec(source.slice(at));
    if (match) return [match[0], at + match[0].length];
  }
  return [source[at] ?? "", at + 1];
}
const join = (parts: string[]) =>
  parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

function script(value: string, table: Record<string, string>, marker: string) {
  const inner = parse(value).text.replace(/\s+/g, "");
  return [...inner].every((c) => table[c])
    ? [...inner].map((c) => table[c]).join("")
    : `${marker}(${inner})`;
}

function parse(source: string): Parsed {
  const text: string[] = [];
  const spoken: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "^" || c === "_") {
      const [value, next] = group(source, i + 1);
      i = next;
      const inner = parse(value);
      if (c === "^") {
        text.push(script(value, SUPERSCRIPT, "^"));
        spoken.push(
          inner.spoken === "2"
            ? "squared"
            : inner.spoken === "3"
              ? "cubed"
              : `to the power ${inner.spoken}`,
        );
      } else {
        text.push(script(value, SUBSCRIPT, "_"));
        spoken.push(`sub ${inner.spoken}`);
      }
      // Attach scripts to what precedes them in the visible text.
      if (text.length > 1) text.splice(-2, 2, `${text.at(-2)}${text.at(-1)}`);
      continue;
    }
    if (c === "\\") {
      const [command, next] = group(source, i);
      const name = command.slice(1);
      i = next;
      if (name === "frac") {
        const [top, afterTop] = group(source, i);
        const [bottom, afterBottom] = group(source, afterTop);
        i = afterBottom;
        const a = parse(top),
          b = parse(bottom);
        text.push(`(${a.text})/(${b.text})`);
        spoken.push(`the fraction ${a.spoken} over ${b.spoken}, end fraction`);
        continue;
      }
      if (name === "sqrt") {
        const [inside, after] = group(source, i);
        i = after;
        const a = parse(inside);
        text.push(`√(${a.text})`);
        spoken.push(`the square root of ${a.spoken}, end root`);
        continue;
      }
      if (
        name === "text" ||
        name === "mathrm" ||
        name === "mathbf" ||
        name === "operatorname"
      ) {
        const [inside, after] = group(source, i);
        i = after;
        text.push(inside);
        spoken.push(inside);
        continue;
      }
      if (name === "left" || name === "right" || name === ",") continue;
      const symbol = SYMBOLS[name];
      text.push(symbol ? symbol[0] : name);
      spoken.push(symbol ? symbol[1] : name);
      continue;
    }
    if (c === "{" || c === "}") {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      text.push(c);
      spoken.push(c === "(" ? "open paren" : "close paren");
      i++;
      continue;
    }
    if (OPERATORS[c]) {
      text.push(` ${c === "*" ? "×" : c === "-" ? "−" : c} `);
      spoken.push(OPERATORS[c]!);
      i++;
      continue;
    }
    const word = /^[a-zA-Z0-9.,]+/.exec(source.slice(i))?.[0] ?? c;
    text.push(word);
    spoken.push(word);
    i += word.length;
  }
  return {
    text: text.join("").replace(/\s+/g, " ").trim(),
    spoken: join(spoken),
  };
}

export function mathAlternative(tex: string): Parsed {
  return parse(tex.trim().slice(0, 2000));
}

/** Splits prose into text and math segments. A `$` needs a closing `$` on the
 * same paragraph and no surrounding spaces, so "$5 and $10" stays prose. */
export function splitMath(
  text: string,
): (
  | { kind: "text"; value: string }
  | { kind: "math"; tex: string; display: boolean }
)[] {
  const parts: (
    | { kind: "text"; value: string }
    | { kind: "math"; tex: string; display: boolean }
  )[] = [];
  const pattern =
    /\$\$([^$]+?)\$\$|(?<![\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last)
      parts.push({ kind: "text", value: text.slice(last, match.index) });
    parts.push({
      kind: "math",
      tex: match[1] ?? match[2]!,
      display: match[1] !== undefined,
    });
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}
