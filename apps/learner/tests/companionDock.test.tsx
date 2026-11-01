import React from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "react-native";
import { ConnectedCompanion, lessonLabel } from "../src/components/ConnectedCompanion";
import { stripBidiControls } from "@course-core/i18n";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";
import { CompanionDock } from "../src/components/CompanionDock.web";
import { companionOpen } from "../src/connected/companion/openState";
import { companionLayout } from "../src/domain/companionLayout";
import {
  createCompanionClient,
  companionJobLabel,
  companionState,
  companionHasPending,
  companionCanAskAgain,
  companionCouldNotAnswer,
  companionWithheldNote,
  plainExcerpt,
  type CompanionContextUsed,
  applyDraftFrame,
  type CompanionDraft,
  type CompanionContext,
  type CompanionMessage,
  type ContextualCompanionClient,
} from "../src/client/companionClient";
import { createCourseApi } from "../src/client/apiClient";
import { useCompanionConversation } from "../src/hooks/useCompanionConversation";
import { createConnectedDraftStore } from "../src/connected/drafts";
import { connectedSnapshot } from "./connectedFixtures";
import { companionFocus, selectedLines } from "../src/client/companionFocus";
import { pressWhenReady } from "./pressWhenReady";
import { context, message, receipt } from "./companionFixtures";

// Split from companion.test.tsx: the dock (pane beside the lesson or sheet) keeps the draft and focus.

afterEach(() => vi.useRealTimers());
/** A window that docks the companion beside the lesson, or one that shows it as a sheet. */
const dockLayout = (wide: boolean) => (wide ? companionLayout(1440, 960) : companionLayout(390, 844));
describe("persisted companion integration", () => {
  it("keeps the same textarea through responsive changes and traps/restores drawer focus", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();
    companionOpen.reset();
    const renderDock = (wide: boolean, open: boolean) => {
      act(() => {
        companionOpen.sync({ docked: wide, surface: "lesson" });
        companionOpen.setSheetOpen(open);
      });
      return (
        <CompanionDock layout={dockLayout(wide)}>
          <textarea aria-label="Draft" defaultValue="Keep this" />
        </CompanionDock>
      );
    };
    const { rerender } = render(renderDock(false, true));
    const input = screen.getByRole("textbox", { name: "Draft" });
    input.focus();
    (input as HTMLTextAreaElement).setSelectionRange(2, 5);
    rerender(renderDock(true, true));
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe(2);
    rerender(renderDock(false, true));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(companionOpen.get().sheetOpen).toBe(false);
    rerender(renderDock(false, false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    trigger.remove();
  });
  it("collapses the pane beside the lesson without unmounting the draft, and moves it into a sheet when the window narrows", async () => {
    companionOpen.reset();
    const renderDock = (wide: boolean) => (
      <CompanionDock layout={dockLayout(wide)}>
        <textarea aria-label="Draft" defaultValue="Keep this" />
      </CompanionDock>
    );
    act(() => {
      companionOpen.sync({ docked: true, surface: "lesson" });
      companionOpen.setPaneOpen(true);
    });
    const { rerender } = render(renderDock(true));
    const input = screen.getByRole("textbox", { name: "Draft" });
    expect(screen.getByRole("complementary", { name: "Your companion" })).toBeVisible();
    expect(document.querySelector(".connected-companion-trigger")).not.toBeVisible();
    const close = screen.getByRole("button", { name: "Close companion" });
    expect(close).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(close);
    expect(companionOpen.get().paneOpen).toBe(false);
    // Hidden, not removed: the draft keeps its value for when the pane returns.
    expect(screen.getByRole("textbox", { name: "Draft", hidden: true })).toBe(input);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Companion" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    await act(async () => {});
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(companionOpen.get().paneOpen).toBe(true);
    input.focus();
    // Narrowing to a compact window while typing keeps the learner in the companion.
    act(() => companionOpen.sync({ docked: false, surface: "lesson" }));
    rerender(renderDock(false));
    expect(companionOpen.get().sheetOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Your companion" })).toBeVisible();
    expect(input).toHaveFocus();
    // Widening with the sheet open shows the pane even if it had been collapsed.
    act(() => companionOpen.setPaneOpen(false));
    act(() => companionOpen.sync({ docked: true, surface: "lesson" }));
    rerender(renderDock(true));
    expect(companionOpen.get().paneOpen).toBe(true);
  });
  it("closes the sheet with Escape even from a React Native text input, which stops key events bubbling", () => {
    companionOpen.reset();
    act(() => companionOpen.setSheetOpen(true));
    render(
      <CompanionDock layout={dockLayout(false)}>
        <TextInput accessibilityLabel="Message" defaultValue="Keep this" />
      </CompanionDock>,
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(companionOpen.get().sheetOpen).toBe(false);
  });
});
