import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Challenge, ServerSnapshot } from "../src/client/apiClient";
import { KindLine } from "../src/connected/credit/KindLine.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";

const question = { id: "q", type: "choice", objectiveIds: [], prompt: "Which?" } as unknown as Challenge["question"];
const challenge = (extra: Partial<Challenge> = {}): Challenge => ({
  challengeId: "check", episodeId: "intro", question, independentEligible: true, mode: "independent", ...extra,
});
const withRecovery = (minutes?: number): ServerSnapshot => ({
  ...connectedSnapshot(),
  ...(minutes === undefined ? {} : { recovery: [{ episodeId: "intro", required: true, freshCheck: { objectiveId: "observe", familyId: "f", plannedMinutes: minutes, additionalEpisodes: 0 } }] }),
});

// The kind line at the top of a check (final design §3.11, §4.1): Counts or Practice, why a
// practice question is practice, and the way back to a check that counts.
describe("the kind line", () => {
  it("says a counted question counts, with the Counts icon and the tested sentence", () => {
    const { container } = render(<KindLine challenge={challenge()} server={withRecovery()} episodeId="intro" onFreshCheck={vi.fn()} />);
    expect(screen.getByTestId("question-kind")).toHaveTextContent(/^Counts toward this lesson\. Answer on your own\.$/);
    expect(container.querySelector('[data-icon="counts"]')).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says why a practice question is practice and offers a fresh check with its minutes", () => {
    const fresh = vi.fn();
    const { container } = render(
      <KindLine challenge={challenge({ independentEligible: false, practiceReason: "companion" })} server={withRecovery(4)} episodeId="intro" onFreshCheck={fresh} />,
    );
    expect(screen.getByTestId("question-kind")).toHaveTextContent(/^Practice\. This question does not count toward finishing the lesson\.$/);
    expect(screen.getByText("Practice.").tagName).toBe("STRONG");
    expect(container.querySelector('[data-icon="practice"]')).not.toBeNull();
    expect(screen.getByText("You asked your companion for help.")).toBeVisible();
    expect(screen.getByText("Want this to count? A fresh check is ready when you are.")).toBeVisible();
    const button = screen.getByRole("button", { name: "Get a fresh check · 4 min" });
    // The arrow points along the line: it mirrors in right-to-left text.
    expect(button.querySelector('[data-icon="arrow-right"]')).toHaveClass("cc-ui-icon-mirror");
    fireEvent.click(button);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("names each recorded reason, and none it does not know", () => {
    const reasons: [Challenge["practiceReason"], string | null][] = [
      ["hint", "You used a hint."], ["solution", "You opened the explanation."], ["seen_before", "You saw this question before."],
      ["fresh_question", null], [null, null], [undefined, null],
    ];
    for (const [practiceReason, line] of reasons) {
      const { container, unmount } = render(<KindLine challenge={challenge({ independentEligible: false, practiceReason })} />);
      expect(container.querySelector(".cc-credit-kind-reason")?.textContent ?? null).toBe(line);
      unmount();
    }
  });

  it("offers a fresh check without minutes when none are known, and none once the lesson is passed or without a way to start one", () => {
    const practice = challenge({ independentEligible: false, practiceReason: "solution" });
    const { unmount } = render(<KindLine challenge={practice} server={withRecovery()} episodeId="intro" onFreshCheck={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Get a fresh check" })).toBeVisible();
    unmount();
    const passed = withRecovery();
    passed.lessons[0]!.gate!.passed = true;
    const second = render(<KindLine challenge={practice} server={passed} episodeId="intro" onFreshCheck={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    second.unmount();
    render(<KindLine challenge={practice} server={withRecovery(4)} episodeId="intro" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads in Hebrew with impersonal forms", () => {
    render(
      <I18nProvider value={createLearnerTranslator("he")}>
        <KindLine challenge={challenge({ independentEligible: false, practiceReason: "companion" })} server={withRecovery(4)} episodeId="intro" onFreshCheck={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("question-kind")).toHaveTextContent("תרגול. השאלה הזו לא נספרת לסיום השיעור.");
    expect(screen.getByText("הייתה פנייה למנחה.")).toBeVisible();
    expect(screen.getByRole("button", { name: /בדיקה חדשה · 4 דק׳/ })).toBeVisible();
  });
});
