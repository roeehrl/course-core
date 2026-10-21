import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PRESENCE_REPEAT_MS, PresenceRegion } from "../src/connected/presence.web";

afterEach(() => vi.useRealTimers());

it("reports a part open only once the learner uses it, repeats while it stays in view, and closes it when they leave", () => {
  vi.useFakeTimers();
  const report = vi.fn();
  const { unmount } = render(
    <PresenceRegion blockId="activity-1" kind="activity" report={report}>
      <button type="button">Try it</button>
    </PresenceRegion>,
  );
  // Reading past a part is not working in it.
  expect(report).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Try it" }));
  expect(report).toHaveBeenLastCalledWith("activity-1", "activity", "open", false);
  fireEvent.keyDown(screen.getByRole("button", { name: "Try it" }), { key: "a" });
  expect(report).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(PRESENCE_REPEAT_MS));
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith("activity-1", "activity", "open", false);
  // Leaving the page sends a report that survives the unload.
  unmount();
  expect(report).toHaveBeenLastCalledWith("activity-1", "activity", "closed", true);
  act(() => vi.advanceTimersByTime(PRESENCE_REPEAT_MS * 3));
  expect(report).toHaveBeenCalledTimes(3);
});

it("closes the part when the tab is hidden or the part is finished, and reports nothing for a finished part", () => {
  const report = vi.fn();
  const { rerender } = render(
    <PresenceRegion blockId="sim" kind="simulation" report={report}>
      <input aria-label="Value" />
    </PresenceRegion>,
  );
  fireEvent.input(screen.getByLabelText("Value"), { target: { value: "3" } });
  expect(report).toHaveBeenLastCalledWith("sim", "simulation", "open", false);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(report).toHaveBeenLastCalledWith("sim", "simulation", "closed", true);
  visibility.mockRestore();
  fireEvent.input(screen.getByLabelText("Value"), { target: { value: "4" } });
  expect(report).toHaveBeenLastCalledWith("sim", "simulation", "open", false);
  rerender(
    <PresenceRegion blockId="sim" kind="simulation" report={report} done>
      <input aria-label="Value" />
    </PresenceRegion>,
  );
  expect(report).toHaveBeenLastCalledWith("sim", "simulation", "closed", true);
  const calls = report.mock.calls.length;
  fireEvent.input(screen.getByLabelText("Value"), { target: { value: "5" } });
  expect(report).toHaveBeenCalledTimes(calls);
});
