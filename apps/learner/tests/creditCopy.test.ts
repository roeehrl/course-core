import { describe, expect, it } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import type { Challenge } from "../src/client/apiClient";
import { createLearnerTranslator, type MessageKey } from "../src/i18n";
import { practiceSuffix, wordedReason } from "../src/connected/credit/creditCopy";

const en = createLearnerTranslator("en").t, he = createLearnerTranslator("he").t;
const say = (t: typeof en, key: MessageKey, args?: Record<string, number>) => stripBidiControls(t(key, args));

// Every credit-honesty string of the final design (§3.4, §3.11), in English and in the Hebrew the
// design specifies: impersonal forms ("פנייה למנחה", "עונים", "נעשה שימוש"), never a verb with
// המנחה as its subject. Scoped copy (owner decision Q2); course-wide copy only for older history.
const copy: [MessageKey, Record<string, number> | undefined, string, string][] = [
  ["creditNotice.line", { ordinal: 1 }, "Question 1 counts. Asking now makes it practice.", "שאלה 1 נספרת. פנייה למנחה עכשיו תהפוך אותה לתרגול."],
  ["creditNotice.lineMany", { count: 2 }, "2 questions count. Asking now makes them practice.", "2 שאלות נספרות. פנייה למנחה עכשיו תהפוך אותן לתרגול."],
  ["creditInfo.body", undefined,
    "Questions you answer on your own count toward finishing. After you get help on one, it becomes practice: you can still answer it, and a fresh check comes later.",
    "שאלות שעונים עליהן לבד נספרות לסיום. אחרי עזרה בשאלה היא הופכת לתרגול: עדיין אפשר לענות עליה, ובדיקה חדשה תגיע בהמשך."],
  ["sendConfirm.sentence", { ordinal: 1 }, "Asking now makes question 1 practice. It won't count toward finishing the lesson.",
    "פנייה למנחה עכשיו תהפוך את שאלה 1 לתרגול, והיא לא תיספר לסיום השיעור."],
  ["sendConfirm.sentenceMany", { count: 2 }, "Asking now makes 2 questions practice. They won't count toward finishing the lesson.",
    "פנייה למנחה עכשיו תהפוך את 2 השאלות לתרגול, והן לא ייספרו לסיום השיעור."],
  ["sendConfirm.switch", undefined, "Send as practice", "שליחה כתרגול"],
  ["sendConfirm.keep", undefined, "Keep it counted", "להשאיר נספרת"],
  ["sendConfirm.later", undefined, "Save for after the question", "שמירה לאחרי השאלה"],
  ["kindLine.counted", undefined, "Counts toward this lesson. Answer on your own.", "נספרת בשיעור הזה. עונים לבד, בלי עזרה."],
  ["kindLine.practice", undefined, "Practice. This question does not count toward finishing the lesson.", "תרגול. השאלה הזו לא נספרת לסיום השיעור."],
  ["kindLine.reason.companion", undefined, "You asked your companion for help.", "הייתה פנייה למנחה."],
  ["kindLine.reason.hint", undefined, "You used a hint.", "נעשה שימוש ברמז."],
  ["kindLine.reason.solution", undefined, "You opened the explanation.", "ההסבר נפתח."],
  ["kindLine.reason.seen_before", undefined, "You saw this question before.", "השאלה הזו כבר הוצגה."],
  ["kindLine.pathBack", undefined, "Want this to count? A fresh check is ready when you are.", "כדי שזה ייספר, אפשר לעשות בדיקה חדשה."],
  ["kindLine.fresh", { minutes: 4 }, "Get a fresh check · 4 min", "בדיקה חדשה · 4 דק׳"],
  ["kindLine.freshAnyTime", undefined, "Get a fresh check", "בדיקה חדשה"],
  ["creditCopy.practiceSuffix.companion", undefined, "This counts as practice because you asked your companion.", "זה נספר כתרגול כי הייתה פנייה למנחה."],
  ["creditCopy.practiceSuffix.solution", undefined, "This counts as practice because you opened the explanation.", "זה נספר כתרגול כי ההסבר נפתח."],
  ["creditCopy.practiceSuffix.seen_before", undefined, "This counts as practice because you saw this question before.", "זה נספר כתרגול כי השאלה הזו כבר הוצגה."],
  ["creditThreadLines.downgraded", { ordinal: 1 }, "Question 1 is now practice.", "שאלה 1 היא עכשיו תרגול."],
  ["creditThreadLines.downgradedMany", { count: 2 }, "2 questions are now practice.", "2 שאלות הן עכשיו תרגול."],
  ["creditThreadLines.downgradedCourse", undefined, "Your open checks in this course are now practice.", "הבדיקות הפתוחות בקורס הן עכשיו תרגול."],
  ["creditThreadLines.recap", { own: 2, practice: 1 }, "Lesson finished: 2 questions on your own, 1 as practice.", "השיעור הסתיים: 2 שאלות בלי עזרה, 1 כתרגול."],
  ["creditThreadLines.saved", undefined, "A question is saved for after the check.", "שאלה נשמרה לאחרי הבדיקה."],
  ["creditThreadLines.sendNow", undefined, "Send it now", "שליחה עכשיו"],
];

describe("credit honesty copy", () => {
  it.each(copy)("%s reads as the design says, in English and Hebrew", (key, args, english, hebrew) => {
    expect(say(en, key, args)).toBe(english);
    expect(say(he, key, args)).toBe(hebrew);
  });

  it("never makes the companion the subject of a Hebrew verb, and never uses a slashed form", () => {
    for (const [key, args] of copy) {
      const text = say(he, key, args);
      expect(text, key).not.toMatch(/המנחה\s+(רואה|יכול|עונה|זמין|נותן|עוזר|יסביר|ישלח)/);
      expect(text, key).not.toMatch(/[א-ת]\/[א-ת]/);
    }
  });

  it("adds the reason under a verdict on a practice question, and nothing when it counts or the reason is unknown", () => {
    const question = (independentEligible: boolean, practiceReason: Challenge["practiceReason"]) => ({ independentEligible, practiceReason });
    expect(practiceSuffix(question(false, "companion"), en)).toBe("This counts as practice because you asked your companion.");
    expect(practiceSuffix(question(false, "solution"), he)).toBe("זה נספר כתרגול כי ההסבר נפתח.");
    expect(practiceSuffix(question(false, "seen_before"), en)).toBe("This counts as practice because you saw this question before.");
    expect(practiceSuffix(question(true, "companion"), en)).toBeUndefined();
    expect(practiceSuffix(question(false, null), en)).toBeUndefined();
    expect(practiceSuffix(question(false, "fresh_question"), en)).toBeUndefined();
    expect(wordedReason(question(false, "hint"))).toBe("hint");
    expect(wordedReason(question(false, undefined))).toBeUndefined();
  });
});
