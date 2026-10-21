// i18n-ignore-file: fictional demo questions, answers and rubrics are course content, like src/data/
import {
  AssessmentAdminError,
  type AssessmentAdminPort,
  type AssessmentItem,
  type AssessmentList,
  type Fixture,
  type FixtureResult,
  type FixtureRuns,
} from "../domain/assessmentAdmin";
import type { CourseWorkspace } from "../domain/contracts";

type Outcome = FixtureResult["outcome"];
type Rubric = AssessmentList["rubrics"][number];
type Criterion = NonNullable<AssessmentItem["criteria"]>[number];
type Release = {
  id: string;
  version: string;
  status: string;
  editable: boolean;
  digest: string;
  items: AssessmentItem[];
  rubrics: Rubric[];
};
type StoredRun = FixtureRuns["runs"][number] & { digest: string };

const LIMITS = { perItem: 50, perCourse: 2000 };
const RUNNABLE = new Set(["choice", "numeric", "prediction", "trace"]);

/** A stable 64-character hex digest of a value: enough for the demo's change checks. */
function digestOf(value: unknown): string {
  const text = JSON.stringify(value);
  let out = "";
  for (let seed = 0; out.length < 64; seed++) {
    let hash = 2166136261 ^ seed;
    for (let i = 0; i < text.length; i++)
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

const explanationRubric = (): Rubric => ({
  id: "explain-in-own-words",
  version: "1.0.0",
  title: "Explains the idea in their own words",
  criteria: [
    {
      id: "names-idea",
      description: "Names the idea the question is about.",
      required: true,
    },
    {
      id: "uses-example",
      description: "Uses a small example to show it.",
      required: false,
    },
  ],
  usedBy: ["explain-own-words"],
});

/** Public fictional questions for the demo courses: one of each kind the view shows. */
function demoItems(courseId: string): AssessmentItem[] {
  const graphs = courseId === "graphs";
  return [
    {
      assessmentId: "first-choice",
      type: "choice",
      prompt: graphs
        ? "Which node can you reach from A in one step: A–B, B–C?"
        : "Insertion sort on [4, 2, 7]: which value ends up first?",
      objectiveIds: ["predict-example"],
      familyId: "predict",
      fixtures: 0,
      kind: "key",
      editable: true,
      options: graphs
        ? [
            { id: "b", text: "B" },
            { id: "c", text: "C" },
          ]
        : [
            { id: "two", text: "2" },
            { id: "four", text: "4" },
            { id: "seven", text: "7" },
          ],
      key: graphs
        ? {
            correctOptionId: "b",
            explanation: "Only the edge A–B starts at A.",
          }
        : {
            correctOptionId: "two",
            explanation: "2 is the smallest value, so it moves to the front.",
          },
    },
    {
      assessmentId: "count-steps",
      type: "numeric",
      prompt: graphs
        ? "How many edges does the shortest path from A to C use?"
        : "How many swaps does insertion sort make on [3, 1, 2]?",
      objectiveIds: ["predict-example"],
      familyId: "count",
      fixtures: 0,
      kind: "key",
      editable: true,
      key: {
        expected: 2,
        absoluteTolerance: 0,
        explanation: graphs ? "A to B, then B to C." : "1 moves twice; 2 once.",
      },
    },
    {
      assessmentId: "trace-passes",
      type: "trace",
      prompt: graphs
        ? "Write the order a breadth-first search visits A–B, A–C."
        : "Trace insertion sort on [3, 1, 2] after each pass.",
      objectiveIds: ["core-idea"],
      familyId: "trace",
      fixtures: 0,
      kind: "key",
      editable: true,
      steps: [
        { id: "pass-1", prompt: graphs ? "First visited" : "After pass 1" },
        { id: "pass-2", prompt: graphs ? "Then" : "After pass 2" },
      ],
      key: {
        expected: graphs
          ? [
              { stepId: "pass-1", answer: "A" },
              { stepId: "pass-2", answer: "B C" },
            ]
          : [
              { stepId: "pass-1", answer: "1 3 2" },
              { stepId: "pass-2", answer: "1 2 3" },
            ],
        match: "normalized_whitespace",
        explanation: "Each pass places one more value.",
      },
    },
    {
      assessmentId: "why-it-works",
      type: "short_text",
      prompt: graphs
        ? "Why does breadth-first search find the shortest path in edges?"
        : "Why does insertion sort keep equal values in order?",
      objectiveIds: ["explain-result"],
      familyId: "explain",
      fixtures: 0,
      kind: "item_rubric",
      editable: true,
      criteria: [
        {
          id: "states-rule",
          description: "States the rule that makes it work.",
          required: true,
        },
        {
          id: "gives-case",
          description: "Gives one case where it matters.",
          required: false,
        },
      ],
    },
    {
      assessmentId: "explain-own-words",
      type: "short_text",
      prompt: "Explain the idea of this course in your own words.",
      objectiveIds: ["explain-result"],
      familyId: "explain",
      fixtures: 0,
      kind: "course_rubric",
      editable: true,
      rubricId: "explain-in-own-words",
    },
    {
      assessmentId: "repair-loop",
      type: "code_repair",
      prompt: graphs
        ? "Repair neighbours(graph, node) so it returns every neighbour."
        : "Repair insertion_sort(values) so the last value is sorted too.",
      objectiveIds: ["core-idea"],
      familyId: "repair",
      fixtures: 0,
      kind: "not_editable",
      editable: false,
    },
  ];
}

const normalize = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
const numberOf = (answer: unknown) => {
  const value =
    typeof answer === "object" && answer !== null && "value" in answer
      ? (answer as { value: unknown }).value
      : answer;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};
const unitOf = (answer: unknown) =>
  typeof answer === "object" && answer !== null && "unit" in answer
    ? String((answer as { unit: unknown }).unit)
    : undefined;

/** Whether an answer fits the question at all (an option it has, a number, every step). */
function answerFits(item: AssessmentItem, answer: unknown): boolean {
  if (item.type === "choice")
    return (
      typeof answer === "string" &&
      (item.options ?? []).some((o) => o.id === answer)
    );
  if (item.type === "numeric" || item.type === "prediction")
    return numberOf(answer) !== undefined;
  if (item.type === "trace")
    return (
      typeof answer === "object" &&
      answer !== null &&
      (item.steps ?? []).every(
        (s) => typeof (answer as Record<string, unknown>)[s.id] === "string",
      )
    );
  return false;
}

/** Grades one answer with a key, the way the server's deterministic graders do. */
function grade(
  item: AssessmentItem | undefined,
  key: Record<string, unknown> | undefined,
  answer: unknown,
): Outcome {
  if (!item) return "item_missing";
  if (!RUNNABLE.has(item.type) || !key) return "not_runnable";
  if (!answerFits(item, answer)) return "invalid_answer";
  if (item.type === "choice")
    return answer === key.correctOptionId ? "correct" : "incorrect";
  if (item.type === "trace") {
    const expected = (key.expected ?? []) as {
      stepId: string;
      answer: string;
    }[];
    const given = answer as Record<string, string>;
    return expected.every(
      (s) => normalize(given[s.stepId]) === normalize(s.answer),
    )
      ? "correct"
      : "incorrect";
  }
  const value = numberOf(answer)!;
  const unit = unitOf(answer);
  if (key.unit !== undefined && unit !== undefined && unit !== key.unit)
    return "incorrect";
  const tolerance = Number(key.absoluteTolerance ?? 0);
  return Math.abs(value - Number(key.expected)) <= tolerance
    ? "correct"
    : "incorrect";
}

/** A test answer passes when the grade matches what it expects; an unfit answer counts as wrong. */
function statusOf(
  expected: Fixture["expected"],
  outcome: Outcome,
): FixtureResult["status"] {
  if (outcome === "not_runnable" || outcome === "item_missing")
    return "not_runnable";
  const correct = outcome === "correct";
  return correct === (expected === "correct") ? "passed" : "failed";
}

/** Checks a new key's shape the way the server does (INVALID_KEY otherwise). */
function validKey(item: AssessmentItem, grading: unknown): boolean {
  if (typeof grading !== "object" || grading === null) return false;
  const key = grading as Record<string, unknown>;
  if (typeof key.explanation !== "string" || !key.explanation.trim())
    return false;
  if (item.type === "choice")
    return (item.options ?? []).some((o) => o.id === key.correctOptionId);
  if (item.type === "trace")
    return (
      Array.isArray(key.expected) &&
      (item.steps ?? []).every((s) =>
        (key.expected as { stepId: string; answer: unknown }[]).some(
          (e) =>
            e.stepId === s.id &&
            typeof e.answer === "string" &&
            e.answer.trim() !== "",
        ),
      )
    );
  return (
    typeof key.expected === "number" &&
    Number.isFinite(key.expected) &&
    typeof key.absoluteTolerance === "number" &&
    key.absoluteTolerance >= 0
  );
}

/**
 * The demo's answer keys, rubrics and test answers: in memory, per page load. Keys change only
 * on a course's draft release; test answers belong to the course and run against any release.
 */
export function createDemoAssessments({
  getWorkspace,
  scenario = "standard",
  latency = 140,
  actorName = "Demo operator",
  now = () => new Date().toISOString(),
}: {
  /** The demo workspace of a course id; throws when there is none. */
  getWorkspace: (courseId: string) => CourseWorkspace;
  scenario?:
    "standard" | "permission_denied" | "stale_revision" | "load_failure";
  latency?: number;
  /** Who the run history says ran the checks. */
  actorName?: string;
  now?: () => string;
}): AssessmentAdminPort {
  const courses = new Map<
    string,
    { releases: Map<string, Release>; fixtures: Fixture[]; runs: StoredRun[] }
  >();
  let sequence = 0;
  const uuid = () =>
    `00000000-0000-4000-8000-${String(0xa55000 + ++sequence).padStart(12, "0")}`;
  const clone = <T>(value: T): T => structuredClone(value);

  async function delay(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!latency) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, latency);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  function course(catalogId: string) {
    let workspace: CourseWorkspace;
    try {
      workspace = getWorkspace(catalogId);
    } catch {
      throw new AssessmentAdminError("RELEASE_NOT_FOUND");
    }
    if (
      scenario === "permission_denied" ||
      !workspace.permissions.includes("course.write")
    )
      throw new AssessmentAdminError("FORBIDDEN");
    let state = courses.get(catalogId);
    if (!state) {
      const releases = new Map<string, Release>();
      for (const release of workspace.releases) {
        const editable = release.state === "draft";
        const items = demoItems(catalogId).map((item) => ({
          ...item,
          editable: item.kind !== "not_editable" && editable,
        }));
        const rubrics = [explanationRubric()];
        releases.set(release.id, {
          id: release.id,
          version: release.version,
          status: release.state,
          editable,
          digest: digestOf([release.id, items, rubrics]),
          items,
          rubrics,
        });
      }
      const first = demoItems(catalogId)[0]!;
      const fixtures: Fixture[] = [
        {
          fixtureId: uuid(),
          assessmentId: first.assessmentId,
          label: "The right option",
          answer: first.key!.correctOptionId,
          expected: "correct",
          createdAt: "2026-10-12T09:00:00Z",
          createdBy: actorName,
        },
        {
          fixtureId: uuid(),
          assessmentId: first.assessmentId,
          label: "Picks the largest value",
          answer: first.options!.at(-1)!.id,
          expected: "incorrect",
          createdAt: "2026-10-12T09:01:00Z",
          createdBy: actorName,
        },
        {
          fixtureId: uuid(),
          assessmentId: "count-steps",
          label: "Off by one",
          answer: 3,
          expected: "incorrect",
          createdAt: "2026-10-12T09:02:00Z",
          createdBy: actorName,
        },
      ];
      state = { releases, fixtures, runs: [] };
      courses.set(catalogId, state);
      const published = [...releases.values()].find((r) => !r.editable);
      if (published) {
        const results = gradeAll(state.fixtures, published);
        state.runs.push({
          ...counts(results),
          runId: uuid(),
          releaseId: published.id,
          releaseVersion: published.version,
          stale: false,
          at: "2026-10-12T09:05:00Z",
          by: actorName,
          results,
          digest: published.digest,
        });
      }
    }
    return state;
  }
  async function read(catalogId: string, signal?: AbortSignal) {
    await delay(signal);
    if (scenario === "load_failure")
      throw new AssessmentAdminError("unavailable");
    return course(catalogId);
  }
  function release(
    state: ReturnType<typeof course>,
    releaseId: string,
  ): Release {
    const found = state.releases.get(releaseId);
    if (!found) throw new AssessmentAdminError("RELEASE_NOT_FOUND");
    return found;
  }
  function item(target: Release, assessmentId: string) {
    const found = target.items.find((i) => i.assessmentId === assessmentId);
    if (!found) throw new AssessmentAdminError("ASSESSMENT_NOT_FOUND");
    return found;
  }
  function result(
    fixture: Fixture,
    target: Release,
    key?: Record<string, unknown>,
  ): FixtureResult {
    const question = target.items.find(
      (i) => i.assessmentId === fixture.assessmentId,
    );
    const outcome = grade(question, key ?? question?.key, fixture.answer);
    return {
      fixtureId: fixture.fixtureId,
      assessmentId: fixture.assessmentId,
      label: fixture.label,
      expected: fixture.expected,
      outcome,
      status: statusOf(fixture.expected, outcome),
    };
  }
  function gradeAll(fixtures: Fixture[], target: Release) {
    return fixtures.map((f) => result(f, target));
  }
  function counts(results: FixtureResult[]) {
    return {
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      notRunnable: results.filter((r) => r.status === "not_runnable").length,
    };
  }
  function impact(
    state: ReturnType<typeof course>,
    target: Release,
    question: AssessmentItem,
    grading: unknown,
  ) {
    if (question.kind !== "key")
      throw new AssessmentAdminError("KEY_NOT_EDITABLE");
    if (!validKey(question, grading))
      throw new AssessmentAdminError("INVALID_KEY");
    const results = state.fixtures
      .filter((f) => f.assessmentId === question.assessmentId)
      .map((f) => {
        const before = result(f, target).outcome;
        const after = result(f, target, grading as Record<string, unknown>);
        return { ...after, before, changed: before !== after.outcome };
      });
    return {
      results,
      failing: results.filter((r) => r.status === "failed").length,
      changed: results.filter((r) => r.changed).length,
    };
  }
  function editable(target: Release, expectedDigest: string) {
    if (!target.editable)
      throw new AssessmentAdminError("PUBLISHED_RELEASE_IMMUTABLE");
    if (target.digest !== expectedDigest)
      throw new AssessmentAdminError("RELEASE_CHANGED");
  }
  const redigest = (target: Release) =>
    (target.digest = digestOf([target.id, target.items, target.rubrics]));

  return {
    async list(catalogId, releaseId, signal) {
      const state = await read(catalogId, signal);
      const target = release(state, releaseId);
      return clone({
        release: {
          id: target.id,
          version: target.version,
          status: target.status,
          digest: target.digest,
          editable: target.editable,
        },
        items: target.items.map((i) => ({
          ...i,
          fixtures: state.fixtures.filter(
            (f) => f.assessmentId === i.assessmentId,
          ).length,
        })),
        rubrics: target.rubrics,
      });
    },
    async previewKey(catalogId, releaseId, assessmentId, grading) {
      const state = await read(catalogId);
      const target = release(state, releaseId);
      return clone(impact(state, target, item(target, assessmentId), grading));
    },
    async saveKey(catalogId, releaseId, assessmentId, input) {
      await delay();
      const state = course(catalogId);
      const target = release(state, releaseId);
      const question = item(target, assessmentId);
      editable(target, input.expectedDigest);
      const checked = impact(state, target, question, input.grading);
      if (checked.failing > 0 && !input.acceptFailingFixtures)
        throw new AssessmentAdminError("FIXTURES_FAIL");
      question.key = clone(input.grading as Record<string, unknown>);
      return clone({ ...checked, digest: redigest(target) });
    },
    async saveRubric(catalogId, releaseId, rubricId, input) {
      await delay();
      const state = course(catalogId);
      const target = release(state, releaseId);
      editable(target, input.expectedDigest);
      if (
        input.criteria.length < 1 ||
        input.criteria.length > 12 ||
        input.criteria.some(
          (c) =>
            !c.id.trim() ||
            !c.description.trim() ||
            c.description.length > 2000,
        )
      )
        throw new AssessmentAdminError("INVALID_REQUEST");
      const criteria: Criterion[] = input.criteria.map((c) => ({ ...c }));
      const rubric = target.rubrics.find((r) => r.id === rubricId);
      if (rubric) {
        const changed =
          JSON.stringify(rubric.criteria) !== JSON.stringify(criteria);
        // A published version never changes meaning: changed criteria need a new version.
        if (changed && (!input.version || input.version === rubric.version))
          throw new AssessmentAdminError("RUBRIC_VERSION_REQUIRED");
        rubric.criteria = criteria;
        if (input.version) rubric.version = input.version;
      } else {
        const question = target.items.find(
          (i) => i.assessmentId === rubricId && i.kind === "item_rubric",
        );
        if (!question) throw new AssessmentAdminError("RUBRIC_NOT_FOUND");
        question.criteria = criteria;
      }
      return { digest: redigest(target) };
    },
    async fixtures(catalogId, signal) {
      const state = await read(catalogId, signal);
      return clone({ fixtures: state.fixtures, limits: LIMITS });
    },
    async addFixture(catalogId, input) {
      await delay();
      const state = course(catalogId);
      const target = release(state, input.releaseId);
      const question = item(target, input.assessmentId);
      if (!RUNNABLE.has(question.type))
        throw new AssessmentAdminError("FIXTURE_NOT_RUNNABLE");
      if (
        input.label.length > 200 ||
        !["correct", "incorrect"].includes(input.expected)
      )
        throw new AssessmentAdminError("INVALID_REQUEST");
      if (!answerFits(question, input.answer))
        throw new AssessmentAdminError("FIXTURE_ANSWER_INVALID");
      const same = state.fixtures.filter(
        (f) => f.assessmentId === input.assessmentId,
      );
      if (
        same.some(
          (f) => JSON.stringify(f.answer) === JSON.stringify(input.answer),
        )
      )
        throw new AssessmentAdminError("FIXTURE_DUPLICATE");
      if (
        same.length >= LIMITS.perItem ||
        state.fixtures.length >= LIMITS.perCourse
      )
        throw new AssessmentAdminError("FIXTURE_LIMIT");
      const fixture: Fixture = {
        fixtureId: uuid(),
        assessmentId: input.assessmentId,
        label: input.label.trim(),
        answer: clone(input.answer),
        expected: input.expected,
        createdAt: now(),
        createdBy: actorName,
      };
      state.fixtures.push(fixture);
      return clone(result(fixture, target));
    },
    async removeFixture(catalogId, fixtureId) {
      await delay();
      const state = course(catalogId);
      const index = state.fixtures.findIndex((f) => f.fixtureId === fixtureId);
      if (index < 0) throw new AssessmentAdminError("FIXTURE_NOT_FOUND");
      state.fixtures.splice(index, 1);
      return { removed: fixtureId };
    },
    async run(catalogId, releaseId) {
      await delay();
      const state = course(catalogId);
      const target = release(state, releaseId);
      const results = gradeAll(state.fixtures, target);
      const run: StoredRun = {
        ...counts(results),
        runId: uuid(),
        releaseId: target.id,
        releaseVersion: target.version,
        stale: false,
        at: now(),
        by: actorName,
        results,
        digest: target.digest,
      };
      state.runs = [run, ...state.runs].slice(0, 20);
      const { runId, passed, failed, notRunnable } = run;
      return clone({ runId, passed, failed, notRunnable, results });
    },
    async runs(catalogId, signal) {
      const state = await read(catalogId, signal);
      // A run is stale once its release's keys or rubrics changed after it.
      return clone({
        runs: state.runs.map(({ digest, ...run }) => ({
          ...run,
          stale: state.releases.get(run.releaseId)?.digest !== digest,
        })),
      });
    },
  };
}
