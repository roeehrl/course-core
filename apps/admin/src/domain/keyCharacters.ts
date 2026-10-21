import { trimKey } from "./providerSetup";

/**
 * Characters in a pasted API key that the server refuses (it accepts printable ASCII only,
 * after removing the same edge whitespace and zero-width characters as `trimKey`). Copying
 * through an app that auto-formats text can swap a letter or hyphen for a look-alike or add an
 * invisible character; this names each one so the person can fix it. Nothing here logs or sends
 * the key, and a problem carries only the offending character, never its neighbours.
 */
export type KeyCharKind =
  /** Looks like a plain character it probably was: `plain` names it. */
  | "letter"
  | "digit"
  | "hyphen"
  | "symbol"
  /** A curly quotation mark. Keys never contain quotation marks. */
  | "quote"
  /** A space, line break or invisible character with a known name. */
  | "hidden"
  /** Any other visible character. */
  | "other"
  /** Any other invisible or control character. */
  | "otherHidden";

export type KeyCharName =
  | "multiplication"
  | "hyphen"
  | "nonBreakingHyphen"
  | "figureDash"
  | "enDash"
  | "emDash"
  | "horizontalBar"
  | "minus"
  | "fullWidth"
  | "cyrillic"
  | "greek"
  | "leftSingleQuote"
  | "rightSingleQuote"
  | "lowSingleQuote"
  | "leftDoubleQuote"
  | "rightDoubleQuote"
  | "lowDoubleQuote"
  | "space"
  | "noBreakSpace"
  | "specialSpace"
  | "tab"
  | "lineBreak"
  | "zeroWidthSpace"
  | "zeroWidthNonJoiner"
  | "zeroWidthJoiner"
  | "wordJoiner"
  | "zeroWidthNoBreakSpace"
  | "softHyphen"
  | "leftToRightMark"
  | "rightToLeftMark"
  | "directionControl";

export interface KeyCharProblem {
  /** 1-based position in the key as it will be saved (edges trimmed), counted in characters. */
  position: number;
  char: string;
  /** For example "U+00D7". */
  codePoint: string;
  kind: KeyCharKind;
  name?: KeyCharName;
  /** What "Fix these characters" puts in its place; "" removes it. Absent: not fixable. */
  replacement?: string;
}

export interface KeyCharAnalysis {
  problems: KeyCharProblem[];
  /** How many problems "Fix these characters" resolves. */
  fixable: number;
}

type Entry = Pick<KeyCharProblem, "kind" | "name" | "replacement">;
const table = new Map<number, Entry>();
const add = (codes: number[], entry: Entry) =>
  codes.forEach((c) => table.set(c, entry));

add([0xd7], { kind: "letter", name: "multiplication", replacement: "x" });
for (const [code, name] of [
  [0x2010, "hyphen"],
  [0x2011, "nonBreakingHyphen"],
  [0x2012, "figureDash"],
  [0x2013, "enDash"],
  [0x2014, "emDash"],
  [0x2015, "horizontalBar"],
  [0x2212, "minus"],
] as const)
  add([code], { kind: "hyphen", name, replacement: "-" });
// Cyrillic and Greek letters drawn like Latin ones, as [code point, Latin letter] pairs.
for (const [pairs, name] of [
  [
    [
      [0x430, "a"],
      [0x435, "e"],
      [0x43e, "o"],
      [0x440, "p"],
      [0x441, "c"],
      [0x445, "x"],
      [0x443, "y"],
      [0x456, "i"],
      [0x458, "j"],
      [0x455, "s"],
      [0x410, "A"],
      [0x412, "B"],
      [0x415, "E"],
      [0x41a, "K"],
      [0x41c, "M"],
      [0x41d, "H"],
      [0x41e, "O"],
      [0x420, "P"],
      [0x421, "C"],
      [0x422, "T"],
      [0x425, "X"],
      [0x406, "I"],
      [0x408, "J"],
      [0x405, "S"],
    ],
    "cyrillic",
  ],
  [
    [
      [0x3bf, "o"],
      [0x3bd, "v"],
      [0x391, "A"],
      [0x392, "B"],
      [0x395, "E"],
      [0x397, "H"],
      [0x399, "I"],
      [0x39a, "K"],
      [0x39c, "M"],
      [0x39d, "N"],
      [0x39f, "O"],
      [0x3a1, "P"],
      [0x3a4, "T"],
      [0x3a5, "Y"],
      [0x3a7, "X"],
      [0x396, "Z"],
    ],
    "greek",
  ],
] as const)
  for (const [code, letter] of pairs)
    add([code], { kind: "letter", name, replacement: letter });
for (const [code, name] of [
  [0x2018, "leftSingleQuote"],
  [0x2019, "rightSingleQuote"],
  [0x201a, "lowSingleQuote"],
  [0x201c, "leftDoubleQuote"],
  [0x201d, "rightDoubleQuote"],
  [0x201e, "lowDoubleQuote"],
] as const)
  add([code], { kind: "quote", name });
// Spaces inside a key are never fixed here: the key may have been cut in two.
add([0x20], { kind: "hidden", name: "space" });
add([0xa0], { kind: "hidden", name: "noBreakSpace" });
add([0x09], { kind: "hidden", name: "tab" });
add([0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029], {
  kind: "hidden",
  name: "lineBreak",
});
add(
  [
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
  ],
  { kind: "hidden", name: "specialSpace" },
);
// Invisible characters that never belong to a key: fixing removes them.
for (const [codes, name] of [
  [[0x200b], "zeroWidthSpace"],
  [[0x200c], "zeroWidthNonJoiner"],
  [[0x200d], "zeroWidthJoiner"],
  [[0x2060], "wordJoiner"],
  [[0xfeff], "zeroWidthNoBreakSpace"],
  [[0xad], "softHyphen"],
  [[0x200e], "leftToRightMark"],
  [[0x200f], "rightToLeftMark"],
  [
    [
      0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ],
    "directionControl",
  ],
] as const)
  add([...codes], { kind: "hidden", name, replacement: "" });

const PRINTABLE = /^[\x21-\x7e]$/;
const INVISIBLE = /^[\p{C}\p{M}\p{Z}]$/u;

function classify(char: string): Entry {
  const code = char.codePointAt(0)!;
  const known = table.get(code);
  if (known) return known;
  // Full-width forms (U+FF01–FF5E) of printable ASCII, from East Asian input methods.
  if (code >= 0xff01 && code <= 0xff5e) {
    const plain = String.fromCodePoint(code - 0xfee0);
    return {
      kind: /[A-Za-z]/.test(plain)
        ? "letter"
        : /\d/.test(plain)
          ? "digit"
          : plain === "-"
            ? "hyphen"
            : "symbol",
      name: "fullWidth",
      replacement: plain,
    };
  }
  return { kind: INVISIBLE.test(char) ? "otherHidden" : "other" };
}

export const codePointLabel = (char: string) =>
  "U+" + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");

/** The characters the server would refuse, or undefined when the key is empty or acceptable. */
export function analyzeKey(value: string): KeyCharAnalysis | undefined {
  const chars = Array.from(trimKey(value));
  const problems: KeyCharProblem[] = [];
  chars.forEach((char, index) => {
    if (PRINTABLE.test(char)) return;
    problems.push({
      position: index + 1,
      char,
      codePoint: codePointLabel(char),
      ...classify(char),
    });
  });
  if (!problems.length) return undefined;
  return {
    problems,
    fixable: problems.filter((p) => p.replacement !== undefined).length,
  };
}

/** The trimmed key with look-alikes replaced and invisible characters removed; nothing else changes. */
export function fixKeyCharacters(value: string): string {
  return trimKey(
    Array.from(trimKey(value))
      .map((char) =>
        PRINTABLE.test(char) ? char : (classify(char).replacement ?? char),
      )
      .join(""),
  );
}
