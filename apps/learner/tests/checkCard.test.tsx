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
});
