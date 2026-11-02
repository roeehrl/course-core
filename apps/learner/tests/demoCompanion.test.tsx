import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

// Split from components.test.tsx: the demo companion's notes and authored guidance.

describe("reusable learner components", () => {
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
    // The connected companion's parts (the real panel gives it its header): one line that no AI is
    // connected, the guidance as a companion turn under its label line, and no avatar tile or idea
    // bubble.
    expect(screen.getAllByText("Demo · authored guidance. No live AI is connected.")).toHaveLength(1);
    const turn = screen.getByRole("article", { name: "Companion said" });
    expect(within(turn).getByText(demoCourse.lessons[0]!.steps[0]!.companion.idea)).toBeVisible();
    expect(screen.queryByText("✧")).toBeNull();
    // "Show a hint" is a chip that shows the authored hint in place.
    const chip = screen.getByRole("button", { name: "Show a hint" });
    expect(chip).toHaveClass("cc-ui-chip");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(chip);
    expect(screen.getByText(/Compare just two neighbors/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide hint" })).toHaveAttribute("aria-expanded", "true");
    // Notes: the long-answer composer, described by where they are kept.
    const notes = screen.getByRole("textbox", { name: "Notes to yourself" });
    expect(notes).toHaveAttribute("placeholder", "A question, an idea, something to revisit…");
    expect(notes).toHaveAccessibleDescription(/Saved on this device\./);
    fireEvent.change(notes, { target: { value: "A new note" } });
    expect(change).toHaveBeenCalledWith("A new note");
  });

  it("saves the note with Cmd/Ctrl+Enter and the button, and says so", async () => {
    const change = vi.fn();
    render(<Companion note="Look for neighbors." onNoteChange={change} mode="demo" />);
    // On the roadmap there is no step: the course's own guidance, and no hint.
    expect(screen.getByText(/One clear path, at your pace/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show a hint" })).toBeNull();
    const notes = screen.getByRole("textbox", { name: "Notes to yourself" });
    // The key saves, and its hint says so (§4.19), not "submit".
    expect(notes).toHaveAccessibleDescription(/Enter to save/);
    expect(notes).not.toHaveAccessibleDescription(/submit/);
    notes.focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(change).toHaveBeenLastCalledWith("Look for neighbors.");
    expect(screen.getByRole("status")).toHaveTextContent("Saved on this device.");
    change.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(change).toHaveBeenCalledWith("Look for neighbors.");
  });

  it("in Hebrew", () => {
    render(
      <I18nProvider value={createLearnerTranslator("he")}>
        <Companion step={demoCourse.lessons[0]!.steps[0]!} lessonTitle="Example" note="" onNoteChange={() => {}} mode="demo" />
      </I18nProvider>,
    );
    expect(screen.getByText("הדגמה · הנחיות כתובות. אין חיבור ל־AI.")).toBeVisible();
    expect(screen.getByRole("button", { name: "הצגת רמז" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "הערות אישיות" })).toHaveAttribute("placeholder", "שאלה, רעיון, משהו לחזור אליו…");
    expect(screen.getByText("נשמר במכשיר הזה.")).toBeVisible();
  });
});
