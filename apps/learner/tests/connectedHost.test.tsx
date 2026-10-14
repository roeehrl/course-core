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
afterEach(() => vi.unstubAllGlobals());
it("does not duplicate an acknowledged message when refreshing progress fails", async () => {
  const snapshot = connectedSnapshot();
  snapshot.course.chapters[0]!.episodes[0]!.blocks = [
    { type: "text", id: "reading", markdown: "A public example." },
  ];
  let acknowledged = false;
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/auth/session")
        return response({
          user: { id: "receipt-user", displayName: "Learner" },
        });
      if (input === "/api/enrollments")
        return response([
          {
            id: snapshot.enrollmentId,
            title: "Study",
            version: "1",
            status: "active",
          },
        ]);
      if (input === "/api/workspaces") return response([]);
      if (input === `/api/enrollments/${snapshot.enrollmentId}`) {
        if (acknowledged) throw Error("GET unavailable");
        return response(snapshot);
      }
      throw Error("Unexpected endpoint");
    }),
  );
  const client: ContextualCompanionClient = {
    load: vi.fn().mockResolvedValue([]),
    send: vi.fn(async () => {
      acknowledged = true;
      return {
        messageId: "saved",
        eventId: "event",
        state: "queued" as const,
        revision: 2,
        downgradedChallengeIds: [],
      };
    }),
  };
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<ConnectedHost companionClient={client} />);
  await screen.findByRole("heading", { name: "Your courses" });
  fireEvent.click(screen.getByRole("button", { name: "Continue learning →" }));
  await screen.findByRole("heading", {
    name: "Everyday patterns",
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue learning →" }));
  await screen.findByRole("heading", {
    name: "Notice the change",
  });
  const trigger = screen.queryByRole("button", {
    name: "Companion",
  });
  if (trigger) fireEvent.click(trigger);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message to your companion" }),
    { target: { value: "Save this once" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
  expect(client.send).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ episodeId: "intro", blockId: "reading" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message to your companion" }),
    ).toHaveValue(""),
  );
  expect(screen.getByText(/Message saved\./)).toBeVisible();
});
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
  fireEvent.click(screen.getByRole("button", { name: "Continue learning →" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from the beginning" }));
  await waitFor(() => expect(posts).toEqual([`/api/enrollments/${snapshot.enrollmentId}/placement/decline`]));
  // Navigation stays available, but the lesson must not start a second saved
  // request while the decline is unconfirmed (it would be refused as uncertain).
  fireEvent.click(screen.getByRole("button", { name: "Continue learning →" }));
  await screen.findByRole("heading", { name: "Notice the change" });
  const markRead = screen.getByRole("button", { name: "Mark this part read" });
  expect(markRead).toBeDisabled();
  await act(async () => confirmDecline!());
  await waitFor(() => expect(markRead).toBeEnabled());
  expect(posts).toHaveLength(1);
});
