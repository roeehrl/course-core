import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { CourseRoadmap, coverageText } from "../src/components/CourseRoadmap";
import { LessonFlow } from "../src/components/LessonFlow";
import { EnrollmentPreview } from "../src/components/EnrollmentPreview";
import { ProfileEditor } from "../src/components/ProfileEditor";
import { resultMessage } from "../src/components/PracticeRunner.web";
import { playerErrorMessage } from "../src/components/YouTubePlayer.web";
import { placementReason, retakeState, type PlacementView } from "../src/components/placementRunState";
import { createLearnerTranslator } from "../src/i18n";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import type { CatalogCourse } from "../src/client/policyClient";
import { demoCourse } from "../src/data/demoCourse";
import { authorPolicy } from "./policyFixtures";
import { demo } from "./helpers";

const he = createLearnerTranslator("he");
const plain = (value: string) => stripBidiControls(value);
const inLocale = (locale: string, node: React.ReactNode) => {
  window.history.replaceState(null, "", `/?locale=${locale}`);
  return render(<LocaleProvider>{node}</LocaleProvider>);
};
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const coverage = (covered: number, denominator: number, extras = 0) => ({
  denominator,
  coveredCoreObjectives: covered,
  personalExtras: {
    committed: { count: extras, additionalMinutes: 0, additionalEpisodes: extras },
    reserved: { count: 0, additionalMinutes: 0, additionalEpisodes: 0 },
  },
  headroom: [],
});

describe("lesson, roadmap and placement in Hebrew", () => {
  it("uses Hebrew plural forms in pure helpers and keeps English as the default", () => {
    expect(coverageText(coverage(1, 4)).core).toBe("1 of 4 core objectives covered");
    expect(coverageText(coverage(1, 1)).core).toBe("1 of 1 core objective covered");
    expect(plain(coverageText(coverage(1, 4), he.t).core)).toBe("כוסו 1 מתוך 4 מטרות ליבה");
    expect(plain(coverageText(coverage(0, 2), he.t).core)).toBe("כוסו 0 מתוך שתי מטרות ליבה");
    expect(plain(coverageText(coverage(1, 4, 1), he.t).extras!)).toMatch(/^נוספה בשבילך תוספת אישית אחת/);
    const limits = { timeoutMs: 5000, outputBytes: 65536, memoryBytes: 268435456, sourceBytes: 64000 };
    expect(resultMessage({ status: "ok", durationMs: 400, outputBytes: 0 }, limits)).toBe("Finished in 0.4 s.");
    expect(plain(resultMessage({ status: "timeout", durationMs: 0, outputBytes: 0 }, limits, he))).toBe(
      "נעצר: ההרצה חרגה ממגבלת הזמן של 5 שנ׳. כדאי לחפש לולאה שלא נגמרת.",
    );
    expect(playerErrorMessage(100, he.t)).toBe("הסרטון הוסר או הוגדר כפרטי.");
    expect(placementReason("course_covered", he)).toBe("ענית על כל נושאי השיבוץ.");
    expect(placementReason("an_unknown_reason", he)).toBeUndefined();
    const used: PlacementView = {
      available: true, maxItems: 4, studied: false, state: "finished", runNumber: 2, maxRuns: 2,
      retest: { allowed: false, availableAt: null }, run: null,
    };
    expect(retakeState(used, he)?.text).toBe("ניצלת את שני ניסיונות השיבוץ שהקורס מאפשר.");
    expect(retakeState({ ...used, retest: { allowed: true, availableAt: null }, runNumber: 1, maxRuns: 3 }, he)?.text).toMatch(
      /^אפשר לחזור על השיבוץ כשמרגישים מוכנים: ניסיון ⁨?2⁩? מתוך ⁨?3⁩?\./,
    );
  });

  it("renders the roadmap and a lesson step in Hebrew, right to left, with course text left as authored", async () => {
    const snapshot = await demo().load();
    inLocale(
      "he",
      <CourseRoadmap course={demoCourse} snapshot={snapshot} compact={false} onOpenLesson={vi.fn()} onPlacement={vi.fn()} />,
    );
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(screen.getByText("מסלול הלמידה שלך")).toBeVisible();
    expect(screen.getByText(new RegExp(`· ${demoCourse.lessons.length} שיעורים ·`))).toBeVisible();
    expect(screen.getByRole("heading", { name: demoCourse.title })).toBeVisible();
    expect(screen.queryByText("Your learning path")).toBeNull();
    expect(screen.queryByText(/Continue learning/)).toBeNull();
  });

  it("renders lesson steps in Hebrew with a mirrored back arrow", async () => {
    const snapshot = await demo().load();
    const lesson = demoCourse.lessons[0]!;
    inLocale(
      "he",
      <LessonFlow
        lesson={lesson}
        step={lesson.steps[0]!}
        snapshot={snapshot}
        compact
        answer=""
        pending={false}
        onAnswer={vi.fn()}
        onStep={vi.fn()}
        onSubmit={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "→ מפת הקורס" })).toBeVisible();
    const current = `${lesson.steps[0]!.title}, שלב חובה, השלב הנוכחי`;
    expect(screen.getByRole("button", { name: (name) => plain(name) === current })).toBeVisible();
    expect(screen.queryByText(/Required steps open in order/)).toBeNull();
  });

  it("explains enrollment limits in Hebrew and isolates the time zone", () => {
    const course: CatalogCourse = {
      id: "release", title: "Everyday patterns", version: "1", status: "published", summary: "Notice what changes.", policy: authorPolicy,
    };
    inLocale("he", <EnrollmentPreview course={course} pending={false} onStart={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: "התחלת הקורס" })).toBeVisible();
    const zone = screen.getByText(/^הזמנים מוצגים לפי/);
    expect(zone.textContent).toContain("⁨Asia/Jerusalem⁩");
    expect(screen.queryByText(/calendar days/)).toBeNull();
  });

  it("shows every profile label through the catalog under the en-XA pseudo-locale", () => {
    inLocale(
      "en-XA",
      <ProfileEditor
        profile={{ displayName: "Dana", goal: "", pace: "steady" } as never}
        onSave={vi.fn()}
        pending={false}
        saved={false}
        demo={false}
      />,
    );
    for (const text of ["Display name", "Preferred pace", "Save profile", "Make room for learning."])
      expect(screen.queryByText(text)).toBeNull();
    expect(screen.getByRole("button").textContent).toMatch(/^⟦.*⟧$/);
  });
});
