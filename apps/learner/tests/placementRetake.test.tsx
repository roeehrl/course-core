import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PlacementRun } from "../src/components/PlacementRun.web";
import { CourseApiError } from "../src/client/apiClient";

const finished = (extra: Record<string, unknown>) => ({
  available: true, maxItems: 4, studied: false, state: "finished",
  run: { itemsUsed: 2, pendingChallengeId: null, nextItem: null, stopReason: "not_demonstrated",
    proposal: { exempt: [], startEpisodeId: "min", startTitle: "Minimum", demonstrated: [], pending: [], untestedNoteCode: "not_a_judgement" as const } },
  ...extra,
});
const renderWith = (view: unknown, command = vi.fn()) => {
  const api = { request: vi.fn(async (url: string) => (url.endsWith("/reviews") ? { reviews: [] } : view)) };
  render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
  return { api, command };
};

it("offers Retake placement only when the server allows a retest now", async () => {
  const command = vi.fn(async () => ({}));
  renderWith(finished({ runNumber: 1, maxRuns: 3, retest: { allowed: true, availableAt: "2026-01-01T00:00:00.000Z" } }), command);
  expect(await screen.findByText(/attempt 2 of 3\. It uses only questions you have not seen/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retake placement" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("placement/start", {}));
});

it("shows when a retest becomes available, or that every attempt is used, without a button", async () => {
  renderWith(finished({ runNumber: 1, maxRuns: 2, retest: { allowed: false, availableAt: new Date(Date.now() + 86_400_000).toISOString() } }));
  expect(await screen.findByText(/You can retake placement from .* \(attempt 2 of 2\)/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retake placement" })).toBeNull();
});

it("says every attempt is used, and shows nothing when retests are off or the server is older", async () => {
  renderWith(finished({ runNumber: 2, maxRuns: 2, retest: { allowed: false, availableAt: null } }));
  expect(await screen.findByText("You have used all 2 placement attempts this course allows.")).toBeTruthy();
  for (const view of [finished({ runNumber: 1, maxRuns: 1, retest: { allowed: false, availableAt: null } }), finished({})]) {
    const { container, unmount } = render(
      <PlacementRun api={{ request: vi.fn(async () => view) } as never} command={vi.fn() as never} enrollmentId="e2" firstEpisodeId="min" onFinished={() => {}} />,
    );
    await screen.findAllByText(/Your placement result/);
    expect(container.querySelector(".connected-placement-retake")).toBeNull();
    unmount();
  }
});

it("explains a cooldown or run-limit refusal and keeps the result", async () => {
  const command = vi.fn(async () => {
    throw new CourseApiError("PLACEMENT_RETEST_COOLDOWN", 409, { availableAt: "2030-01-01T09:00:00.000Z" });
  });
  renderWith(finished({ runNumber: 1, maxRuns: 3, retest: { allowed: true, availableAt: null } }), command);
  fireEvent.click(await screen.findByRole("button", { name: "Retake placement" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Placement can be retaken from .*2030.*Your result above still stands/);
});
