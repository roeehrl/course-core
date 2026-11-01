import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { companionBridge, resetCompanionBridge } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import {
  handleCompanionShortcut,
  lessonSelection,
  shortcutAction,
  shortcutAria,
  shortcutLabel,
} from "../src/connected/companion/shortcut";

// The companion shortcut (final design §3.1, §5, Q8): Ctrl+Shift+. or ⌘⇧., read from the physical
// key so a Hebrew layout works, never with Alt, never while typing in a field.
const key = (init: KeyboardEventInit & { target?: EventTarget }) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.target) Object.defineProperty(event, "target", { value: init.target });
  return event;
};

describe("companion shortcut", () => {
  afterEach(() => {
    resetCompanionBridge();
    companionOpen.reset();
    document.body.innerHTML = "";
    document.getSelection()?.removeAllRanges();
  });
  it("is Ctrl+Shift+. or ⌘⇧. on the physical key, on any layout", () => {
    expect(shortcutAction(key({ code: "Period", key: ">", ctrlKey: true, shiftKey: true }), false)).toBe("toggle");
    expect(shortcutAction(key({ code: "Period", key: ">", metaKey: true, shiftKey: true }), false)).toBe("toggle");
    // The Hebrew layout puts ץ on that key: the code is still Period.
    expect(shortcutAction(key({ code: "Period", key: "ץ", ctrlKey: true, shiftKey: true }), false)).toBe("toggle");
    // A "." typed elsewhere on some layout is not it.
    expect(shortcutAction(key({ code: "Slash", key: ".", ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });
  it("never uses Alt, and needs Shift and Ctrl or ⌘", () => {
    expect(shortcutAction(key({ code: "Period", ctrlKey: true, shiftKey: true, altKey: true }), false)).toBeNull();
    expect(shortcutAction(key({ code: "Period", altKey: true, shiftKey: true }), false)).toBeNull();
    expect(shortcutAction(key({ code: "Period", ctrlKey: true }), false)).toBeNull();
    expect(shortcutAction(key({ code: "Period", shiftKey: true }), false)).toBeNull();
    expect(shortcutAction(key({ code: "Period", ctrlKey: true, shiftKey: true, repeat: true }), false)).toBeNull();
  });
  it("leaves fields alone", () => {
    for (const html of ["<textarea></textarea>", "<input>", '<div contenteditable="true"></div>']) {
      document.body.innerHTML = html;
      const field = document.body.firstElementChild as HTMLElement;
      if (field.hasAttribute("contenteditable")) Object.defineProperty(field, "isContentEditable", { value: true });
      expect(shortcutAction(key({ code: "Period", ctrlKey: true, shiftKey: true, target: field }), false), html).toBeNull();
    }
    document.body.innerHTML = "<button>Mark read</button>";
    expect(shortcutAction(key({ code: "Period", ctrlKey: true, shiftKey: true, target: document.body.firstElementChild! }), false)).toBe("toggle");
  });
  it("toggles the companion, and with lesson text selected attaches it and opens", () => {
    companionOpen.sync({ docked: false, surface: "lesson" });
    act(() => void handleCompanionShortcut(key({ code: "Period", ctrlKey: true, shiftKey: true })));
    expect(companionOpen.get().open).toBe(true);
    act(() => void handleCompanionShortcut(key({ code: "Period", ctrlKey: true, shiftKey: true })));
    expect(companionOpen.get().open).toBe(false);
    document.body.innerHTML = '<main class="connected-main"><p>The smallest value comes first.</p></main>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    document.getSelection()!.addRange(range);
    expect(lessonSelection()).toBe(true);
    const attach = vi.fn(() => true);
    companionBridge.registerSelection(attach);
    const event = key({ code: "Period", ctrlKey: true, shiftKey: true });
    act(() => void handleCompanionShortcut(event));
    expect(attach).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(companionOpen.get().open).toBe(true);
    // Open already, a selection attaches again and keeps it open.
    act(() => void handleCompanionShortcut(key({ code: "Period", ctrlKey: true, shiftKey: true })));
    expect(attach).toHaveBeenCalledTimes(2);
    expect(companionOpen.get().open).toBe(true);
  });
  it("names the keys for the tooltip and aria-keyshortcuts", () => {
    expect(shortcutAria(false)).toBe("Control+Shift+.");
    expect(shortcutAria(true)).toBe("Meta+Shift+.");
    expect(shortcutLabel(false)).toBe("Ctrl+Shift+.");
    expect(shortcutLabel(true)).toBe("⌘⇧.");
  });
});
