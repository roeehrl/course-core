import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { componentProgram, componentResult, GeneratedComponentPanel, type GeneratedComponent } from "../src/connected/GeneratedComponent.web";

const component: GeneratedComponent = { episodeId: "min", blockId: "op", digest: "d".repeat(64), title: "Line explorer", description: "y follows the line.",
  source: 'def solve(inputs):\n    return {"y": inputs["slope"] * inputs["x"]}\n',
  inputs: [{ name: "slope", label: "Slope", min: -5, max: 5, step: 1, initial: 2 }, { name: "x", label: "Input x", min: 0, max: 10, step: 1, initial: 3 }],
  outputs: [{ name: "y", label: "Output y" }] };

it("calls solve on the learner's values and accepts only the declared outputs", () => {
  const program = componentProgram(component.source, { slope: 2, x: 3 });
  expect(program.startsWith(component.source)).toBe(true);
  expect(program).toContain('loads("{\\"slope\\":2,\\"x\\":3}")');
  expect(componentResult("noise\nCOURSE-COMPONENT-RESULT:{\"y\": 6}\n", component.outputs)).toEqual({ y: 6 });
  for (const stdout of ["COURSE-COMPONENT-RESULT:{\"y\": 6, \"z\": 1}", "COURSE-COMPONENT-RESULT:[6]", "COURSE-COMPONENT-RESULT:{\"y\": {\"a\": 1}}", "y = 6", "COURSE-COMPONENT-RESULT:{bad"])
    expect(componentResult(stdout, component.outputs)).toBeNull();
});

it("runs the model in the runner with labelled controls and shows its result", async () => {
  const run = vi.fn(async (code: string, _input: string | null, callbacks: { onOutput(stream: "stdout" | "stderr", text: string): void }) => {
    const values = JSON.parse(JSON.parse(code.match(/loads\((".*")\)\)\)\)/)![1]!));
    callbacks.onOutput("stdout", `COURSE-COMPONENT-RESULT:${JSON.stringify({ y: values.slope * values.x })}\n`);
    return { status: "ok" as const, durationMs: 5, outputBytes: 10 };
  });
  render(<GeneratedComponentPanel component={component} loadRunner={async () => ({ run })} />);
  expect(screen.getByRole("heading", { name: "Line explorer" })).toBeVisible();
  expect(screen.getByText("Run the model to see this.")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Slope"), { target: { value: "4" } });
  // Values outside the declared range are clamped to it.
  fireEvent.change(screen.getByLabelText("Input x"), { target: { value: "50" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Run the model" })); });
  expect(run).toHaveBeenCalledOnce();
  expect(screen.getByText("40")).toBeVisible();
  expect(screen.getByText("Results updated.")).toBeVisible();
});

it("says so when models cannot run here, and keeps the text alternative as the way in", async () => {
  render(<GeneratedComponentPanel component={component} loadRunner={async () => null} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Run the model" })); });
  expect(screen.getByText(/Models cannot run in this browser/)).toBeVisible();
});

it("shows the grader-verified starting values before a run, and only at the starting position", () => {
  render(<GeneratedComponentPanel component={{ ...component, start: { outputs: { y: 6 } } }} loadRunner={async () => null} />);
  expect(screen.getByText("6")).toBeVisible();
  expect(screen.getByText(/values at the starting position, checked before this was added/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Slope"), { target: { value: "4" } });
  // Another position was never checked: nothing is claimed for it until the learner runs the model.
  expect(screen.queryByText("6")).toBeNull();
  expect(screen.getByText("Run the model to see this.")).toBeVisible();
});
