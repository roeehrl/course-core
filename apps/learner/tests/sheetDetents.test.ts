import { describe, expect, it } from "vitest";
import {
  cycleDetent,
  defaultDetent,
  detentHeights,
  detentsFor,
  dragHeight,
  releaseDetent,
  stepDetent,
  validDetent,
} from "../src/connected/companion/sheetDetents";

// The companion sheet's heights (final design §2.3-§2.5) and how a drag or a key moves between them.
describe("sheet detents", () => {
  it("opens at Half on phones and tablets, at Full on a short window", () => {
    expect(defaultDetent("phone")).toBe("half");
    expect(defaultDetent("tablet")).toBe("half");
    expect(defaultDetent("short")).toBe("full");
    expect(detentsFor("short")).toEqual(["collapsed", "full"]);
    expect(validDetent("short", "half")).toBe("full");
    expect(validDetent("phone", "collapsed")).toBe("collapsed");
  });
  it("measures each height as the design gives it", () => {
    // Phone 390 × 844, header 66: Half 422, Full at header + 88 (690 tall).
    expect(detentHeights({ kind: "phone", viewport: 844, header: 66, keyboard: 0 })).toEqual({ collapsed: 72, half: 422, full: 690 });
    // With a 336 px keyboard the strip is 48: top at 114, so 394 above the keyboard.
    const typing = detentHeights({ kind: "phone", viewport: 844, header: 66, keyboard: 336 });
    expect(typing.full).toBe(730);
    expect(typing.full - 336).toBe(394);
    // Tablet 834 × 1112, header 74: Half 556, Full at header + 120 (top 194).
    expect(detentHeights({ kind: "tablet", viewport: 1112, header: 74, keyboard: 0 })).toEqual({ collapsed: 72, half: 556, full: 918 });
    // Short 844 × 390: Full is 342 tall.
    expect(detentHeights({ kind: "short", viewport: 390, header: 74, keyboard: 0 }).full).toBe(342);
    // A tiny window never inverts the heights.
    const tiny = detentHeights({ kind: "phone", viewport: 200, header: 66, keyboard: 0 });
    expect(tiny.half).toBeLessThanOrEqual(tiny.full);
    expect(tiny.full).toBeGreaterThanOrEqual(72);
  });
  it("steps with ↑/↓ and cycles Half ↔ Full on a press", () => {
    expect(stepDetent("phone", "half", 1)).toBe("full");
    expect(stepDetent("phone", "full", 1)).toBe("full");
    expect(stepDetent("phone", "half", -1)).toBe("collapsed");
    expect(stepDetent("phone", "collapsed", -1)).toBe("collapsed");
    expect(stepDetent("short", "collapsed", 1)).toBe("full");
    expect(cycleDetent("phone", "half")).toBe("full");
    expect(cycleDetent("phone", "full")).toBe("half");
    expect(cycleDetent("tablet", "collapsed")).toBe("half");
    expect(cycleDetent("short", "collapsed")).toBe("full");
    expect(cycleDetent("short", "full")).toBe("collapsed");
  });
  it("follows a drag with a rubber band above Full", () => {
    expect(dragHeight(422, 100, 690)).toBe(322);
    expect(dragHeight(422, -200, 690)).toBe(622);
    expect(dragHeight(690, -100, 690)).toBe(720);
  });
  it("settles a release at the nearest height, a flick at the next one, and dismisses", () => {
    const heights = { collapsed: 72, half: 422, full: 690 };
    expect(releaseDetent("phone", heights, 600, 0)).toBe("full");
    expect(releaseDetent("phone", heights, 450, 0.2)).toBe("half");
    expect(releaseDetent("phone", heights, 120, 0)).toBe("collapsed");
    // A downward flick goes one height lower from above Half; from Half or below it closes.
    expect(releaseDetent("phone", heights, 600, 0.8)).toBe("half");
    expect(releaseDetent("phone", heights, 400, 0.8)).toBe("closed");
    expect(releaseDetent("phone", heights, 70, 0.8)).toBe("closed");
    expect(releaseDetent("phone", heights, 400, 0.3)).toBe("half");
    // An upward flick goes one height higher.
    expect(releaseDetent("phone", heights, 430, -0.8)).toBe("full");
    expect(releaseDetent("phone", heights, 700, -0.8)).toBe("full");
    // More than a quarter below Collapsed closes it.
    expect(releaseDetent("phone", heights, 54, 0)).toBe("collapsed");
    expect(releaseDetent("phone", heights, 53, 0)).toBe("closed");
    // A short window has no Half.
    expect(releaseDetent("short", { collapsed: 72, half: 195, full: 342 }, 220, 0)).toBe("full");
  });
});
