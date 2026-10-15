import { describe, expect, it } from "vitest";
import {
  companionPlacement,
  EXPANDED_MIN_WIDTH,
  MEDIUM_MIN_WIDTH,
  windowClass,
} from "../src/domain/windowClass";
import { effectiveLayout } from "../src/domain/session";

describe("window classes", () => {
  it("uses exactly the compact <600, medium 600–839 and expanded ≥840 boundaries", () => {
    expect([MEDIUM_MIN_WIDTH, EXPANDED_MIN_WIDTH]).toEqual([600, 840]);
    expect(windowClass(320)).toBe("compact");
    expect(windowClass(599)).toBe("compact");
    expect(windowClass(599.9)).toBe("compact");
    expect(windowClass(600)).toBe("medium");
    expect(windowClass(839)).toBe("medium");
    expect(windowClass(840)).toBe("expanded");
    expect(windowClass(1024)).toBe("expanded");
  });
  it("divides by the text scale, so large text gets the layout its effective width supports", () => {
    expect(windowClass(1024, 1.25)).toBe("medium"); // 819 effective
    expect(windowClass(1024, 2)).toBe("compact"); // 512 effective
    expect(windowClass(840, 1)).toBe("expanded");
    // A scale below 1 never widens the class; nonsense input is safe.
    expect(windowClass(599, 0.5)).toBe("compact");
    expect(windowClass(900, Number.NaN)).toBe("expanded");
    expect(windowClass(Number.NaN)).toBe("compact");
  });
  it("puts the companion beside the lesson only when the window is wide and tall enough", () => {
    expect(companionPlacement("compact", 1000)).toBe("sheet");
    expect(companionPlacement("medium", 1112)).toBe("pane");
    expect(companionPlacement("expanded", 960)).toBe("pane");
    // A phone in landscape is wide but too short for a side pane.
    expect(companionPlacement(windowClass(844), 390)).toBe("sheet");
  });
  it("is the same function the public demo uses", () => {
    for (const width of [599, 600, 839, 840, 1024])
      expect(effectiveLayout(width, 900).windowClass).toBe(windowClass(width));
    expect(effectiveLayout(839, 900).companionPane).toBe(false);
    expect(effectiveLayout(840, 900).companionPane).toBe(true);
  });
});
