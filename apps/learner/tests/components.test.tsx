import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CourseRoadmap } from "../src/components/CourseRoadmap";
import { LessonFlow } from "../src/components/LessonFlow";
import { Companion } from "../src/components/Companion";
import { ProfileEditor } from "../src/components/ProfileEditor";
import { ChoiceList } from "../src/components/ui";
import { Overlay } from "../src/components/Overlay.web";
import { demoCourse } from "../src/data/demoCourse";
import { demo } from "./helpers";

describe("reusable learner components", () => {
  it("renders an unrelated supplied title, inspects locked lessons without entering them", async () => {
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
    await userEvent.click(
      screen.getByRole("button", { name: /Inspect Compare & swap/ }),
    );
    expect(
      screen.getByRole("button", { name: "Lesson locked" }),
    ).toBeDisabled();
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
  it("keeps notes editable and identifies authored guidance honestly", async () => {
    const change = vi.fn();
    render(
      <Companion
        step={demoCourse.lessons[0]!.steps[0]!}
        lessonTitle="Example"
        note="A note"
        onNoteChange={change}
        mode="demo"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Show a hint ↗" }),
    );
    expect(screen.getByText(/Compare just two neighbors/)).toBeVisible();
    expect(screen.getByText(/No live AI is connected/)).toBeVisible();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Notes to yourself" }),
      { target: { value: "A new note" } },
    );
    expect(change).toHaveBeenCalledWith("A new note");
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
});
