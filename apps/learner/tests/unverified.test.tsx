import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { indexUnverified, UnverifiedBadge } from "../src/connected/unverified.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

it("indexes only live, shown, generated changes by block and inserted episode", () => {
  const index = indexUnverified([
    { proposalId: "p1", episodeId: "min", blockId: "b1", kind: "append_teaching", unverified: true },
    { proposalId: "p2", episodeId: "min", blockId: "b2", kind: "append_teaching", unverified: false },
    { proposalId: "p3", episodeId: "min", blockId: "b3", kind: "append_teaching", unverified: true, reverted: true },
    { proposalId: "p4", episodeId: "min", blockId: "b4", kind: "append_teaching", unverified: true, hidden: true },
    { proposalId: "p5", episodeId: "extra", blockId: "op", kind: "insert_episode", unverified: true },
  ]);
  expect([...index.blocks]).toEqual([["min/b1", "p1"]]);
  expect([...index.episodes]).toEqual([["extra", "p5"]]);
});

it("names the pill for assistive technology, explains it in a note and leads to the change", () => {
  const review = vi.fn();
  render(<UnverifiedBadge what="part" onReview={review} />);
  const pill = screen.getByRole("button", { name: "Unverified: this part was written by AI and hasn't been reviewed by a person" });
  expect(pill).toHaveTextContent("Unverified");
  // No warning glyph: the pill carries the info icon only.
  expect(pill.textContent).not.toContain("⚠");
  expect(pill.querySelector('svg[data-icon="info"]')).not.toBeNull();
  expect(pill).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(pill);
  expect(pill).toHaveAttribute("aria-expanded", "true");
  const note = screen.getByRole("dialog", { name: "About this AI-written part" });
  expect(note).toHaveTextContent("Written by AI for you and checked automatically. No person has reviewed it yet. Your checks and progress never depend on it.");
  // The note's first control takes focus (Popover); the link closes it and opens the change.
  const link = screen.getByRole("button", { name: "See this change, hide or undo it" });
  expect(link).toHaveFocus();
  fireEvent.click(link);
  expect(review).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("closes the note on Escape and gives focus back to the pill", () => {
  render(<UnverifiedBadge what="lesson" onReview={vi.fn()} />);
  const pill = screen.getByRole("button", { name: "Unverified: this lesson was written by AI and hasn't been reviewed by a person" });
  fireEvent.click(pill);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "About this AI-written lesson" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pill).toHaveFocus();
});

it("names each kind once, without slashes, in Hebrew", () => {
  const he = createLearnerTranslator("he");
  render(
    <I18nProvider value={he}>
      <UnverifiedBadge what="part" />
      <UnverifiedBadge what="lesson" />
      <UnverifiedBadge what="question" />
    </I18nProvider>,
  );
  const names = screen.getAllByRole("button").map((button) => stripBidiControls(button.getAttribute("aria-label") ?? ""));
  expect(names).toEqual([
    "טרם נבדק: החלק הזה נכתב על ידי AI, ואדם עוד לא עבר עליו",
    "טרם נבדק: השיעור הזה נכתב על ידי AI, ואדם עוד לא עבר עליו",
    "טרם נבדקה: השאלה הזו נכתבה על ידי AI, ואדם עוד לא עבר עליה",
  ]);
  for (const name of names) expect(name).not.toContain("/");
  expect(screen.getAllByText("טרם נבדק")).toHaveLength(3);
});

it("indexes generated questions by item, so a check asking one labels it", () => {
  const index = indexUnverified([
    { proposalId: "p6", episodeId: "min", blockId: "op6", kind: "add_assessment_variant", assessmentId: "artifact-6--item", unverified: true },
    { proposalId: "p7", episodeId: "min", blockId: "op7", kind: "add_assessment_variant", assessmentId: "bank-item", unverified: false },
  ]);
  expect([...index.questions]).toEqual([["artifact-6--item", "p6"]]);
});

it("explains a generated question honestly: its key was checked, no person reviewed it (E06)", () => {
  render(<UnverifiedBadge what="question" />);
  const pill = screen.getByRole("button", { name: "Unverified: this question was written by AI and hasn't been reviewed by a person" });
  fireEvent.click(pill);
  const note = screen.getByRole("dialog", { name: "About this AI-written question" });
  expect(note).toHaveTextContent(
    "Written by AI for you. Its answer was checked automatically, but no person has reviewed it yet. If you think it's marked wrongly, you can dispute it in your learning record.",
  );
  // Without a change to open there is no link.
  expect(screen.queryByRole("button", { name: "See this change, hide or undo it" })).toBeNull();
});
