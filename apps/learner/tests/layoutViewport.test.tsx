import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  isEditable,
  nextLayoutSize,
  useLayoutViewport,
} from "../src/connected/layoutViewport";

const wide = { width: 1194, height: 834 };

describe("layout viewport", () => {
  it("holds back a height-only shrink while editing and applies it afterwards", () => {
    const keyboard = { width: 1194, height: 400 };
    expect(nextLayoutSize(wide, keyboard, true)).toBe(wide);
    expect(nextLayoutSize(wide, keyboard, false)).toEqual(keyboard);
  });

  it("applies width changes and height growth at once, even while editing", () => {
    expect(nextLayoutSize(wide, { width: 834, height: 1194 }, true)).toEqual({ width: 834, height: 1194 });
    expect(nextLayoutSize(wide, { width: 900, height: 834 }, true)).toEqual({ width: 900, height: 834 });
    const grown = { width: 1194, height: 900 };
    expect(nextLayoutSize(wide, grown, true)).toEqual(grown);
    expect(nextLayoutSize(wide, { ...wide }, false)).toBe(wide);
  });

  it("treats only keyboard-summoning fields as editable", () => {
    const make = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.firstElementChild!;
    };
    for (const html of ["<textarea></textarea>", "<input>", '<input type="text">', '<input type="number">', '<input type="password">'])
      expect(isEditable(make(html)), html).toBe(true);
    // jsdom has no isContentEditable; browsers set it for contenteditable hosts.
    expect(isEditable(Object.assign(document.createElement("div"), { isContentEditable: true }))).toBe(true);
    for (const html of ['<input type="radio">', '<input type="checkbox">', '<input type="submit">', "<textarea readonly></textarea>", "<input readonly>", "<button></button>", "<div></div>"])
      expect(isEditable(make(html)), html).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe("useLayoutViewport", () => {
  const root = document.documentElement;
  const setSize = (width: number, height: number) => {
    Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: height });
  };
  afterEach(() => {
    delete (root as unknown as Record<string, unknown>).clientWidth;
    delete (root as unknown as Record<string, unknown>).clientHeight;
  });
  function Probe() {
    const { width, height } = useLayoutViewport();
    return (
      <>
        <output data-testid="size">{`${width}x${height}`}</output>
        <textarea aria-label="field" />
        <button type="button">elsewhere</button>
      </>
    );
  }
  const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

  it("follows window resizes, ignores visual-viewport-only shrinks and releases a held shrink on blur", async () => {
    setSize(1194, 834);
    render(<Probe />);
    await frame();
    expect(screen.getByTestId("size").textContent).toBe("1194x834");
    // A visual viewport resize alone does not change the layout size.
    await act(async () => window.visualViewport?.dispatchEvent(new Event("resize")));
    await frame();
    expect(screen.getByTestId("size").textContent).toBe("1194x834");
    // Keyboard that also shrinks the layout viewport while a field is focused.
    act(() => (screen.getByLabelText("field") as HTMLTextAreaElement).focus());
    setSize(1194, 420);
    act(() => window.dispatchEvent(new Event("resize")));
    await frame();
    expect(screen.getByTestId("size").textContent).toBe("1194x834");
    expect(document.activeElement).toBe(screen.getByLabelText("field"));
    // Editing ends while the window really is short: apply it.
    act(() => screen.getByRole("button", { name: "elsewhere" }).focus());
    await frame();
    expect(screen.getByTestId("size").textContent).toBe("1194x420");
    // Window shrinks without editing: apply at once.
    setSize(800, 420);
    act(() => window.dispatchEvent(new Event("resize")));
    await frame();
    expect(screen.getByTestId("size").textContent).toBe("800x420");
  });
});
