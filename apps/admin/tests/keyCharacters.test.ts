import { describe, expect, it } from "vitest";
import {
  analyzeKey,
  codePointLabel,
  fixKeyCharacters,
} from "../src/domain/keyCharacters";
import { trimKey } from "../src/domain/providerSetup";

// Synthetic keys only, built from pieces: the shapes of Gemini "AQ." keys and classic keys.
const dotted = ["AQ", "Ab8SYNTHETICxKEY-not_real", "0123456789"].join(".");
const classic = ["AIza", "SyNTHETIC-test_KEY-0000000000000000"].join("");
const server = /^[\x21-\x7e]+$/;

describe("key character analysis", () => {
  it("accepts dotted, classic and punctuated printable-ASCII keys, as the server does", () => {
    for (const key of [
      dotted,
      classic,
      "sk-ant-api03-SYNTHETIC_key-0000",
      "!#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
    ]) {
      expect(analyzeKey(key), key).toBeUndefined();
      expect(server.test(key)).toBe(true);
    }
  });

  it("ignores what the server trims: edge whitespace, line breaks and zero-width characters", () => {
    expect(analyzeKey(`  ​${dotted}\r\n﻿`)).toBeUndefined();
    expect(analyzeKey("")).toBeUndefined();
    expect(analyzeKey(" ​ ")).toBeUndefined();
  });

  it("names a multiplication sign by position and what it was meant to be", () => {
    const key = dotted.replace("SYNTHETICxKEY", "SYNTHETIC×KEY");
    const position = Array.from(key).indexOf("×") + 1;
    expect(analyzeKey(`  ${key}`)).toEqual({
      fixable: 1,
      problems: [
        {
          position,
          char: "×",
          codePoint: "U+00D7",
          kind: "letter",
          name: "multiplication",
          replacement: "x",
        },
      ],
    });
    expect(server.test(trimKey(key))).toBe(false);
  });

  it("maps every dash look-alike to a plain hyphen", () => {
    const dashes = [
      [0x2010, "hyphen"],
      [0x2011, "nonBreakingHyphen"],
      [0x2012, "figureDash"],
      [0x2013, "enDash"],
      [0x2014, "emDash"],
      [0x2015, "horizontalBar"],
      [0x2212, "minus"],
    ] as const;
    for (const [code, name] of dashes) {
      const char = String.fromCodePoint(code);
      const result = analyzeKey(`AQ.ab${char}cd`)!;
      expect(result.problems, name).toEqual([
        {
          position: 6,
          char,
          codePoint: codePointLabel(char),
          kind: "hyphen",
          name,
          replacement: "-",
        },
      ]);
    }
  });

  it("names inner spaces, line breaks and invisible characters; only invisible ones are fixable", () => {
    const result = analyzeKey("ab cd ef​gh⁠ij‏kl\nmn op­q")!;
    expect(
      result.problems.map((p) => [p.position, p.kind, p.name, p.replacement]),
    ).toEqual([
      [3, "hidden", "space", undefined],
      [6, "hidden", "noBreakSpace", undefined],
      [9, "hidden", "zeroWidthSpace", ""],
      [12, "hidden", "wordJoiner", ""],
      [15, "hidden", "rightToLeftMark", ""],
      [18, "hidden", "lineBreak", undefined],
      [21, "hidden", "specialSpace", undefined],
      [24, "hidden", "softHyphen", ""],
    ]);
    expect(result.fixable).toBe(4);
  });

  it("names smart quotes without guessing a replacement", () => {
    const result = analyzeKey("“AQ.abc”")!;
    expect(result.problems.map((p) => [p.position, p.kind, p.name])).toEqual([
      [1, "quote", "leftDoubleQuote"],
      [8, "quote", "rightDoubleQuote"],
    ]);
    expect(result.fixable).toBe(0);
  });

  it("recognises Cyrillic, Greek and full-width look-alikes", () => {
    const result = analyzeKey("AхBΟCＡD０E／")!;
    expect(
      result.problems.map((p) => [p.position, p.kind, p.name, p.replacement]),
    ).toEqual([
      [2, "letter", "cyrillic", "x"],
      [4, "letter", "greek", "O"],
      [6, "letter", "fullWidth", "A"],
      [8, "digit", "fullWidth", "0"],
      [10, "symbol", "fullWidth", "/"],
    ]);
  });

  it("reports other characters by code point, counting an emoji as one character", () => {
    const result = analyzeKey("a\u{1f511}béc\u0007d́")!;
    expect(
      result.problems.map((p) => [p.position, p.kind, p.codePoint]),
    ).toEqual([
      [2, "other", "U+1F511"],
      [4, "other", "U+00E9"],
      [6, "otherHidden", "U+0007"],
      [8, "otherHidden", "U+0301"],
    ]);
    expect(result.fixable).toBe(0);
  });

  it("fixes only look-alikes and invisible characters, and the result passes the server's rule", () => {
    const broken = `​ ${dotted.replace("x", "×").replace("-", "–")}‑Z‍ `;
    const fixed = fixKeyCharacters(broken);
    expect(fixed).toBe(`${dotted}-Z`);
    expect(server.test(fixed)).toBe(true);
    expect(analyzeKey(fixed)).toBeUndefined();
    // A space or quote is left for the person to deal with.
    expect(fixKeyCharacters("ab–c d”")).toBe("ab-c d”");
  });

  it("never carries the rest of the key in a problem", () => {
    const result = analyzeKey(dotted.replace("x", "×"))!;
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });
});
