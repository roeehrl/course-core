import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RetentionPanel } from "../src/components/RetentionPanel.web";
import type { RetentionPanelProps } from "../src/components/RetentionPanel";

const apiOf = (body: unknown) => ({ request: vi.fn(async () => body) }) as unknown as RetentionPanelProps["api"];
const view = (availability: { weekdays: number[]; timeZone: string } | null) => ({
  available: true,
  availability,
  items: [{ objectiveId: "minimum", description: "Find a minimum", state: "needs_review", dueAt: "2026-10-26T00:00:00.000Z", due: false, freshItemsLeft: 1,
    lastOutcome: "missed", movedForAvailability: true }],
});

describe("delayed checks panel (F06)", () => {
  it("explains a graded miss and a check moved to the learner's study day", async () => {
    const api = apiOf(view({ weekdays: [1, 3], timeZone: "Asia/Jerusalem" }));
    render(<RetentionPanel api={api} enrollmentId="e1" revision={1} onStart={vi.fn()} onSaveAvailability={vi.fn()} />);
    expect(await screen.findByText(/the next one comes a step sooner, not back to the start/)).toBeVisible();
    expect(screen.getByText(/moved to your next study day/)).toBeVisible();
    expect(screen.getByText(/in your time zone \(Asia\/Jerusalem\)/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Monday" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Sunday" })).not.toBeChecked();
  });
  it("saves the ticked days, refuses none, and saves every day as no restriction", async () => {
    const api = apiOf(view(null));
    const save = vi.fn(async () => undefined);
    render(<RetentionPanel api={api} enrollmentId="e1" revision={1} onStart={vi.fn()} onSaveAvailability={save} />);
    expect(await screen.findByText("Checks can fall due on any day.")).toBeVisible();
    const button = screen.getByRole("button", { name: "Save study days" });
    expect(button).toBeDisabled();
    for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) fireEvent.click(screen.getByRole("checkbox", { name: day }));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledWith([6], expect.any(String)));
    expect(await screen.findByText(/Study days saved/)).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Saturday" }));
    expect(screen.getByText("Pick at least one day.")).toBeVisible();
    expect(button).toBeDisabled();
    for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) fireEvent.click(screen.getByRole("checkbox", { name: day }));
    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(null, expect.any(String)));
  });
  it("says so when saving fails", async () => {
    const api = apiOf(view(null));
    render(<RetentionPanel api={api} enrollmentId="e1" revision={1} onStart={vi.fn()} onSaveAvailability={vi.fn(async () => { throw new Error("offline"); })} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Sunday" }));
    fireEvent.click(screen.getByRole("button", { name: "Save study days" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your study days could not be saved. Nothing changed; try again.");
  });
});
