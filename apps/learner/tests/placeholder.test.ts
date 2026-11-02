import { describe, expect, it } from "vitest";
import { createLearnerTranslator } from "../src/i18n";
import { composerPlaceholder, type PlaceholderInput } from "../src/connected/companion/placeholder";

const base: PlaceholderInput = { inLesson: true, emptyThread: false, yourTurn: false, inProgress: false };

describe("the message box's placeholder follows the thread (final design §3.6, CMP-6)", () => {
  const rows: [Partial<PlaceholderInput>, string, string][] = [
    [{ emptyThread: true }, "Ask about this lesson…", "שאלה על השיעור…"],
    [{ attachment: { kind: "check", ordinal: 1 } }, "Ask about question 1…", "עזרה בשאלה 1…"],
    [{ yourTurn: true }, "Your answer…", "כתיבת תשובה…"],
    [{}, "Reply…", "תגובה…"],
    [{ attachment: { kind: "text" } }, "Ask about the selected text…", "שאלה על הקטע שנבחר…"],
    [{ attachment: { kind: "code" } }, "Ask about your code…", "שאלה על הקוד…"],
    [{ attachment: { kind: "video" } }, "Ask about this moment…", "שאלה על הרגע הזה…"],
    [{ attachment: { kind: "illustration" } }, "Ask about this part…", "שאלה על החלק הזה…"],
    [{ inProgress: true, yourTurn: true }, "Write your next message…", "ההודעה הבאה…"],
    [{ inLesson: false }, "Keep drafting. Send it from a lesson.", "אפשר להמשיך לנסח ולשלוח מתוך שיעור."],
  ];
  const he = createLearnerTranslator("he").t;
  for (const [input, english, hebrew] of rows)
    it(`${english}`, () => {
      expect(composerPlaceholder({ ...base, ...input })).toBe(english);
      expect(composerPlaceholder({ ...base, ...input }, he).replace(/[⁦-⁩]/g, "")).toBe(hebrew);
    });
  it("never ends with a question mark, after the companion asked something too", () => {
    for (const [input] of rows) {
      expect(composerPlaceholder({ ...base, ...input })).not.toMatch(/[?؟]$/);
      expect(composerPlaceholder({ ...base, ...input }, he)).not.toMatch(/[?؟]⁩?$/);
    }
  });
  it("an attachment wins over the turn: the learner chose what to ask about", () => {
    expect(composerPlaceholder({ ...base, yourTurn: true, attachment: { kind: "check", ordinal: 2 } })).toBe("Ask about question 2…");
  });
});
