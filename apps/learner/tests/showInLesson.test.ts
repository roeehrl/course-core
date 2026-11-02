import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lessonNavigator, resetCompanionBridge, type LessonTarget } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { showInLesson } from "../src/connected/companion/showInLesson";

/** Two frames: the commit that shows the lesson again, then its layout. */
const frames = () => new Promise((resolve) => setTimeout(resolve, 80));

beforeEach(() => {
  resetCompanionBridge();
  window.localStorage.clear();
  window.sessionStorage.clear();
  companionOpen.reset();
  document.body.innerHTML = `<main class="connected-main"></main>`;
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("a jump from the companion into the lesson", () => {
  it("in focus view goes back beside the lesson first, and shows the place once the lesson is back", async () => {
    companionOpen.sync({ docked: true, surface: "lesson" });
    companionOpen.open("trigger");
    companionOpen.setView("focus");
    const shown: { target: LessonTarget; view: string }[] = [];
    lessonNavigator.register((target) => (shown.push({ target, view: companionOpen.get().view }), true));
    const target: LessonTarget = { challengeId: "check-1", focus: "answer" };
    showInLesson(target);
    // The panel goes back beside the lesson at once; nothing is shown in the hidden lesson.
    expect(companionOpen.get()).toMatchObject({ open: true, view: "docked" });
    expect(window.sessionStorage.getItem("course:learner-companion-view")).toBeNull();
    expect(shown).toEqual([]);
    await frames();
    expect(shown).toEqual([{ target, view: "docked" }]);
  });

  it("beside the lesson keeps the panel as it is", async () => {
    companionOpen.sync({ docked: true, surface: "lesson" });
    companionOpen.open("trigger");
    const shown: LessonTarget[] = [];
    lessonNavigator.register((target) => (shown.push(target), true));
    showInLesson({ blockId: "part-2", focus: "block" });
    await frames();
    expect(shown).toEqual([{ blockId: "part-2", focus: "block" }]);
    expect(companionOpen.get()).toMatchObject({ open: true, view: "docked", paneOpen: true });
  });

  it("as a sheet drops it to Collapsed first", async () => {
    companionOpen.sync({ docked: false, surface: "lesson" });
    companionOpen.open("trigger");
    const shown: LessonTarget[] = [];
    lessonNavigator.register((target) => (shown.push(target), true));
    showInLesson({ challengeId: "check-1", focus: "answer" });
    expect(companionOpen.get().detent).toBe("collapsed");
    await frames();
    expect(shown).toEqual([{ challengeId: "check-1", focus: "answer" }]);
  });
});
