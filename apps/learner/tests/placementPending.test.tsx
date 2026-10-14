import React from "react";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PlacementRun } from "../src/components/PlacementRun.web";

const finished = (stopReason: string, pending: { objectiveId: string; description: string }[]) => ({
  available: true, maxItems: 4, studied: false, state: "finished",
  run: { itemsUsed: 2, pendingChallengeId: null, nextItem: null, stopReason,
    proposal: { exempt: [], startEpisodeId: "min", startTitle: "Minimum", demonstrated: [], pending,
      untestedNote: "Objectives not listed were not tested and stay on your path; this is not a judgement of ability." } },
});

it("shows an answer awaiting evaluation as undecided, never as wrong", async () => {
  const api = { request: vi.fn().mockResolvedValue(finished("pending_evaluation", [{ objectiveId: "minimum", description: "Find a minimum." }])) };
  render(<PlacementRun api={api as never} command={vi.fn() as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
  expect(await screen.findByText(/still waiting to be evaluated\. It is not counted as wrong/)).toBeTruthy();
  expect(screen.getByText(/Waiting for evaluation, not marked wrong: Find a minimum\./)).toBeTruthy();
  expect(screen.queryByText(/incorrect/)).toBeNull();
});

it("shows no pending note when nothing awaits evaluation", async () => {
  const api = { request: vi.fn().mockResolvedValue(finished("not_demonstrated", [])) };
  render(<PlacementRun api={api as never} command={vi.fn() as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
  expect(await screen.findByText(/One answer was incorrect or assisted/)).toBeTruthy();
  expect(screen.queryByText(/Waiting for evaluation/)).toBeNull();
});
