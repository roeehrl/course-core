import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedCompanion } from "../src/components/ConnectedCompanion";
import { companionFocus } from "../src/client/companionFocus";
import type { CompanionMessage } from "../src/client/companionClient";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";
import { context, message, receipt } from "./companionFixtures";

/*
 * The composer's keys and states (final design §3.6, §5): Enter sends with a fine pointer,
 * Shift+Enter makes a line, Cmd/Ctrl+Enter sends everywhere, a touch keyboard's Enter makes a
 * line, nothing sends while an input method composes, Enter does nothing while a reply runs, Esc
 * stops a reply and keeps the text, Backspace in an empty box removes the attachment, and the
 * round button is one element in every state.
 */
type Props = React.ComponentProps<typeof ConnectedCompanion>;
const send = vi.fn();
function show(props: Partial<Props> = {}, locale: "en" | "he" = "en") {
  const view = (extra: Partial<Props>) => (
    <I18nProvider value={createLearnerTranslator(locale)}>
      <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[]} episodeTitles={{ intro: "Notice change" }}
        draft="" onDraftChange={() => {}} onSend={send} pending={false} loaded {...extra} />
    </I18nProvider>
  );
  const result = render(view(props));
  return { ...result, again: (extra: Partial<Props>) => result.rerender(view({ ...props, ...extra })) };
}
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
/** Presses a key in the box; true when the page took it (no new line). */
const press = (init: KeyboardEventInit & { keyCode?: number }) => !fireEvent.keyDown(box(), init);
const running: CompanionMessage = { ...message, job_state: "running" };
/** The saved conversation after `n` questions were sent and answered (a reply on its way blocks
 * Enter, so a test that sends again first lets the last one be answered). */
const answered = (n: number): CompanionMessage[] =>
  Array.from({ length: n }, (_, i) => [
    { ...message, id: `new${i + 1}`, job_id: `a${i + 1}`, job_state: "applied", content: `Question ${i + 1}` },
    { id: `a${i + 1}`, role: "assistant" as const, content: `Answer ${i + 1}.`, context: {}, created_at: "2026-01-01", job_id: `a${i + 1}` },
  ]).flat();
const sendAs = (n: number) => send.mockResolvedValueOnce({ ...receipt, messageId: `new${n}`, downgradedChallengeIds: [] });

beforeEach(() => {
  send.mockReset().mockResolvedValue({ ...receipt, messageId: "new", downgradedChallengeIds: [] });
  companionFocus.clear();
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function coarse(matching: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matching && query === "(pointer: coarse)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

describe("the key hint", () => {
  it("shows while typing with a fine pointer and goes after three keyboard sends, also with storage denied", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { again } = show();
    for (const n of [1, 2, 3]) {
      sendAs(n);
      act(() => box().focus());
      type(`Question ${n}`);
      expect(screen.getByText(/to send · /)).toBeVisible();
      // Key names stay left to right in any language.
      expect([...document.querySelector(".cc-chat-key-hint")!.querySelectorAll("bdi")].map((node) => node.textContent)).toEqual(["Enter", "Shift+Enter"]);
      expect(press({ key: "Enter" })).toBe(true);
      await waitFor(() => expect(send).toHaveBeenCalledTimes(n));
      again({ messages: answered(n) });
    }
    type("A fourth");
    expect(screen.queryByText(/to send · /)).toBeNull();
  });
});

describe("keys", () => {
  it("Enter sends with a fine pointer; Shift+Enter makes a new line; Cmd+Enter and Ctrl+Enter send", async () => {
    const { again } = show();
    sendAs(1);
    sendAs(2);
    sendAs(3);
    type("First");
    expect(press({ key: "Enter", shiftKey: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(press({ key: "Enter" })).toBe(true);
    await waitFor(() => expect(send).toHaveBeenCalledWith("First", undefined));
    // Focus stays in the box after a send; the box is empty.
    expect(box()).toHaveValue("");
    again({ messages: answered(1) });
    type("Second");
    expect(press({ key: "Enter", metaKey: true })).toBe(true);
    await waitFor(() => expect(send).toHaveBeenLastCalledWith("Second", undefined));
    again({ messages: answered(2) });
    type("Third");
    expect(press({ key: "Enter", ctrlKey: true })).toBe(true);
    await waitFor(() => expect(send).toHaveBeenLastCalledWith("Third", undefined));
    expect(box()).toHaveAttribute("enterkeyhint", "send");
  });
  it("on a touch keyboard Enter makes a new line and Cmd/Ctrl+Enter still sends", async () => {
    coarse(true);
    show();
    type("Line one");
    expect(press({ key: "Enter" })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(box()).toHaveAttribute("enterkeyhint", "enter");
    expect(press({ key: "Enter", ctrlKey: true })).toBe(true);
    await waitFor(() => expect(send).toHaveBeenCalledWith("Line one", undefined));
  });
  it("never sends while an input method composes: isComposing, keyCode 229, and 50 ms after compositionend", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    show();
    type("日本");
    expect(press({ key: "Enter", isComposing: true })).toBe(false);
    expect(press({ key: "Enter", keyCode: 229 })).toBe(false);
    fireEvent.compositionStart(box());
    expect(press({ key: "Enter" })).toBe(false);
    fireEvent.compositionEnd(box());
    vi.setSystemTime(10_049);
    expect(press({ key: "Enter" })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    vi.setSystemTime(10_051);
    expect(press({ key: "Enter" })).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("日本", undefined));
  });
  it("Enter does nothing while a reply runs; the box stays editable; Esc stops the reply and keeps the text", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    show({ messages: [running], onCancelQuestion: cancel });
    type("Next thought");
    expect(press({ key: "Enter" })).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(box()).toHaveValue("Next thought");
    expect(box()).not.toHaveAttribute("readonly");
    expect(press({ key: "Escape" })).toBe(true);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("m"));
    expect(box()).toHaveValue("Next thought");
  });
  it("Esc with nothing running is left to the panel (it closes or leaves focus view), and never clears the text", () => {
    show();
    type("Keep");
    expect(press({ key: "Escape" })).toBe(false);
    expect(box()).toHaveValue("Keep");
  });
  it("Backspace in an empty box removes the attachment chip, never text", () => {
    show();
    act(() => companionFocus.setCheck({ challengeId: "c", ordinal: 1 }));
    expect(screen.getByText("Question 1")).toBeVisible();
    expect(box()).toHaveAttribute("placeholder", "Ask about question 1…");
    type("x");
    expect(press({ key: "Backspace" })).toBe(false);
    expect(companionFocus.get().check).toBeDefined();
    type("");
    expect(press({ key: "Backspace" })).toBe(true);
    expect(companionFocus.get().check).toBeUndefined();
    expect(screen.queryByText("Question 1")).toBeNull();
  });
});

describe("the round button", () => {
  it("is one element in every state, so focus stays on it, with its key shortcuts", () => {
    const { again } = show({ onCancelQuestion: vi.fn() });
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-keyshortcuts", "Enter Control+Enter Meta+Enter");
    type("Ready");
    expect(button).not.toHaveAttribute("aria-disabled");
    // Its tip is a drawn tooltip (Composer-states 10, 12) that describes it, not a native title.
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveAccessibleDescription("Send (Enter)");
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toHaveAttribute("role", "tooltip");
    button.focus();
    again({ messages: [running], onCancelQuestion: vi.fn() });
    const stop = screen.getByRole("button", { name: "Stop reply" });
    expect(stop).toBe(button);
    expect(stop).toHaveFocus();
    expect(stop).toHaveAttribute("aria-keyshortcuts", "Escape");
  });
  it("counts characters from 3,200 and refuses a message over 4,000, saying by how much", () => {
    show();
    type("a".repeat(3412));
    expect(screen.getByText("3,412 / 4,000")).toBeVisible();
    type("a".repeat(4212));
    expect(screen.getByText("212 characters over")).toBeVisible();
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("212 characters over");
    fireEvent.click(button);
    expect(press({ key: "Enter" })).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it("stays editable and sends while another request of the page is in flight", async () => {
    show({ pending: true });
    type("Not locked");
    expect(box()).toHaveValue("Not locked");
    expect(box()).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("Not locked", undefined));
  });
  it("describes the box by the attachment and the notice that apply, and takes its direction from the text once typed", () => {
    show({ availability: "not_set_up" });
    act(() => companionFocus.setSelection({ kind: "text", excerpt: "the bias is added at the end" }));
    const described = box().getAttribute("aria-describedby")!.split(" ");
    expect(described).toHaveLength(2);
    expect(box()).toHaveAccessibleDescription(/Your companion isn't on for this course yet.*Selected: “the bias is added at the end”/);
    expect(box()).not.toHaveAttribute("dir");
    type("שאלה");
    expect(box()).toHaveAttribute("dir", "auto");
    expect(screen.getByRole("button", { name: "Remove quoted text" })).toBeVisible();
  });
  it("in Hebrew names the button, its shortcut and the key hint", () => {
    show({}, "he");
    type("שאלה");
    expect(screen.getByRole("button", { name: "שליחה" })).toHaveAccessibleDescription("שליחה (Enter)");
    expect(createLearnerTranslator("he").t("composer.keyHint")).toBe("Enter לשליחה · Shift+Enter לשורה חדשה");
  });
});
