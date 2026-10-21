import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { installImeSubmitGuard, isImeEnter } from "../src/client/imeGuard";

/* I06: an Enter that commits IME composition never submits a form. jsdom has no
 * implicit submission, so each case dispatches the submit the browser would. */
function Form({ onSubmit }: { onSubmit: () => void }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input aria-label="Answer" />
    </form>
  );
}
const key = (target: Element, init: KeyboardEventInit & { keyCode?: number }) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  target.dispatchEvent(event);
};
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

describe("IME submit guard", () => {
  let uninstall = () => {};
  afterEach(() => uninstall());

  it("recognises composing Enter keys only", () => {
    expect(isImeEnter({ key: "Enter", isComposing: true })).toBe(true);
    expect(isImeEnter({ key: "Process", keyCode: 229 })).toBe(true);
    expect(isImeEnter({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeEnter({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeEnter({ key: "a", isComposing: true })).toBe(false);
  });

  it("cancels a submit while composing and right after an IME Enter, but not a plain Enter", async () => {
    uninstall = installImeSubmitGuard(document);
    const onSubmit = vi.fn();
    const { container, getByLabelText } = render(<Form onSubmit={onSubmit} />);
    const form = container.querySelector("form")!,
      input = getByLabelText("Answer");

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    key(input, { key: "Enter", isComposing: true });
    expect(submit(form)).toBe(false);
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
    // Safari: the committing Enter arrives after compositionend with keyCode 229.
    key(input, { key: "Enter", keyCode: 229 });
    expect(submit(form)).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    // The next keystroke is ordinary again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    key(input, { key: "Enter", keyCode: 13 });
    submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does nothing once uninstalled", () => {
    installImeSubmitGuard(document)();
    const onSubmit = vi.fn();
    const { container, getByLabelText } = render(<Form onSubmit={onSubmit} />);
    getByLabelText("Answer").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
