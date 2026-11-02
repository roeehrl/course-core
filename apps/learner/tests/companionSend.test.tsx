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

// Split from connectedHost.test.tsx: a sent companion message is not duplicated when refreshing
// progress fails, and the conversation shows it as the learner's turn.

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
  await pressWhenReady(screen.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await screen.findByRole("heading", {
    name: "Everyday patterns",
  });
  await pressWhenReady(screen.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await screen.findByRole("heading", {
    name: "Notice the change",
  });
  const trigger = screen.queryByRole("button", {
    name: "Companion",
  });
  if (trigger) await pressWhenReady(trigger);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message to your companion" }),
    { target: { value: "Save this once" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
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
  // The sent question is the learner's turn in the conversation: no "Message saved" notice, and
  // the progress read that failed after the save is not the page's error either.
  expect(screen.getByRole("log", { name: "Saved companion messages" })).toHaveTextContent("Save this once");
  expect(screen.queryByText(/Message saved/)).toBeNull();
  expect(screen.queryByText(/progress could not refresh/)).toBeNull();
  expect(client.send).toHaveBeenCalledTimes(1);
});

it("sends once more against the newest progress when the course moved on just before the send", async () => {
  // A check started a moment ago: the server is at a newer revision than the page has drawn, and
  // refuses the question as stale. Nothing was saved; the learner sees no failure.
  const snapshot = connectedSnapshot();
  snapshot.course.chapters[0]!.episodes[0]!.blocks = [{ type: "text", id: "reading", markdown: "A public example." }];
  let moved = false;
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/auth/session") return response({ user: { id: "stale-user", displayName: "Learner" } });
      if (input === "/api/enrollments") return response([{ id: snapshot.enrollmentId, title: "Study", version: "1", status: "active" }]);
      if (input === "/api/workspaces") return response([]);
      if (input === `/api/enrollments/${snapshot.enrollmentId}`) return response({ ...snapshot, revision: snapshot.revision + (moved ? 5 : 0) });
      throw Error("Unexpected endpoint");
    }),
  );
  const { CourseApiError } = await import("../src/client/apiClient");
  const revisions: number[] = [];
  const client: ContextualCompanionClient = {
    load: vi.fn().mockResolvedValue([]),
    send: vi.fn(async (sent) => {
      revisions.push(sent.revision);
      if (revisions.length === 1) {
        moved = true;
        throw new CourseApiError("STALE_REVISION", 409);
      }
      return { messageId: "saved", eventId: "event", state: "queued" as const, revision: sent.revision + 1, downgradedChallengeIds: [] };
    }),
  };
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<ConnectedHost companionClient={client} />);
  await screen.findByRole("heading", { name: "Your courses" });
  await pressWhenReady(screen.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await screen.findByRole("heading", { name: "Everyday patterns" });
  await pressWhenReady(screen.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await screen.findByRole("heading", { name: "Notice the change" });
  const trigger = screen.queryByRole("button", { name: "Companion" });
  if (trigger) await pressWhenReady(trigger);
  fireEvent.change(screen.getByRole("textbox", { name: "Message to your companion" }), { target: { value: "Sent just as a check opened" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.send).toHaveBeenCalledTimes(2));
  expect(revisions[1]).toBeGreaterThan(revisions[0]!);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue(""));
  expect(screen.queryByText("Couldn't send. Your text is back in the box.")).toBeNull();
});
