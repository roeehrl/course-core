import { describe, expect, it } from "vitest";
import { markScrollFades } from "../src/client/scrollFades";

/** A row with the given scroll room and position (jsdom does no layout). */
function row(scrollWidth: number, clientWidth: number, scrollLeft: number) {
  const element = document.createElement("nav");
  Object.defineProperties(element, {
    scrollWidth: { value: scrollWidth },
    clientWidth: { value: clientWidth },
    scrollLeft: { value: scrollLeft },
  });
  return element;
}
const marks = (element: Element) => [
  element.hasAttribute("data-fade-start"),
  element.hasAttribute("data-fade-end"),
];

describe("scroll fades on sideways rows", () => {
  it("fades the edges with more past them, at either end, and none when the row fits", () => {
    const fits = row(300, 300, 0);
    markScrollFades(fits);
    expect(marks(fits)).toEqual([false, false]);
    const atStart = row(600, 300, 0);
    markScrollFades(atStart);
    expect(marks(atStart)).toEqual([false, true]);
    const middle = row(600, 300, 150);
    markScrollFades(middle);
    expect(marks(middle)).toEqual([true, true]);
    const atEnd = row(600, 300, 300);
    markScrollFades(atEnd);
    expect(marks(atEnd)).toEqual([true, false]);
  });

  it("reads right-to-left rows, which scroll to negative positions, the same way", () => {
    const middle = row(600, 300, -150);
    markScrollFades(middle);
    expect(marks(middle)).toEqual([true, true]);
    const atEnd = row(600, 300, -300);
    markScrollFades(atEnd);
    expect(marks(atEnd)).toEqual([true, false]);
  });
});
