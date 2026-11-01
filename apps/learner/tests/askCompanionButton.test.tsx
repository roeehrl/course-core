import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companionFocus } from "../src/client/companionFocus";
import { CodeEditor } from "../src/components/CodeEditor.web";
import { AskFromLesson } from "../src/connected/companion/AskFromLesson.web";
import { companionBridge, resetCompanionBridge, type ComposeRequest } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { ASK_GAP, ASK_STABLE_MS, codeSelection } from "../src/connected/companion/selectionAttach";

// The floating "Ask companion" button (final design §3.9, §5, §6, M18): it appears only after a
// selection of lesson text or code lines has been stable for 300 ms, sits 8 px below the
// selection's end on the reading side, hides on Esc, on clearing and on scroll, never offers text
// in fields or the companion, has a keyboard path, and attaches only when pressed.

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const original = {
  rects: Range.prototype.getClientRects,
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!,
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!,
};
let requests: ComposeRequest[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  Range.prototype.getClientRects = () => [rect(100, 200, 300, 24)] as unknown as DOMRectList;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains("cc-ask-float") ? 140 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains("cc-ask-float") ? 32 : 0;
    },
  });
  companionBridge.setAvailable(true);
  requests = [];
  companionBridge.onCompose((request) => requests.push(request));
});
afterEach(() => {
  vi.useRealTimers();
  Range.prototype.getClientRects = original.rects;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", original.width);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", original.height);
  document.getSelection()?.removeAllRanges();
  companionFocus.clear();
  codeSelection.withdraw(null);
  resetCompanionBridge();
  companionOpen.reset();
});

function Lesson({ rtl = false, children }: { rtl?: boolean; children?: React.ReactNode }) {
  return (
    <>
      <div className="connected-lesson">
        <p id="lesson" style={rtl ? { direction: "rtl" } : undefined}>
          {rtl ? "המינימום לא גדול מאף איבר אחר." : "The minimum is no greater than any other member."}
        </p>
        <input id="field" defaultValue="An answer the learner typed" />
        {children}
        <a href="#next" id="next">
          Next
        </a>
      </div>
      <aside id="connected-companion">
        <p id="reply">A reply in the companion.</p>
      </aside>
      <AskFromLesson episodeId="min" />
    </>
  );
}
function select(node: Node, from: number, to: number) {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => void document.dispatchEvent(new Event("selectionchange")));
}
const selectLesson = (from = 31, to = 47) => select(document.getElementById("lesson")!.firstChild!, from, to);
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const floating = () => screen.queryByRole("button", { name: "Ask companion" });
const status = () => document.querySelector(".cc-ask-status")!;

describe("the floating Ask companion button", () => {
  it("appears only after the selection has been stable for 300 ms, and a change restarts the wait", () => {
    render(<Lesson />);
    selectLesson();
    wait(ASK_STABLE_MS - 1);
    expect(floating()).toBeNull();
    selectLesson(30, 47);
    wait(ASK_STABLE_MS - 1);
    expect(floating()).toBeNull();
    wait(1);
    expect(floating()).toBeVisible();
    expect(floating()).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Period Meta+Shift+Period");
    // Portalled to the page, outside the lesson.
    expect(floating()!.parentElement).toBe(document.body);
    // Nothing is attached until it is pressed.
    expect(companionFocus.get().selection).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("waits for the pointer to be let go after a drag", () => {
    render(<Lesson />);
    fireEvent.pointerDown(document.getElementById("lesson")!);
    selectLesson();
    wait(ASK_STABLE_MS * 2);
    expect(floating()).toBeNull();
    fireEvent.pointerUp(document.getElementById("lesson")!);
    wait(ASK_STABLE_MS - 1);
    expect(floating()).toBeNull();
    wait(1);
    expect(floating()).toBeVisible();
  });

  it("sits 8 px below the end of the selection, lined up with its end in either direction", () => {
    const { unmount } = render(<Lesson />);
    selectLesson();
    wait(ASK_STABLE_MS);
    // Left to right: the selection ends at x = 400, so the 140 px button starts at 260.
    expect(floating()).toHaveStyle({ top: `${224 + ASK_GAP}px`, left: "260px" });
    unmount();
    document.getSelection()!.removeAllRanges();
    render(<Lesson rtl />);
    selectLesson(0, 8);
    wait(ASK_STABLE_MS);
    // Right to left the selection ends at its left edge (x = 100), where the button starts.
    expect(floating()).toHaveStyle({ top: `${224 + ASK_GAP}px`, left: "100px" });
  });

  it("hides on Esc, on clearing the selection and on a scroll of the page, not of the companion", () => {
    render(<Lesson />);
    selectLesson();
    wait(ASK_STABLE_MS);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(floating()).toBeNull();
    // The same selection stays dismissed; a new one is offered again.
    wait(ASK_STABLE_MS);
    expect(floating()).toBeNull();
    selectLesson(30, 47);
    wait(ASK_STABLE_MS);
    expect(floating()).toBeVisible();
    fireEvent.scroll(document.getElementById("reply")!);
    expect(floating()).toBeVisible();
    fireEvent.scroll(document);
    expect(floating()).toBeNull();
    selectLesson(4, 11);
    wait(ASK_STABLE_MS);
    expect(floating()).toBeVisible();
    act(() => {
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(floating()).toBeNull();
  });

  it("never offers text in a field or in the companion", () => {
    render(<Lesson />);
    select(document.getElementById("reply")!.firstChild!, 2, 9);
    wait(ASK_STABLE_MS);
    expect(floating()).toBeNull();
    const field = document.getElementById("field") as HTMLInputElement;
    field.focus();
    field.setSelectionRange(3, 9);
    act(() => void document.dispatchEvent(new Event("selectionchange")));
    wait(ASK_STABLE_MS);
    expect(floating()).toBeNull();
  });

  it("pressing it attaches the selection and opens the companion with its composer", () => {
    const open = vi.spyOn(companionOpen, "open");
    render(<Lesson />);
    selectLesson();
    wait(ASK_STABLE_MS);
    fireEvent.click(floating()!);
    expect(companionFocus.get().selection).toEqual({ kind: "text", excerpt: "any other member" });
    expect(requests).toEqual([{ source: "selection", focus: true }]);
    expect(open).toHaveBeenCalledWith("selection");
    expect(floating()).toBeNull();
  });

  it("keyboard path: says once that the shortcut is available, Tab reaches the button, the shortcut attaches", () => {
    render(<Lesson />);
    fireEvent.keyDown(document, { key: "ArrowRight", shiftKey: true });
    selectLesson(31, 34);
    fireEvent.keyDown(document, { key: "ArrowRight", shiftKey: true });
    selectLesson();
    wait(ASK_STABLE_MS);
    expect(status()).toHaveTextContent("Ask companion is available: Ctrl+Shift+period");
    expect(status()).toHaveAttribute("role", "status");
    // Extending the selection does not say it again (the region is not emptied and refilled).
    const changes: string[] = [];
    const observer = new MutationObserver(() => changes.push(status().textContent ?? ""));
    observer.observe(status(), { childList: true, characterData: true, subtree: true });
    fireEvent.keyDown(document, { key: "ArrowLeft", shiftKey: true });
    selectLesson(31, 46);
    wait(ASK_STABLE_MS);
    observer.disconnect();
    expect(changes).toEqual([]);
    // Tab from the selection reaches the button.
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(floating()).toHaveFocus();
    // The companion shortcut (the shell calls the bridge) attaches the selection.
    let attached = false;
    act(() => void (attached = companionBridge.attachSelection()));
    expect(attached).toBe(true);
    expect(companionFocus.get().selection).toEqual({ kind: "text", excerpt: "any other membe" });
    expect(requests).toEqual([{ source: "selection", focus: true }]);
    expect(floating()).toBeNull();
    // Tab from the button goes on after the selection.
    selectLesson(4, 11);
    wait(ASK_STABLE_MS);
    fireEvent.keyDown(document.body, { key: "Tab" });
    for (const element of document.querySelectorAll("a, input")) element.getClientRects = () => [rect(0, 0, 10, 10)] as unknown as DOMRectList;
    fireEvent.keyDown(floating()!, { key: "Tab" });
    expect(document.getElementById("field")).toHaveFocus();
    act(() => {
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(companionBridge.attachSelection()).toBe(false);
  });

  it("says nothing for a selection made with the pointer, even after a copy shortcut", () => {
    render(<Lesson />);
    fireEvent.pointerDown(document.getElementById("lesson")!);
    selectLesson();
    fireEvent.pointerUp(document.getElementById("lesson")!);
    fireEvent.keyDown(document, { key: "c", ctrlKey: true });
    wait(ASK_STABLE_MS);
    expect(floating()).toBeVisible();
    expect(status()).toHaveTextContent("");
  });

  it("Esc on the focused button puts focus back at the selection, so Tab carries on from there", () => {
    render(<Lesson />);
    fireEvent.keyDown(document, { key: "ArrowRight", shiftKey: true });
    selectLesson();
    wait(ASK_STABLE_MS);
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(floating()).toHaveFocus();
    fireEvent.keyDown(floating()!, { key: "Escape" });
    expect(floating()).toBeNull();
    const paragraph = document.getElementById("lesson")!;
    expect(paragraph).toHaveFocus();
    expect(paragraph).toHaveAttribute("tabindex", "-1");
    // The paragraph is focusable only while it has focus.
    act(() => (document.getElementById("next") as HTMLElement).focus());
    expect(paragraph).not.toHaveAttribute("tabindex");
  });

  it("offers selected code lines through the same button", async () => {
    render(
      <Lesson>
        <CodeEditor language="python" value={"a = 1\nb = 2\nc = 3\n"} onChange={() => {}} />
      </Lesson>,
    );
    const field = screen.getByRole("textbox", { name: "Your code" }) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(6, 17);
    fireEvent.select(field);
    wait(ASK_STABLE_MS - 1);
    expect(floating()).toBeNull();
    wait(1);
    expect(floating()).toBeVisible();
    expect(floating()).toHaveAttribute("data-kind", "code");
    // Tab from the code field reaches the button, which keeps the offer.
    fireEvent.keyDown(field, { key: "Tab" });
    expect(floating()).toHaveFocus();
    fireEvent.click(floating()!);
    await act(async () => {
      await vi.waitFor(() => expect(requests).toEqual([{ source: "code", focus: true }]));
    });
    expect(companionFocus.get().selection).toMatchObject({ kind: "code", lineStart: 2, lineEnd: 3, excerpt: "b = 2\nc = 3" });
    // The editor keeps its error and protocol lines.
    expect(document.querySelector(".connected-code-protocol")).not.toBeNull();
  });

  it("in a code field, where the shell leaves the shortcut alone, Ctrl+Shift+. attaches the selected lines", async () => {
    render(
      <Lesson>
        <CodeEditor language="python" value={"a = 1\nb = 2\nc = 3\n"} onChange={() => {}} />
      </Lesson>,
    );
    const field = screen.getByRole("textbox", { name: "Your code" }) as HTMLTextAreaElement;
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowDown", shiftKey: true });
    field.setSelectionRange(0, 5);
    fireEvent.select(field);
    wait(ASK_STABLE_MS);
    // The status region names the shortcut, and the shortcut works where focus is.
    expect(status()).toHaveTextContent("Ask companion is available: Ctrl+Shift+period");
    const event = new KeyboardEvent("keydown", { key: ">", code: "Period", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    act(() => void field.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await act(async () => {
      await vi.waitFor(() => expect(requests).toEqual([{ source: "code", focus: true }]));
    });
    expect(companionFocus.get().selection).toMatchObject({ kind: "code", lineStart: 1, lineEnd: 1, excerpt: "a = 1" });
    // Esc from the code button returns to the field, not the page.
    field.setSelectionRange(6, 11);
    fireEvent.select(field);
    wait(ASK_STABLE_MS);
    fireEvent.keyDown(field, { key: "Tab" });
    expect(floating()).toHaveFocus();
    fireEvent.keyDown(floating()!, { key: "Escape" });
    expect(field).toHaveFocus();
  });

  it("a code selection is withdrawn when it collapses or focus leaves the field", () => {
    render(
      <Lesson>
        <CodeEditor language="python" value={"a = 1\nb = 2\n"} onChange={() => {}} />
      </Lesson>,
    );
    const field = screen.getByRole("textbox", { name: "Your code" }) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(0, 5);
    fireEvent.select(field);
    wait(ASK_STABLE_MS);
    expect(floating()).toBeVisible();
    field.setSelectionRange(2, 2);
    fireEvent.select(field);
    expect(floating()).toBeNull();
    field.setSelectionRange(0, 5);
    fireEvent.select(field);
    wait(ASK_STABLE_MS);
    expect(floating()).toBeVisible();
    act(() => (document.getElementById("next") as HTMLElement).focus());
    expect(floating()).toBeNull();
  });

  it("offers nothing while the companion is not offered (a study arm without it)", () => {
    act(() => companionBridge.setAvailable(false));
    render(
      <Lesson>
        <CodeEditor language="python" value={"a = 1\n"} onChange={() => {}} />
      </Lesson>,
    );
    selectLesson();
    wait(ASK_STABLE_MS);
    expect(floating()).toBeNull();
    const field = screen.getByRole("textbox", { name: "Your code" }) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(0, 5);
    fireEvent.select(field);
    wait(ASK_STABLE_MS);
    expect(floating()).toBeNull();
    expect(codeSelection.current()).toBeNull();
    expect(companionBridge.attachSelection()).toBe(false);
  });
});
