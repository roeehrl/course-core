import { describe, expect, it } from "vitest";
import { createAdminTranslator } from "../src/i18n";
import { learnerName } from "../src/domain/learnerName";
import { workspaceSchema } from "../src/domain/contracts";

// The API sends codes, not English labels: an erased enrollment has no name and the page is a
// "course_workspace"; the admin words both in the reader's language.
describe("server labels worded in the admin", () => {
  const en = createAdminTranslator("en").t,
    he = createAdminTranslator("he").t;
  const profile = (displayName: string) => ({
    displayName,
    goal: "",
    pace: "steady" as const,
  });

  it("words an erased enrollment in English and Hebrew, and keeps a learner's own name", () => {
    expect(learnerName(en, { status: "erased", profile: profile("") })).toBe(
      "Erased learning data",
    );
    expect(learnerName(he, { status: "erased", profile: profile("") })).toBe(
      "נתוני למידה שנמחקו",
    );
    // Even if a name came back for an erased enrollment, it is not shown.
    expect(
      learnerName(he, { status: "erased", profile: profile("Avery") }),
    ).toBe("נתוני למידה שנמחקו");
    expect(
      learnerName(he, { status: "active", profile: profile("Avery") }),
    ).toBe("Avery");
    expect(learnerName(he, { status: "active", profile: profile("") })).toBe(
      "לומד/ת ללא שם",
    );
  });

  it("accepts the course workspace code and an erased enrollment without a name, and rejects an unknown code", () => {
    const course = {
      id: "c1",
      title: "T",
      description: "",
      objectives: [],
      workspaceId: "w1",
    };
    expect(
      workspaceSchema.shape.course.safeParse({
        ...course,
        categoryCode: "course_workspace",
      }).success,
    ).toBe(true);
    expect(
      workspaceSchema.shape.course.safeParse({
        ...course,
        categoryCode: "Course workspace",
      }).success,
    ).toBe(false);
    expect(en("adminApp.workspace")).toBe("Course workspace");
    expect(he("adminApp.workspace")).not.toMatch(/[A-Za-z]/);
    expect(
      workspaceSchema.shape.enrollments.element.shape.profile.safeParse(
        profile(""),
      ).success,
    ).toBe(true);
  });
});
