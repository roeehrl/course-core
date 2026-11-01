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
});
