import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CourseVersionOffer } from "../src/components/CourseVersionOffer.web";
import { CourseVersionNotice } from "../src/components/CourseVersionNotice.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";

// Synthetic versions and lesson titles only.
const offer = {
  moveId: "00000000-0000-4000-8000-0000000000cc",
  offeredAt: "2026-10-24T10:00:00.000Z",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  personalChanges: {
    count: 2,
    items: [
      { episodeId: "min", title: "Minimum", kind: "append_teaching" },
      { episodeId: "max", title: "Maximum", kind: "waiting_practice" },
    ],
  },
  keeps: { lessons: 1, checkpointsCarried: 1, checkpointsAgain: 1, removed: 0 },
};

describe("the offer to move to a new course version (learners with personal changes)", () => {
  it("lists the personal changes the move drops, and moves only when the learner accepts", async () => {
    const onDecide = vi.fn(async () => ({ status: "waiting" as const }));
    render(
      <CourseVersionOffer
        server={{ ...connectedSnapshot(), courseVersionOffer: offer }}
        onDecide={onDecide}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Your course has a new version",
    });
    expect(region).toHaveTextContent(
      /Moving keeps your progress where it can, but drops your personal changes: Minimum and Maximum\. Move now\?/,
    );
    expect(region).toHaveTextContent(
      /1 completed lesson stays completed\. You would pass 1 checkpoint again\./,
    );
    expect(region).toHaveTextContent(/archived, not deleted/);
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Move now" }));
    expect(onDecide).toHaveBeenCalledWith(offer.moveId, true);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "You will be moved as soon as you finish what you are doing.",
    );
  });

  it("lets the learner stay, says when it failed, and shows nothing without an offer", async () => {
    const onDecide = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: "declined" });
    const { rerender } = render(
      <CourseVersionOffer
        server={{ ...connectedSnapshot(), courseVersionOffer: offer }}
        onDecide={onDecide}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Stay on this version" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That did not work. Try again in a moment.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Stay on this version" }),
    );
    expect(onDecide).toHaveBeenLastCalledWith(offer.moveId, false);
    // The refreshed snapshot no longer has the offer: the outcome stays visible.
    rerender(
      <CourseVersionOffer
        server={{ ...connectedSnapshot(), courseVersionOffer: null }}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "You stay on this version, with your personal changes.",
    );
    const { container } = render(
      <CourseVersionOffer
        server={{ ...connectedSnapshot(), courseVersionOffer: null }}
        onDecide={onDecide}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says it in Hebrew", () => {
    render(
      <I18nProvider value={createLearnerTranslator("he")}>
        <CourseVersionOffer
          server={{ ...connectedSnapshot(), courseVersionOffer: offer }}
          onDecide={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(
      screen.getByRole("region", { name: "יש גרסה חדשה לקורס שלך" }),
    ).toHaveTextContent(/מבטל את השינויים האישיים שלך/);
    expect(screen.getByRole("button", { name: "לעבור עכשיו" })).toBeVisible();
  });

  it("tells a learner moved by the course team that their personal changes are archived, and which checkpoints carried over", () => {
    const notice = {
      id: "00000000-0000-4000-8000-0000000000dd",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      movedAt: "2026-10-24T10:00:00.000Z",
      carriedCheckpoints: 2,
      personalChanges: "forced" as const,
      personalChangesArchived: 1,
    };
    render(
      <CourseVersionNotice
        server={{ ...connectedSnapshot(), courseVersionNotice: notice }}
      />,
    );
    const status = screen.getByRole("status", {
      name: "Your course was updated",
    });
    expect(status).toHaveTextContent(
      /2 checkpoints you passed were unchanged, so your passes still count\./,
    );
    expect(status).toHaveTextContent(
      /Your course team moved you even though you had personal changes\. Those changes are archived, not deleted/,
    );
  });
});
