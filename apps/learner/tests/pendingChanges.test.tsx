import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PendingChangesNotice, type PendingChange } from "../src/connected/pendingChanges.web";

const waiting: PendingChange = { pendingId: "w1", episodeId: "min", episodeTitle: "Minimum", kind: "attach_visual", reason: "attempt_in_progress",
  addableNow: false, waitingFor: "attempt_in_progress" };

it("says why an addition waits and offers to add it only at a safe point", () => {
  const add = vi.fn(), decline = vi.fn();
  const { rerender } = render(<PendingChangesNotice items={[waiting]} episodeId="min" pending={false} onAdd={add} onDecline={decline} />);
  expect(screen.getByRole("heading", { name: "New material is ready for this lesson" })).toBeVisible();
  expect(screen.getByText(/An interactive simulation your supervisor made for you/)).toBeVisible();
  expect(screen.getByText(/waits until you finish the question you are working on/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Add it to this lesson" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "No thanks" }));
  expect(decline).toHaveBeenCalledWith("w1");
  rerender(<PendingChangesNotice items={[{ ...waiting, addableNow: true, waitingFor: undefined } as PendingChange]} episodeId="min" pending={false} onAdd={add} onDecline={decline} />);
  expect(screen.getByText("You can add it now.", { exact: false })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add it to this lesson" }));
  expect(add).toHaveBeenCalledWith("w1");
});

it("shows nothing for other lessons", () => {
  const { container } = render(<PendingChangesNotice items={[waiting]} episodeId="max" pending={false} onAdd={vi.fn()} onDecline={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});
