import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PlacementRunProps } from "../src/components/PlacementRun";
import { pressWhenReady } from "./pressWhenReady";

const offered = { available: true, maxItems: 3, studied: false, state: "offered", run: null };
const UNAVAILABLE = "Placement is unavailable right now. You can start learning normally, or try again.";

/** The first-load failure cases, run against both the web and the native panel. */
export function unavailableCases(PlacementRun: (props: PlacementRunProps) => React.ReactNode) {
  const mount = (request: () => Promise<unknown>) => {
    const api = { request: vi.fn(request) };
    render(<PlacementRun api={api as never} command={vi.fn() as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
    return api;
  };

  it("says placement is unavailable when the first load fails, and a retry recovers", async () => {
    let fail = true;
    const api = mount(async () => {
      if (fail) throw new Error("offline");
      return offered;
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE);
    fail = false;
    await pressWhenReady(screen.getByRole("button", { name: "Try placement again" }));
    expect(await screen.findByRole("heading", { name: "Already know some of this?" })).toBeTruthy();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it("keeps the message and the retry when the retry fails too", async () => {
    const api = mount(async () => {
      throw new Error("offline");
    });
    await screen.findByRole("alert");
    await pressWhenReady(screen.getByRole("button", { name: "Try placement again" }));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
    // Web buttons use `disabled`; native (react-native-web) ones use aria-disabled.
    await waitFor(() => {
      const retry = screen.getByRole("button", { name: "Try placement again" });
      expect(retry.hasAttribute("disabled") || retry.getAttribute("aria-disabled") === "true").toBe(false);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(screen.queryByRole("heading", { name: "Already know some of this?" })).toBeNull();
  });

  it("shows nothing for an aborted load, which is not a failure", async () => {
    const api = mount(async () => {
      throw Object.assign(new Error("Request cancelled"), { name: "AbortError" });
    });
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try placement again" })).toBeNull();
  });
}
