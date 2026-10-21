import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
// The native project resolves the app's own modules, never their `.web` variants.
import { PlacementRun } from "../../src/components/PlacementRun";
import { CourseApiError } from "../../src/client/apiClient";

type View = Record<string, unknown> & { state: string; run: Record<string, unknown> | null };
const proposal = (extra: Record<string, unknown> = {}) => ({
  exempt: [], startEpisodeId: "min", startTitle: "Minimum", demonstrated: [], pending: [], untestedNoteCode: "not_a_judgement" as const, ...extra,
});
const inProgress = (extra: Record<string, unknown> = {}): View => ({
  available: true, maxItems: 4, studied: false, state: "in_progress",
  run: { itemsUsed: 0, pendingChallengeId: null, nextItem: { episodeId: "min", assessmentId: "item-1" }, stopReason: "continuing", proposal: proposal(), ...extra },
});
const finished = (stopReason: string, extra: Record<string, unknown> = {}, view: Record<string, unknown> = {}): View => ({
  available: true, maxItems: 4, studied: false, state: "finished",
  run: { itemsUsed: 2, pendingChallengeId: null, nextItem: null, stopReason, proposal: proposal(extra) }, ...view,
});

/** A scripted placement server: each answer moves the run to `after`. */
function setup(question: Record<string, unknown> | null, initial: View = inProgress(), after: View = finished("not_demonstrated")) {
  let view = initial;
  const api = { request: vi.fn(async () => view) };
  const command = vi.fn(async (action: string) => {
    if (action === "challenges") return { challengeId: "c1", question };
    if (action === "answers") view = after;
    if (action === "placement/finish") view = finished("stopped_by_learner");
    return {};
  });
  const onFinished = vi.fn();
  const utils = render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={onFinished} />);
  return { api, command, onFinished, ...utils };
}
const answers = (command: ReturnType<typeof setup>["command"]) => command.mock.calls.filter(([action]) => action === "answers");
/** Opens the next item and waits until the panel has settled: native buttons ignore presses while busy. */
async function openItem(prompt: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: "Next question" }));
  await screen.findByText(prompt);
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop and see my result" })).not.toHaveAttribute("aria-disabled", "true"));
}
const minHeight = (element: HTMLElement) => parseFloat(getComputedStyle(element).minHeight);

describe("native placement items", () => {
  it("renders the native panel, not the web form", async () => {
    const { container } = setup({ id: "q", type: "choice", prompt: "Pick one.", options: [{ id: "a", text: "A" }] });
    await openItem(/Pick one/);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByRole("heading", { name: "Placement question 1 of at most 4" })).toBeTruthy();
  });

  it("answers a choice item with the chosen option id", async () => {
    const { command } = setup({ id: "q", type: "choice", prompt: "Which keeps the minimum?", options: [{ id: "a", text: "Sort" }, { id: "b", text: "Scan once" }] });
    await openItem(/Which keeps the minimum/);
    const group = screen.getByRole("radiogroup", { name: "Your answer" });
    expect(screen.getByRole("button", { name: "Save answer" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(group).getByRole("radio", { name: "Scan once" }));
    expect(within(group).getByRole("radio", { name: "Scan once" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: "b" }));
  });

  it("takes a numeric answer with its unit, explains another unit and never sends it", async () => {
    const { command } = setup({ id: "q", type: "numeric", prompt: "How long is the kept piece?", unit: "cm" });
    await openItem(/How long/);
    const field = screen.getByRole("textbox", { name: "Your numeric answer (cm)" });
    expect(screen.getByText("Type the number; adding “cm” after it is fine.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "126 mm" } });
    expect(screen.getByRole("status")).toHaveTextContent("Give your answer in cm, not mm.");
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    expect(answers(command)).toHaveLength(0);
    fireEvent.change(field, { target: { value: "abc" } });
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Save answer" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(field, { target: { value: "−12.6 cm" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: { value: -12.6, unit: "cm" } }));
    expect(answers(command)).toHaveLength(1);
  });

  it("sends a bare number as a number and asks for just the number where no unit is declared", async () => {
    const { command } = setup({ id: "q", type: "prediction", prompt: "Predict the count." });
    await openItem(/Predict the count/);
    expect(screen.getByText(/Commit to a number before you see the result/)).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Your prediction" });
    fireEvent.change(field, { target: { value: "4 cm" } });
    expect(screen.getByRole("status")).toHaveTextContent("Enter just the number; this question has no unit.");
    fireEvent.change(field, { target: { value: " 4 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: 4 }));
  });

  it("answers trace items step by step, and only once every step is filled", async () => {
    const { command } = setup({ id: "q", type: "trace", prompt: "Trace the kept value.", steps: [{ id: "s1", prompt: "After 6" }, { id: "s2", prompt: "After 4" }] });
    await openItem(/Trace the kept value/);
    expect(within(screen.getByRole("list", { name: "Trace steps" })).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "After 6" }), { target: { value: "6" } });
    expect(screen.getByRole("button", { name: "Save answer" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "After 4" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: { s1: "6", s2: "4" } }));
  });

  it("starts a code-repair item from its starter code in the native editor", async () => {
    const starterCode = "def solve(xs):\n    return xs[0]\n";
    const { command } = setup({ id: "q", type: "code_repair", prompt: "Fix the minimum.", language: "python", starterCode });
    await openItem(/Fix the minimum/);
    const editor = screen.getByRole("textbox", { name: "Your code" });
    expect(editor).toHaveValue(starterCode);
    const fixed = "def solve(xs):\n    return min(xs)\n";
    fireEvent.change(editor, { target: { value: fixed } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: fixed }));
  });

  it("shows a written item's criteria and sends the explanation", async () => {
    const { command } = setup({ id: "q", type: "teach_back", prompt: "Teach the scan.",
      criteria: [{ id: "c1", description: "Names the invariant.", required: true }, { id: "c2", description: "Gives an example.", required: false }] });
    await openItem(/Teach the scan/);
    expect(screen.getByText("A reviewer will look for")).toBeTruthy();
    const criteria = within(screen.getAllByRole("list")[0]!).getAllByRole("listitem");
    expect(criteria.map((c) => c.textContent)).toEqual(["• Names the invariant.", "• Gives an example. (optional)"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Your explanation, as you would teach it" }), { target: { value: "Keep the smallest seen so far." } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: "Keep the smallest seen so far." }));
  });
});

describe("native \"I don't know yet\"", () => {
  it("records an abstention, not an answer, and explains it is not wrong", async () => {
    const { command } = setup({ id: "q", type: "numeric", prompt: "How long?", unit: "cm", allowAbstain: true });
    await openItem(/How long/);
    const abstain = screen.getByRole("button", { name: "I don't know yet" });
    expect(abstain).toHaveAccessibleDescription(/is not a wrong answer\. Placement stops at that topic and it stays on your path\./);
    fireEvent.click(abstain);
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", abstain: true }));
    expect(await screen.findByText(/marked “I don't know yet”, so placement stopped there/)).toBeTruthy();
    expect(answers(command)).toEqual([["answers", { challengeId: "c1", abstain: true }]]);
  });

  it("is not offered where the item does not allow it", async () => {
    setup({ id: "q", type: "numeric", prompt: "How long?", allowAbstain: false });
    await openItem(/How long/);
    expect(screen.queryByRole("button", { name: "I don't know yet" })).toBeNull();
    expect(screen.queryByText(/is not a wrong answer/)).toBeNull();
  });

  it("gives every action and input a target of at least 44 points", async () => {
    setup({ id: "q", type: "choice", prompt: "Pick.", options: [{ id: "a", text: "A" }] });
    await openItem(/Pick\./);
    const targets = [
      ...screen.getAllByRole("button"),
      ...screen.getAllByRole("radio"),
    ];
    expect(targets.map((t) => t.getAttribute("aria-label") ?? t.textContent)).toEqual(expect.arrayContaining(["Save answer", "I don't know yet", "Stop and see my result", "A"]));
    for (const target of targets) expect(minHeight(target), target.textContent ?? "").toBeGreaterThanOrEqual(44);
  });
});

describe("native placement run states", () => {
  it("offers placement before study, starts it, or starts from the beginning", async () => {
    const offered: View = { available: true, maxItems: 3, studied: false, state: "offered", run: null };
    const { command, onFinished } = setup({ id: "q", type: "choice", prompt: "First item.", options: [{ id: "a", text: "A" }] }, offered);
    expect(await screen.findByRole("heading", { name: "Already know some of this?" })).toBeTruthy();
    expect(screen.getByText(/Answer up to 3 short questions without help/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start from the beginning" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("placement/decline", {}));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
  });

  it("is hidden once the learner has studied, and when placement is unavailable", async () => {
    for (const view of [{ available: true, maxItems: 3, studied: true, state: "offered", run: null }, { available: false, maxItems: 3, studied: false, state: "unavailable", run: null }]) {
      const api = { request: vi.fn(async () => view) };
      const { container, unmount } = render(<PlacementRun api={api as never} command={vi.fn() as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
      await waitFor(() => expect(api.request).toHaveBeenCalled());
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("resumes an interrupted item instead of asking for a second one", async () => {
    const question = { id: "q", type: "numeric", prompt: "Resumed item.", unit: "cm" };
    const api = { request: vi.fn(async (url: string) =>
      url.endsWith("/placement") ? inProgress({ pendingChallengeId: "c9" }) : { activeChallenges: [{ challengeId: "c9", question, mode: "placement" }] }) };
    const command = vi.fn(async (action: string) => {
      if (action === "challenges") throw new CourseApiError("PLACEMENT_ITEM_PENDING", 409);
      return {};
    });
    render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume my question" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Your numeric answer (cm)" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c9", answer: 3 }));
  });

  it("lets the learner stop mid-item and see the result", async () => {
    const { command } = setup({ id: "q", type: "choice", prompt: "Pick.", options: [{ id: "a", text: "A" }] });
    await openItem(/Pick\./);
    fireEvent.click(screen.getByRole("button", { name: "Stop and see my result" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("placement/finish", {}));
    expect(await screen.findByRole("heading", { name: "Your placement result" })).toBeTruthy();
    expect(screen.getByText("You stopped placement. Unanswered topics stay on your path.")).toBeTruthy();
    expect(answers(command)).toHaveLength(0);
  });

  it("says why a run with no next item stopped before the learner asks for the result", async () => {
    setup(null, inProgress({ nextItem: null, stopReason: "item_limit" }));
    expect(await screen.findByText("You reached this course's placement question limit.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "See my result" })).toBeTruthy();
  });

  it("shows a placed-out result and accepts the proposed start", async () => {
    const view = finished("course_covered", {
      exempt: [{ episodeId: "min", title: "Minimum" }], startEpisodeId: "sort", startTitle: "Sorting",
      demonstrated: [{ objectiveId: "o1", description: "Finds a minimum.", families: 2 }], pending: [{ objectiveId: "o2", description: "Explains the scan." }],
    }, { runNumber: 1, maxRuns: 2, retest: { allowed: true, availableAt: null } });
    const { command, onFinished } = setup(null, view);
    expect(await screen.findByRole("heading", { name: "Your placement result" })).toBeTruthy();
    expect(screen.getByText("You answered every placement topic.")).toBeTruthy();
    expect(screen.getByRole("listitem")).toHaveTextContent("Minimum");
    expect(screen.getByText("Shown independently: Finds a minimum.")).toBeTruthy();
    expect(screen.getByText("Waiting for evaluation, not marked wrong: Explains the scan.")).toBeTruthy();
    expect(screen.getByText(/attempt 2 of 2\. It uses only questions you have not seen/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start at “Sorting”" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("placement/accept", { startEpisodeId: "sort" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
  });

  it("offers only the beginning when nothing was shown, and explains a refusal", async () => {
    const view = finished("not_demonstrated", {}, { runNumber: 2, maxRuns: 2, retest: { allowed: false, availableAt: null } });
    const api = { request: vi.fn(async () => view) };
    const command = vi.fn(async () => {
      throw new CourseApiError("PLACEMENT_AFTER_STUDY", 409);
    });
    render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
    expect(await screen.findByText("Nothing will be skipped. Starting from the beginning is the right path.")).toBeTruthy();
    expect(screen.getByText("You have used all 2 placement attempts this course allows.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start at/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retake placement" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start from the beginning" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Placement is only offered before you start studying.");
    expect(command).toHaveBeenCalledWith("placement/accept", { startEpisodeId: "min" });
  });

  it("keeps the item and reports a failed save without moving on", async () => {
    const question = { id: "q", type: "numeric", prompt: "How long?" };
    const api = { request: vi.fn(async () => inProgress()) };
    const command = vi.fn(async (action: string) => {
      if (action === "challenges") return { challengeId: "c1", question };
      throw new Error("offline");
    });
    render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
    await openItem(/How long/);
    fireEvent.change(screen.getByRole("textbox", { name: "Your numeric answer" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That did not go through. Your progress is saved; try again.");
    expect(screen.getByRole("textbox", { name: "Your numeric answer" })).toHaveValue("5");
  });
});
