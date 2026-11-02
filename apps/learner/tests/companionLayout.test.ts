import { describe, expect, it } from "vitest";
import { companionLayout, DOCKED_MIN_HEIGHT, DOCKED_MIN_WIDTH } from "../src/domain/companionLayout";

// Where the companion goes in a window (final design §2): docked beside the lesson from 840 px wide
// and 480 px high, else a sheet: phone under 600, tablet 600–839, short under 480 px high.
describe("companion layout", () => {
  it("docks from 840 wide and 480 high", () => {
    expect([DOCKED_MIN_WIDTH, DOCKED_MIN_HEIGHT]).toEqual([840, 480]);
    for (const [width, height] of [[840, 480], [1024, 768], [1440, 900], [1112, 834], [1920, 1080]] as const)
      expect(companionLayout(width, height), `${width}×${height}`).toEqual({
        placement: "docked",
        sheet: null,
        compactPage: false,
        windowClass: "expanded",
      });
  });
  it("uses the tablet sheet from 600 to 839 wide, with the page's own layout", () => {
    for (const width of [600, 700, 834, 839])
      expect(companionLayout(width, 1112), String(width)).toEqual({
        placement: "sheet",
        sheet: "tablet",
        compactPage: false,
        windowClass: "medium",
      });
  });
  it("uses the phone sheet under 600 wide, with the scrolling learning pane", () => {
    for (const [width, height] of [[320, 568], [390, 844], [599, 1112], [599, 300]] as const)
      expect(companionLayout(width, height), `${width}×${height}`).toEqual({
        placement: "sheet",
        sheet: "phone",
        compactPage: true,
        windowClass: "compact",
      });
  });
  it("uses the short sheet under 480 high in a window wider than a phone", () => {
    expect(companionLayout(844, 390)).toEqual({ placement: "sheet", sheet: "short", compactPage: true, windowClass: "expanded" });
    expect(companionLayout(1440, 479)).toMatchObject({ placement: "sheet", sheet: "short", compactPage: true });
    expect(companionLayout(740, 360)).toMatchObject({ placement: "sheet", sheet: "short", compactPage: true, windowClass: "medium" });
    expect(companionLayout(1440, 480).placement).toBe("docked");
  });
  it("divides the width by the text scale, never the height", () => {
    // 1280 at 1.5× text is 853 effective: still docked; at 2× it is 640: a tablet sheet.
    expect(companionLayout(1280, 900, 1.5)).toMatchObject({ placement: "docked", windowClass: "expanded" });
    expect(companionLayout(1280, 900, 2)).toMatchObject({ placement: "sheet", sheet: "tablet", windowClass: "medium" });
    expect(companionLayout(1024, 900, 2)).toMatchObject({ sheet: "phone", compactPage: true });
    // A scale below 1 never widens it; nonsense input is safe.
    expect(companionLayout(839, 900, 0.5).sheet).toBe("tablet");
    expect(companionLayout(Number.NaN, Number.NaN)).toMatchObject({ placement: "sheet", sheet: "phone" });
  });
});
