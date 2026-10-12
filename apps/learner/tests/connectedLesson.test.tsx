import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectedLesson,
  type ConnectedLessonProps,
} from "../src/connected/ConnectedLesson.web";
import { connectedSnapshot } from "./connectedFixtures";
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
    onStart: vi.fn(),
    onAnswer: vi.fn(),
    onSolution: vi.fn(),
    onComplete: vi.fn(),
    onNormal: vi.fn(),
    onRefresh: vi.fn(),
    onBlockChange: vi.fn(),
  };
}
describe("linear connected lesson and authoritative gates", () => {
  it("shows only the current unread part and advances only after a server snapshot", () => {
    const p = props();
    const { container, rerender } = render(<ConnectedLesson {...p} />);
    expect(
      screen.getByRole("article", { name: "Reading part 1" }),
    ).toBeVisible();
    expect(container.querySelector("svg")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Complete episode →" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Mark this part read" }),
    );
    expect(p.onRead).toHaveBeenCalledWith("reading");
    expect(
      screen.getByRole("article", { name: "Reading part 1" }),
    ).toBeVisible();
    p.server.lessons[0]!.completedBlockIds = ["reading"];
    rerender(<ConnectedLesson {...p} />);
    expect(
      screen.getByRole("article", { name: "Reading part 2" }),
    ).toBeVisible();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Complete episode →" }),
    ).toBeDisabled();
  });
  it("blocks unreviewed mandatory media even when stale server coverage calls it read", () => {
    const p = props();
    p.server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    p.server.lessons[0]!.gate!.passed = true;
    p.server.course.media[0]!.review = "unreviewed";
    render(<ConnectedLesson {...p} />);
    expect(
      screen.getByRole("button", { name: "Complete episode →" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/required media step is unavailable/),
    ).toBeVisible();
    expect(p.onComplete).not.toHaveBeenCalled();
  });
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
      screen.queryByRole("button", { name: "Check answer" }),
    ).not.toBeInTheDocument();
    expect(p.onAnswer).not.toHaveBeenCalled();
    expect(p.onAnswerChange).not.toHaveBeenCalled();
  });
});
