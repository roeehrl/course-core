import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { companionFocus } from "../src/client/companionFocus";
import { PartMenu } from "../src/components/PartMenu.web";
import { VisualBlock } from "../src/components/VisualBlock.web";
import { companionBridge, resetCompanionBridge, type ComposeRequest } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { visualContextFixture } from "./visualContext.fixture";

// "Ask about this part" under an illustration (final design §3.9): the app's own menu, titled
// "Which part?", replaces the native select; choosing a part asks about it.

afterEach(() => {
  window.localStorage.clear();
  resetCompanionBridge();
  companionOpen.reset();
  companionFocus.clear();
});

const parts = [
  { id: "input", label: "Input x" },
  { id: "weight", label: "Weight w" },
  { id: "bias", label: "Bias b" },
];

describe("the illustration's part menu", () => {
  it("opens by keyboard on the checked part, moves with the arrows and closes on Esc", () => {
    const chosen: string[] = [];
    const { rerender } = render(<PartMenu parts={parts} onChoose={(part) => chosen.push(part.id)} />);
    const button = screen.getByRole("button", { name: "Ask about this part" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Which part?" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["Input x", "Weight w", "Bias b"]);
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1]!, { key: "End" });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2]!, { key: "ArrowDown" });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
    expect(chosen).toEqual([]);
    // The part asked about last is checked and takes focus when the menu opens.
    rerender(<PartMenu parts={parts} current="bias" onChoose={(part) => chosen.push(part.id)} />);
    fireEvent.click(button);
    const checked = screen.getByRole("menuitemradio", { name: "Bias b" });
    expect(checked).toHaveAttribute("aria-checked", "true");
    expect(checked.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Input x" })).toHaveAttribute("aria-checked", "false");
    expect(checked).toHaveFocus();
    fireEvent.keyDown(checked, { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Weight w" }), { key: "Enter" });
    expect(chosen).toEqual(["weight"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a click outside closes it without choosing", () => {
    const chosen: string[] = [];
    render(<PartMenu parts={parts} onChoose={(part) => chosen.push(part.id)} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about this part" }));
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chosen).toEqual([]);
  });

  it("speaks Hebrew", () => {
    window.history.replaceState(null, "", "/?locale=he");
    try {
      render(
        <LocaleProvider>
          <PartMenu parts={parts} onChoose={() => {}} />
        </LocaleProvider>,
      );
    } finally {
      window.history.replaceState(null, "", "/");
    }
    fireEvent.click(screen.getByRole("button", { name: "שאלה על החלק הזה" }));
    expect(screen.getByRole("menu", { name: "איזה חלק?" })).toBeVisible();
  });
});

describe("an illustration with labelled parts", () => {
  const experience = () => {
    const visual = visualContextFixture();
    const scene = visual as unknown as { scene?: { nodes: { id: string; label?: string }[] }; nodes?: { id: string; label?: string }[] };
    const nodes = scene.scene?.nodes ?? scene.nodes ?? [];
    nodes[0]!.label = "Meter bar";
    return visual;
  };
  const source = { episodeId: "lesson-one", blockId: "diagram-one", episodeTitle: "Lesson one" };

  it("asks about the chosen part: it is attached, the companion opens, and the menu checks it", () => {
    const requests: ComposeRequest[] = [];
    companionBridge.setAvailable(true);
    companionBridge.onCompose((request) => requests.push(request));
    render(<VisualBlock experience={experience()} source={source} />);
    expect(screen.queryByRole("combobox", { name: /part/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask about this part" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Meter bar" }));
    expect(companionFocus.get().selection).toEqual({ kind: "visual_node", blockId: "diagram-one", nodeId: "meter", label: "Meter bar" });
    expect(requests).toEqual([{ source: "illustration", focus: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Ask about this part" }));
    expect(screen.getByRole("menuitemradio", { name: "Meter bar" })).toHaveAttribute("aria-checked", "true");
    // Sent (or removed in the companion): nothing is checked any more.
    act(() => companionFocus.clear());
    expect(screen.getByRole("menuitemradio", { name: "Meter bar" })).toHaveAttribute("aria-checked", "false");
  });

  it("offers nothing where the companion is not available", () => {
    const { rerender } = render(<VisualBlock experience={experience()} source={source} />);
    expect(screen.queryByRole("button", { name: "Ask about this part" })).toBeNull();
    act(() => companionBridge.setAvailable(true));
    expect(screen.getByRole("button", { name: "Ask about this part" })).toBeVisible();
    rerender(<VisualBlock experience={experience()} source={source} companionAvailable={false} />);
    expect(screen.queryByRole("button", { name: "Ask about this part" })).toBeNull();
  });
});
