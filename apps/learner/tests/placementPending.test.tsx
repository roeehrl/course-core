import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  expect(await screen.findByText(/One answer was incorrect, assisted or marked “I don.t know yet”/)).toBeTruthy();
  expect(screen.queryByText(/Waiting for evaluation/)).toBeNull();
});

it("lets a judged placement answer be appealed through the same review command as any written answer", async () => {
  const view = { ...finished("not_demonstrated", []), state: "in_progress" as const };
  view.run = { ...view.run, nextItem: null } as never;
  let appealed = false;
  const reviews = () => ({
    reviews: [{
      attemptId: "a1", episodeId: "max", submittedAt: "2026-01-01T00:00:00.000Z", status: "not_met", learnerNote: null, placement: true,
      canAppeal: !appealed, appeal: appealed ? { state: "open", note: null } : null,
      criteria: [{ id: "invariant", description: "States the invariant.", required: true, met: false, quote: null, note: null }],
    }],
  });
  const api = { request: vi.fn(async (url: string) => (url.endsWith("/reviews") ? reviews() : view)) };
  const command = vi.fn(async () => { appealed = true; return {}; });
  render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Ask for a second opinion" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Why should another reviewer look again?" }), { target: { value: "I stated the invariant in my second sentence." } });
  fireEvent.click(screen.getByRole("button", { name: "Request a second opinion" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("reviews/a1/appeal", { reason: "I stated the invariant in my second sentence." }));
  // The panel reloads: the request is shown as open and cannot be sent twice.
  expect(await screen.findByText(/Second opinion requested/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Ask for a second opinion" })).toBeNull();
});

it("reports whether its panel is on screen, so the roadmap card can point to it", async () => {
  for (const [state, studied, open] of [["offered", false, true], ["offered", true, false], ["in_progress", false, true], ["finished", false, true], ["declined", false, false], ["accepted", false, false]] as const) {
    const onOpenChange = vi.fn();
    const api = { request: vi.fn(async (url: string) => (url.endsWith("/reviews") ? { reviews: [] } : { ...finished("not_demonstrated", []), state, studied })) };
    const { unmount, container } = render(<PlacementRun api={api as never} command={vi.fn() as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} onOpenChange={onOpenChange} />);
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    await act(async () => {});
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(open));
    expect(Boolean(container.querySelector("#placement-run")), state).toBe(open);
    unmount();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  }
});
