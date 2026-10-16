import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlacementRun } from "../src/components/PlacementRun.web";
import { numericPayload } from "../src/connected/AssessmentInput.web";

const inProgress = {
  available: true, maxItems: 4, studied: false, state: "in_progress",
  run: { itemsUsed: 0, pendingChallengeId: null, nextItem: { episodeId: "min", assessmentId: "min-predict" }, stopReason: "continuing",
    proposal: { exempt: [], startEpisodeId: "min", startTitle: "Minimum", demonstrated: [], pending: [], untestedNote: "Not tested." } },
};
const prediction = { id: "min-predict", type: "prediction", prompt: "How long is the kept piece?", unit: "cm", allowAbstain: true };
function renderItem(question: Record<string, unknown>) {
  const api = { request: vi.fn(async (url: string) => (url.endsWith("/reviews") ? { reviews: [] } : inProgress)) };
  const command = vi.fn(async (action: string) => (action === "challenges" ? { challengeId: "c1", question } : {}));
  render(<PlacementRun api={api as never} command={command as never} enrollmentId="e1" firstEpisodeId="min" onFinished={() => {}} />);
  return { command };
}
async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "Next question" }));
  await screen.findByText(question => question.includes("How long") || question.includes("Trace"));
}

describe("numeric answers with units", () => {
  it("sends a bare number as a number, a stated declared unit as value and unit, and points out another unit", () => {
    expect(numericPayload("12.5", "cm")).toEqual({ value: 12.5 });
    expect(numericPayload(" 12.5 cm ", "cm")).toEqual({ value: { value: 12.5, unit: "cm" } });
    expect(numericPayload("−12.5cm", "cm")).toEqual({ value: { value: -12.5, unit: "cm" } });
    expect(numericPayload("125 mm", "cm")).toEqual({ error: "Give your answer in cm, not mm.", wrongUnit: true });
    expect(numericPayload("4 cm", undefined)).toEqual({ error: "Enter just the number; this question has no unit.", wrongUnit: true });
    for (const bad of ["", "cm", "1,5", "--2", "1e999"]) expect(numericPayload(bad, "cm"), bad).toEqual({ error: "Enter a finite number." });
  });
});

describe("placement questions", () => {
  it("takes a prediction with its unit, explains another unit, and never sends it", async () => {
    const { command } = renderItem(prediction);
    await open();
    const field = screen.getByRole("textbox", { name: "Your prediction (cm)" });
    fireEvent.change(field, { target: { value: "126 mm" } });
    expect(screen.getByRole("status")).toHaveTextContent("Give your answer in cm, not mm.");
    expect(screen.getByRole("button", { name: "Save answer" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "12.6 cm" } });
    expect(screen.getByRole("status")).toHaveTextContent("");
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: { value: 12.6, unit: "cm" } }));
    expect(command.mock.calls.filter(([action]) => action === "answers")).toHaveLength(1);
  });
  it("records \"I don't know yet\" as an abstention, not an answer", async () => {
    const { command } = renderItem(prediction);
    await open();
    const abstain = screen.getByRole("button", { name: "I don't know yet" });
    expect(abstain).toHaveAccessibleDescription(/is not a wrong answer\. Placement stops at that topic/);
    fireEvent.click(abstain);
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", abstain: true }));
  });
  it("offers no abstention where the item does not allow one, and answers trace items step by step", async () => {
    const { command } = renderItem({ id: "min-trace", type: "trace", prompt: "Trace the kept value.", allowAbstain: false,
      steps: [{ id: "s1", prompt: "After 6" }, { id: "s2", prompt: "After 4" }] });
    await open();
    expect(screen.queryByRole("button", { name: "I don't know yet" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "After 6" }), { target: { value: "6" } });
    expect(screen.getByRole("button", { name: "Save answer" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "After 4" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("answers", { challengeId: "c1", answer: { s1: "6", s2: "4" } }));
  });
});
