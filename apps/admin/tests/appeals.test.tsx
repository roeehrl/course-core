import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewsView } from "../src/views/ReviewsView";
import type { Appeal, ReviewsPort } from "../src/domain/reviews";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

const answer =
  "I keep the smallest value seen so far, so the kept value is never greater than any element.";
const appeal: Appeal = {
  appealId: "00000000-0000-4000-8000-000000000011",
  attemptId: "00000000-0000-4000-8000-000000000012",
  enrollmentId: "00000000-0000-4000-8000-000000000013",
  learner: "Ada",
  reason: "My answer states the invariant.",
  createdAt: "2026-10-14T00:00:00.000Z",
  prompt: "Explain the minimum.",
  response: answer,
  thread: [],
  rubric: [
    { id: "invariant", description: "States the invariant.", required: true },
  ],
  original: {
    decision: "not_met",
    findings: [{ criterionId: "invariant", met: false }],
  },
  canDecide: true,
};
function setup(item: Appeal, locale: "en" | "he" = "en") {
  const port: ReviewsPort = {
    pending: vi.fn(async () => ({ pending: [] })),
    review: vi.fn(),
    appeals: vi.fn(async () => ({ appeals: [item] })),
    decideAppeal: vi.fn(async () => ({})),
  };
  render(
    <I18nProvider value={createAdminTranslator(locale)}>
      <ReviewsView
        data={{ course: { id: "catalog" } } as unknown as CourseWorkspace}
        client={{ reviews: port } as unknown as AdminClient}
      />
    </I18nProvider>,
  );
  return port;
}
describe("second opinions on written answers", () => {
  it("shows the learner's reason and records a changed decision with quoted findings", async () => {
    const port = setup(appeal);
    expect(
      await screen.findByText("My answer states the invariant."),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "The answer shows this" }),
    );
    await userEvent.type(
      screen.getByLabelText("Exact quotation from the answer"),
      "the kept value is never greater than any element",
    );
    expect(screen.getByText(/changes the original/)).toBeVisible();
    await userEvent.type(
      screen.getByLabelText("Message to the learner"),
      "The invariant is stated.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save second opinion" }),
    );
    await waitFor(() => expect(port.decideAppeal).toHaveBeenCalled());
    expect(vi.mocked(port.decideAppeal!).mock.calls[0]![1]).toEqual({
      decision: "met",
      note: "The invariant is stated.",
      criteria: [
        {
          criterionId: "invariant",
          met: true,
          quote: "the kept value is never greater than any element",
        },
      ],
    });
  });
  it("the original reviewer cannot decide", async () => {
    setup({ ...appeal, canDecide: false });
    expect(
      await screen.findByText(
        /A different reviewer must give the second opinion/,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save second opinion" }),
    ).toBeDisabled();
  });
  it("renders a second opinion in Hebrew with the learner's reason isolated", async () => {
    setup(appeal, "he");
    expect(await screen.findByText("במקור: עדיין לא")).toBeVisible();
    expect(screen.getByText(appeal.reason).tagName).toBe("BDI");
    expect(screen.getByText("ההחלטה שלך:", { exact: false })).toHaveTextContent(
      "ההחלטה שלך: עדיין לא (משאירה את ההחלטה המקורית)",
    );
    expect(
      screen.getByRole("button", { name: "שמירת חוות הדעת השנייה" }),
    ).toBeDisabled();
  });
});
