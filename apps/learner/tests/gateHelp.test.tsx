import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAction } from "@course-core/sdk";
import { stripBidiControls } from "@course-core/i18n";
import { GateDecisionPanel, helpPrefill } from "../src/connected/GateDecision.web";
import type { GateView } from "../src/client/apiClient";
import { companionBridge, resetCompanionBridge, type ComposeRequest } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

/** A "let's get you some help" decision whose first step asks the companion about the lesson. */
function needsHelp(focus: Record<string, string | string[]> = { focusKind: "lesson", focus: "Adding the bias" }): GateView {
  const help: NextAction = { kind: "request_help", label: "Ask for help: your last 2 attempts did not succeed." };
  const review: NextAction = { kind: "review_material", label: "Review “Adding the bias” before your next attempt", targetId: "bias" };
  return {
    passed: false, status: "needs_help", objectives: [], decisionId: "d1", learnerVisibleReason: "Your recent attempts did not succeed.",
    criterionResults: [], nextActions: [help, review],
    messages: { reason: { code: "reason.needs_help" }, criteria: {},
      actions: [{ code: "action.askHelpAfterStruggles", params: { count: 2, ...focus } }, { code: "action.reviewLesson", params: { title: "Adding the bias" } }] },
  };
}

describe("the gate's help pill (§4.5)", () => {
  let requests: ComposeRequest[];
  beforeEach(() => {
    requests = [];
    companionBridge.setAvailable(true);
    companionBridge.onCompose((request) => requests.push(request));
  });
  afterEach(() => {
    resetCompanionBridge();
    companionOpen.reset();
    document.body.innerHTML = "";
  });

  it("is a 40 px outline pill with the companion glyph that asks about the lesson", () => {
    render(<GateDecisionPanel gate={needsHelp()} pending={false} onAction={vi.fn()} />);
    const pill = screen.getByRole("button", { name: "Ask your companion about “Adding the bias”" });
    expect(pill).toHaveClass("cc-ui-pill", "cc-ui-pill-outline", "cc-ui-pill-40");
    expect(pill.querySelector('svg[data-icon="sparkle"]')).not.toBeNull();
    // The other steps keep their copy, as text actions.
    expect(screen.getByRole("button", { name: "Review “Adding the bias” before you try again" })).toHaveClass("cc-ui-text-button");
  });

  it("puts the question in the companion's message box and sends nothing", () => {
    const onAction = vi.fn();
    render(<GateDecisionPanel gate={needsHelp()} pending={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask your companion about “Adding the bias”" }));
    expect(requests).toEqual([{ source: "gate", text: "Can you explain “Adding the bias” another way?" }]);
    // The host is not asked to do anything; the companion opens through the bridge.
    expect(onAction).not.toHaveBeenCalled();
    expect(companionOpen.get().open || companionOpen.get().paneOpen || companionOpen.get().sheetOpen).toBe(true);
  });

  it("rings the message box when the companion was already open", async () => {
    const field = document.createElement("textarea");
    const region = document.createElement("aside");
    region.id = "connected-companion";
    region.append(field);
    document.body.append(region);
    vi.spyOn(companionOpen, "get").mockReturnValue({ ...companionOpen.get(), open: true });
    render(<GateDecisionPanel gate={needsHelp()} pending={false} onAction={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask your companion about “Adding the bias”" }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(field).toHaveAttribute("data-cc-ring", "hold");
  });

  it("does not ring a companion that was closed (opening it is the change)", async () => {
    const field = document.createElement("textarea");
    const region = document.createElement("aside");
    region.id = "connected-companion";
    region.append(field);
    document.body.append(region);
    vi.spyOn(companionOpen, "get").mockReturnValue({ ...companionOpen.get(), open: false });
    render(<GateDecisionPanel gate={needsHelp()} pending={false} onAction={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask your companion about “Adding the bias”" }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(field).not.toHaveAttribute("data-cc-ring");
  });

  it("asks plainly, as the pill says, when the decision names no lesson", () => {
    const en = createLearnerTranslator("en");
    // The pill says "…to explain this another way" for objectives, so the question does too.
    expect(helpPrefill({ code: "action.askCompanion", params: { focusKind: "objectives", focus: ["Find a minimum", "Find a maximum"] } }, en))
      .toBe("Can you explain this another way?");
    render(<GateDecisionPanel gate={needsHelp({ focusKind: "objectives", focus: ["Find a minimum"] })} pending={false} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask your companion to explain this another way" }));
    expect(requests.at(-1)?.text).toBe("Can you explain this another way?");
    cleanup();
    expect(helpPrefill({ code: "action.askCompanion", params: { focusKind: "checkpoint", focus: "" } }, en)).toBe("Can you explain this another way?");
    expect(helpPrefill(null, en)).toBe("Can you explain this another way?");
    render(<GateDecisionPanel gate={needsHelp({ focusKind: "checkpoint", focus: "" })} pending={false} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask your companion to explain this another way" }));
    expect(requests.at(-1)?.text).toBe("Can you explain this another way?");
  });

  it("falls back to the host's review when the companion is not on the page", () => {
    const onAction = vi.fn();
    render(<GateDecisionPanel gate={needsHelp()} pending={false} onAction={onAction} />);
    const pill = screen.getByRole("button", { name: "Ask your companion about “Adding the bias”" });
    // The companion left after the panel was drawn (the press arrives first).
    vi.spyOn(companionBridge, "available").mockReturnValue(false);
    fireEvent.click(pill);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "request_help" }));
    expect(requests).toEqual([]);
  });

  it("is not offered without a companion (§4.16)", () => {
    companionBridge.setAvailable(false);
    render(<GateDecisionPanel gate={needsHelp()} pending={false} onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Ask your companion/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Review “Adding the bias” before you try again" })).toBeVisible();
  });

  it("says it in Hebrew, with a plain-text question for the message box", () => {
    render(<I18nProvider value={createLearnerTranslator("he")}><GateDecisionPanel gate={needsHelp()} pending={false} onAction={vi.fn()} /></I18nProvider>);
    expect(screen.getByText("המצב שלך")).toBeVisible();
    const pill = screen.getByRole("button", { name: /שאלה למנחה על/ });
    expect(stripBidiControls(pill.textContent ?? "")).toBe("שאלה למנחה על “Adding the bias”");
    fireEvent.click(pill);
    expect(requests.at(-1)?.text).toBe("אפשר הסבר אחר ל“Adding the bias”?");
    // Nothing invisible goes into the learner's message.
    expect(requests.at(-1)?.text).toBe(stripBidiControls(requests.at(-1)!.text!));
  });
});
