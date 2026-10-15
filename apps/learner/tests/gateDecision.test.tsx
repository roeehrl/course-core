import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NextAction } from "@course-core/sdk";
import { GateDecisionPanel, GATE_STATUS_LABELS } from "../src/connected/GateDecision.web";
import { AssessmentInput, answerPayload, traceAnswers } from "../src/connected/AssessmentInput.web";
import { ConnectedLesson, type ConnectedLessonProps } from "../src/connected/ConnectedLesson.web";
import type { Challenge, GateView, Question } from "../src/client/apiClient";
import { answerFeedback } from "../src/connected/answerFeedback";
import { connectedSnapshot } from "./connectedFixtures";

const gate = (status: NonNullable<GateView["status"]>, nextActions: NextAction[]): GateView => ({
  passed: status === "ready", status, objectives: [{ id: "observe", families: [], required: 2, passed: false }], decisionId: "decision-1",
  learnerVisibleReason: "Needs independent success on a new transfer task.",
  criterionResults: [
    { criterionId: "families", met: true, reason: "Independent success in 2 item families." },
    { criterionId: "transfer", met: status === "under_review" ? "pending" : false, reason: "Needs independent success on a new transfer task." },
  ],
  nextActions,
});

describe("server gate decision panel", () => {
  it.each([
    ["ready", [{ kind: "continue", label: "Continue to “Compare”", targetId: "compare" }]],
    ["needs_evidence", [{ kind: "attempt_check", label: "Solve a new transfer task: “Predict the next value”", targetId: "predict" }, { kind: "request_help", label: "Ask the companion" }]],
    ["needs_help", [{ kind: "request_help", label: "Ask for help: your last 2 attempts did not succeed" }]],
    ["under_review", [{ kind: "await_review", label: "Wait for a reviewer to look at your answer" }, { kind: "request_help", label: "Ask the companion" }]],
    ["closed_with_gaps", [{ kind: "view_gaps", label: "See what remains unproven" }, { kind: "appeal", label: "Request a staff review within 14 days" }]],
  ] as const)("%s: shows the status, reason, criteria and the server's next steps", (status, actions) => {
    const onAction = vi.fn();
    render(<GateDecisionPanel gate={gate(status, [...actions])} pending={false} onAction={onAction} />);
    expect(screen.getByRole("heading", { name: GATE_STATUS_LABELS[status] })).toBeVisible();
    expect(screen.getByText("Needs independent success on a new transfer task.", { selector: "p" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Readiness criteria" }).querySelectorAll("li")).toHaveLength(2);
    if (status === "under_review") expect(screen.getByText("Waiting for review")).toBeVisible();
    const buttons = actions.filter((a) => a.kind !== "await_review");
    for (const action of buttons) fireEvent.click(screen.getByRole("button", { name: action.label }));
    expect(onAction).toHaveBeenCalledTimes(buttons.length);
    if (status === "under_review") expect(screen.queryByRole("button", { name: /Wait for a reviewer/ })).toBeNull();
  });
  it("disables next steps while a request is pending", () => {
    render(<GateDecisionPanel gate={gate("needs_evidence", [{ kind: "attempt_check", label: "Try a check", targetId: "x" }])} pending onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Try a check" })).toBeDisabled();
  });
});

describe("new item type inputs", () => {
  it("collects trace steps and validates every step before sending", () => {
    const question: Question = { id: "t", type: "trace", prompt: "Trace", steps: [{ id: "s1", prompt: "After 6" }, { id: "s2", prompt: "After 4" }] };
    const onChange = vi.fn();
    const { rerender } = render(<AssessmentInput question={question} answer="" pending={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("After 6"), { target: { value: "6" } });
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify({ s1: "6" }));
    expect(answerPayload(question, JSON.stringify({ s1: "6" }))).toEqual({ error: "Fill in every step (1 left)." });
    rerender(<AssessmentInput question={question} answer={JSON.stringify({ s1: "6", s2: "4" })} pending={false} onChange={onChange} />);
    expect(screen.getByLabelText("After 4")).toHaveValue("4");
    expect(answerPayload(question, JSON.stringify({ s1: "6", s2: "4" }))).toEqual({ value: { s1: "6", s2: "4" } });
    expect(traceAnswers("not json")).toEqual({});
  });
  it("labels predictions with their unit and written tasks with their rubric", () => {
    const prediction: Question = { id: "p", type: "prediction", prompt: "Predict", unit: "cm" };
    const { unmount } = render(<AssessmentInput question={prediction} answer="" pending={false} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Your prediction (cm)")).toBeVisible();
    expect(answerPayload(prediction, "12.5")).toEqual({ value: 12.5 });
    expect(answerPayload(prediction, "twelve")).toEqual({ error: "Enter a finite number." });
    unmount();
    const teach: Question = { id: "w", type: "teach_back", prompt: "Teach it", criteria: [{ id: "c", description: "States the rule.", required: true }] };
    render(<AssessmentInput question={teach} answer="" pending={false} onChange={vi.fn()} />);
    expect(screen.getByText("States the rule.")).toBeVisible();
    expect(screen.getByLabelText("Your explanation, as you would teach it")).toBeVisible();
  });
  it("describes an abstention as recording nothing against the learner", () => {
    expect(answerFeedback({ result: { passed: false, abstained: true, independent: true, explanation: "12.5 stays." } }))
      .toBe("Noted. Nothing was recorded against you, and it does not count as evidence. 12.5 stays.");
  });
});

describe("lesson check with \"I don't know\", confidence and the gate decision", () => {
  function props(question: Question): ConnectedLessonProps {
    const server = connectedSnapshot();
    server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    server.lessons[0]!.gate = gate("needs_evidence", [{ kind: "attempt_check", label: "Solve a new transfer task", targetId: "predict" }]);
    const challenge: Challenge = { challengeId: "c1", episodeId: "intro", question, independentEligible: true, mode: "independent" };
    server.activeChallenges = [challenge];
    return { server, episode: server.course.chapters[0]!.episodes[0]!, placement: false, pending: false, now: Date.now(), answer: "", confidence: null,
      onAnswerChange: vi.fn(), onRead: vi.fn(), onStart: vi.fn(), onAnswer: vi.fn(), onSolution: vi.fn(), onComplete: vi.fn(), onNormal: vi.fn(), onRefresh: vi.fn(),
      onBlockChange: vi.fn(), onAbstain: vi.fn(), onConfidenceChange: vi.fn(), onGateAction: vi.fn() };
  }
  it("offers an explicit abstention and optional confidence that never changes the result", () => {
    const p = props({ id: "predict", type: "prediction", prompt: "Predict the next value.", unit: "cm", allowAbstain: true, confidence: { capture: "optional", scale: { minimum: 1, maximum: 5 } } });
    render(<ConnectedLesson {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "I don't know yet: record no answer and get help" }));
    expect(p.onAbstain).toHaveBeenCalledWith(p.server.activeChallenges[0]);
    expect(screen.getByText(/Your confidence never changes your result/)).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: "5" }));
    expect(p.onConfidenceChange).toHaveBeenCalledWith(5);
    expect(screen.getByRole("button", { name: "Check answer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Solve a new transfer task" }));
    expect(p.onGateAction).toHaveBeenCalledWith({ kind: "attempt_check", label: "Solve a new transfer task", targetId: "predict" });
    expect(screen.getByRole("button", { name: "Complete episode →" })).toBeDisabled();
  });
  it("hides the abstention when the author turned it off and routes written tasks to review", () => {
    const p = props({ id: "teach", type: "teach_back", prompt: "Teach it.", allowAbstain: false, criteria: [{ id: "c", description: "States the rule.", required: true }] });
    p.answer = "My own explanation of the rule, with an example.";
    render(<ConnectedLesson {...p} />);
    expect(screen.queryByRole("button", { name: /I don't know yet/ })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Confidence" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    expect(p.onAnswer).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Show explanation/ })).toBeNull();
  });
});
