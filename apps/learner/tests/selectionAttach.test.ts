import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companionFocus } from "../src/client/companionFocus";
import { companionBridge, resetCompanionBridge, type ComposeRequest } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { isCompanionShortcut } from "../src/connected/ui/keys";
import {
  ASK_GAP,
  ASK_MARGIN,
  askButtonPosition,
  attachCandidate,
  codeCandidate,
  codeSelection,
  focusAfterAsk,
  focusSelectionEnd,
  tabbableNeighbour,
  textCandidate,
} from "../src/connected/companion/selectionAttach";

// Asking about a selection (final design §3.9): what a selection may attach, where the floating
// button goes, and what pressing it does. Nothing here attaches on its own.

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
let rects: DOMRect[] = [];
const original = Range.prototype.getClientRects;

beforeEach(() => {
  rects = [rect(100, 100, 300, 24)];
  Range.prototype.getClientRects = function () {
    return rects as unknown as DOMRectList;
  };
  document.body.innerHTML = `
    <main>
      <div class="connected-lesson">
        <p id="lesson">The minimum is no greater than any other member.</p>
        <p id="hebrew" style="direction: rtl">המינימום לא גדול מאף איבר אחר.</p>
        <div contenteditable="true" id="editable">A field inside the lesson</div>
        <button id="before">Before</button>
        <a id="after" href="#x">After</a>
      </div>
      <aside id="connected-companion"><p id="reply">A reply in the companion.</p></aside>
    </main>`;
});
afterEach(() => {
  Range.prototype.getClientRects = original;
  document.getSelection()?.removeAllRanges();
  companionFocus.clear();
  codeSelection.withdraw(null);
  resetCompanionBridge();
  companionOpen.reset();
  document.body.innerHTML = "";
});

function select(id: string, from: number, to: number) {
  const text = document.getElementById(id)!.firstChild!;
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("where the floating button goes", () => {
  const end = { top: 100, bottom: 124, left: 100, right: 400 };
  const size = { width: 140, height: 32 };
  const viewport = { width: 1440, height: 900 };
  it("sits 8 px below the selection's last line with its inline end at the selection's end", () => {
    expect(askButtonPosition(end, size, "ltr", viewport)).toEqual({ top: 124 + ASK_GAP, left: 400 - 140 });
    // Right to left, the selection ends at its left edge and the button starts there.
    expect(askButtonPosition(end, size, "rtl", viewport)).toEqual({ top: 124 + ASK_GAP, left: 100 });
  });
  it("goes above the line near the bottom of the window and stays inside it", () => {
    const low = { top: 860, bottom: 884, left: 4, right: 60 };
    expect(askButtonPosition(low, size, "ltr", viewport)).toEqual({ top: 860 - ASK_GAP - 32, left: ASK_MARGIN });
    const edge = { top: 100, bottom: 124, left: 1400, right: 1440 };
    expect(askButtonPosition(edge, size, "rtl", viewport).left).toBe(1440 - ASK_MARGIN - 140);
  });
});

describe("what a selection may attach", () => {
  it("lesson text: the excerpt, the end of its last line and the text's direction", () => {
    const candidate = textCandidate(select("lesson", 31, 47))!;
    expect(candidate.kind).toBe("text");
    expect(candidate.build()).toEqual({ kind: "text", excerpt: "any other member" });
    expect(candidate.end).toEqual({ top: 100, bottom: 124, left: 100, right: 400 });
    expect(candidate.direction).toBe("ltr");
    expect(candidate.origin.id).toBe("lesson");
    expect(textCandidate(select("hebrew", 0, 8))!.direction).toBe("rtl");
  });
  it("the end is the last drawn line, whichever lines came before", () => {
    rects = [rect(100, 100, 600, 24), rect(40, 130, 0, 24), rect(40, 130, 220, 24), rect(260, 131, 30, 22)];
    expect(textCandidate(select("lesson", 0, 48))!.end).toEqual({ top: 130, bottom: 154, left: 40, right: 290 });
  });
  it("the same selection keeps its key; another one does not", () => {
    const first = textCandidate(select("lesson", 31, 47))!.key;
    expect(textCandidate(select("lesson", 31, 47))!.key).toBe(first);
    expect(textCandidate(select("lesson", 30, 47))!.key).not.toBe(first);
  });
  it("nothing outside the lesson, in a field, in the companion, or shorter than two characters", () => {
    expect(textCandidate(select("reply", 0, 7))).toBeNull();
    expect(textCandidate(select("editable", 0, 7))).toBeNull();
    expect(textCandidate(select("lesson", 4, 5))).toBeNull();
    document.getSelection()!.removeAllRanges();
    expect(textCandidate(document.getSelection())).toBeNull();
    expect(textCandidate(null)).toBeNull();
  });
  it("code: the selected lines of the learner's own code, never blank space", async () => {
    const field = document.createElement("textarea");
    field.value = "a = 1\nb = 2\nc = 3\n";
    document.querySelector(".connected-lesson")!.append(field);
    field.setSelectionRange(6, 17);
    const candidate = codeCandidate(field)!;
    expect(candidate.kind).toBe("code");
    expect(candidate.direction).toBe("ltr");
    expect(candidate.origin).toBe(field);
    expect(await candidate.build()).toEqual({
      kind: "code",
      excerpt: "b = 2\nc = 3",
      lineStart: 2,
      lineEnd: 3,
      codeSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    field.setSelectionRange(5, 6);
    expect(codeCandidate(field)).toBeNull();
    field.setSelectionRange(3, 3);
    expect(codeCandidate(field)).toBeNull();
  });
});

describe("attaching", () => {
  it("sets the next message's focus and asks the companion to open with its composer", () => {
    const requests: ComposeRequest[] = [];
    companionBridge.onCompose((request) => requests.push(request));
    const open = vi.spyOn(companionOpen, "open");
    attachCandidate(textCandidate(select("lesson", 31, 47))!);
    expect(companionFocus.get().selection).toEqual({ kind: "text", excerpt: "any other member" });
    expect(requests).toEqual([{ source: "selection", focus: true }]);
    expect(open).toHaveBeenCalledWith("selection");
    attachCandidate(textCandidate(select("lesson", 4, 11))!, { focus: false });
    expect(requests.at(-1)).toEqual({ source: "selection", focus: false });
  });
  it("code lines go once their snapshot hash is known, as source code", async () => {
    const requests: ComposeRequest[] = [];
    companionBridge.onCompose((request) => requests.push(request));
    const field = document.createElement("textarea");
    field.value = "x = 1\ny = x + 1";
    document.body.append(field);
    field.setSelectionRange(0, 5);
    attachCandidate(codeCandidate(field)!);
    await vi.waitFor(() => expect(requests).toEqual([{ source: "code", focus: true }]));
    expect(companionFocus.get().selection).toMatchObject({ kind: "code", lineStart: 1, lineEnd: 1, excerpt: "x = 1" });
  });
});

describe("focus after asking", () => {
  it("goes to the message box after a key press, and after a pointer press except on a touch screen", () => {
    expect(focusAfterAsk({ detail: 0 }, true)).toBe(true);
    expect(focusAfterAsk({ detail: 1 }, true)).toBe(false);
    expect(focusAfterAsk({ detail: 1 }, false)).toBe(true);
    expect(focusAfterAsk(undefined, false)).toBe(true);
  });
});

describe("the code field's offer", () => {
  it("is replaced by a new offer, withdrawn only by its own field, and announced to listeners", () => {
    const listener = vi.fn();
    const stop = codeSelection.subscribe(listener);
    const one = document.createElement("textarea"),
      two = document.createElement("textarea");
    one.value = two.value = "print(1)";
    one.setSelectionRange(0, 5);
    two.setSelectionRange(0, 5);
    codeSelection.offer(codeCandidate(one)!);
    codeSelection.offer(codeCandidate(one)!);
    expect(listener).toHaveBeenCalledTimes(1);
    codeSelection.withdraw(two);
    expect(codeSelection.current()?.origin).toBe(one);
    codeSelection.withdraw(one);
    expect(codeSelection.current()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("Tab order around the floating button", () => {
  it("goes on after the selection's end, or back before it", () => {
    for (const element of document.querySelectorAll("button, a")) element.getClientRects = () => [rect(0, 0, 10, 10)] as unknown as DOMRectList;
    const end = document.getElementById("editable")!.firstChild!;
    expect(tabbableNeighbour(end, true)?.id).toBe("before");
    expect(tabbableNeighbour(document.getElementById("before")!, true)?.id).toBe("after");
    expect(tabbableNeighbour(document.getElementById("after")!, false)?.id).toBe("before");
    expect(tabbableNeighbour(document.getElementById("lesson")!.firstChild!, false)).toBeNull();
  });
});

describe("the companion shortcut and coming back from the button", () => {
  it("uses the shell's matcher: Ctrl+Shift+. or Cmd+Shift+. by key position (any layout), never with Alt", () => {
    const key = (init: Partial<KeyboardEvent>) => ({ code: "Period", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, ...init });
    expect(isCompanionShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isCompanionShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCompanionShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCompanionShortcut(key({ ctrlKey: true, shiftKey: false }))).toBe(false);
    expect(isCompanionShortcut(key({ ctrlKey: true, code: "Comma" }))).toBe(false);
  });

  it("puts focus on the block the selection ends in, focusable only while it has focus", () => {
    const candidate = textCandidate(select("lesson", 31, 47))!;
    focusSelectionEnd(candidate);
    const paragraph = document.getElementById("lesson")!;
    expect(paragraph).toHaveFocus();
    expect(paragraph.getAttribute("tabindex")).toBe("-1");
    document.getElementById("after")!.focus();
    expect(paragraph.hasAttribute("tabindex")).toBe(false);
  });

  it("puts focus back in the code field for code", () => {
    document.body.insertAdjacentHTML("beforeend", '<div class="connected-lesson"><textarea id="code">a = 1\nb = 2</textarea></div>');
    const field = document.getElementById("code") as HTMLTextAreaElement;
    field.setSelectionRange(0, 5);
    focusSelectionEnd(codeCandidate(field)!);
    expect(field).toHaveFocus();
  });
});
