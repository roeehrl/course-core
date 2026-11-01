import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { componentProgram, componentResult, GeneratedComponentPanel, type GeneratedComponent } from "../src/connected/GeneratedComponent.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

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
  expect(screen.getByRole("alert")).toHaveTextContent("This browser can't run models. The description above has the same information.");
  // The button gives way to the line; the sandbox note stays.
  expect(screen.queryByRole("button", { name: "Run the model" })).toBeNull();
  expect(screen.getByText("This runs in your browser, offline, and never counts as an answer.")).toBeVisible();
});

it("names each state of a run on the button, which stays in place, and keeps the results' room", async () => {
  let finish!: () => void;
  let phase!: (phase: "loading" | "running") => void;
  const run = vi.fn((code: string, _input: string | null, callbacks: { onOutput(stream: "stdout" | "stderr", text: string): void; onPhase?(phase: "loading" | "running"): void }) => {
    phase = callbacks.onPhase!;
    return new Promise<{ status: "ok"; durationMs: number; outputBytes: number }>((resolve) => {
      finish = () => {
        callbacks.onOutput("stdout", "COURSE-COMPONENT-RESULT:{\"y\": 6}\n");
        resolve({ status: "ok", durationMs: 5, outputBytes: 10 });
      };
    });
  });
  const { container } = render(<GeneratedComponentPanel component={component} loadRunner={async () => ({ run })} />);
  const button = screen.getByRole("button", { name: "Run the model" });
  // The always-on sandbox note describes the button.
  expect(button).toHaveAccessibleDescription("This runs in your browser, offline, and never counts as an answer.");
  expect(container.querySelector(".cc-ai-model-results")).not.toBeNull();
  await act(async () => { fireEvent.click(button); });
  await act(async () => phase("loading"));
  expect(button).toHaveTextContent("Loading Python…");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(container.querySelector(".cc-ai-spinner")).not.toBeNull();
  await act(async () => phase("running"));
  expect(button).toHaveTextContent("Running…");
  await act(async () => finish());
  expect(button).toHaveTextContent("Run the model");
  expect(button).not.toHaveAttribute("aria-disabled");
  expect(screen.getByText("Results updated.")).toBeVisible();
});

it("says which values did not run, with the first value ready to change", async () => {
  render(<GeneratedComponentPanel component={component} loadRunner={async () => ({ run: async () => ({ status: "error" as const, durationMs: 5, outputBytes: 0 }) })} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Run the model" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("These values didn't run.");
  expect(screen.getByLabelText("Slope")).toHaveFocus();
  screen.getByLabelText("Input x").focus();
  fireEvent.click(screen.getByRole("button", { name: "Try other values" }));
  expect(screen.getByLabelText("Slope")).toHaveFocus();
});

it("hides output that looks wrong and says so in the results box", async () => {
  const run = async (_code: string, _input: string | null, callbacks: { onOutput(stream: "stdout" | "stderr", text: string): void }) => {
    callbacks.onOutput("stdout", "y = 6\n");
    return { status: "ok" as const, durationMs: 5, outputBytes: 6 };
  };
  const { container } = render(<GeneratedComponentPanel component={{ ...component, start: { outputs: { y: 6 } } }} loadRunner={async () => ({ run })} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Run the model" })); });
  const results = container.querySelector(".cc-ai-model-results")!;
  expect(results).toHaveTextContent("The result looked wrong, so it's hidden. The description above has the same information.");
  expect(screen.queryByText("6")).toBeNull();
});

it("says the run states in Hebrew, with Python kept left to right", async () => {
  let phase!: (phase: "loading" | "running") => void;
  const run = (_code: string, _input: string | null, callbacks: { onOutput(stream: "stdout" | "stderr", text: string): void; onPhase?(phase: "loading" | "running"): void }) => {
    phase = callbacks.onPhase!;
    return new Promise<never>(() => {});
  };
  render(<I18nProvider value={createLearnerTranslator("he")}><GeneratedComponentPanel component={component} loadRunner={async () => ({ run })} /></I18nProvider>);
  expect(screen.getByText("זה רץ בדפדפן, בלי חיבור לרשת, ואף פעם לא נספר כתשובה.")).toBeVisible();
  const button = screen.getByRole("button", { name: "הרצת המודל" });
  await act(async () => { fireEvent.click(button); });
  await act(async () => phase("loading"));
  expect(button.querySelector("bdi")).toHaveTextContent("Python");
  expect(button).toHaveTextContent("Python נטען…");
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
