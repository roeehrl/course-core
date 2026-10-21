import React from "react";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { PlacementRun } from "../src/components/PlacementRun.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

// H04: the result names the questions behind each objective shown and the specific uncertain areas.
const finished = {
  available: true, maxItems: 4, studied: false, state: "finished",
  run: { itemsUsed: 3, pendingChallengeId: null, nextItem: null, stopReason: "not_demonstrated",
    proposal: { exempt: [{ episodeId: "min", title: "Minimum" }], startEpisodeId: "max", startTitle: "Maximum",
      demonstrated: [{ objectiveId: "minimum", description: "Find a minimum.", families: 2,
        supportingItems: [{ assessmentId: "min-a", familyId: "compare", prompt: "Which is smaller?" }, { assessmentId: "min-b", familyId: "select", prompt: "Minimum of 4 and 9?" }] }],
      pending: [],
      notShown: [{ objectiveId: "maximum", description: "Find a maximum.", questions: 1, reason: "answer_not_correct" }],
      untested: [{ objectiveId: "median", description: "Find a median." }], untestedCount: 1, untestedNoteCode: "not_a_judgement" } },
};
const show = (locale: "en" | "he" = "en") => {
  const api = { request: vi.fn().mockResolvedValue(finished) };
  render(<I18nProvider value={createLearnerTranslator(locale)}><PlacementRun api={api as never} command={vi.fn() as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} /></I18nProvider>);
};

it("lists the questions behind each objective shown, what was tried but not shown and why, and what was never asked", async () => {
  show();
  expect(await screen.findByText("Shown independently:")).toBeTruthy();
  expect(screen.getByText("(by these 2 questions)")).toBeTruthy();
  expect(screen.getByText("Which is smaller?")).toBeTruthy();
  expect(screen.getByText("Minimum of 4 and 9?")).toBeTruthy();
  expect(screen.getByText("Tried but not shown yet. These stay on your path:")).toBeTruthy();
  expect(screen.getByText("the answer was not correct")).toBeTruthy();
  expect(screen.getByText("Not asked in this placement (1 objective). These stay on your path:")).toBeTruthy();
  expect(screen.getByText("Find a median.")).toBeTruthy();
  expect(screen.getByText("Objectives not listed were not tested and stay on your path; this is not a judgement of ability.")).toBeTruthy();
});

it("says it in Hebrew, with the course text as written", async () => {
  show("he");
  expect(await screen.findByText("הוכח באופן עצמאי:")).toBeTruthy();
  expect(screen.getByText((_, node) => node?.tagName === "SPAN" && stripBidiControls(node.textContent ?? "").trim() === "(בשתי השאלות האלה)")).toBeTruthy();
  expect(screen.getByText("מטרות למידה שלא מופיעות כאן לא נבדקו ונשארות במסלול שלך; אין בזה שיפוט של יכולת.")).toBeTruthy();
  expect(screen.getByText("Which is smaller?")).toBeTruthy();
});
