import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "react-native";
import { CompanionDock } from "../src/components/CompanionDock.web";
import { companionOpen } from "../src/connected/companion/openState";
import { companionBridge, resetCompanionBridge } from "../src/connected/companion/bridge";
import { companionLayout } from "../src/domain/companionLayout";

// Split from companion.test.tsx: the companion's frame (final design §2). One aside keeps the
// draft and its focus across every layout; the sheet is never modal; Escape is decided after the
// conversation had its say.

/** A window that docks the companion beside the lesson, or one that shows it as a sheet. */
const dockLayout = (wide: boolean) => (wide ? companionLayout(1440, 960) : companionLayout(390, 844));
/** The Escape chain decides after the event went everywhere (a timer). */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  companionOpen.reset();
  resetCompanionBridge();
});
afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("companion dock", () => {
  it("keeps the same textarea through layout changes, with no focus trap and no dialog", async () => {
    const renderDock = (wide: boolean) => (
      <CompanionDock layout={dockLayout(wide)}>
        <textarea aria-label="Draft" defaultValue="Keep this" />
        <button type="button">Last</button>
      </CompanionDock>
    );
    act(() => {
      companionOpen.sync({ docked: false, surface: "lesson" });
      companionOpen.setSheetOpen(true);
    });
    const { rerender } = render(renderDock(false));
    // The sheet is the complementary region, never a dialog, and opens at Half.
    const region = screen.getByRole("complementary", { name: "Your companion" });
    expect(region).toHaveAttribute("data-placement", "sheet");
    expect(region).toHaveAttribute("data-detent", "half");
    expect(region).not.toHaveAttribute("aria-modal");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement;
    // Focusing the message box at Half takes the sheet to Full (G6).
    act(() => input.focus());
    expect(companionOpen.get().detent).toBe("full");
    input.setSelectionRange(2, 5);
    // Tab is never held inside it.
    const last = screen.getByRole("button", { name: "Last" });
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(true);
    act(() => companionOpen.sync({ docked: true, surface: "lesson" }));
    rerender(renderDock(true));
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2);
    expect(screen.getByRole("complementary", { name: "Your companion" })).toHaveAttribute("data-placement", "docked");
    act(() => companionOpen.sync({ docked: false, surface: "lesson" }));
    rerender(renderDock(false));
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    await settle();
    expect(companionOpen.get().sheetOpen).toBe(false);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("opens and closes from the trigger in the header, which stays and shows its state", async () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    const renderDock = (wide: boolean) => (
      <CompanionDock layout={dockLayout(wide)} headerSlot={slot}>
        <textarea aria-label="Draft" defaultValue="Keep this" />
      </CompanionDock>
    );
    act(() => companionOpen.sync({ docked: true, surface: "lesson" }));
    const { rerender } = render(renderDock(true));
    const trigger = slot.querySelector<HTMLButtonElement>(".connected-companion-trigger")!;
    expect(trigger).toHaveAccessibleName("Companion");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", "connected-companion");
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Control+Shift+.");
    expect(trigger).toHaveAttribute("data-usability", "detour");
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(trigger);
    expect(companionOpen.get().paneOpen).toBe(true);
    const region = screen.getByRole("complementary", { name: "Your companion" });
    expect(region).toHaveFocus();
    // Open: pressed, still in the header, and a press closes it.
    expect(trigger).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("title", "Close companion");
    // The panel's header: the title, About, Expand and Close; its splitter beside it.
    expect(screen.getByRole("heading", { level: 2, name: "Companion" })).toBeVisible();
    expect(screen.getByRole("button", { name: "About your companion" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Expand" })).toHaveAttribute("title", "Expand to a wide view");
    expect(screen.getByRole("separator", { name: "Resize companion" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close companion" }));
    expect(companionOpen.get().paneOpen).toBe(false);
    // Hidden, not removed: the draft keeps its value for when the panel returns.
    expect(screen.getByRole("textbox", { name: "Draft", hidden: true })).toHaveValue("Keep this");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    const input = screen.getByRole("textbox", { name: "Draft" });
    act(() => input.focus());
    // Narrowing to a phone while typing keeps the learner in the companion, now a sheet.
    act(() => companionOpen.sync({ docked: false, surface: "lesson" }));
    rerender(renderDock(false));
    expect(companionOpen.get().sheetOpen).toBe(true);
    expect(screen.getByRole("complementary", { name: "Your companion" })).toHaveAttribute("data-placement", "sheet");
    expect(input).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Widening with the sheet open shows the panel even if it had been closed.
    act(() => companionOpen.setPaneOpen(false));
    act(() => companionOpen.sync({ docked: true, surface: "lesson" }));
    rerender(renderDock(true));
    expect(companionOpen.get().paneOpen).toBe(true);
    slot.remove();
  });

  it("closing from the trigger puts focus on it wherever focus was, and a layout change keeps it open or closed whatever has focus", () => {
    const slot = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(slot, outside);
    const renderDock = (wide: boolean) => (
      <CompanionDock layout={dockLayout(wide)} headerSlot={slot}>
        <textarea aria-label="Draft" />
      </CompanionDock>
    );
    act(() => companionOpen.sync({ docked: true, surface: "lesson" }));
    const { rerender } = render(renderDock(true));
    const trigger = slot.querySelector<HTMLButtonElement>(".connected-companion-trigger")!;
    fireEvent.click(trigger);
    // The learner went on reading: focus is in the lesson, not in the companion.
    act(() => outside.focus());
    // Narrower than a panel allows: the open panel becomes an open sheet, at Half.
    act(() => companionOpen.sync({ docked: false, surface: "lesson" }));
    rerender(renderDock(false));
    expect(screen.getByRole("complementary", { name: "Your companion" })).toHaveAttribute("data-placement", "sheet");
    expect(companionOpen.get().detent).toBe("half");
    expect(outside).toHaveFocus();
    // Wider again: the panel, still open.
    act(() => companionOpen.sync({ docked: true, surface: "lesson" }));
    rerender(renderDock(true));
    expect(screen.getByRole("complementary", { name: "Your companion" })).toHaveAttribute("data-placement", "docked");
    // A click on the trigger in Safari does not focus it: closing from it still returns focus there.
    fireEvent.click(trigger);
    expect(companionOpen.get().paneOpen).toBe(false);
    expect(trigger).toHaveFocus();
    // A closed panel stays closed as a sheet.
    act(() => companionOpen.sync({ docked: false, surface: "lesson" }));
    rerender(renderDock(false));
    expect(companionOpen.get().open).toBe(false);
    slot.remove();
    outside.remove();
  });

  it("names unread replies and a waiting suggestion on the trigger", () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    render(
      <CompanionDock layout={dockLayout(true)} headerSlot={slot}>
        <p>Thread</p>
      </CompanionDock>,
    );
    const trigger = slot.querySelector(".connected-companion-trigger")!;
    act(() => companionBridge.updateActivity({ unread: 1 }));
    expect(trigger).toHaveAccessibleName("Companion, 1 new reply");
    expect(trigger.querySelector(".cc-shell-trigger-dot")).not.toBeNull();
    act(() => companionBridge.updateActivity({ unread: 3 }));
    expect(trigger).toHaveAccessibleName("Companion, 3 new replies");
    act(() => companionBridge.updateActivity({ unread: 0, suggestions: 1 }));
    expect(trigger).toHaveAccessibleName("Companion, a suggestion to review");
    act(() => companionBridge.updateActivity({ suggestions: 0 }));
    expect(trigger).toHaveAccessibleName("Companion");
    expect(trigger.querySelector(".cc-shell-trigger-dot")).toBeNull();
    slot.remove();
  });

  it("closes the sheet with Escape even from a React Native text input, which stops key events bubbling", async () => {
    act(() => companionOpen.setSheetOpen(true));
    render(
      <CompanionDock layout={dockLayout(false)}>
        <TextInput accessibilityLabel="Message" defaultValue="Keep this" />
      </CompanionDock>,
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    await settle();
    expect(companionOpen.get().sheetOpen).toBe(false);
  });

  it("lets Escape stop a reply first, then leave focus view, then close; a key used inside is left alone", async () => {
    act(() => {
      companionOpen.sync({ docked: true, surface: "lesson" });
      companionOpen.setPaneOpen(true);
    });
    render(
      <CompanionDock layout={dockLayout(true)}>
        <textarea aria-label="Draft" />
        <button type="button" onKeyDown={(event) => event.key === "Escape" && event.preventDefault()}>
          Menu
        </button>
      </CompanionDock>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(companionOpen.get().view).toBe("focus");
    expect(window.sessionStorage.getItem("course:learner-companion-view")).toBe("focus");
    expect(screen.getByRole("complementary", { name: "Your companion" })).toHaveAttribute("data-view", "focus");
    expect(screen.getByRole("button", { name: "Show lesson beside" })).toBeVisible();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    // A key a menu or popover used stays theirs.
    fireEvent.keyDown(screen.getByRole("button", { name: "Menu" }), { key: "Escape" });
    await settle();
    expect(companionOpen.get().view).toBe("focus");
    let running = true;
    const stop = vi.fn(() => {
      const was = running;
      running = false;
      return was;
    });
    companionBridge.registerStop(stop);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.keyDown(draft, { key: "Escape" });
    await settle();
    expect(stop).toHaveBeenCalledOnce();
    expect(companionOpen.get().view).toBe("focus");
    fireEvent.keyDown(draft, { key: "Escape" });
    await settle();
    expect(companionOpen.get().view).toBe("docked");
    expect(companionOpen.get().open).toBe(true);
    expect(window.sessionStorage.getItem("course:learner-companion-view")).toBeNull();
    // Composing text with an input method: Escape belongs to it.
    fireEvent.keyDown(draft, { key: "Escape", isComposing: true });
    await settle();
    expect(companionOpen.get().open).toBe(true);
    fireEvent.keyDown(draft, { key: "Escape" });
    await settle();
    expect(companionOpen.get().open).toBe(false);
  });

  it("resizes the panel by writing --panel-w on the host, without rendering the conversation again", () => {
    let renders = 0;
    function Conversation() {
      renders++;
      return <p>Thread</p>;
    }
    act(() => {
      companionOpen.sync({ docked: true, surface: "lesson" });
      companionOpen.setPaneOpen(true);
    });
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1440 });
    try {
      const { container } = render(
        <div className="connected-host">
          <CompanionDock layout={dockLayout(true)}>
            <Conversation />
          </CompanionDock>
        </div>,
      );
      const host = container.querySelector<HTMLElement>(".connected-host")!;
      const splitter = screen.getByRole("separator", { name: "Resize companion" });
      expect(splitter).toHaveAttribute("aria-orientation", "vertical");
      expect(splitter).toHaveAttribute("aria-controls", "connected-learning");
      expect(splitter).toHaveAttribute("aria-valuemin", "360");
      expect(splitter).toHaveAttribute("aria-valuemax", "720");
      expect(host.style.getPropertyValue("--panel-w")).toBe("400px");
      const before = renders;
      fireEvent.keyDown(splitter, { key: "ArrowLeft" });
      expect(host.style.getPropertyValue("--panel-w")).toBe("416px");
      expect(splitter).toHaveAttribute("aria-valuenow", "416");
      fireEvent.keyDown(splitter, { key: "Enter" });
      expect(host.style.getPropertyValue("--panel-w")).toBe("400px");
      fireEvent.keyDown(splitter, { key: "Enter" });
      expect(host.style.getPropertyValue("--panel-w")).toBe("560px");
      expect(window.localStorage.getItem("course:learner-companion-width")).toBe("560");
      fireEvent.keyDown(splitter, { key: "End" });
      expect(splitter).toHaveAttribute("aria-valuenow", "720");
      fireEvent.doubleClick(splitter);
      expect(host.style.getPropertyValue("--panel-w")).toBe("400px");
      expect(window.localStorage.getItem("course:learner-companion-width")).toBeNull();
      expect(renders).toBe(before);
    } finally {
      delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
    }
  });

  it("moves the sheet between Collapsed, Half and Full with the handle, the toggle and the keys", () => {
    act(() => companionOpen.setSheetOpen(true));
    render(
      <CompanionDock layout={dockLayout(false)}>
        <p>Thread</p>
      </CompanionDock>,
    );
    const region = () => screen.getByRole("complementary", { name: "Your companion" });
    expect(region()).toHaveAttribute("data-detent", "half");
    const handle = screen.getByRole("button", { name: "Resize companion" });
    fireEvent.click(handle);
    expect(region()).toHaveAttribute("data-detent", "full");
    // The toggle names the height it goes to.
    fireEvent.click(screen.getByRole("button", { name: "Half height" }));
    expect(region()).toHaveAttribute("data-detent", "half");
    expect(screen.getByRole("button", { name: "Full height" })).toHaveAttribute("data-detent", "full");
    screen.getByRole("button", { name: "Resize companion" }).focus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize companion" }), { key: "ArrowDown" });
    expect(region()).toHaveAttribute("data-detent", "collapsed");
    // The handle went with the header: the focus is on "Show companion", not on the page.
    expect(screen.getByRole("button", { name: "Show companion" })).toHaveFocus();
    // Collapsed: the latest line, or "Companion"; then the dots while a reply is prepared.
    expect(screen.getByText("Companion", { selector: ".cc-shell-collapsed-text" })).toBeVisible();
    act(() => companionBridge.updateActivity({ latest: { text: "Preparing a reply…", busy: true } }));
    expect(screen.getByText("Preparing a reply…")).toBeVisible();
    expect(region().querySelector(".cc-ui-dots")).not.toBeNull();
    // Once text streams the line is that text alone: no dots beside it.
    act(() => companionBridge.updateActivity({ latest: { text: "9 is x + b, so the bias went onto the input", busy: false } }));
    expect(screen.getByText("9 is x + b, so the bias went onto the input")).toBeVisible();
    expect(region().querySelector(".cc-ui-dots")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show companion" }));
    expect(region()).toHaveAttribute("data-detent", "half");
    // Leaving Collapsed, the focus goes to the handle of the header that came back.
    expect(screen.getByRole("button", { name: "Resize companion" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize companion" }), { key: "ArrowUp" });
    expect(region()).toHaveAttribute("data-detent", "full");
    // Closing and opening again starts at Half every time.
    fireEvent.click(screen.getByRole("button", { name: "Close companion" }));
    act(() => companionOpen.open("trigger"));
    expect(region()).toHaveAttribute("data-detent", "half");
  });

  it("opens a short window's sheet at Full, with no Half", () => {
    act(() => companionOpen.setSheetOpen(true));
    render(
      <CompanionDock layout={companionLayout(844, 390)}>
        <p>Thread</p>
      </CompanionDock>,
    );
    act(() => companionOpen.close());
    act(() => companionOpen.open("trigger"));
    const region = screen.getByRole("complementary", { name: "Your companion" });
    expect(region).toHaveAttribute("data-detent", "full");
    expect(screen.queryByRole("button", { name: "Half height" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resize companion" }));
    expect(region).toHaveAttribute("data-detent", "collapsed");
  });
});
