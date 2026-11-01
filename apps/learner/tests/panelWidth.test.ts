import { afterEach, describe, expect, it } from "vitest";
import {
  dragWidth,
  forgetWidth,
  keyWidth,
  panelRange,
  readWidth,
  snapWidth,
  WIDTH_PREFERENCE,
  writeWidth,
} from "../src/connected/companion/panelWidth";

// The docked panel's width (final design §2.1): 360 … min(720, W − 480), default 400 where the
// lesson keeps 540 beside it, snaps at 400 and 560, keyboard steps in screen direction.
describe("panel width", () => {
  afterEach(() => window.localStorage.clear());
  it("follows the width table", () => {
    const table: [number, number, number][] = [
      [1920, 400, 720],
      [1440, 400, 720],
      [1280, 400, 720],
      [1024, 400, 544],
      [900, 360, 420],
      [840, 360, 360],
    ];
    for (const [width, initial, max] of table) {
      const range = panelRange(width);
      expect([range.min, range.default, range.max], String(width)).toEqual([360, initial, max]);
      // The lesson column: never under 479 beside the divider.
      expect(width - range.max - 1, String(width)).toBeGreaterThanOrEqual(479);
    }
    expect(1440 - 400 - 1).toBe(1039);
  });
  it("snaps within 12 px of 400 and 560, and clamps to the range", () => {
    const range = panelRange(1440);
    expect(snapWidth(388, range)).toBe(400);
    expect(snapWidth(412, range)).toBe(400);
    expect(snapWidth(413, range)).toBe(413);
    expect(snapWidth(549, range)).toBe(560);
    expect(snapWidth(572, range)).toBe(560);
    expect(snapWidth(200, range)).toBe(360);
    expect(snapWidth(900, range)).toBe(720);
    // A snap the window does not allow is not used: at 900 px the maximum is 420.
    expect(snapWidth(560, panelRange(900))).toBe(420);
  });
  it("widens when the divider moves toward the lesson, in either direction", () => {
    const range = panelRange(1440);
    expect(dragWidth(400, -100, false, range)).toBe(500);
    expect(dragWidth(400, 30, false, range)).toBe(370);
    // Right to left: the panel is on the left, so moving the divider right widens it.
    expect(dragWidth(400, 100, true, range)).toBe(500);
    expect(dragWidth(400, -30, true, range)).toBe(370);
    expect(dragWidth(400, -155, false, range)).toBe(560);
  });
  it("moves with the keyboard in screen direction", () => {
    const range = panelRange(1440);
    const key = (name: string, shiftKey = false) => ({ key: name, shiftKey });
    expect(keyWidth(400, key("ArrowLeft"), false, range)).toBe(416);
    expect(keyWidth(400, key("ArrowRight"), false, range)).toBe(384);
    expect(keyWidth(400, key("ArrowLeft", true), false, range)).toBe(464);
    expect(keyWidth(400, key("ArrowRight", true), false, range)).toBe(360);
    // RTL: ← still moves the divider left, which narrows a panel on the left.
    expect(keyWidth(400, key("ArrowLeft"), true, range)).toBe(384);
    expect(keyWidth(400, key("ArrowRight"), true, range)).toBe(416);
    expect(keyWidth(500, key("Home"), false, range)).toBe(360);
    expect(keyWidth(500, key("End"), false, range)).toBe(720);
    expect(keyWidth(400, key("Enter"), false, range)).toBe(560);
    expect(keyWidth(560, key("Enter"), false, range)).toBe(400);
    expect(keyWidth(470, key("Enter"), false, range)).toBe(400);
    expect(keyWidth(400, key("Enter"), false, panelRange(1024))).toBe(544);
    expect(keyWidth(400, key("a"), false, range)).toBeNull();
  });
  it("remembers the width on this device, and works without storage", () => {
    expect(readWidth()).toBeUndefined();
    writeWidth(512.4);
    expect(window.localStorage.getItem(WIDTH_PREFERENCE)).toBe("512");
    expect(readWidth()).toBe(512);
    forgetWidth();
    expect(readWidth()).toBeUndefined();
    window.localStorage.setItem(WIDTH_PREFERENCE, "wide");
    expect(readWidth()).toBeUndefined();
    const storage = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(readWidth()).toBeUndefined();
      expect(() => writeWidth(500)).not.toThrow();
      expect(() => forgetWidth()).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", storage);
    }
  });
});
