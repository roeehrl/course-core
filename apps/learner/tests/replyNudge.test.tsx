import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { companionBridge, resetCompanionBridge, type ComposeRequest } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { ReplyNudge } from "../src/connected/checks/ReplyNudge.web";

// The reply-ready nudge at the end of a check (§4.1): while the companion is closed and its reply
// about this question has settled unseen, one line with "Open" that opens it at that reply.
beforeEach(() => {
  resetCompanionBridge();
  companionOpen.reset();
  companionOpen.sync({ docked: true, surface: "lesson" });
  companionOpen.close();
});

describe("the reply-ready nudge", () => {
  it("shows for this question's reply while the companion is closed, and Open reveals the reply", () => {
    const requests: ComposeRequest[] = [];
    companionBridge.onCompose((request) => requests.push(request));
    render(<ReplyNudge challengeId="c1" />);
    expect(screen.queryByText("Your companion replied about this question.")).toBeNull();
    act(() => companionBridge.updateActivity({ replyAbout: { other: "m0" } }));
    expect(screen.queryByText("Your companion replied about this question.")).toBeNull();
    act(() => companionBridge.updateActivity({ replyAbout: { c1: "m1" } }));
    expect(screen.getByText("Your companion replied about this question.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(requests).toEqual([{ source: "nudge", revealMessageId: "m1" }]);
    // Open now: the reply is in view, so the line goes.
    expect(companionOpen.get().open).toBe(true);
    expect(screen.queryByText("Your companion replied about this question.")).toBeNull();
  });

  it("goes once the reply is seen", () => {
    act(() => companionBridge.updateActivity({ replyAbout: { c1: "m1" } }));
    render(<ReplyNudge challengeId="c1" />);
    expect(screen.getByRole("button", { name: "Open" })).toBeVisible();
    act(() => companionBridge.updateActivity({ replyAbout: {} }));
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });
});
