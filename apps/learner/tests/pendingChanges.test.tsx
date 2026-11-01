import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { LessonPlaceContext, PendingChangesNotice, type LessonPlace, type PendingChange } from "../src/connected/pendingChanges.web";
import { lessonNavigator, resetCompanionBridge } from "../src/connected/companion/bridge";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

const waiting: PendingChange = { pendingId: "w1", episodeId: "min", episodeTitle: "Minimum", kind: "attach_visual", reason: "attempt_in_progress",
  addableNow: false, waitingFor: "attempt_in_progress" };
const ready: PendingChange = { ...waiting, addableNow: true, waitingFor: undefined } as PendingChange;
const blocks = [{ id: "reading", type: "text" }, { id: "check", type: "assessment" }];
const place = (planRevision: number, extra: { id: string; type: string }[] = []): LessonPlace => ({
  planRevision, episodeId: "min", blocks: [...blocks, ...extra], showable: (id) => id === "generated",
});
afterEach(() => resetCompanionBridge());

/** The offer as the lesson shows it: inside the lesson's place, with the host's props. */
function Offer({ items, pending, plan, onAdd = vi.fn(), onDecline = vi.fn() }: {
  items: PendingChange[]; pending: boolean; plan: LessonPlace; onAdd?: (id: string) => void; onDecline?: (id: string) => void;
}) {
  return (
    <LessonPlaceContext.Provider value={plan}>
      <PendingChangesNotice items={items} episodeId="min" pending={pending} onAdd={onAdd} onDecline={onDecline} />
    </LessonPlaceContext.Provider>
  );
}

it("says what the new material is and why it waits, and offers to add it only at a safe point", () => {
  const add = vi.fn(), decline = vi.fn();
  const { rerender } = render(<Offer items={[waiting]} pending={false} plan={place(1)} onAdd={add} onDecline={decline} />);
  const card = screen.getByRole("region", { name: "New for this lesson: an interactive simulation" });
  expect(card).toHaveTextContent("Your companion made it for what you're working on. It goes at the end of this lesson; what you've done stays as it is.");
  expect(card).toHaveTextContent("It'll be added after you finish this question.");
  const addButton = screen.getByRole("button", { name: "Add it to this lesson" });
  expect(addButton).toBeDisabled();
  expect(addButton).toHaveAccessibleDescription("It'll be added after you finish this question.");
  fireEvent.click(screen.getByRole("button", { name: "No thanks" }));
  expect(decline).toHaveBeenCalledWith("w1");
  rerender(<Offer items={[{ ...ready, kind: "add_assessment_variant" }]} pending={false} plan={place(1)} onAdd={add} onDecline={decline} />);
  expect(screen.getByRole("region", { name: "New for this lesson: a practice question" })).not.toHaveTextContent("It'll be added after");
  fireEvent.click(screen.getByRole("button", { name: "Add it to this lesson" }));
  expect(add).toHaveBeenCalledWith("w1");
});

it("prepares an addition, then says it was added and goes to it", async () => {
  const show = vi.spyOn(lessonNavigator, "show");
  const { rerender, container } = render(<Offer items={[ready]} pending={false} plan={place(1)} />);
  fireEvent.click(screen.getByRole("button", { name: "Add it to this lesson" }));
  // The host's request runs: three dots and "Preparing it…" at a fixed height.
  rerender(<Offer items={[ready]} pending plan={place(1)} />);
  const card = screen.getByRole("region", { name: "New for this lesson: an interactive simulation" });
  expect(card).toHaveAttribute("data-state", "preparing");
  expect(card).toHaveTextContent("Preparing it…");
  expect(container.querySelector(".cc-ui-dots")).not.toBeNull();
  // The plan moved and the part is at the end of the lesson; the waiting list no longer has it.
  rerender(<Offer items={[ready]} pending={false} plan={place(2, [{ id: "generated", type: "visual" }])} />);
  await act(async () => rerender(<Offer items={[]} pending={false} plan={place(2, [{ id: "generated", type: "visual" }])} />));
  expect(card).toHaveAttribute("data-state", "added");
  expect(card).toHaveTextContent("Added to the end of this lesson.");
  fireEvent.click(screen.getByRole("button", { name: "Go to it" }));
  expect(show).toHaveBeenCalledWith({ episodeId: "min", blockId: "generated", focus: "block" });
});

it("says when an addition was turned down, or was no longer available", async () => {
  const { rerender } = render(<Offer items={[ready, { ...ready, pendingId: "w2", kind: "append_teaching" }]} pending={false} plan={place(1)} />);
  const [, explanation] = screen.getAllByRole("region");
  fireEvent.click(screen.getAllByRole("button", { name: "No thanks" })[0]!);
  rerender(<Offer items={[ready, { ...ready, pendingId: "w2", kind: "append_teaching" }]} pending plan={place(1)} />);
  await act(async () => rerender(<Offer items={[{ ...ready, pendingId: "w2", kind: "append_teaching" }]} pending={false} plan={place(1)} />));
  expect(screen.getByRole("region", { name: "New for this lesson: an interactive simulation" })).toHaveTextContent("Not added.");
  // Added, but the server found it lapsed: the plan did not move.
  fireEvent.click(screen.getByRole("button", { name: "Add it to this lesson" }));
  rerender(<Offer items={[{ ...ready, pendingId: "w2", kind: "append_teaching" }]} pending plan={place(1)} />);
  await act(async () => rerender(<Offer items={[]} pending={false} plan={place(1)} />));
  expect(explanation).toHaveTextContent("This is no longer available, so nothing was added.");
  expect(screen.queryByRole("button", { name: "Go to it" })).toBeNull();
});

it("offers the addition again when the request did not go through", async () => {
  vi.useFakeTimers();
  try {
    const { rerender } = render(<Offer items={[ready]} pending={false} plan={place(1)} />);
    fireEvent.click(screen.getByRole("button", { name: "Add it to this lesson" }));
    rerender(<Offer items={[ready]} pending plan={place(1)} />);
    rerender(<Offer items={[ready]} pending={false} plan={place(1)} />);
    expect(screen.getByRole("region")).toHaveAttribute("data-state", "preparing");
    await act(async () => vi.advanceTimersByTime(4000));
    expect(screen.getByRole("button", { name: "Add it to this lesson" })).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
});

it("shows nothing for other lessons", () => {
  const { container } = render(<PendingChangesNotice items={[waiting]} episodeId="max" pending={false} onAdd={vi.fn()} onDecline={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

it("says it in Hebrew", () => {
  render(<I18nProvider value={createLearnerTranslator("he")}><Offer items={[waiting]} pending={false} plan={place(1)} /></I18nProvider>);
  const card = screen.getByRole("region", { name: "חדש בשיעור: סימולציה אינטראקטיבית" });
  expect(stripBidiControls(card.textContent ?? "")).toContain("זה יתווסף אחרי שהשאלה הנוכחית תסתיים.");
  expect(screen.getByRole("button", { name: "הוספה לשיעור" })).toBeDisabled();
});
