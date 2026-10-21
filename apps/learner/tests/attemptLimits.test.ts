import { describe, expect, it } from "vitest";
import { apiErrorMessage, CourseApiError } from "../src/client/apiClient";
import { createLearnerTranslator } from "../src/i18n";

describe("graded-attempt refusals (assessment policy)", () => {
  const en = createLearnerTranslator("en").t, he = createLearnerTranslator("he").t;
  it("says how many graded attempts the check allows and that practice and staff help remain", () => {
    expect(apiErrorMessage("ATTEMPT_LIMIT_REACHED", en, { checkId: "gate:x", used: 2, limit: 2 }))
      .toBe("This check allows 2 graded attempts, and you have used them all. Practice is still open, and your course staff can allow another attempt.");
    expect(apiErrorMessage("ATTEMPT_LIMIT_REACHED", en, { limit: 1, used: 1 })).toMatch(/^This check allows 1 graded attempt, and you have used it\./);
    expect(apiErrorMessage("ATTEMPT_LIMIT_REACHED", he, { limit: 3, used: 3 })).toMatch(/^בנקודת הבקרה הזו יש 3 ניסיונות, וכולם נוצלו\./);
    // Without details the general explanation still says what to do.
    expect(apiErrorMessage("ATTEMPT_LIMIT_REACHED", en)).toMatch(/your course staff can allow another attempt/);
  });
  it("says when the next graded attempt may start, in the learner's language", () => {
    const retryAt = "2026-10-21T10:30:00Z";
    const english = apiErrorMessage("RETRY_COOLDOWN", en, { retryAt });
    expect(english).toMatch(/^You can take the next graded attempt at this check from .*2026.*\. Practice is open now\.$/);
    expect(apiErrorMessage("RETRY_COOLDOWN", he, { retryAt })).toMatch(/^הניסיון הבא בנקודת הבקרה הזו יתאפשר החל מ-.*2026/);
    // A malformed time falls back to the general message rather than an invalid date.
    expect(apiErrorMessage("RETRY_COOLDOWN", en, { retryAt: "soon" })).toBe("You can take the next graded attempt at this check a little later. Practice is open now.");
    expect(new CourseApiError("RETRY_COOLDOWN", 409, { retryAt }).message).toBe(english);
  });
});
