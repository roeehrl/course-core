import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock, COPIED_MS } from "../src/components/CodeBlock.web";
import { MarkdownContent } from "../src/components/MarkdownContent";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("code blocks (final design §3.3)", () => {
  it("shows the language and Copy in a header, and the code left to right in a keyboard-reachable scroller", () => {
    render(<CodeBlock language="python" code={"print(1)\nprint(2)"} />);
    expect(screen.getByText("python")).toBeVisible();
    const region = screen.getByRole("region", { name: "python code, scrollable" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.textContent).toBe("print(1)\nprint(2)");
    expect(region.closest(".markdown-code")).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeVisible();
  });
  it("copies the code and says Copied for 2 s; without a clipboard it does nothing", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CodeBlock language="" code="let x = 1" />);
    expect(screen.getByText("Example")).toBeVisible();
    expect(screen.getByRole("region", { name: "Example code, scrollable" })).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy code" })));
    expect(writeText).toHaveBeenCalledWith("let x = 1");
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
    act(() => void vi.advanceTimersByTime(COPIED_MS));
    expect(screen.getByRole("button", { name: "Copy code" })).toBeVisible();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy code" })));
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
  it("is used for lesson text and replies alike, in Hebrew too", () => {
    render(
      <I18nProvider value={createLearnerTranslator("he")}>
        <MarkdownContent markdown={"שורה.\n\n```js\nalert(1)\n```"} />
      </I18nProvider>,
    );
    expect(screen.getByRole("region", { name: /קוד .*js.*, אפשר לגלול/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "העתקת הקוד" })).toBeVisible();
  });
});
