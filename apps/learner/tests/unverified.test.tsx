import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { indexUnverified, UnverifiedBadge } from "../src/connected/unverified.web";

it("indexes only live, shown, generated changes by block and inserted episode", () => {
  const index = indexUnverified([
    { proposalId: "p1", episodeId: "min", blockId: "b1", kind: "append_teaching", unverified: true },
    { proposalId: "p2", episodeId: "min", blockId: "b2", kind: "append_teaching", unverified: false },
    { proposalId: "p3", episodeId: "min", blockId: "b3", kind: "append_teaching", unverified: true, reverted: true },
    { proposalId: "p4", episodeId: "min", blockId: "b4", kind: "append_teaching", unverified: true, hidden: true },
    { proposalId: "p5", episodeId: "extra", blockId: "op", kind: "insert_episode", unverified: true },
  ]);
  expect([...index.blocks]).toEqual([["min/b1", "p1"]]);
  expect([...index.episodes]).toEqual([["extra", "p5"]]);
});

it("names the label for assistive technology, explains it and leads to the change", () => {
  const review = vi.fn();
  render(<UnverifiedBadge what="part" onReview={review} />);
  const summary = screen.getByText("Unverified", { exact: false }).closest("summary")!;
  expect(summary).toHaveAttribute("aria-label", "Unverified: this part was written by AI and has not been reviewed by a person");
  expect(summary).toHaveAttribute("title");
  fireEvent.click(summary);
  fireEvent.click(screen.getByRole("button", { name: "See this change, hide or undo it" }));
  expect(review).toHaveBeenCalledOnce();
});

it("indexes generated questions by item, so a check asking one labels it", () => {
  const index = indexUnverified([
    { proposalId: "p6", episodeId: "min", blockId: "op6", kind: "add_assessment_variant", assessmentId: "artifact-6--item", unverified: true },
    { proposalId: "p7", episodeId: "min", blockId: "op7", kind: "add_assessment_variant", assessmentId: "bank-item", unverified: false },
  ]);
  expect([...index.questions]).toEqual([["artifact-6--item", "p6"]]);
});

it("explains a generated question honestly: its key was checked, no person reviewed it", () => {
  render(<UnverifiedBadge what="question" />);
  const summary = screen.getByText("Unverified", { exact: false }).closest("summary")!;
  expect(summary).toHaveAttribute("aria-label", "Unverified: this question was written by AI and has not been reviewed by a person");
  fireEvent.click(summary);
  expect(screen.getByText(/checked automatically against the course's own model or tests/)).toBeInTheDocument();
});
