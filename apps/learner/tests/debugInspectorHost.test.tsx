import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectedHost } from "../src/ConnectedHost.web";
import { connectedSnapshot } from "./connectedFixtures";
import type { ContextualCompanionClient } from "../src/client/companionClient";
import { pressWhenReady } from "./pressWhenReady";

afterEach(() => vi.unstubAllGlobals());
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

/** Opens the first lesson with the server answering the inspector question with `access`. */
async function openLesson(access: unknown) {
  const snapshot = connectedSnapshot();
  snapshot.course.chapters[0]!.episodes[0]!.blocks = [{ type: "text", id: "reading", markdown: "A public example." }];
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/auth/session") return response({ user: { id: "inspector-user", displayName: "Person" } });
    if (input === "/api/enrollments") return response([{ id: snapshot.enrollmentId, title: "Study", version: "1", status: "active" }]);
    if (input === "/api/workspaces") return response([]);
    if (input === `/api/enrollments/${snapshot.enrollmentId}`) return response(snapshot);
    if (input === `/api/enrollments/${snapshot.enrollmentId}/debug-inspector`) { asked.push(input); return response(access); }
    throw Error("Unexpected endpoint");
  }));
  const client: ContextualCompanionClient = { load: vi.fn().mockResolvedValue([]), send: vi.fn() };
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<ConnectedHost companionClient={client} />);
  await screen.findByRole("heading", { name: "Your courses" });
  await pressWhenReady(screen.getByRole("button", { name: "Continue learning →" }));
  await screen.findByRole("heading", { name: "Everyday patterns" });
  await pressWhenReady(screen.getByRole("button", { name: "Continue learning →" }));
  await screen.findByRole("heading", { name: "Notice the change" });
  await waitFor(() => expect(asked).toHaveLength(1));
  return snapshot;
}

it("never shows the inspector entry to a learner the server did not authorize", async () => {
  await openLesson({ available: false, permissions: [] });
  expect(screen.queryByRole("button", { name: "Debug inspector" })).toBeNull();
});

it("shows the entry beside the lesson for an authorized owner and frames the inspector at the current part", async () => {
  const snapshot = await openLesson({ available: true, role: "owner", permissions: ["learner.view", "run.inspect"], path: "/admin/inspector", receipt: "learner.viewed_by_staff" });
  await pressWhenReady(await screen.findByRole("button", { name: "Debug inspector" }));
  const frame = await screen.findByTitle("Debug inspector for this lesson");
  expect(frame.getAttribute("src")).toBe(`/admin/inspector?enrollment=${snapshot.enrollmentId}&episode=intro&block=reading&locale=en`);
});
