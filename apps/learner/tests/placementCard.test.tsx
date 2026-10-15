import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ConnectedHost } from "../src/ConnectedHost.web";
import { presentation } from "../src/client/presentation";
import { connectedSnapshot } from "./connectedFixtures";

afterEach(() => vi.unstubAllGlobals());
const card = "Already know this material?";
function placeable() {
  const snapshot = connectedSnapshot();
  snapshot.course.chapters[0]!.episodes[0]!.blocks = [{ type: "text", id: "reading", markdown: "A public example." }];
  (snapshot.course as { placement?: unknown }).placement = { enabled: true, objectiveIds: ["observe"], assessmentIds: [], protectedEpisodeIds: [], maxItems: 3 };
  return snapshot;
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function host(snapshot: ReturnType<typeof placeable>, initial: string) {
  let state = initial;
  const base = `/api/enrollments/${snapshot.enrollmentId}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/auth/session") return response({ user: { id: "card-user", displayName: "Learner" } });
      if (input === "/api/enrollments") return response([{ id: snapshot.enrollmentId, title: "Study", version: "1", status: "active" }]);
      if (input === "/api/workspaces") return response([]);
      if (input === base) return response(snapshot);
      if (input === `${base}/placement`) return response({ available: true, maxItems: 3, studied: false, state, run: null });
      if (input === `${base}/placement/decline`) {
        state = "declined";
        return response({ state: "declined" });
      }
      throw Error(`Unexpected endpoint ${input}`);
    }),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<ConnectedHost />);
}

it("never offers the roadmap placement card unless the placement panel is on screen", () => {
  expect(presentation(placeable()).course.placement).toBeUndefined();
  expect(presentation(placeable(), { placementOpen: false }).course.placement).toBeUndefined();
  expect(presentation(placeable(), { placementOpen: true }).course.placement?.title).toBe(card);
});

it("points the card at the open placement panel, and drops it once placement is declined", async () => {
  const scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  onTestFinished(() => { Element.prototype.scrollIntoView = original; });
  host(placeable(), "offered");
  await screen.findByRole("heading", { name: "Your courses" });
  fireEvent.click(screen.getByRole("button", { name: "Continue learning →" }));
  const panel = await screen.findByRole("region", { name: "Already know some of this?" });
  fireEvent.click(await screen.findByRole("button", { name: "Explore placement ↗" }));
  expect(scrolled).toEqual([panel]);
  expect(document.activeElement).toBe(panel);
  fireEvent.click(screen.getByRole("button", { name: "Start from the beginning" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Already know some of this?" })).toBeNull());
  await waitFor(() => expect(screen.queryByText(card)).toBeNull());
  expect(screen.queryByRole("button", { name: "Explore placement ↗" })).toBeNull();
});

it.each(["declined", "accepted", "unavailable"])("shows no placement card when placement is %s", async (state) => {
  host(placeable(), state);
  await screen.findByRole("heading", { name: "Your courses" });
  fireEvent.click(screen.getByRole("button", { name: "Continue learning →" }));
  // The roadmap is on screen and the placement view has been read.
  expect((await screen.findAllByText("Notice the change")).length).toBeGreaterThan(0);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/placement"))).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText(card)).toBeNull();
  expect(screen.queryByRole("button", { name: "Explore placement ↗" })).toBeNull();
});
