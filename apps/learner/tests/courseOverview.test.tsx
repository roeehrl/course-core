import { describe, expect, it } from "vitest";
import { nextStep } from "../src/components/CourseRoadmap";
import { authoredInstant, dueDate } from "../src/connected/policyPresentation";
import { createLearnerTranslator } from "../src/i18n";
import type { Course, LearnerSnapshot, Lesson } from "../src/domain/types";

/** Two chapters of two lessons, each lesson with two parts. */
function course(): Course {
  const lesson = (id: string): Lesson => ({
    id, title: id, description: "", minutes: 5, requirement: "required",
    steps: ["a", "b"].map((part) => ({ id: `${id}-${part}`, kind: "reading", title: part, requirement: "required", eyebrow: "", heading: id, body: "", companion: { idea: "", hint: "" } })),
  } as Lesson);
  return {
    id: "c", version: "1", title: "Course", description: "",
    sections: [
      { id: "one", title: "One", description: "", lessonIds: ["l1", "l2"] },
      { id: "two", title: "Two", description: "", lessonIds: ["l3", "l4"] },
    ],
    lessons: ["l1", "l2", "l3", "l4"].map(lesson),
  } as Course;
}
/** Lessons before `at` completed, the one at `at` available (with `read` parts read), the rest locked. */
function snapshot(at: number, read = 0, extra: Partial<LearnerSnapshot["lessons"][string]> = {}): LearnerSnapshot {
  const ids = ["l1", "l2", "l3", "l4"];
  return {
    revision: "1", mode: "connected", profile: {} as LearnerSnapshot["profile"],
    lessons: Object.fromEntries(ids.map((id, index) => [id, index < at
      ? { status: "completed", completedStepIds: [`${id}-a`, `${id}-b`] }
      : index === at
        ? { status: "available", completedStepIds: [`${id}-a`, `${id}-b`].slice(0, read), ...extra }
        : { status: "locked", completedStepIds: [] }])),
  } as LearnerSnapshot;
}

describe("the course page's next step follows where the learner really is", () => {
  it("a fresh enrollment starts the course; nothing says to pick up where it left off", () => {
    expect(nextStep(course(), snapshot(0))).toMatchObject({ state: "fresh", lesson: { id: "l1" } });
  });
  it("a lesson with a part read continues; a lesson not started yet starts", () => {
    expect(nextStep(course(), snapshot(0, 1))).toMatchObject({ state: "resume", lesson: { id: "l1" } });
    expect(nextStep(course(), snapshot(1))).toMatchObject({ state: "next", lesson: { id: "l2" } });
    expect(nextStep(course(), snapshot(1, 1))).toMatchObject({ state: "resume", lesson: { id: "l2" } });
  });
  it("at a chapter boundary says the chapter is done and the next one begins", () => {
    expect(nextStep(course(), snapshot(2))).toMatchObject({ state: "chapter", lesson: { id: "l3" }, section: { id: "two" } });
    expect(nextStep(course(), snapshot(2, 1)).state).toBe("resume");
  });
  it("finished, waiting on a review, paused and closed each say so", () => {
    expect(nextStep(course(), snapshot(4)).state).toBe("finished");
    const waiting = snapshot(1);
    waiting.lessons.l2 = { status: "locked", completedStepIds: [], underReview: true };
    expect(nextStep(course(), waiting)).toMatchObject({ state: "waiting", lesson: undefined });
    expect(nextStep(course(), snapshot(1), "paused").state).toBe("paused");
    expect(nextStep(course(), snapshot(1), "closed").state).toBe("closed");
  });
});

describe("due dates are dates in the learner's own zone", () => {
  const en = createLearnerTranslator("en");
  it("show the date alone when the time came from a window counted from enrollment", () => {
    // 22:30 UTC is already the next day in Jerusalem: the learner's own calendar day.
    const value = "2027-01-29T22:30:00Z";
    expect(authoredInstant(value, [{ mode: "bounded", window: { calendarDays: 90, timeZone: "UTC", anchor: "enrollment_started", pauseRule: "approved_only" }, existingMaterialAccess: "read_only" }])).toBe(false);
    const shown = dueDate(value, en);
    expect(shown).not.toMatch(/\d{1,2}:\d{2}|UTC|GMT/);
    expect(shown).toBe(new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value)));
  });
  it("keep the time an author set, with the learner's zone named once", () => {
    const value = "2027-03-01T17:00:00Z";
    expect(authoredInstant(value, [undefined, { mode: "bounded", hardDeadline: "2027-03-01T19:00:00+02:00", existingMaterialAccess: "read_only" }])).toBe(true);
    const shown = dueDate(value, en, true);
    expect(shown).toMatch(/\d{1,2}:00/);
    expect(shown.match(/GMT|UTC|[A-Z]{2,4}T/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
