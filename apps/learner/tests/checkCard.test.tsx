import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectedLesson,
  returnPoint,
  type ConnectedLessonProps,
} from "../src/connected/ConnectedLesson.web";
import { stripBidiControls } from "@course-core/i18n";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";
import { lessonNavigator, resetCompanionBridge } from "../src/connected/companion/bridge";
import { Card, answered, cardProps, question } from "./checkCardFixtures";

// Split from connectedLesson.test.tsx: the check uses the server's current question and keeps expired drafts.

function props(): ConnectedLessonProps {
  const server = connectedSnapshot();
  return {
    server,
    episode: server.course.chapters[0]!.episodes[0]!,
    placement: false,
    pending: false,
    now: Date.now(),
    answer: "",
    onAnswerChange: vi.fn(),
    onRead: vi.fn(),
    check: { onStart: vi.fn(), onAnswer: vi.fn(), onSolution: vi.fn() },
    onComplete: vi.fn(),
    onNormal: vi.fn(),
    onRefresh: vi.fn(),
    onBlockChange: vi.fn(),
  };
}
describe("linear connected lesson and authoritative gates", () => {
  it("uses current server questions and preserves expired answer drafts without submitting", () => {
    const p = props();
    p.server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    p.server.activeChallenges = [
      {
        challengeId: "fresh",
        episodeId: "intro",
        independentEligible: true,
        mode: "independent",
        question: {
          id: "q",
          type: "numeric",
          prompt: "A dynamically issued problem",
        },
        expiresAt: new Date(p.now - 1).toISOString(),
      },
    ];
    p.answer = "42";
    render(<ConnectedLesson {...p} />);
    expect(screen.getByRole("button", { name: "Refresh check" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Check" }),
    ).not.toBeInTheDocument();
    expect(p.check.onAnswer).not.toHaveBeenCalled();
    expect(p.onAnswerChange).not.toHaveBeenCalled();
  });
  it("shows the check and puts focus on its answer when asked from elsewhere in the app", () => {
    resetCompanionBridge();
    const p = props();
    p.server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    p.server.activeChallenges = [
      { challengeId: "open", episodeId: "intro", independentEligible: true, mode: "independent", question: { id: "q", type: "numeric", prompt: "How many?" } },
    ];
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<ConnectedLesson {...p} />);
    expect(lessonNavigator.show({ challengeId: "elsewhere", focus: "answer" })).toBe(false);
    expect(lessonNavigator.show({ episodeId: "intro", challengeId: "open", focus: "answer" })).toBe(true);
    expect(scroll).toHaveBeenCalled();
    expect(document.querySelector(".connected-check")).toHaveAttribute("data-cc-highlight", "hold");
    expect(screen.getByRole("textbox")).toHaveFocus();
  });
  it("says the result in place under the question: the verdict, the explanation and why it was practice", () => {
    const open = question({}, { independentEligible: false, practiceReason: "companion" });
    render(<Card {...cardProps(undefined, { attempts: answered(open, { passed: true, explanation: "Before the bias: $2 \\cdot 6 = 12$." }, "12") })} />);
    const slot = document.querySelector(".connected-check .connected-answer-feedback")!;
    expect(slot).toHaveAttribute("role", "status");
    expect(slot).toHaveAttribute("aria-atomic", "true");
    // Under the question and its answer, not above them.
    const prompt = screen.getByText(/With w = 2 and x = 6/);
    expect(prompt.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const verdict = slot.querySelector(".cc-check-verdict")!;
    expect(verdict).toHaveTextContent("Correct.");
    expect(verdict.querySelector("svg[data-icon='check']")).not.toBeNull();
    expect(slot.textContent).not.toContain("$");
    // Why it was practice, in the credit's own words (CRD-6).
    expect(slot.querySelector(".cc-check-suffix")).toHaveTextContent("This counts as practice because you asked your companion.");
    // No box, no warning colour: words carry the verdict.
    expect(slot.querySelector("[data-tone]")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Your numeric answer" })).toHaveValue("12");
    // Answered: no "Check", no help bar; the next question is the lesson's own button.
    expect(screen.queryByRole("button", { name: "Check" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Get help" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start the next check →" })).toBeVisible();
  });
  it("words a written answer, a code check and a time limit as feedback lines", () => {
    const written = question({ type: "teach_back", criteria: [] } as never);
    const { unmount } = render(<Card {...cardProps(undefined, { attempts: answered(written, { passed: false, pendingReview: true, message: { code: "pending_review" } }, "Mine.") })} />);
    expect(document.querySelector(".cc-check-verdict")).toHaveTextContent("Submitted for review.");
    unmount();
    const code = question({ type: "code", language: "python", starterCode: "" } as never);
    render(<Card {...cardProps(undefined, { attempts: { intro: { ...answered(code, { passed: false, message: { code: "code_limit", params: { limit: "time" } }, execution: { status: "timeout" } }).intro!, code: true } } })} />);
    const verdict = document.querySelector(".cc-check-verdict")!;
    expect(verdict).toHaveTextContent("Code check didn't pass.");
    expect(verdict.querySelector("svg[data-icon='rotate-ccw']")).not.toBeNull();
    expect(document.querySelector(".connected-answer-feedback")).toHaveTextContent("The submission did not finish within the time limit.");
  });
  it("keeps the answer when the grader could not check it, and offers to try again", () => {
    const open = question();
    const p = cardProps(open, { attempts: { intro: { challenge: open, answer: "12", kind: "answer", status: "failed" } } });
    p.answer = "12";
    render(<Card {...p} />);
    expect(document.querySelector(".connected-answer-feedback")).toHaveTextContent("Couldn't check your answer. Your answer is kept; try again.");
    expect(screen.getByRole("textbox", { name: "Your numeric answer" })).toHaveValue("12");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.check.onRetry).toHaveBeenCalledWith(open);
  });
  it("checks on Enter in a one-line field and keeps the button's width while it checks", () => {
    const open = question();
    const p = cardProps(open);
    p.answer = "12";
    const { rerender } = render(<Card {...p} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your numeric answer" }), { key: "Enter" });
    expect(p.check.onAnswer).toHaveBeenCalledWith(open);
    // An input method still composing keeps its Enter.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your numeric answer" }), { key: "Enter", keyCode: 229 });
    expect(p.check.onAnswer).toHaveBeenCalledTimes(1);
    const button = screen.getByRole("button", { name: "Check" });
    // Both labels sit in the button; only one is named and shown at a time.
    expect(button.textContent).toBe("CheckChecking…");
    rerender(<Card {...p} check={{ ...p.check, savingAnswer: true, attempts: { intro: { challenge: open, answer: "12", kind: "answer", status: "checking" } } }} />);
    expect(screen.getByRole("button", { name: "Checking…" })).toBe(button);
    expect(button).toBeDisabled();
    expect(button).toHaveClass("is-checking");
  });
  it("puts back the focus a pressed Check lost while saving: on the retry, or on the field after a refusal", () => {
    const open = question();
    const p = cardProps(open);
    p.answer = "12";
    const { rerender } = render(<Card {...p} />);
    const button = screen.getByRole("button", { name: "Check" });
    button.focus();
    fireEvent.click(button);
    // The pressed button is disabled while the answer is saved: the browser drops its focus.
    button.blur();
    rerender(<Card {...p} check={{ ...p.check, savingAnswer: true, attempts: { intro: { challenge: open, answer: "12", kind: "answer", status: "checking" } } }} />);
    rerender(<Card {...p} check={{ ...p.check, attempts: { intro: { challenge: open, answer: "12", kind: "answer", status: "failed" } } }} />);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
    // A refusal recorded nothing: the learner answers again in the field, which the refusal describes.
    (document.activeElement as HTMLElement).blur();
    rerender(<Card {...p} check={{ ...p.check, fieldErrors: { c1: "attemptRequired" } }} />);
    const field = screen.getByRole("textbox", { name: "Your numeric answer" });
    expect(field).toHaveFocus();
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("This question needs an attempt. A partial answer is fine.");
    expect(field).toHaveAttribute("aria-describedby", error.id);
  });
});

