import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AssessmentsView } from "../src/views/AssessmentsView";
import {
  AssessmentAdminError,
  assessmentErrorMessage,
  type AssessmentAdminPort,
  type AssessmentList,
} from "../src/domain/assessmentAdmin";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

const DRAFT = "00000000-0000-4000-8000-000000000001",
  PUBLISHED = "00000000-0000-4000-8000-000000000002";
const list = (editable: boolean): AssessmentList => ({
  release: {
    id: editable ? DRAFT : PUBLISHED,
    version: editable ? "1.0.1" : "1.0.0",
    status: editable ? "draft" : "published",
    digest: "d".repeat(64),
    editable,
  },
  items: [
    {
      assessmentId: "min-a",
      type: "choice",
      prompt: "Which is smaller?",
      objectiveIds: ["minimum"],
      familyId: "compare",
      fixtures: 1,
      kind: "key",
      editable,
      options: [
        { id: "two", text: "2" },
        { id: "five", text: "5" },
      ],
      key: { correctOptionId: "two", explanation: "2 is below 5." },
    },
    {
      assessmentId: "min-repair",
      type: "code_repair",
      prompt: "Repair solve(values).",
      objectiveIds: ["minimum"],
      familyId: "repair",
      fixtures: 0,
      kind: "not_editable",
      editable: false,
    },
  ],
  rubrics: [],
});
const freshness = (releaseId: string, windowDays: number) => ({
  release: { id: releaseId, version: "1.0.0", status: "published" },
  windowDays,
  checkedAt: "2026-10-21T00:00:00.000Z",
  summary: {
    total: 2,
    current: 1,
    dueSoon: 0,
    overdue: windowDays < 365 ? 1 : 0,
    undated: 0,
  },
  sources: [
    {
      id: "old",
      title: "Old lecture notes",
      url: "https://example.com/old",
      host: "example.com",
      reviewedAt: "2026-02-03",
      ageDays: 260,
      status: windowDays < 365 ? ("overdue" as const) : ("current" as const),
      citedBy: { blocks: 2, episodeIds: ["min"] },
    },
    {
      id: "fresh",
      title: "Recent notes",
      url: "https://example.org/new",
      host: "example.org",
      reviewedAt: "2026-10-01",
      ageDays: 20,
      status: "current" as const,
      citedBy: { blocks: 0, episodeIds: [] },
    },
  ],
});
const fixture = {
  fixtureId: "00000000-0000-4000-8000-000000000003",
  assessmentId: "min-a",
  label: "Picks the larger value",
  answer: "five",
  expected: "incorrect" as const,
  createdAt: "2026-10-21T00:00:00.000Z",
};
function port(
  over: Partial<AssessmentAdminPort> = {},
  editable = true,
): AssessmentAdminPort {
  return {
    list: vi.fn(async () => list(editable)),
    previewKey: vi.fn(async () => ({
      failing: 1,
      changed: 1,
      results: [
        {
          fixtureId: fixture.fixtureId,
          assessmentId: "min-a",
          label: fixture.label,
          expected: "incorrect" as const,
          outcome: "correct" as const,
          status: "failed" as const,
          before: "incorrect" as const,
          changed: true,
        },
      ],
    })),
    saveKey: vi.fn(async () => ({
      failing: 1,
      changed: 1,
      results: [],
      digest: "e".repeat(64),
    })),
    saveRubric: vi.fn(),
    fixtures: vi.fn(async () => ({
      fixtures: [fixture],
      limits: { perItem: 50, perCourse: 2000 },
    })),
    addFixture: vi.fn(async () => ({
      fixtureId: fixture.fixtureId,
      assessmentId: "min-a",
      label: "",
      expected: "correct" as const,
      outcome: "correct" as const,
      status: "passed" as const,
    })),
    removeFixture: vi.fn(async () => ({})),
    run: vi.fn(async () => ({
      runId: fixture.fixtureId,
      passed: 0,
      failed: 1,
      notRunnable: 0,
      results: [
        {
          fixtureId: fixture.fixtureId,
          assessmentId: "min-a",
          label: fixture.label,
          expected: "incorrect" as const,
          outcome: "correct" as const,
          status: "failed" as const,
        },
      ],
    })),
    runs: vi.fn(async () => ({ runs: [] })),
    sources: vi.fn(async (_c: string, releaseId: string, windowDays: number) =>
      freshness(releaseId, windowDays),
    ),
    ...over,
  };
}
const workspace = (permissions = ["course.read", "course.write"]) =>
  ({
    course: { id: "c1" },
    permissions,
    enrollments: [],
    releases: [
      { id: DRAFT, version: "1.0.1", state: "draft" },
      { id: PUBLISHED, version: "1.0.0", state: "published" },
    ],
  }) as unknown as CourseWorkspace;
const show = (
  p: AssessmentAdminPort,
  permissions?: string[],
  locale: "en" | "he" = "en",
) =>
  render(
    <I18nProvider value={createAdminTranslator(locale)}>
      <AssessmentsView
        data={workspace(permissions)}
        client={{ assessments: p } as unknown as AdminClient}
      />
    </I18nProvider>,
  );

describe("answer keys and test answers (Q09)", () => {
  it("checks a key change against the test answers before it can be saved, and asks before saving a failing one", async () => {
    const p = port();
    show(p);
    expect(await screen.findByText("Right answer now:")).toBeVisible();
    expect(screen.getByText("Which is smaller?")).toBeVisible();
    const save = screen.getByRole("button", { name: "Save key to the draft" });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByLabelText("Right answer"),
      "five",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Check against test answers" }),
    );
    await waitFor(() =>
      expect(p.previewKey).toHaveBeenCalledWith("c1", DRAFT, "min-a", {
        correctOptionId: "five",
        explanation: "2 is below 5.",
      }),
    );
    expect(
      await screen.findByText(/1 test answer would be graded the wrong way/),
    ).toBeVisible();
    expect(save).toBeDisabled();
    await userEvent.click(
      screen.getByLabelText(
        /Save anyway: 1 test answer will be graded the wrong way/,
      ),
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(p.saveKey).toHaveBeenCalledWith("c1", DRAFT, "min-a", {
        grading: { correctOptionId: "five", explanation: "2 is below 5." },
        expectedDigest: "d".repeat(64),
        acceptFailingFixtures: true,
      }),
    );
    // Changing the key again needs a new check.
    await userEvent.selectOptions(screen.getByLabelText("Right answer"), "two");
    expect(
      screen.getByRole("button", { name: "Save key to the draft" }),
    ).toBeDisabled();
  });

  it("adds a test answer the question must accept and reports what the current key says", async () => {
    const p = port();
    show(p);
    expect(await screen.findByText("must reject")).toBeVisible();
    expect(screen.getByText(/Picks the larger value/)).toBeVisible();
    await userEvent.click(screen.getByLabelText("must be marked right"));
    await userEvent.click(
      screen.getByRole("button", { name: "Add test answer" }),
    );
    await waitFor(() =>
      expect(p.addFixture).toHaveBeenCalledWith("c1", {
        releaseId: DRAFT,
        assessmentId: "min-a",
        answer: "two",
        expected: "correct",
        label: "",
      }),
    );
    expect(
      await screen.findByText(
        "Added. The current key already grades it as expected.",
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(p.removeFixture).toHaveBeenCalledWith("c1", fixture.fixtureId),
    );
    // Code questions are never run here.
    expect(
      screen.getByText(/An installed evaluator grades this question/),
    ).toBeVisible();
  });

  it("runs every test answer and lists the failures", async () => {
    const p = port();
    show(p);
    await userEvent.click(
      await screen.findByRole("button", { name: "Run all test answers" }),
    );
    expect(await screen.findByText("1 test answer failed")).toBeVisible();
    expect(
      screen.getByText(
        /min-a · Picks the larger value: should be rejected, was graded right/,
      ),
    ).toBeVisible();
  });

  it("keeps a published release read-only, hides keys from roles that cannot edit, and explains refusals", async () => {
    show(port({}, false));
    expect(await screen.findByText(/This release is published/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save key to the draft" }),
    ).toBeNull();
    show(port(), ["course.read"]);
    expect(
      screen.getByText("Only people who can edit the course see answer keys"),
    ).toBeVisible();
    expect(
      assessmentErrorMessage(new AssessmentAdminError("RELEASE_CHANGED")),
    ).toMatch(/Refresh, then make your change again/);
    expect(assessmentErrorMessage(new Error("boom"))).toBe(
      "This could not be done. Nothing changed; try again.",
    );
  });

  it("speaks Hebrew", async () => {
    show(port(), undefined, "he");
    expect(await screen.findByText("התשובה הנכונה עכשיו:")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "הרצת כל תשובות הבדיקה" }),
    ).toBeVisible();
  });
});

describe("source freshness (Q09)", () => {
  it("lists each source with when it was last checked, most urgent first, against a window staff choose", async () => {
    const p = port();
    show(p);
    const list = await screen.findByRole("list", {
      name: "Sources, most urgent first",
    });
    expect(p.sources).toHaveBeenCalledWith("c1", DRAFT, 365, expect.anything());
    expect(list).toHaveTextContent(/Recently checked\s*Old lecture notes/);
    expect(list).toHaveTextContent("Last checked 2026-02-03 (260 days ago)");
    expect(list).toHaveTextContent("cited in 2 lesson parts");
    expect(list).toHaveTextContent("not cited in any lesson text");
    await userEvent.selectOptions(
      screen.getByLabelText("Check again after"),
      "180",
    );
    await waitFor(() =>
      expect(p.sources).toHaveBeenLastCalledWith(
        "c1",
        DRAFT,
        180,
        expect.anything(),
      ),
    );
    expect(
      await screen.findByText(
        "2 sources: 1 need checking now, 0 within a month.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Check now")).toBeVisible();
  });

  it("says when a release cites no sources, and in Hebrew", async () => {
    show(
      port({
        sources: vi.fn(async (_c: string, r: string, w: number) => ({
          ...freshness(r, w),
          summary: { total: 0, current: 0, dueSoon: 0, overdue: 0, undated: 0 },
          sources: [],
        })),
      }),
      undefined,
      "he",
    );
    expect(
      await screen.findByText("הגרסה הזאת לא מצטטת מקורות."),
    ).toBeVisible();
  });
});
