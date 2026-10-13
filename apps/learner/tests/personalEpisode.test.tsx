import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { presentation } from "../src/client/presentation";
import { CourseRoadmap } from "../src/components/CourseRoadmap";
import { connectedSnapshot } from "./connectedFixtures";

function withInsertedEpisode(requirement?: "optional") {
  const server = connectedSnapshot();
  server.course.chapters[0]!.episodes.push({
    id: "artifact-remedial",
    title: "Change, one step at a time",
    objectiveIds: ["observe"],
    ...(requirement ? { requirement } : {}),
    blocks: [{ id: "artifact-remedial--walk", type: "text", markdown: "Compare each value with the one before it." }],
  } as never);
  server.lessons.push({ id: "artifact-remedial", status: "locked", completedBlockIds: [], gate: null } as never);
  server.adaptationRequirements = [
    { episodeId: "artifact-remedial", blockId: "operation-1", classification: requirement ?? "required", insertedEpisode: true },
  ];
  return server;
}

describe("personal inserted episodes", () => {
  it("marks only the inserted episode as personal and keeps base lessons unmarked", () => {
    const { course } = presentation(withInsertedEpisode());
    expect(course.lessons.map((l) => [l.id, l.personal ?? false, l.requirement])).toEqual([
      ["intro", false, "required"],
      ["artifact-remedial", true, "required"],
    ]);
  });
  it("labels a personal lesson on the roadmap, including when it is optional", () => {
    const { course, snapshot } = presentation(withInsertedEpisode("optional"));
    render(<CourseRoadmap course={course} snapshot={snapshot} compact onOpenLesson={vi.fn()} onPlacement={vi.fn()} />);
    expect(screen.getByText("Change, one step at a time")).toBeVisible();
    expect(screen.getAllByText("Personal · optional")).toHaveLength(1);
  });
});
