import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectedHost } from "../src/ConnectedHost.web";
import { connectedSnapshot } from "./connectedFixtures";
import type { ContextualCompanionClient } from "../src/client/companionClient";
import { pressWhenReady } from "./pressWhenReady";
afterEach(() => vi.unstubAllGlobals());
it("keeps lesson saves disabled until a placement decline is confirmed", async () => {
  const snapshot = connectedSnapshot();
  snapshot.course.chapters[0]!.episodes[0]!.blocks = [
    { type: "text", id: "reading", markdown: "A public example." },
  ];
  let confirmDecline: (() => void) | undefined;
  const declined = new Promise<void>((resolve) => (confirmDecline = resolve));
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const base = `/api/enrollments/${snapshot.enrollmentId}`;
      // The app's platform report describes the device; it is not a lesson save.
      if (input === `${base}/platform-capabilities`) return response({ recorded: true, duplicate: false, snapshotId: "snapshot" });
      if (init?.method === "POST") posts.push(input);
      if (input === "/auth/session")
        return response({ user: { id: "placement-user", displayName: "Learner" } });
      if (input === "/api/enrollments")
        return response([{ id: snapshot.enrollmentId, title: "Study", version: "1", status: "active" }]);
      if (input === "/api/workspaces") return response([]);
      if (input === base) return response(snapshot);
      if (input === `${base}/placement`)
        return response({ available: true, maxItems: 3, studied: false, state: "offered", run: null });
      if (input === `${base}/placement/decline`) {
        await declined;
        return response({ state: "declined" });
      }
      throw Error("Unexpected endpoint");
    }),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<ConnectedHost />);
  await screen.findByRole("heading", { name: "Your courses" });
  await pressWhenReady(screen.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await pressWhenReady(await screen.findByRole("button", { name: "Start from the beginning" }));
  await waitFor(() => expect(posts).toEqual([`/api/enrollments/${snapshot.enrollmentId}/placement/decline`]));
  // Navigation stays available, but the lesson must not start a second saved
  // request while the decline is unconfirmed (it would be refused as uncertain).
  await pressWhenReady(screen.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await screen.findByRole("heading", { name: "Notice the change" });
  const markRead = screen.getByRole("button", { name: "Mark this part read" });
  expect(markRead).toBeDisabled();
  await act(async () => confirmDecline!());
  await waitFor(() => expect(markRead).toBeEnabled());
  expect(posts).toHaveLength(1);
});
