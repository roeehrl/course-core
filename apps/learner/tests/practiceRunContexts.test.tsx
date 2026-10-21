import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectedLesson, type ConnectedLessonProps } from "../src/connected/ConnectedLesson.web";
import { PlacementRun } from "../src/components/PlacementRun.web";
import { BROWSER_RUN_MODES, browserRunsAllowed } from "../src/connected/code";
import { connectedSnapshot } from "./connectedFixtures";

// The page's runner is available in every test here, so a missing panel means the context hid it.
const runner = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../src/connected/pythonRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/connected/pythonRunner")>();
  return {
    ...actual,
    practiceRunner: async () => {
      runner.loads++;
      return {
        config: { limits: { timeoutMs: 10_000, outputBytes: 65_536, memoryBytes: 268_435_456, sourceBytes: 64_000 },
          runtime: { name: "pyodide", version: "314.0.7", license: { spdx: "MPL-2.0", source: "https://github.com/pyodide/pyodide/tree/314.0.7" } } },
        run: vi.fn(), stop: vi.fn(), reset: vi.fn(),
      };
    },
  };
});

const source = "def solve(values):\n    return min(values)\n";
const codeQuestion = { id: "program", type: "code", language: "python", starterCode: source, prompt: "Implement solve(values)." };
function lesson(mode: string, independentEligible = mode !== "practice"): ConnectedLessonProps {
  const server = connectedSnapshot();
  server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
  server.activeChallenges = [{ challengeId: `code-${mode}`, episodeId: "intro", independentEligible, mode, question: codeQuestion as never }];
  return {
    server, episode: server.course.chapters[0]!.episodes[0]!, placement: false, pending: false, now: Date.now(), answer: source,
    onAnswerChange: vi.fn(), onRead: vi.fn(), onStart: vi.fn(), onAnswer: vi.fn(), onSolution: vi.fn(), onComplete: vi.fn(),
    onNormal: vi.fn(), onRefresh: vi.fn(), onBlockChange: vi.fn(),
  };
}
const panel = () => screen.queryByRole("region", { name: "Practice run in your browser" });

describe("where browser practice runs are offered", () => {
  it("allows only lesson checks, by allow-list", () => {
    expect([...BROWSER_RUN_MODES].sort()).toEqual(["independent", "practice"]);
    for (const mode of ["placement", "retention", "final", "", "PRACTICE"]) expect(browserRunsAllowed(mode), mode).toBe(false);
  });
  it.each(["practice", "independent"])("offers them on a %s lesson check", async (mode) => {
    render(<ConnectedLesson {...lesson(mode)} />);
    expect(await screen.findByRole("region", { name: "Practice run in your browser" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run in browser" })).toBeEnabled();
  });
  it("hides them on a delayed retention check, which measures what the learner kept without help", async () => {
    const loads = runner.loads;
    render(<ConnectedLesson {...lesson("retention")} />);
    expect(await screen.findByRole("textbox", { name: "Your code" })).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(panel()).toBeNull();
    expect(runner.loads).toBe(loads);
  });
  it("hides them on placement code items, which measure what the learner already knows", async () => {
    const loads = runner.loads;
    const state = { available: true, maxItems: 4, studied: false, state: "in_progress",
      run: { itemsUsed: 0, pendingChallengeId: null, nextItem: { episodeId: "min", assessmentId: "program" }, stopReason: "continuing",
        proposal: { exempt: [], startEpisodeId: "min", startTitle: "Minimum", demonstrated: [], pending: [], untestedNoteCode: "not_a_judgement" as const } } };
    const api = { request: vi.fn(async (url: string) => (url.endsWith("/reviews") ? { reviews: [] } : state)) };
    const command = vi.fn(async (action: string) => (action === "challenges" ? { challengeId: "p1", question: codeQuestion } : {}));
    render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
    (await screen.findByRole("button", { name: "Next question" })).click();
    expect(await screen.findByRole("textbox", { name: "Your code" })).toBeVisible();
    await waitFor(() => expect(command).toHaveBeenCalledWith("challenges", expect.anything()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(panel()).toBeNull();
    expect(runner.loads).toBe(loads);
  });
});
