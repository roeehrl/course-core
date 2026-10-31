import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  lessonSteps,
  nowAndNext,
  stepStatusLabels,
} from "../src/connected/lessonSteps";
import { presentation } from "../src/client/presentation";
import { CourseRoadmap, roadmapState } from "../src/components/CourseRoadmap";
import { connectedSnapshot } from "./connectedFixtures";
import type { ServerSnapshot } from "../src/client/apiClient";

const episodeOf = (server: ServerSnapshot) =>
  server.course.chapters[0]!.episodes[0]!;
const statuses = (server: ServerSnapshot) =>
  lessonSteps(server, episodeOf(server)).map((step) => [
    step.title,
    step.status,
  ]);

describe("connected lesson steps", () => {
  it("labels every part and the check with the SDK's step statuses and finds Now and Next", () => {
    const server = connectedSnapshot();
    expect(statuses(server)).toEqual([
      ["Part 1 · Reading", "current"],
      ["Part 2 · Illustration", "required"],
      ["Part 3 · Video", "required"],
      ["Check your understanding", "locked"],
      ["Finish this lesson", "locked"],
    ]);
    const place = nowAndNext(lessonSteps(server, episodeOf(server)));
    expect(place.now?.title).toBe("Part 1 · Reading");
    expect(place.next?.title).toBe("Part 2 · Illustration");
    expect(Object.keys(stepStatusLabels)).toHaveLength(7);
  });
  it("marks optional media and plan-optional parts as optional help that Next skips", () => {
    const server = connectedSnapshot();
    const blocks = episodeOf(server).blocks;
    blocks[2] = {
      id: "movie",
      type: "media",
      mediaId: "video",
      required: false,
    };
    server.adaptationRequirements = [
      { episodeId: "intro", blockId: "picture", classification: "optional" },
    ];
    server.lessons[0]!.completedBlockIds = ["reading"];
    expect(statuses(server)).toEqual([
      ["Part 1 · Reading", "completed"],
      ["Part 2 · Illustration", "current"],
      ["Part 3 · Video", "optional_help"],
      ["Check your understanding", "locked"],
      ["Finish this lesson", "locked"],
    ]);
    expect(nowAndNext(lessonSteps(server, episodeOf(server))).next?.title).toBe(
      "Check your understanding",
    );
  });
  it("shows a check under review, a passed check, and gaps when access closes", () => {
    const server = connectedSnapshot();
    server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    expect(statuses(server).slice(3)).toEqual([
      ["Check your understanding", "current"],
      ["Finish this lesson", "locked"],
    ]);
    server.lessons[0]!.gate = {
      ...server.lessons[0]!.gate!,
      status: "under_review",
    };
    expect(statuses(server)[3]![1]).toBe("under_review");
    expect(nowAndNext(lessonSteps(server, episodeOf(server))).now?.status).toBe(
      "under_review",
    );
    server.lessons[0]!.gate = {
      ...server.lessons[0]!.gate!,
      status: "ready",
      passed: true,
    };
    expect(statuses(server).slice(3)).toEqual([
      ["Check your understanding", "completed"],
      ["Finish this lesson", "current"],
    ]);
    const closed = connectedSnapshot();
    closed.inaccessibleEpisodeIds = ["intro"];
    closed.lessons[0]!.completedBlockIds = ["reading"];
    expect(statuses(closed).map(([, status]) => status)).toEqual([
      "completed",
      "closed_with_gaps",
      "closed_with_gaps",
      "closed_with_gaps",
      "closed_with_gaps",
    ]);
    const finished = connectedSnapshot();
    finished.lessons[0]!.status = "completed";
    finished.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    finished.lessons[0]!.gate!.passed = true;
    expect(
      statuses(finished).every(([, status]) => status === "completed"),
    ).toBe(true);
    expect(
      nowAndNext(lessonSteps(finished, episodeOf(finished))).now,
    ).toBeUndefined();
  });
});

function stagedServer() {
  const server = connectedSnapshot();
  const intro = episodeOf(server);
  server.course.stages = [
    { id: "foundations", title: "Foundations", summary: "Where it starts." },
    { id: "practice", title: "Practice" },
  ];
  server.course.chapters = [
    {
      id: "begin",
      title: "Begin",
      stageId: "foundations",
      subtitle: "Author eyebrow",
      episodes: [intro],
    },
    {
      id: "apply",
      title: "Apply",
      stageId: "practice",
      episodes: [
        {
          id: "review-me",
          title: "Reviewed lesson",
          objectiveIds: ["observe"],
          blocks: [],
        },
        {
          id: "detour",
          title: "A side trip",
          objectiveIds: ["observe"],
          requirement: "optional",
          blocks: [],
        },
      ],
    },
    {
      id: "loose",
      title: "Unstaged chapter",
      episodes: [
        { id: "later", title: "Later", objectiveIds: ["observe"], blocks: [] },
      ],
    },
  ];
  server.lessons.push(
    {
      id: "review-me",
      status: "available",
      completedBlockIds: [],
      gate: { passed: false, objectives: [], status: "under_review" },
    },
    { id: "detour", status: "available", completedBlockIds: [], gate: null },
    { id: "later", status: "locked", completedBlockIds: [], gate: null },
  );
  return server;
}

describe("roadmap from SDK metadata", () => {
  it("carries stages, chapter subtitles and icons without inventing labels", () => {
    const { course, snapshot } = presentation(stagedServer());
    expect(course.subtitle).toBeUndefined();
    expect(course.stages?.map((stage) => stage.id)).toEqual([
      "foundations",
      "practice",
    ]);
    expect(course.sections[0]).toMatchObject({
      stageId: "foundations",
      subtitle: "Author eyebrow",
    });
    expect(snapshot.lessons["review-me"]?.underReview).toBe(true);
    expect(snapshot.lessons["detour"]?.underReview).toBeUndefined();
  });
  it("distinguishes current, under review, optional detour and locked", () => {
    const { course, snapshot } = presentation(stagedServer());
    const state = (id: string) =>
      roadmapState(
        course.lessons.find((l) => l.id === id)!,
        snapshot.lessons[id],
        "intro",
      );
    expect(["intro", "review-me", "detour", "later"].map(state)).toEqual([
      "current",
      "under_review",
      "optional_detour",
      "locked",
    ]);
  });
  it("groups chapters under stage headings, folds all but the current chapter, and keeps them open through a resize", () => {
    const { course, snapshot } = presentation(stagedServer());
    const props = {
      course,
      snapshot,
      onOpenLesson: vi.fn(),
      onPlacement: vi.fn(),
    };
    const { rerender } = render(<CourseRoadmap {...props} compact={false} />);
    expect(screen.getByRole("heading", { level: 2, name: "Your learning path" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Foundations" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "Begin" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Unstaged chapter" })).toBeVisible();
    expect(screen.getByText("Author eyebrow")).toBeVisible();
    expect(screen.queryByText("≋")).not.toBeInTheDocument();
    // Only the chapter with the next lesson starts open.
    const toggle = (title: string) => screen.getByRole("button", { name: new RegExp(`^(Author eyebrow)?${title}`) });
    expect(toggle("Begin")).toHaveAttribute("aria-expanded", "true");
    expect(toggle("Apply")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Lessons in Apply" })).toBeNull();
    fireEvent.click(toggle("Apply"));
    const lessons = screen.getByRole("list", { name: "Lessons in Apply" });
    expect(within(lessons).getAllByRole("listitem")).toHaveLength(2);
    expect(within(lessons).getByText("Under review")).toBeVisible();
    expect(within(lessons).getByText("Optional detour")).toBeVisible();
    // A lesson that can be opened is one press away; a locked one is not a button.
    fireEvent.click(screen.getByRole("button", { name: "Lesson 3: A side trip, Optional detour" }));
    expect(props.onOpenLesson).toHaveBeenCalledWith(expect.objectContaining({ id: "detour" }));
    fireEvent.click(toggle("Unstaged chapter"));
    expect(screen.queryByRole("button", { name: /Lesson 4: Later/ })).toBeNull();
    expect(screen.getAllByText((_, node) => node?.textContent === "Later, Locked")[0]).toBeVisible();
    // A resize to a compact window changes the layout, not which chapters are open.
    rerender(<CourseRoadmap {...props} compact />);
    expect(toggle("Apply")).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Lessons in Apply" })).getAllByRole("listitem")).toHaveLength(2);
  });
});
