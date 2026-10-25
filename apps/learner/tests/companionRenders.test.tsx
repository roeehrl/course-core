import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { connectedSnapshot } from "./connectedFixtures";
import type { CompanionMessage, ContextualCompanionClient } from "../src/client/companionClient";
import { pressWhenReady } from "./pressWhenReady";

// Count how often the lesson and the companion render, around the real components.
const renders = vi.hoisted(() => ({ lesson: 0, companion: 0 }));
vi.mock("../src/connected/ConnectedLesson.web", async (original) => {
  const actual = await original<typeof import("../src/connected/ConnectedLesson.web")>();
  return {
    ...actual,
    ConnectedLesson: (props: Parameters<typeof actual.ConnectedLesson>[0]) => {
      renders.lesson++;
      return <actual.ConnectedLesson {...props} />;
    },
  };
});
vi.mock("../src/components/ConnectedCompanion", async (original) => {
  const actual = await original<typeof import("../src/components/ConnectedCompanion")>();
  return {
    ...actual,
    ConnectedCompanion: (props: Parameters<typeof actual.ConnectedCompanion>[0]) => {
      renders.companion++;
      return <actual.ConnectedCompanion {...props} />;
    },
  };
});
const { ConnectedHost } = await import("../src/ConnectedHost.web");

afterEach(() => vi.unstubAllGlobals());

it("a companion answer re-renders the companion, not the lesson, and identical reads re-render nothing", async () => {
  const snapshot = connectedSnapshot();
  snapshot.course.chapters[0]!.episodes[0]!.blocks = [{ type: "text", id: "reading", markdown: "A public example." }];
  const encoder = new TextEncoder();
  const streams: { push(text: string): void; signal: AbortSignal }[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/auth/session") return json({ user: { id: "render-user", displayName: "Learner" } });
      if (input === "/api/enrollments")
        return json([{ id: snapshot.enrollmentId, title: "Study", version: "1", status: "active" }]);
      if (input === "/api/workspaces") return json([]);
      if (input === `/api/enrollments/${snapshot.enrollmentId}`) return json(snapshot);
      if (input.endsWith("/events/stream")) {
        let push: (text: string) => void = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(encoder.encode(text));
          },
        });
        streams.push({ push: (text) => push(text), signal: init!.signal! });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      throw Error("Unexpected endpoint");
    }),
  );
  const question: CompanionMessage = {
    id: "q",
    role: "learner",
    content: "Why does it change?",
    context: { episodeId: "intro" },
    created_at: "2026-01-01",
    job_state: "succeeded",
  };
  let messages: readonly CompanionMessage[] = [question];
  const load = vi.fn(async () => messages);
  const client: ContextualCompanionClient = { load, send: vi.fn() };
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<ConnectedHost companionClient={client} />);
  await screen.findByRole("heading", { name: "Your courses" });
  await pressWhenReady(screen.getByRole("button", { name: "Continue learning →" }));
  await screen.findByRole("heading", { name: "Everyday patterns" });
  await pressWhenReady(screen.getByRole("button", { name: "Continue learning →" }));
  await screen.findByRole("heading", { name: "Notice the change" });
  const trigger = screen.queryByRole("button", { name: "Companion" });
  if (trigger) await pressWhenReady(trigger);
  await screen.findByText("Why does it change?");
  await waitFor(() => expect(streams).toHaveLength(1));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const settled = { ...renders }, reads = load.mock.calls.length;
  const event = (id: number, type: string) =>
    `id: ${id}\nevent: learning-event\ndata: ${JSON.stringify({ event_type: type })}\n\n`;
  // An event whose read returns the same conversation: nothing renders.
  streams[0]!.push(event(1, "companion.asked"));
  await waitFor(() => expect(load.mock.calls.length).toBe(reads + 1));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(renders).toEqual(settled);
  // The answer arrives: the companion shows it, the lesson does not render again.
  messages = [question, { ...question, id: "a", role: "assistant", content: "Because the input changed." }];
  streams[0]!.push(event(2, "companion.answered"));
  await screen.findByText("Because the input changed.");
  expect(renders.lesson).toBe(settled.lesson);
  expect(renders.companion).toBeGreaterThan(settled.companion);
  // Still one stream.
  expect(streams).toHaveLength(1);
  expect(streams[0]!.signal.aborted).toBe(false);
}, 15000);
