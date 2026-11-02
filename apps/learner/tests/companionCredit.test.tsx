import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedCompanion } from "../src/components/ConnectedCompanion";
import { CourseApiError, type Challenge, type ServerSnapshot } from "../src/client/apiClient";
import type { CompanionMessage } from "../src/client/companionClient";
import { companionFocus } from "../src/client/companionFocus";
import { CREDIT_LINE_ID } from "../src/connected/credit/CreditNotice.web";
import { CreditLineAfter, CreditLineBeforeDivider } from "../src/connected/credit/CreditThreadLines.web";
import { deferredQuestion } from "../src/connected/credit/deferredQuestion";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";
import { context, message, receipt } from "./companionFixtures";
import { pressWhenReady } from "./pressWhenReady";

// Split from companion.test.tsx: consent before a message that changes credit (final design §3.11).

afterEach(() => {
  vi.useRealTimers();
  companionFocus.clear();
  localStorage.clear();
  deferredQuestion.resetMemory();
});
const question = { id: "q", type: "choice", objectiveIds: [], prompt: "Which?" } as unknown as Challenge["question"];
/** The enrollment with a counted question open in the lesson "intro" (and, optionally, in another lesson). */
function snapshot(open: Partial<Challenge>[] = [{}]): ServerSnapshot {
  return {
    ...connectedSnapshot(),
    enrollmentId: "e",
    activeChallenges: open.map((extra, index) => ({
      challengeId: index ? `check-${index}` : "active-check", episodeId: "intro", question, independentEligible: true, mode: "independent", ...extra,
    })),
  };
}
function companion(props: Partial<React.ComponentProps<typeof ConnectedCompanion>> = {}) {
  const send = vi.fn().mockResolvedValue(receipt), change = vi.fn();
  // Inside the companion's region, as on the page: "Keep it counted" returns focus to its message box.
  const view = render(
    <ConnectedCompanion context={context} messages={[]} episodeTitles={{ intro: "Notice change" }} draft="Question" onDraftChange={change}
      onSend={send} pending={false} loaded server={snapshot()} now={Date.parse("2026-11-01T12:00:00Z")} {...props} />,
    { wrapper: ({ children }) => <aside id="connected-companion">{children}</aside> },
  );
  return { send, change, view };
}
const field = () => screen.getByRole("textbox", { name: "Message to your companion" });

describe("credit honesty in the companion", () => {
  it("requires a clear choice and never silently sets assessment assistance consent", async () => {
    const send = vi.fn().mockResolvedValue(receipt),
      change = vi.fn();
    render(
      <ConnectedCompanion
        context={context}
        messages={[]}
        episodeTitles={{ intro: "Notice change" }}
        draft="Question"
        onDraftChange={change}
        onSend={send}
        pending={false}
        loaded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Keep it counted" }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Message to your companion" }),
    ).toHaveValue("Question");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Send as practice" }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledWith("Question", true));
    await waitFor(() => expect(change).toHaveBeenCalledWith(""));
    // The sent question shows as the learner's turn (conversation §3.5: no "Message saved" notice).
    expect(screen.getByRole("log")).toHaveTextContent("Question");
  });

  it("asks in one inline row, focused on the safe choice; Esc and Keep send nothing and keep the draft", async () => {
    const { send, change } = companion();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const row = screen.getByRole("group", { name: "Asking now makes question 1 practice. It won't count toward finishing the lesson." });
    expect(row).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep it counted" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save for after the question" })).toBeVisible();
    // No card and no heading: the sentence is the only text of the row.
    expect(within(row).queryByRole("heading")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep it counted" }), { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it counted" }));
    expect(send).not.toHaveBeenCalled();
    expect(field()).toHaveValue("Question");
    await waitFor(() => expect(field()).toHaveFocus());
  });

  it("shows the same row when the server asks for the choice, with no extra paragraph", async () => {
    const send = vi.fn().mockRejectedValueOnce(new CourseApiError("ASSESSMENT_HELP_CONSENT_REQUIRED", 409)).mockResolvedValue(receipt);
    // The preview did not see the question (the snapshot is older): the server's answer asks.
    companion({ onSend: send, server: snapshot([]), context: { ...context, independentChallengeIds: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep it counted" })).toHaveFocus());
    expect(send).toHaveBeenCalledWith("Question", undefined);
    expect(screen.getByRole("group", { name: /^Asking now makes question 1 practice\./ })).toBeVisible();
    expect(screen.queryByText(/Choose whether/)).toBeNull();
    await pressWhenReady(screen.getByRole("button", { name: "Send as practice" }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith("Question", true));
  });

  it("does not ask for a question in another lesson, and asks for one attached from there", () => {
    const other = snapshot([{ episodeId: "elsewhere" }]);
    const { send } = companion({ server: other, context: { ...context, independentChallengeIds: [] } });
    expect(screen.queryByTestId("credit-line")).toBeNull();
    act(() => companionFocus.setCheck({ challengeId: "active-check", ordinal: 3 }));
    expect(screen.getByTestId("credit-line")).toHaveTextContent("Question 1 counts. Asking now makes it practice.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("group")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep it counted" }));
    expect(send).not.toHaveBeenCalled();
    // Without the attachment, the other lesson's question stays counted and nothing is asked.
    act(() => companionFocus.clear());
    expect(screen.queryByTestId("credit-line")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(send).toHaveBeenCalledWith("Question", undefined);
  });

  it("says the credit line before sending, tied to the message box, with how questions count behind the ⓘ", async () => {
    companion();
    const line = screen.getByTestId("credit-line");
    expect(line).toHaveTextContent("Question 1 counts. Asking now makes it practice.");
    expect(document.getElementById(CREDIT_LINE_ID)).toHaveTextContent("Question 1 counts. Asking now makes it practice.");
    // Read once when the box gets focus: the line sits in the notice slot, which describes the box,
    // so its own id is not listed again.
    const described = (field().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(described.match(/Asking now makes it practice\./g)).toHaveLength(1);
    const info = screen.getByRole("button", { name: "How questions count" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(info);
    const popover = await screen.findByRole("dialog", { name: "How questions count" });
    expect(popover).toHaveTextContent(/Questions you answer on your own count toward finishing\./);
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(info).toHaveFocus());
  });

  it("saves the question for after the check, and sends it once the check is answered", async () => {
    const { send, change, view } = companion();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Save for after the question" }));
    expect(send).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledWith("");
    expect(deferredQuestion.get("e", "intro")).toMatchObject({ text: "Question", challengeIds: ["active-check"] });
    view.rerender(
      <ConnectedCompanion context={context} messages={[]} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={change}
        onSend={send} pending={false} loaded server={snapshot()} now={Date.parse("2026-11-01T12:00:00Z")} />,
    );
    expect(screen.getByText("A question is saved for after the check.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send it now" })).toBeDisabled();
    // The check is answered: nothing counted is open any more.
    view.rerender(
      <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[]} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={change}
        onSend={send} pending={false} loaded server={snapshot([])} now={Date.parse("2026-11-01T12:00:00Z")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send it now" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("Question", undefined));
    await waitFor(() => expect(screen.queryByText("A question is saved for after the check.")).toBeNull());
    expect(deferredQuestion.get("e", "intro")).toBeNull();
  });

  it("keeps a saved question when sending it now fails, and clears it once the server accepts it", async () => {
    deferredQuestion.save("e", "intro", "Later question", ["answered-check"]);
    const send = vi.fn().mockRejectedValueOnce(new CourseApiError("COMPANION_UNAVAILABLE", 503)).mockResolvedValue(receipt);
    companion({ onSend: send, draft: "", server: snapshot([]), context: { ...context, independentChallengeIds: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Send it now" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("Later question", undefined));
    // Not accepted: still saved, still offered.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send it now" })).toBeEnabled());
    expect(deferredQuestion.get("e", "intro")?.text).toBe("Later question");
    await pressWhenReady(screen.getByRole("button", { name: "Send it now" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(deferredQuestion.get("e", "intro")).toBeNull());
  });

  it("sends a saved question the learner sent as practice from the message box only once", async () => {
    // A new counted question opened before the saved one was sent: it is asked first, through the box.
    deferredQuestion.save("e", "intro", "Later question", ["answered-check"]);
    const { send, change } = companion({ draft: "" });
    fireEvent.click(screen.getByRole("button", { name: "Send it now" }));
    expect(change).toHaveBeenCalledWith("Later question");
    expect(screen.getByRole("group", { name: /^Asking now makes question 1 practice\./ })).toBeVisible();
    expect(send).not.toHaveBeenCalled();
    expect(deferredQuestion.get("e", "intro")?.text).toBe("Later question");
  });

  it("puts a saved question in the message box while offline, where it waits like any message", async () => {
    deferredQuestion.save("e", "intro", "Later question", ["answered-check"]);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      const { send, change } = companion({ draft: "", server: snapshot([]), context: { ...context, independentChallengeIds: [] } });
      fireEvent.click(screen.getByRole("button", { name: "Send it now" }));
      expect(change).toHaveBeenCalledWith("Later question");
      expect(send).not.toHaveBeenCalled();
      expect(deferredQuestion.get("e", "intro")?.text).toBe("Later question");
    } finally {
      online.mockRestore();
    }
  });

  it("takes Esc in the inline choice and the ⓘ for themselves, never also for the companion around them", async () => {
    // The phone's drawer closes on an Esc it hears in the capture phase (CompanionDock.web.tsx).
    const closeDrawer = vi.fn();
    const send = vi.fn().mockResolvedValue(receipt);
    render(
      <ConnectedCompanion context={context} messages={[]} episodeTitles={{ intro: "Notice change" }} draft="Question" onDraftChange={vi.fn()}
        onSend={send} pending={false} loaded server={snapshot()} now={Date.parse("2026-11-01T12:00:00Z")} />,
      { wrapper: ({ children }) => <aside id="connected-companion" onKeyDownCapture={(event) => event.key === "Escape" && closeDrawer()}>{children}</aside> },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep it counted" }), { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    await waitFor(() => expect(field()).toHaveFocus());
    const info = screen.getByRole("button", { name: "How questions count" });
    await pressWhenReady(info);
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "How questions count" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(info).toHaveFocus());
    expect(closeDrawer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("moves the credit line under the composer while a limitation takes the slot above it", () => {
    companion({ unavailable: true });
    const line = screen.getByTestId("credit-line");
    expect(line).toHaveClass("is-meta");
    // Under the message box and its Send button, never dropped.
    expect(screen.getByRole("button", { name: "Send" }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("credit lines in the thread", () => {
  const turn = (context: CompanionMessage["context"]): CompanionMessage => ({ ...message, context: { episodeId: "intro", ...context } });
  it("says which question became practice after the turn that did it", () => {
    render(<CreditLineAfter message={turn({ downgraded: [{ challengeId: "c", ordinal: 1 }], downgradedChallengeIds: ["c"] })} />);
    expect(screen.getByRole("note")).toHaveTextContent("Question 1 is now practice.");
  });
  it("says every open check became practice only for older turns that changed several", () => {
    const older = render(<CreditLineAfter message={turn({ downgradedChallengeIds: ["c", "d"] })} />);
    expect(screen.getByRole("note")).toHaveTextContent("Your open checks in this course are now practice.");
    older.unmount();
    const single = render(<CreditLineAfter message={turn({ downgradedChallengeIds: ["c"] })} />);
    expect(single.container).toBeEmptyDOMElement();
    single.unmount();
    expect(render(<CreditLineAfter message={turn({})} />).container).toBeEmptyDOMElement();
  });
  it("recaps a finished lesson at the next lesson, in English and Hebrew", () => {
    const server: ServerSnapshot = { ...connectedSnapshot(), checkSummaries: { intro: { own: 2, practice: 1 } } };
    server.lessons[0]!.status = "completed";
    const recap = render(<CreditLineBeforeDivider episodeId="intro" server={server} />);
    expect(screen.getByRole("note")).toHaveTextContent("Lesson finished: 2 questions on your own, 1 as practice.");
    recap.unmount();
    render(<I18nProvider value={createLearnerTranslator("he")}><CreditLineBeforeDivider episodeId="intro" server={server} /></I18nProvider>);
    expect(screen.getByRole("note")).toHaveTextContent("השיעור הסתיים: 2 שאלות בלי עזרה, 1 כתרגול.");
  });
  it("says nothing for a lesson still in progress", () => {
    const server: ServerSnapshot = { ...connectedSnapshot(), checkSummaries: { intro: { own: 1, practice: 0 } } };
    expect(render(<CreditLineBeforeDivider episodeId="intro" server={server} />).container).toBeEmptyDOMElement();
  });
});
