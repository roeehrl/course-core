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
  render(<UnverifiedBadge what="This part" onReview={review} />);
  const summary = screen.getByText("Unverified", { exact: false }).closest("summary")!;
  expect(summary).toHaveAttribute("aria-label", "Unverified: this part was written by AI and has not been reviewed by a person");
  expect(summary).toHaveAttribute("title");
  fireEvent.click(summary);
  fireEvent.click(screen.getByRole("button", { name: "See this change, hide or undo it" }));
  expect(review).toHaveBeenCalledOnce();
});
