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

// Split from connectedHost.test.tsx: an older progress refresh never replaces the open check.

afterEach(() => vi.unstubAllGlobals());
it("a slower, older progress refresh never replaces the check the learner is typing into", async () => {
  const base = connectedSnapshot();
  base.course.chapters[0]!.episodes[0]!.blocks = [
    { type: "text", id: "reading", markdown: "A public example." },
  ];
  const declinedSnapshot = { ...structuredClone(base), revision: 2 };
  const read = { ...structuredClone(base), revision: 3 };
  read.lessons[0]!.completedBlockIds = ["reading"];
  const checking = { ...structuredClone(read), revision: 4 };
  checking.activeChallenges = [
    {
      challengeId: "issued",
      episodeId: "intro",
      independentEligible: true,
      mode: "independent",
      question: { id: "q", type: "numeric", prompt: "What is 2 + 2?" },
    },
  ];
  let current = base,
    placementState = "offered",
    declinedLoads = 0,
    lateStarted = false,
    releaseLate: (() => void) | undefined;
  const late = new Promise<void>((resolve) => (releaseLate = resolve));
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = `/api/enrollments/${base.enrollmentId}`;
      if (input === "/auth/session")
        return response({ user: { id: "late-refresh-user", displayName: "Learner" } });
      if (input === "/api/enrollments")
        return response([{ id: base.enrollmentId, title: "Study", version: "1", status: "active" }]);
      if (input === "/api/workspaces") return response([]);
      if (input === `${path}/placement`)
        return response({ available: true, maxItems: 3, studied: false, state: placementState, run: null });
      if (input === `${path}/placement/decline`) {
        placementState = "declined";
        current = declinedSnapshot;
        return response({ state: "declined" });
      }
      if (input === `${path}/read`) {
        current = read;
        return response({ revision: 3 });
      }
      if (input === `${path}/challenges`) {
        current = checking;
        return response({ revision: 4 });
      }
      if (input === path) {
        const answer = current;
        // The refresh that follows a confirmed decline (the panel's onFinished)
        // reads the state as it was, then reaches the browser late.
        if (answer === declinedSnapshot && ++declinedLoads === 2) {
          lateStarted = true;
          await late;
        }
        return response(answer);
      }
      throw Error(`Unexpected endpoint ${input}`);
    }),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<ConnectedHost />);
  await screen.findByRole("heading", { name: "Your courses" });
  await pressWhenReady(screen.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await pressWhenReady(await screen.findByRole("button", { name: "Start from the beginning" }));
  await waitFor(() => expect(lateStarted).toBe(true));
  await pressWhenReady(await screen.findByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }));
  await screen.findByRole("heading", { name: "Notice the change" });
  const enabled = (name: string) =>
    waitFor(() => {
      const button = screen.getByRole("button", { name });
      expect(button).toBeEnabled();
      return button;
    });
  await pressWhenReady(await enabled("Mark this part read"));
  await pressWhenReady(await enabled("Start the next check →"));
  const box = await screen.findByRole("textbox", { name: "Your numeric answer" });
  await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
  fireEvent.change(box, { target: { value: "4" } });
  await act(async () => releaseLate!());
  await act(async () => {});
  // The older snapshot neither removes the check nor marks the reading unread.
  expect(screen.getByRole("textbox", { name: "Your numeric answer" })).toBe(box);
  expect(box).toHaveValue("4");
  expect(screen.queryByRole("button", { name: "Mark this part read" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check" })).toBeEnabled();
});
