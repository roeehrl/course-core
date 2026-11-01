import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { ReplyActions } from "../src/connected/companion/ReplyActions.web";
import { basedOnContent, partNumber } from "../src/connected/companion/BasedOn.web";
import { lessonNavigator, resetCompanionBridge } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";
import type { CompanionContextUsed, CompanionMessage } from "../src/client/companionClient";
import { connectedSnapshot } from "./connectedFixtures";
import { context } from "./companionFixtures";

// "Based on" under a companion reply (final design §3.7): the chip, its sections, a lesson source
// that shows the part in the lesson, and the withheld-answer footnote that takes its place (§3.12).

const used = (extra: Partial<CompanionContextUsed> = {}): CompanionContextUsed => ({
  episodeId: "intro", blockId: "intro-text", answersMessageId: "q", contextRevision: 2, courseDigest: "digest", recentEventCursor: null,
  history: [], summary: null, selection: { kind: "text", excerpt: "no greater than", lineStart: 4, lineEnd: 4 }, media: null, simulation: null,
  evidenceCount: 0, assessmentMode: "none",
  constraints: { deadline: null, expansionAllowed: true, independentAssessmentActive: false, policyRevision: 1, digest: "d" },
  ...extra,
});
const question: CompanionMessage = { id: "q", role: "learner", content: "Why isn't it 9?", context: { episodeId: "intro", selectedAnchor: { kind: "text", blockId: "intro-text" } },
  created_at: "2026-01-02T10:00:00Z", job_id: "job", job_state: "applied" };
const reply = (extra: Partial<CompanionMessage> = {}): CompanionMessage => ({ id: "a", role: "assistant", content: "Compare them on a number line.", context: { episodeId: "intro" },
  created_at: "2026-01-02T10:01:00Z", job_id: "job", context_used: used(), ...extra });
const server = () => {
  const snapshot = connectedSnapshot();
  const episode = snapshot.course.chapters[0]!.episodes[0]!;
  return { ...snapshot, course: { ...snapshot.course, chapters: [{ ...snapshot.course.chapters[0]!, episodes: [{ ...episode, id: "intro",
    blocks: [{ id: "intro-intro", type: "text", markdown: "One" }, { id: "intro-text", type: "text", markdown: "Two" }, ...episode.blocks.filter((block) => block.type !== "text")] }] }] } } as typeof snapshot;
};
function renderActions(message: CompanionMessage, props: Partial<React.ComponentProps<typeof ReplyActions>> = {}, locale: "en" | "he" = "en") {
  return render(
    <I18nProvider value={createLearnerTranslator(locale)}>
      <ReplyActions message={message} messages={[question, message]} conversation={{ enrollmentId: "e", episodeTitles: {}, server: server() }} latest
        context={{ ...context, episodeId: "intro" }} busy="" {...props} />
    </I18nProvider>,
  );
}
afterEach(() => resetCompanionBridge());

describe("Based on", () => {
  it("names the lesson part a block is in, as the lesson numbers its reading parts", () => {
    expect(partNumber(server(), "intro", "intro-text")).toBe(2);
    expect(partNumber(server(), "intro", "missing")).toBeUndefined();
    expect(partNumber(undefined, "intro", "intro-text")).toBeUndefined();
    expect(basedOnContent(reply(), [question, reply()], server())).toMatchObject({ part: 2, question: { id: "q" } });
  });

  it("is a chip that summarises the reply's sources and opens them in plain sections", () => {
    renderActions(reply());
    const chip = screen.getByRole("button", { name: /^Based on/ });
    // Both labels are rendered; the panel's width (a container query) shows one of them.
    expect(stripBidiControls(chip.querySelector(".cc-act-based-long")!.textContent!)).toBe("Based on: Part 2 · your question “Why isn't it 9?”");
    expect(chip.querySelector(".cc-act-based-short")).toHaveTextContent(/^Based on$/);
    fireEvent.click(chip);
    const block = screen.getByRole("region", { name: "What this reply was based on" });
    const text = stripBidiControls(block.textContent ?? "");
    expect(text).toContain("Your question“Why isn't it 9?”");
    expect(text).toContain("You pointed atLesson text: “no greater than” (line 4)");
    // No empty sections.
    expect(text).not.toMatch(/Earlier messages used|Rules for this reply|Your answers used|Video/);
  });

  it("shows a lesson source in the lesson: the sheet drops to Collapsed first", async () => {
    const shown = vi.fn(() => true);
    const stop = lessonNavigator.register(shown);
    companionOpen.sync({ docked: false, surface: "lesson" });
    companionOpen.setSheetOpen(true);
    companionOpen.setDetent("full");
    renderActions(reply());
    fireEvent.click(screen.getByRole("button", { name: /^Based on/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show Part 2 in the lesson" }));
    expect(companionOpen.get().detent).toBe("collapsed");
    await vi.waitFor(() => expect(shown).toHaveBeenCalledWith({ episodeId: "intro", blockId: "intro-text", focus: "block" }));
    stop();
    companionOpen.reset();
  });

  it("is replaced by the withheld-answer footnote, and moves into More as “Based on…”", async () => {
    renderActions(reply({ context: { episodeId: "intro", checkAnswerWithheld: "answer_given", asksLearner: true } }));
    expect(screen.queryByRole("button", { name: /^Based on/ })).toBeNull();
    const footnote = screen.getByRole("button", { name: "Hint instead of the answer: this question counts." });
    expect(screen.getByText("The course doesn't let your companion give or confirm answers to counted checks.")).not.toBeVisible();
    fireEvent.click(footnote);
    expect(footnote).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("The course doesn't let your companion give or confirm answers to counted checks.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Based on…" }));
    expect(screen.getByRole("region", { name: "What this reply was based on" })).toBeVisible();
  });

  it("reads in Hebrew with the spec's words, and English quotations keep their own order", () => {
    renderActions(reply({ context_used: used({ history: [{ messageId: "h", role: "assistant", excerpt: "Minimum means no greater.", clipped: false, excluded: false }], evidenceCount: 3,
      constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: true, policyRevision: 1, digest: "d" } }) }), { onExclude: vi.fn() }, "he");
    fireEvent.click(screen.getByRole("button", { name: /^על סמך/ }));
    const block = screen.getByRole("region", { name: "על מה התשובה התבססה" });
    const text = stripBidiControls(block.textContent ?? "");
    for (const words of ["השאלה שלך", "הקטע שסומן", "טקסט מהשיעור", "(שורה 4)", "הודעות קודמות שנלקחו בחשבון", "תשובת המנחה: “Minimum means no greater.”",
      "כללים לתשובה הזו", "הייתה פתוחה בדיקה שנספרת, ולכן ניתנו רמזים ולא תשובות.", "תרגול מהשיעור הזה בלבד.", "תשובות שנלקחו בחשבון:", "3 תשובות אחרונות"])
      expect(text).toContain(words);
    // The quotation marks are inside the English text's own isolate, so they stay at its start and end.
    expect(block.textContent).toMatch(/[⁦-⁨]“Minimum means no greater\.”⁩/);
    expect(within(block).getByRole("button", { name: (name) => stripBidiControls(name) === "לא להשתמש שוב בהודעה “Minimum means no greater.”" })).toBeVisible();
  });
});
