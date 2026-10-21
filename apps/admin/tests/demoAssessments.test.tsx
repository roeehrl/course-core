import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createDemoAssessments } from "../src/client/demoAssessments";
import {
  AssessmentAdminError,
  assessmentListSchema,
  fixtureListSchema,
  fixtureResultSchema,
  fixtureRunSchema,
  fixtureRunsSchema,
  keyImpactSchema,
  type AssessmentAdminPort,
} from "../src/domain/assessmentAdmin";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import {
  demoSession,
  demoWorkspace,
  type DemoRole,
} from "../src/data/fixtures";
import { AssessmentsView } from "../src/views/AssessmentsView";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

const session = demoSession("administrator");
const workspaces = (role: DemoRole = "administrator") =>
  new Map(session.courses.map((c) => [c.id, demoWorkspace(c, role)]));
function setup(
  options: {
    role?: DemoRole;
    scenario?: Parameters<typeof createDemoAssessments>[0]["scenario"];
  } = {},
) {
  const courses = workspaces(options.role);
  const port = createDemoAssessments({
    getWorkspace: (id) => {
      const w = courses.get(id);
      if (!w) throw new Error("not found");
      return w;
    },
    scenario: options.scenario,
    latency: 0,
    now: () => "2026-10-21T10:00:00.000Z",
  });
  return { port, workspace: courses.get("sorting")! };
}
// Demo release ids are readable slugs, not UUIDs; the schemas are checked with UUIDs in their place.
const UUID = "00000000-0000-4000-8000-000000000001";
const withUuid = <T extends object>(value: T): T =>
  JSON.parse(
    JSON.stringify(value).replace(/"sorting-(draft|release)"/g, `"${UUID}"`),
  ) as T;
const DRAFT = "sorting-draft",
  PUBLISHED = "sorting-release";
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AssessmentAdminError);
    return (error as AssessmentAdminError).code;
  }
  throw new Error("expected a refusal");
};

describe("demo answer keys", () => {
  it("lists every kind of question, schema-valid, editable only on the draft", async () => {
    const { port } = setup();
    const draft = await port.list("sorting", DRAFT);
    expect(() => assessmentListSchema.parse(withUuid(draft))).not.toThrow();
    expect(new Set(draft.items.map((i) => i.kind))).toEqual(
      new Set(["key", "item_rubric", "course_rubric", "not_editable"]),
    );
    expect(draft.release.editable).toBe(true);
    expect(
      draft.items.find((i) => i.assessmentId === "first-choice")!.fixtures,
    ).toBe(2);
    const published = await port.list("sorting", PUBLISHED);
    expect(published.release.editable).toBe(false);
    expect(published.items.every((i) => !i.editable)).toBe(true);
    const fixtures = await port.fixtures("sorting");
    expect(() => fixtureListSchema.parse(fixtures)).not.toThrow();
    const runs = await port.runs("sorting");
    expect(() => fixtureRunsSchema.parse(withUuid(runs))).not.toThrow();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({ passed: 3, failed: 0, stale: false });
  });

  it("checks a key change against the test answers before saving it", async () => {
    const { port } = setup();
    const draft = await port.list("sorting", DRAFT);
    const wrong = {
      correctOptionId: "seven",
      explanation: "Wrong on purpose.",
    };
    const preview = await port.previewKey(
      "sorting",
      DRAFT,
      "first-choice",
      wrong,
    );
    expect(() => keyImpactSchema.parse(preview)).not.toThrow();
    expect(preview).toMatchObject({ failing: 2, changed: 2 });
    expect(
      await code(
        port.saveKey("sorting", DRAFT, "first-choice", {
          grading: wrong,
          expectedDigest: draft.release.digest,
          acceptFailingFixtures: false,
        }),
      ),
    ).toBe("FIXTURES_FAIL");
    const saved = await port.saveKey("sorting", DRAFT, "first-choice", {
      grading: wrong,
      expectedDigest: draft.release.digest,
      acceptFailingFixtures: true,
    });
    expect(saved.digest).not.toBe(draft.release.digest);
    // The old digest is now stale, and the published release never changes.
    expect(
      await code(
        port.saveKey("sorting", DRAFT, "first-choice", {
          grading: wrong,
          expectedDigest: draft.release.digest,
          acceptFailingFixtures: true,
        }),
      ),
    ).toBe("RELEASE_CHANGED");
    const published = await port.list("sorting", PUBLISHED);
    expect(
      await code(
        port.saveKey("sorting", PUBLISHED, "first-choice", {
          grading: wrong,
          expectedDigest: published.release.digest,
          acceptFailingFixtures: true,
        }),
      ),
    ).toBe("PUBLISHED_RELEASE_IMMUTABLE");
    expect(
      published.items.find((i) => i.assessmentId === "first-choice")!.key,
    ).toMatchObject({ correctOptionId: "two" });
    expect(
      await code(
        port.previewKey("sorting", DRAFT, "first-choice", {
          correctOptionId: "nine",
          explanation: "x",
        }),
      ),
    ).toBe("INVALID_KEY");
    expect(
      await code(port.previewKey("sorting", DRAFT, "repair-loop", {})),
    ).toBe("KEY_NOT_EDITABLE");
  });

  it("adds, refuses and removes test answers, and runs them", async () => {
    const { port } = setup();
    const added = await port.addFixture("sorting", {
      releaseId: DRAFT,
      assessmentId: "trace-passes",
      answer: { "pass-1": "1  3 2", "pass-2": "1 2 3" },
      expected: "correct",
      label: "Extra spaces",
    });
    expect(() => fixtureResultSchema.parse(added)).not.toThrow();
    expect(added).toMatchObject({ outcome: "correct", status: "passed" });
    const numeric = await port.addFixture("sorting", {
      releaseId: DRAFT,
      assessmentId: "count-steps",
      answer: 2,
      expected: "correct",
      label: "",
    });
    expect(numeric.status).toBe("passed");
    for (const [input, expected] of [
      [
        { assessmentId: "first-choice", answer: "nine" },
        "FIXTURE_ANSWER_INVALID",
      ],
      [{ assessmentId: "first-choice", answer: "two" }, "FIXTURE_DUPLICATE"],
      [{ assessmentId: "repair-loop", answer: "x" }, "FIXTURE_NOT_RUNNABLE"],
      [{ assessmentId: "missing", answer: "x" }, "ASSESSMENT_NOT_FOUND"],
    ] as const)
      expect(
        await code(
          port.addFixture("sorting", {
            releaseId: DRAFT,
            expected: "correct",
            label: "",
            ...input,
          }),
        ),
      ).toBe(expected);
    const run = await port.run("sorting", DRAFT);
    expect(() => fixtureRunSchema.parse(run)).not.toThrow();
    expect(run).toMatchObject({ passed: 5, failed: 0, notRunnable: 0 });
    expect((await port.runs("sorting")).runs[0]!.releaseId).toBe(DRAFT);
    await port.removeFixture("sorting", added.fixtureId);
    expect(await code(port.removeFixture("sorting", added.fixtureId))).toBe(
      "FIXTURE_NOT_FOUND",
    );
    expect((await port.fixtures("sorting")).fixtures).toHaveLength(4);
  });

  it("marks a run stale after the release changes, and versions changed course rubrics", async () => {
    const { port } = setup();
    await port.run("sorting", DRAFT);
    const draft = await port.list("sorting", DRAFT);
    const rubric = draft.rubrics[0]!;
    const criteria = [
      ...rubric.criteria,
      { id: "new", description: "Says why.", required: false },
    ];
    expect(
      await code(
        port.saveRubric("sorting", DRAFT, rubric.id, {
          criteria,
          version: rubric.version,
          expectedDigest: draft.release.digest,
        }),
      ),
    ).toBe("RUBRIC_VERSION_REQUIRED");
    await port.saveRubric("sorting", DRAFT, rubric.id, {
      criteria,
      version: "1.1.0",
      expectedDigest: draft.release.digest,
    });
    const after = await port.list("sorting", DRAFT);
    expect(after.rubrics[0]).toMatchObject({ version: "1.1.0" });
    expect((await port.runs("sorting")).runs[0]!.stale).toBe(true);
    // An item rubric is edited in place, without a version.
    await port.saveRubric("sorting", DRAFT, "why-it-works", {
      criteria: [{ id: "only", description: "One rule.", required: true }],
      expectedDigest: after.release.digest,
    });
    expect(
      (await port.list("sorting", DRAFT)).items.find(
        (i) => i.assessmentId === "why-it-works",
      )!.criteria,
    ).toHaveLength(1);
  });

  it("refuses roles without course writing, the denied scenario and failed loads", async () => {
    expect(
      await code(setup({ role: "reviewer" }).port.list("sorting", DRAFT)),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        setup({ scenario: "permission_denied" }).port.fixtures("sorting"),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(setup({ scenario: "load_failure" }).port.runs("sorting")),
    ).toBe("unavailable");
    expect(await code(setup().port.list("sorting", "nope"))).toBe(
      "RELEASE_NOT_FOUND",
    );
  });

  it("renders the answer keys view with every card in English and Hebrew", async () => {
    for (const locale of ["en", "he"] as const) {
      const { port, workspace } = setup();
      const view = render(
        <I18nProvider value={createAdminTranslator(locale)}>
          <AssessmentsView
            data={workspace as CourseWorkspace}
            client={{ assessments: port as AssessmentAdminPort } as AdminClient}
          />
        </I18nProvider>,
      );
      await waitFor(() =>
        expect(
          screen.getByText(
            "Insertion sort on [4, 2, 7]: which value ends up first?",
          ),
        ).toBeTruthy(),
      );
      expect(screen.getByText("· Picks the largest value")).toBeTruthy();
      expect(
        screen.getByText("Explain the idea of this course in your own words."),
      ).toBeTruthy();
      view.unmount();
    }
  });

  it("checks a key through the view", async () => {
    const { port, workspace } = setup();
    render(
      <I18nProvider value={createAdminTranslator("en")}>
        <AssessmentsView
          data={workspace}
          client={{ assessments: port } as AdminClient}
        />
      </I18nProvider>,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /check/i }).length,
      ).toBeGreaterThan(0),
    );
    await user.click(screen.getAllByRole("button", { name: /check/i })[0]!);
    await waitFor(() =>
      expect(screen.queryByText(/could not be done/i)).toBeNull(),
    );
  });
});
