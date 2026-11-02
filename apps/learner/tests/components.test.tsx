import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CourseRoadmap } from "../src/components/CourseRoadmap";
import { LessonFlow } from "../src/components/LessonFlow";
import { Companion } from "../src/components/Companion";
import { ProfileEditor } from "../src/components/ProfileEditor";
import { Badge, Button, ChoiceList, Field, Notice } from "../src/components/ui";
import { Overlay } from "../src/components/Overlay.web";
import { InlineReference } from "../src/components/InlineReference.web";
import { palette } from "../src/theme/palette";
import { demoCourse } from "../src/data/demoCourse";
import { demo } from "./helpers";

describe("reusable learner components", () => {
  it("renders an unrelated supplied title, and shows locked lessons quietly without a way into them", async () => {
    const onOpen = vi.fn();
    render(
      <CourseRoadmap
        course={{
          ...demoCourse,
          id: "unrelated-course",
          title: "A different topic.",
        }}
        snapshot={await demo().load()}
        compact
        onOpenLesson={onOpen}
        onPlacement={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "A different topic." }),
    ).toBeVisible();
    // Open every chapter: a locked lesson is a padlock and its title, not a button.
    for (const toggle of screen.getAllByRole("button", { expanded: false })) await userEvent.click(toggle);
    expect(screen.queryByRole("button", { name: /Compare & swap/ })).toBeNull();
    expect(screen.getAllByText((_, node) => node?.textContent === "Compare & swap, Locked")[0]).toBeVisible();
    // The word "Locked" is said to assistive technology, never printed on every row.
    expect(screen.queryByText("Locked")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("makes future required steps unavailable and labels the optional detour", async () => {
    const lesson = demoCourse.lessons[0]!;
    render(
      <LessonFlow
        lesson={lesson}
        step={lesson.steps[0]!}
        snapshot={await demo().load()}
        compact
        answer=""
        pending={false}
        onAnswer={vi.fn()}
        onStep={vi.fn()}
        onSubmit={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Predict, required step" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Explore, optional step" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Mark read & continue →" }),
    ).toBeEnabled();
  });
  it("validates empty profiles without calling the client", async () => {
    const save = vi.fn();
    render(
      <ProfileEditor
        profile={{ displayName: "", goal: "", pace: "steady" }}
        onSave={save}
        pending={false}
        saved={false}
        demo
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name");
    expect(save).not.toHaveBeenCalled();
  });
  it("tells a connected learner which profile fields course staff see, and says nothing about staff in the demo", () => {
    const props = { profile: { displayName: "Sam", goal: "", pace: "steady" as const }, onSave: vi.fn(), pending: false, saved: false };
    const { unmount } = render(<ProfileEditor {...props} demo={false} />);
    expect(screen.getByText("Course staff who can see your enrollment see your display name, learning goal and pace.")).toBeVisible();
    unmount();
    const identity = render(<ProfileEditor {...props} demo={false} identityOnly />);
    expect(screen.getByText("Course staff who can see your enrollment see your display name.")).toBeVisible();
    identity.unmount();
    render(<ProfileEditor {...props} demo />);
    expect(screen.queryByText(/Course staff/)).toBeNull();
  });
  it("shows a profile saved elsewhere while nothing is edited, so saving never sends the older one", async () => {
    const save = vi.fn();
    const props = { onSave: save, pending: false, saved: false, demo: false };
    const { rerender } = render(<ProfileEditor {...props} profile={{ displayName: "Sam", goal: "", pace: "steady" }} />);
    // The profile was renamed in another tab; the enrollment refresh brings it here.
    rerender(<ProfileEditor {...props} profile={{ displayName: "Sasha", goal: "Sort lists", pace: "focused" }} />);
    expect(screen.getByLabelText("Display name")).toHaveValue("Sasha");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(save).toHaveBeenCalledWith({ displayName: "Sasha", goal: "Sort lists", pace: "focused" });
  });
  it("keeps a name being typed when a newer profile arrives, names it, and saves over it only when kept", async () => {
    const save = vi.fn();
    const props = { onSave: save, pending: false, saved: false, demo: false };
    const { rerender } = render(<ProfileEditor {...props} profile={{ displayName: "Sam", goal: "", pace: "steady" }} />);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Sam B" } });
    rerender(<ProfileEditor {...props} profile={{ displayName: "Sam", goal: "Sort lists", pace: "steady" }} />);
    expect(screen.getByLabelText("Display name")).toHaveValue("Sam B");
    expect(screen.getByText("This was changed elsewhere")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(save).toHaveBeenCalledWith({ displayName: "Sam B", goal: "", pace: "steady" });
  });
  it("supports arrow-key selection and keyboard focus in choice groups", () => {
    const change = vi.fn();
    render(
      <ChoiceList
        label="An example"
        options={[
          { id: "a", label: "First" },
          { id: "b", label: "Second" },
        ]}
        value="a"
        onChange={change}
      />,
    );
    screen.getByRole("radio", { name: "First" }).focus();
    expect(screen.getByRole("radio", { name: "First" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Second" })).not.toBeChecked();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(change).toHaveBeenCalledWith("b");
    expect(screen.getByRole("radio", { name: "Second" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(change).toHaveBeenLastCalledWith("b");
  });
  it("a locked choice takes no focus from a tap or click, and an open one is chosen by it", () => {
    const change = vi.fn();
    const options = [
      { id: "a", label: "First" },
      { id: "b", label: "Second" },
    ];
    const { rerender } = render(<ChoiceList label="An example" options={options} value="" onChange={change} disabled />);
    const second = screen.getByRole("radio", { name: "Second" });
    // fireEvent returns false when the default (moving focus) was prevented.
    expect(fireEvent.mouseDown(second)).toBe(false);
    fireEvent.click(second);
    expect(change).not.toHaveBeenCalled();
    rerender(<ChoiceList label="An example" options={options} value="" onChange={change} />);
    expect(fireEvent.mouseDown(screen.getByRole("radio", { name: "Second" }))).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Second" }));
    expect(change).toHaveBeenCalledWith("b");
  });
  it("traps dialog focus, dismisses with Escape and restores the trigger", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <Overlay title="test panel" onClose={close}>
        <button>Last control</button>
      </Overlay>,
    );
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last control" })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Close test panel" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
  it("closes on Escape even when focus has dropped out of the sheet (a button disabled while it works)", () => {
    const close = vi.fn();
    render(
      <Overlay title="test panel" onClose={close}>
        <button>Inside</button>
      </Overlay>,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    // Text being composed with an input method keeps its Escape.
    fireEvent.keyDown(document.body, { key: "Escape", isComposing: true });
    expect(close).toHaveBeenCalledOnce();
  });
  it("never ends the focus cycle on a hidden field, such as a username kept for password managers", async () => {
    const user = userEvent.setup();
    render(
      <Overlay title="test panel" onClose={() => {}}>
        <button>Last control</button>
        <input name="username" defaultValue="learner" readOnly hidden />
      </Overlay>,
    );
    screen.getByRole("button", { name: "Last control" }).focus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Close test panel" }),
    ).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last control" })).toHaveFocus();
  });
  it("draws a keyboard-focused button, option and field with a 2 px --focus outline, never a shadow alone", async () => {
    const user = userEvent.setup();
    const ring = { outlineStyle: "solid", outlineWidth: "2px", outlineColor: "var(--focus)" };
    for (const [control, find] of [
      [<Button label="Save" onPress={() => {}} />, () => screen.getByRole("button", { name: "Save" })],
      [<ChoiceList label="An example" options={[{ id: "a", label: "First" }]} value="" onChange={() => {}} />, () => screen.getByRole("radio", { name: "First" })],
      [<Field label="Name" />, () => screen.getByRole("textbox", { name: "Name" })],
    ] as const) {
      const { unmount } = render(control);
      await user.tab();
      expect(find()).toHaveFocus();
      expect(find()).toHaveStyle(ring);
      expect(getComputedStyle(find()).boxShadow).toBe("");
      await user.tab();
      expect(find()).not.toHaveFocus();
      expect(find()).not.toHaveStyle({ outlineStyle: "solid" });
      unmount();
    }
  });
  it("takes the base components' colours from the theme tokens", () => {
    render(
      <>
        <Button label="Primary" kind="primary" onPress={() => {}} />
        <Button label="Secondary" onPress={() => {}} />
        <Button label="Off" kind="primary" disabled onPress={() => {}} />
        <Badge label="Suggested" tone="lilac" />
        <Notice tone="warning">Stopped at the time limit.</Notice>
        <InlineReference label="Source" href="https://example.org/a" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Primary" })).toHaveStyle({ backgroundColor: "var(--accent)" });
    expect(screen.getByText("Primary")).toHaveStyle({ color: "var(--on-accent)" });
    // An outline button's edge keeps 3:1 against the page (--line-strong).
    expect(screen.getByRole("button", { name: "Secondary" })).toHaveStyle({ backgroundColor: "var(--surface)", borderColor: "var(--line-strong)" });
    expect(screen.getByRole("button", { name: "Off" })).toHaveStyle({ backgroundColor: "var(--send-off)" });
    expect(screen.getByText("Off")).toHaveStyle({ color: "var(--ink-muted)" });
    // No purple text on a lilac fill: ink on the second surface.
    expect(screen.getByText("Suggested")).toHaveStyle({ color: "var(--ink)" });
    expect(screen.getByText("Suggested").parentElement!).toHaveStyle({ backgroundColor: "var(--surface-2)" });
    expect(screen.getByText("Stopped at the time limit.").parentElement!).toHaveStyle({ backgroundColor: "var(--warning-soft)" });
    expect(screen.getByRole("link", { name: "Source" })).toHaveStyle({ color: "var(--accent)" });
  });
  it("draws the sheet and its backdrop in the theme's page and backdrop colours", () => {
    render(
      <Overlay title="test panel" onClose={() => {}}>
        <p>Inside</p>
      </Overlay>,
    );
    const sheet = screen.getByRole("dialog", { name: "test panel" });
    expect(sheet).toHaveStyle({ background: "var(--page)", color: "var(--ink)" });
    expect(sheet.parentElement!).toHaveStyle({ background: "var(--backdrop)" });
  });
  it("draws a lesson diagram on its dark stage with the dark theme's light colours, in either theme", async () => {
    const lesson = demoCourse.lessons[0]!;
    const step = lesson.steps.find((candidate) => candidate.kind === "reading" && candidate.diagram)!;
    render(
      <LessonFlow
        lesson={lesson}
        step={step}
        snapshot={await demo().load()}
        compact
        answer=""
        pending={false}
        onAnswer={vi.fn()}
        onStep={vi.fn()}
        onSubmit={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    const hex = (value: string) => `rgb(${[1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)).join(", ")})`;
    if (step.kind !== "reading" || !step.diagram) throw new Error("the demo lesson has a diagram");
    expect(screen.getByText(step.diagram.caption)).toHaveStyle({ color: hex(palette.dark.ink) });
    expect(screen.getByText(step.diagram.label)).toHaveStyle({ color: hex(palette.dark.accent) });
  });
});
