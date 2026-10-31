import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NextAction } from "@course-core/sdk";
import { stripBidiControls } from "@course-core/i18n";
import { GateDecisionPanel, GATE_STATUS_LABELS, gateText } from "../src/connected/GateDecision.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { AssessmentInput, answerPayload, traceAnswers } from "../src/connected/AssessmentInput.web";
import { ConnectedLesson, type ConnectedLessonProps } from "../src/connected/ConnectedLesson.web";
import type { Challenge, GateView, Question } from "../src/client/apiClient";
import { answerFeedback } from "../src/connected/answerFeedback";
import { connectedSnapshot } from "./connectedFixtures";

const gate = (status: NonNullable<GateView["status"]>, nextActions: NextAction[]): GateView => ({
  passed: status === "ready", status, objectives: [{ id: "observe", families: [], required: 2, passed: false }], decisionId: "decision-1",
  learnerVisibleReason: "More independent evidence is needed.",
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
    render(<GateDecisionPanel gate={gate(status, [...actions])} pending={false} onAction={onAction} onRequestReview={vi.fn()} />);
    expect(screen.getByRole("heading", { name: GATE_STATUS_LABELS[status] })).toBeVisible();
    expect(screen.getByText("More independent evidence is needed.", { selector: "p" })).toBeVisible();
    expect(screen.getByRole("list", { name: "What this checkpoint needs" }).querySelectorAll("li")).toHaveLength(2);
    if (status === "under_review") expect(screen.getByText("Waiting for review")).toBeVisible();
    const buttons = actions.filter((a) => a.kind !== "await_review");
    for (const action of buttons) fireEvent.click(screen.getByRole("button", { name: action.label }));
    // An appeal opens the review form in the panel instead of leaving it.
    expect(onAction).toHaveBeenCalledTimes(buttons.filter((a) => a.kind !== "appeal").length);
    if (status === "under_review") expect(screen.queryByRole("button", { name: /Wait for a reviewer/ })).toBeNull();
  });
  it("says each sentence once: no reason that repeats a criterion, no criterion twice", () => {
    // The live card: the reason was the one unmet criterion's sentence, and the criterion said it again.
    const sentence = "Needs independent success in 2 item families for “Read a number line” (0 so far).";
    const repeated: GateView = { ...gate("needs_evidence", [{ kind: "attempt_check", label: "Answer a fresh independent check", targetId: "x" }]),
      learnerVisibleReason: sentence,
      criterionResults: [
        { criterionId: "families", met: false, reason: sentence },
        { criterionId: "families-again", met: false, reason: `${sentence.slice(0, -1)} ` },
        { criterionId: "transfer", met: true, reason: "Independent transfer evidence recorded." },
      ] };
    const { container } = render(<GateDecisionPanel gate={repeated} pending={false} onAction={vi.fn()} />);
    expect(container.textContent!.split("Needs independent success in 2 item families").length - 1).toBe(1);
    expect(container.querySelector(".connected-gate-reason")).toBeNull();
    expect(screen.getByRole("list", { name: "What this checkpoint needs" }).querySelectorAll("li")).toHaveLength(2);
    // Server messages translated to the same sentence are compared after translation, in Hebrew too.
    const he = createLearnerTranslator("he");
    const detail = { code: "criterion.familiesFor.unmet", params: { required: 2, objectives: ["Read a number line"], count: 0 } };
    render(
      <I18nProvider value={he}>
        <GateDecisionPanel pending={false} onAction={vi.fn()} gate={{ ...repeated, criterionResults: [repeated.criterionResults![0]!],
          messages: { reason: { code: "reason.needs_evidence.detail", params: { more: 0 }, detail }, criteria: { families: detail }, actions: [] } }} />
      </I18nProvider>,
    );
    const hebrew = document.querySelectorAll(".connected-gate")[1]!;
    expect(hebrew.querySelector(".connected-gate-reason")).toBeNull();
    expect(hebrew.querySelectorAll(".connected-gate-criteria li")).toHaveLength(1);
  });
  it("opens a review request form for an appeal step and sends the learner's own reason", async () => {
    const onAction = vi.fn(), onRequestReview = vi.fn().mockResolvedValue(undefined);
    render(<GateDecisionPanel gate={gate("closed_with_gaps", [{ kind: "appeal", label: "Request a staff review within 14 days" }])} pending={false} onAction={onAction} onRequestReview={onRequestReview} />);
    const appeal = screen.getByRole("button", { name: "Request a staff review within 14 days" });
    expect(appeal).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(appeal);
    expect(onAction).not.toHaveBeenCalled();
    expect(appeal).toHaveAttribute("aria-expanded", "true");
    const send = screen.getByRole("button", { name: "Send review request" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why should a staff member look at this decision again?"), { target: { value: "  too short " } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why should a staff member look at this decision again?"), { target: { value: "  I ran out of time because of an illness.  " } });
    fireEvent.click(send);
    expect(onRequestReview).toHaveBeenCalledWith("I ran out of time because of an illness.");
    await vi.waitFor(() => expect(screen.queryByRole("form", { name: "Ask for a review of this decision" })).toBeNull());
  });
  it("shows an open, upheld or granted review instead of offering another appeal", () => {
    const appeal: NextAction[] = [{ kind: "view_gaps", label: "See what remains unproven" }, { kind: "appeal", label: "Request a staff review" }];
    const at = "2026-10-15T10:00:00.000Z";
    const { rerender } = render(<GateDecisionPanel gate={{ ...gate("closed_with_gaps", appeal), review: { requestId: "r1", state: "open", reviewerNote: null, requestedAt: at, decidedAt: null } }} pending={false} onAction={vi.fn()} onRequestReview={vi.fn()} />);
    expect(screen.getByText("Review requested")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Request a staff review" })).toBeNull();
    rerender(<GateDecisionPanel gate={{ ...gate("closed_with_gaps", appeal), review: { requestId: "r1", state: "upheld", reviewerNote: "The transfer task is still required.", requestedAt: at, decidedAt: at } }} pending={false} onAction={vi.fn()} onRequestReview={vi.fn()} />);
    expect(screen.getByText("Review completed: the decision stands")).toBeVisible();
    expect(screen.getByText("“The transfer task is still required.”")).toBeVisible();
    expect(screen.getByRole("button", { name: "Request a staff review" })).toBeVisible();
    const onAction = vi.fn();
    rerender(<GateDecisionPanel gate={{ ...gate("closed_with_gaps", appeal), review: { requestId: "r2", state: "exception_granted", reviewerNote: "Accommodation.", requestedAt: at, decidedAt: at }, exception: { requestId: "r2", grantedAt: at } }} pending={false} onAction={onAction} onRequestReview={vi.fn()} />);
    // The status stays honest; the exception is shown beside it.
    expect(screen.getByRole("heading", { name: GATE_STATUS_LABELS.closed_with_gaps })).toBeVisible();
    expect(screen.getByText(/This is not a pass/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Request a staff review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue under the exception" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "continue", label: "Continue under the exception" });
  });
  it("without a review handler the appeal step is not offered", () => {
    render(<GateDecisionPanel gate={gate("closed_with_gaps", [{ kind: "appeal", label: "Request a staff review" }])} pending={false} onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Request a staff review" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Finish this lesson →" })).toBeDisabled();
  });
  it("says plainly when a lesson has no questions left, and that the course team was told", async () => {
    const p = props({ id: "predict", type: "prediction", prompt: "Predict the next value." });
    p.server.activeChallenges = [];
    p.server.recovery = [{ episodeId: "intro", required: true, freshCheck: null }];
    let tell!: (told: boolean) => void;
    const onQuestionsExhausted = vi.fn(() => new Promise<boolean>((resolve) => { tell = resolve; }));
    render(<ConnectedLesson {...p} onQuestionsExhausted={onQuestionsExhausted} />);
    const notice = screen.getByTestId("questions-exhausted");
    expect(notice).toHaveTextContent("No new questions are available for this lesson right now. Your work so far is saved.");
    expect(notice).toHaveTextContent("Telling your course team…");
    expect(onQuestionsExhausted).toHaveBeenCalledWith("intro");
    expect(screen.queryByText(/qualified recovery check/)).toBeNull();
    await act(async () => tell(true));
    expect(notice).toHaveTextContent("Your course team has been told and can add more questions.");
    expect(onQuestionsExhausted).toHaveBeenCalledTimes(1);
  });
  it("lets the learner complete under a standing staff exception, and not otherwise", () => {
    const p = props({ id: "predict", type: "prediction", prompt: "Predict the next value." });
    p.server.activeChallenges = [];
    const { unmount } = render(<ConnectedLesson {...p} />);
    expect(screen.getByRole("button", { name: "Finish this lesson →" })).toBeDisabled();
    unmount();
    p.server.lessons[0]!.gate = { ...p.server.lessons[0]!.gate!, exception: { requestId: "r1", grantedAt: null } };
    render(<ConnectedLesson {...p} />);
    expect(screen.getByRole("heading", { name: GATE_STATUS_LABELS.needs_evidence })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Finish this lesson →" }));
    expect(p.onComplete).toHaveBeenCalled();
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

describe("gate decision text in the learner's language", () => {
  const en = createLearnerTranslator("en"), he = createLearnerTranslator("he"), plain = stripBidiControls;
  const fresh = { code: "action.freshCheck", params: { objectives: ["Find a minimum"], count: 0, required: 2 } };
  it("renders the server's codes in plain learner English, without the objective repeated", () => {
    expect(gateText(fresh, "fallback", en)).toBe("Try a new question (0 of 2 answered correctly so far)");
    expect(gateText({ code: "action.viewGaps", params: { focusKind: "objectives", focus: ["Find a minimum", "Find a maximum"] } }, "", en))
      .toBe("See what is still missing");
    expect(gateText({ code: "action.askCompanion", params: { focusKind: "objectives", focus: ["Find a minimum"] } }, "", en))
      .toBe("Ask the companion to explain this another way");
    expect(gateText({ code: "action.appeal", params: { reviewer: "staff", days: 14 } }, "", en)).toBe("Request a staff review of this decision within 14 days");
    expect(gateText({ code: "reason.needs_evidence.detail", params: { more: 1 }, detail: { code: "criterion.families.unmet", params: { required: 2, objectives: ["Find a minimum"] } } }, "", en))
      .toBe("Answer 2 different kinds of question correctly on your own. (1 more thing still needed.)");
  });
  it("translates to Hebrew, keeping course text as written", () => {
    expect(plain(gateText(fresh, "fallback", he))).toBe("ניסיון בשאלה חדשה (עד עכשיו 0 מתוך 2 נענו נכון)");
    expect(plain(gateText({ code: "reason.under_review" }, "fallback", he))).toBe("חלק מהתשובות שלך נמצאות בבדיקה. בינתיים שום דבר לא נספר לחובתך.");
    expect(plain(gateText({ code: "action.reviewLesson", params: { title: "Find a minimum" } }, "fallback", he))).toBe("חזרה על “Find a minimum” לפני הניסיון הבא");
  });
  it("falls back to the server's English text for a code this app does not know, or no code", () => {
    expect(gateText({ code: "action.fromTheFuture" }, "Server text", he)).toBe("Server text");
    expect(gateText(null, "Server text", he)).toBe("Server text");
    expect(gateText({ code: "reason.needs_help.detail", params: { more: 0 }, detail: { code: "unknown" } }, "Whole server reason", he)).toBe("Whole server reason");
  });
  it("shows the panel in Hebrew from the decision's codes", () => {
    const view: GateView = { ...gate("needs_evidence", [{ kind: "attempt_check", label: "English label", targetId: "min-a" }]),
      messages: { reason: { code: "reason.needs_evidence" }, criteria: { families: { code: "criterion.families.met", params: { required: 2 } } }, actions: [fresh] } };
    render(<GateDecisionPanel gate={view} pending={false} onAction={vi.fn()} />);
    // English UI here (no provider): the codes render the English wording, not the stored label.
    expect(screen.getByRole("button", { name: "Try a new question (0 of 2 answered correctly so far)" })).toBeVisible();
    expect(screen.getByText("You have not yet answered enough questions correctly on your own.", { selector: "p" })).toBeVisible();
    // A criterion without a code keeps the server's text.
    expect(screen.getByText("Needs independent success on a new transfer task.", { selector: "span" })).toBeVisible();
  });
});


describe("a reason that repeats a listed criterion", () => {
  it("is said without the criterion it repeats", () => {
    const detail = { code: "criterion.familiesFor.unmet", params: { required: 2, objectives: ["Find a minimum"], count: 0 } };
    const view: GateView = {
      ...gate("needs_help", [{ kind: "request_help", label: "Ask for help" }]),
      learnerVisibleReason: "Your recent attempts did not succeed. Needs independent success in 2 item families for “Find a minimum” (0 so far).",
      criterionResults: [{ criterionId: "families", met: false, reason: "Needs independent success in 2 item families for “Find a minimum” (0 so far)." }],
      messages: { reason: { code: "reason.needs_help.detail", params: { more: 0 }, detail }, criteria: { families: detail }, actions: [null] },
    };
    const { container } = render(<GateDecisionPanel gate={view} pending={false} onAction={vi.fn()} />);
    expect(container.querySelector(".connected-gate-reason")).toHaveTextContent("Your last few tries did not succeed.");
    expect(container.textContent!.split("Answer 2 different kinds of question correctly on your own").length - 1).toBe(1);
  });
});
