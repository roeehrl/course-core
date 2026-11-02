import type { Page } from "@playwright/test";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";

/**
 * Route fixtures for the connected content and workflow pages at the size of a real course: 117
 * questions (a dozen of them 20-line lab specifications on one line, with JSON in them), 99 cited
 * sources, 56 objectives in 14 chapters, 30 research topics and 40 supervisor runs whose events
 * carry the server's raw event names and ISO times. All fictional. Use after mockConnectedAdmin.
 */
const COURSE = "**/api/admin/courses/sorting";
const DRAFT = "00000000-0000-4000-8000-0000000000d1";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const iso = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 10, 1, 14, 0) - minutesAgo * 60_000).toISOString();

const LAB_BODY =
  'Implement a standard-library Python function `solve(data)` that returns the specified JSON value. Return it; do not print it. The runner calls solve once per hidden case, and one process may receive several cases, so each call must be independent of previous calls. Numeric outputs must be finite. Object-key order is irrelevant; array order, shape and discrete types (strings, booleans, null) matter. No network, third-party package or file access is available. Input is `{"task":"tiled_matmul","a":A,"b":B,"tile":t,"chunk":c,"bytes_per_value":v,"peak_ops_per_s":P,"bandwidth_bytes_per_s":W}`. Return `{"c":C,"ops":int,"naive_bytes":int,"tiled_bytes":int,"lower_bound_bytes":int,"tiled_intensity":number,"roofline_ops_per_s":number,"bound":string}` where C is the exact integer product A·B. Grading: this chapter lab is graded by hidden reference cases on the server. It is recorded as practical evidence but does not block your progress.';
const LABS = [
  "tiled matrix multiplication simulator",
  "byte-pair tokenizer from scratch",
  "attention score calculator",
  "softmax temperature explorer",
  "KV cache memory estimator",
  "beam search over a toy vocabulary",
  "perplexity from token log-probabilities",
  "LoRA parameter counter",
  "quantization error table",
  "batching throughput model",
  "embedding cosine neighbours",
  "gradient clipping trace",
];
const TOPICS = [
  "parameters inference versus training",
  "tokenization and byte pair encoding",
  "attention as weighted averaging",
  "softmax and temperature",
  "the transformer block",
  "positional encodings",
  "embeddings and similarity",
  "loss functions for language models",
  "gradient descent intuition",
  "overfitting and validation",
  "scaling laws",
  "context windows",
  "KV cache",
  "quantization",
  "fine tuning and LoRA",
  "instruction tuning",
  "RLHF basics",
  "evaluation benchmarks",
  "hallucination",
  "retrieval augmented generation",
  "prompt design",
  "sampling strategies",
  "beam search",
  "latency and throughput",
  "batching",
  "mixture of experts",
  "distillation",
  "safety filters",
  "model cards",
  "licensing of model weights",
];

const STEMS = [
  "A team logs every request to a model and changes",
  "Requests are also logged after a change to",
  "An evaluation script checks a model after a change to",
  "A learner rewrites a notebook cell about",
  "A reviewer compares two runs that differ only in",
];
type Item = Record<string, unknown> & { assessmentId: string };
export function answerKeyItems(): Item[] {
  const items: Item[] = [];
  for (let n = 1; n <= 117; n++) {
    const chapter = Math.ceil(n / 9);
    const id = `fnd-a${String(chapter).padStart(2, "0")}-${String(n).padStart(2, "0")}`;
    const base = {
      objectiveIds: [`obj-${chapter}`],
      familyId: `${id}-family`,
      fixtures: 0,
      editable: true,
    };
    if (
      n % 10 === 0 &&
      items.filter((i) => i.kind === "not_editable").length < 12
    ) {
      const lab = LABS[items.filter((i) => i.kind === "not_editable").length]!;
      items.push({
        ...base,
        assessmentId: `llm-lab-ch${String(chapter).padStart(2, "0")}-${lab.split(" ")[0]}`,
        type: "code_lab",
        prompt: `Chapter ${chapter} lab: ${lab} ${LAB_BODY}`,
        kind: "not_editable",
        editable: false,
      });
    } else if (n % 9 === 0)
      items.push({
        ...base,
        assessmentId: `${id}-explain`,
        type: "short_text",
        prompt: `In two or three sentences, explain why ${TOPICS[n % TOPICS.length]} matters when you deploy a model, using an example from the chapter.`,
        kind: "item_rubric",
        criteria: [
          {
            id: "c1",
            description: "Names the mechanism correctly.",
            required: true,
          },
          {
            id: "c2",
            description: "Gives a concrete example.",
            required: false,
          },
        ],
      });
    else if (n % 7 === 0)
      items.push({
        ...base,
        assessmentId: `${id}-estimate`,
        type: "numeric",
        prompt: `A model has ${n} million parameters stored in 16-bit floats. How many megabytes do the weights take?`,
        kind: "key",
        key: {
          expected: n * 2,
          absoluteTolerance: 0.5,
          unit: "MB",
          explanation: "Two bytes per parameter.",
        },
      });
    else if (n % 11 === 0)
      items.push({
        ...base,
        assessmentId: `${id}-trace`,
        type: "trace",
        prompt: "Trace the softmax of the scores [2, 1, 0] step by step.",
        kind: "key",
        steps: [
          { id: "s1", prompt: "Exponentiate each score" },
          { id: "s2", prompt: "Sum the exponentials" },
          { id: "s3", prompt: "Divide each by the sum" },
        ],
        key: {
          expected: [
            { stepId: "s1", answer: "7.39, 2.72, 1" },
            { stepId: "s2", answer: "11.11" },
            { stepId: "s3", answer: "0.67, 0.24, 0.09" },
          ],
          explanation: "Exponentiate, sum, divide.",
        },
      });
    else
      items.push({
        ...base,
        assessmentId: `${id}-transfer`,
        type: "choice",
        prompt: `${STEMS[n % STEMS.length]} ${TOPICS[n % TOPICS.length]}: array bounds and row sums still pass after the change. Which explanation fits best?`,
        kind: "key",
        options: [
          { id: "a", text: "The change did not affect the computation." },
          { id: "b", text: "The checks are too weak to see the change." },
          { id: "c", text: "The model was retrained in the meantime." },
        ],
        key: {
          correctOptionId: "b",
          explanation: "Shape checks do not test values.",
        },
      });
  }
  return items;
}

/** Stubs the Answer keys endpoints with a 117-question release, its test answers and sources. */
export async function stubAnswerKeys(page: Page) {
  const items = answerKeyItems();
  const fixtures = items
    .filter((i) => i.kind === "key")
    .flatMap((item, index) =>
      Array.from({ length: index % 4 }, (_, k) => ({
        fixtureId: uuid(1000 + index * 10 + k),
        assessmentId: item.assessmentId,
        label: k === 0 ? "A likely mistake" : "",
        answer:
          item.type === "choice"
            ? "a"
            : item.type === "trace"
              ? { s1: "1", s2: "2", s3: "3" }
              : 3,
        expected: k % 2 ? "correct" : "incorrect",
        createdAt: iso(600),
      })),
    );
  const failed = fixtures.slice(0, 5).map((f) => ({
    fixtureId: f.fixtureId,
    assessmentId: f.assessmentId,
    label: f.label,
    expected: f.expected,
    outcome: f.expected === "correct" ? "incorrect" : "correct",
    status: "failed",
  }));
  await page.route(`${COURSE}/releases/*/assessments`, (route) =>
    route.fulfill({
      json: {
        release: {
          id: DRAFT,
          version: "1.1.0",
          status: "draft",
          digest: "d".repeat(64),
          editable: true,
        },
        items,
        rubrics: [
          {
            id: "written-explanations",
            version: "1.0.0",
            title: "Written explanations",
            criteria: [
              {
                id: "w1",
                description: "States the idea in the learner's own words.",
                required: true,
              },
              {
                id: "w2",
                description: "Supports it with an example.",
                required: false,
              },
            ],
            usedBy: items.slice(0, 5).map((i) => i.assessmentId),
          },
        ],
      },
    }),
  );
  await page.route(`${COURSE}/assessment-fixtures`, (route) =>
    route.fulfill({
      json: { fixtures, limits: { perItem: 50, perCourse: 2000 } },
    }),
  );
  await page.route(`${COURSE}/fixture-runs`, (route) =>
    route.fulfill({
      json: {
        runs: [0, 1, 2].map((n) => ({
          runId: uuid(9000 + n),
          releaseId: DRAFT,
          releaseVersion: "1.1.0",
          passed: fixtures.length - 5,
          failed: 5,
          notRunnable: 0,
          stale: n > 0,
          at: iso(60 * (n + 1)),
          by: "Dana Levi",
          ...(n === 0 ? { results: failed } : {}),
        })),
      },
    }),
  );
  await page.route(`${COURSE}/releases/*/sources?*`, (route) => {
    const windowDays = Number(
      new URL(route.request().url()).searchParams.get("windowDays") ?? 365,
    );
    const sources = Array.from({ length: 99 }, (_, n) => {
      const age = (n * 37) % 900;
      const status =
        n % 13 === 0
          ? "undated"
          : age > windowDays
            ? "overdue"
            : age > windowDays - 30
              ? "due_soon"
              : "current";
      return {
        id: `src-${n}`,
        title:
          n % 6 === 0
            ? `Lecture notes ${n} ${(n * 1234567).toString(16).padEnd(64, "a")}`
            : `${TOPICS[n % TOPICS.length]![0]!.toUpperCase()}${TOPICS[n % TOPICS.length]!.slice(1)}: a short reference`,
        url: `https://example.org/notes/${n}`,
        host: "example.org",
        reviewedAt: status === "undated" ? null : "2026-02-03",
        ageDays: status === "undated" ? null : age,
        status,
        citedBy: { blocks: n % 5, episodeIds: [] },
      };
    });
    return route.fulfill({
      json: {
        release: { id: DRAFT, version: "1.1.0", status: "draft" },
        windowDays,
        checkedAt: iso(0),
        summary: {
          total: 99,
          current: sources.filter((s) => s.status === "current").length,
          dueSoon: sources.filter((s) => s.status === "due_soon").length,
          overdue: sources.filter((s) => s.status === "overdue").length,
          undated: sources.filter((s) => s.status === "undated").length,
        },
        sources,
      },
    });
  });
}

const EVENT_TYPES = [
  "session.ended",
  "supervisor.applied",
  "assessment.submitted",
  "episode.completed",
  "companion.requested",
  "enrollment.started",
];
/** Stubs a workspace with 40 supervisor runs and each run's detail as the server sends it. */
export async function stubRuns(page: Page) {
  const session = demoSession("administrator");
  const workspace = {
    ...demoWorkspace(session.courses[0]!, "administrator"),
    role: "owner",
  };
  const roles = ["companion", "supervisor", "research"];
  workspace.runs = Array.from({ length: 40 }, (_, n) => ({
    id: uuid(5000 + n),
    role: roles[n % 3]!,
    status: (["applied", "completed", "failed", "pending_review"] as const)[
      n % 4
    ]!,
    startedAt: iso(n * 17),
    contextVersion: `enrollment-${6 + (n % 4)}`,
    toolCalls: n % 3,
    providerAttempts: 1,
    artifactCount: n % 2,
  }));
  await page.route(COURSE, (route) => route.fulfill({ json: workspace }));
  await page.route(`${COURSE}/runs/*`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const summary =
      workspace.runs.find((r) => r.id === id) ?? workspace.runs[0]!;
    return route.fulfill({
      json: {
        ...summary,
        outcome: {},
        payload: "withheld",
        events: Array.from({ length: 14 }, (_, n) => ({
          id: uuid(7000 + n),
          time: iso(n * 3),
          label: EVENT_TYPES[n % EVENT_TYPES.length],
          status: "recorded",
        })),
        context: [
          {
            id: uuid(42),
            kind: "provider_binding",
            facts: { providerRevision: "3" },
          },
          {
            id: summary.id,
            kind: "tool_receipts",
            facts: { count: 2, more: "no" },
          },
          { id: uuid(43), kind: "enrollment", facts: { revision: 6 } },
        ],
        decisions: [],
        artifacts: [],
        providerCalls: [],
      },
    });
  });
}

/** Stubs placement with the author's 117 questions and 56 objectives over 14 chapters. */
export async function stubPlacement(page: Page) {
  const items = answerKeyItems().filter((i) => i.kind === "key");
  const chapters = Array.from({ length: 14 }, (_, c) => c + 1);
  const objectives = chapters.flatMap((c) =>
    [1, 2, 3, 4].map((k) => ({
      objectiveId: `obj-${c}-${k}`,
      description: `Explain ${TOPICS[(c * 4 + k) % TOPICS.length]} and predict its effect on a small example.`,
    })),
  );
  await page.route(`${COURSE}/placement`, (route) =>
    route.fulfill({
      json: {
        authorLimit: 30,
        authorBounds: {
          maxRuns: 3,
          minCooldownHours: 24,
          minFamiliesPerEpisode: 2,
        },
        author: {
          enabled: true,
          maxItems: 30,
          learnerMayDecline: true,
          protectedEpisodeIds: ["ep-1"],
          assistancePolicy: "unassisted_only",
          // The server cuts each prompt at a fixed length, sometimes inside a word.
          items: Array.from({ length: 117 }, (_, n) => {
            const item = items[n % items.length]!;
            const chapter = Math.floor(n / 9) + 1;
            return {
              assessmentId: `fnd-a${String(chapter).padStart(2, "0")}-${String(n + 1).padStart(2, "0")}-transfer`,
              familyId: `fam-${n}`,
              objectiveIds: [`obj-${Math.min(14, chapter)}-${(n % 4) + 1}`],
              prompt: String(item.prompt).slice(0, 118),
            };
          }),
          objectives,
        },
        blueprint: chapters.map((c) => ({
          episodeId: `ep-${c}`,
          title: `Chapter ${c}: ${TOPICS[c]![0]!.toUpperCase()}${TOPICS[c]!.slice(1)}`,
          status:
            c === 1
              ? "protected_by_author"
              : c % 5 === 0
                ? "not_placeable"
                : "placeable",
          questions: 8,
          families: 3,
          objectives: objectives
            .filter((o) => o.objectiveId.startsWith(`obj-${c}-`))
            .map((o) => ({ ...o, placeable: true })),
        })),
        settings: {
          enabled: true,
          retestCooldownHours: 48,
          maxRuns: 2,
          maxItems: 20,
          minFamiliesPerEpisode: 2,
          excludedAssessmentIds: [],
          excludedObjectiveIds: [],
          protectedEpisodeIds: [],
          revision: 4,
          updatedAt: iso(900),
        },
        effective: {
          enabled: true,
          authorEnabled: true,
          staffEnabled: true,
          maxItems: 20,
          authorMaxItems: 30,
        },
        counters: {
          runs: { finished: 12 },
          exemptions: 31,
          falseSkips: { total: 2, revokedByStaff: 1, laterFailed: 1 },
          unnecessaryRepetitions: 4,
        },
      },
    }),
  );
}

/** Stubs research with 30 topics (raw lower-case queries), a few of them with sources. */
export async function stubResearch(page: Page, { youtube = true } = {}) {
  await page.route("**/api/admin/releases/*/research/library", (route) =>
    route.fulfill({
      json: {
        release: {
          id: "sorting-release",
          version: "1.0.0",
          status: "published",
        },
        topics: TOPICS.map((topic, n) => ({
          id: `topic-${n}`,
          objectiveIds: [`obj-${n}`],
          queryText: `what is a machine learning model ${topic} explained for beginners`,
          allowedDomains: n % 4 === 0 ? ["example.org", "example.com"] : [],
          episodes:
            n % 3 === 0 ? [] : [{ id: `ep-${n}`, title: `Chapter ${n}` }],
        })),
        sources: [0, 4, 9].map((n, k) => ({
          id: uuid(3000 + k),
          topicId: `topic-${n}`,
          kind: "web",
          url: `https://example.org/reading/${n}`,
          fallbackText: null,
          candidateId: null,
          expiresAt: "2027-01-01T00:00:00.000Z",
          createdAt: iso(3000),
          expired: false,
          inspections: [],
          failures: [],
          reviews: [],
        })),
        attachments: [],
        grantsCredit: false,
      },
    }),
  );
  await page.route("**/api/admin/releases/*/research", (route) =>
    route.fulfill({ json: { requests: [] } }),
  );
  await page.route("**/api/admin/workspaces/*/youtube", (route) =>
    route.fulfill({
      json: {
        configured: youtube,
        resetsAt: "2026-11-03T07:00:00.000Z",
        units: { used: 300, limit: 10000 },
        searches: { used: 3, limit: 100 },
        exhaustedByProvider: false,
      },
    }),
  );
}

/** Stubs Answer reviews with every queue empty, as on a course nobody has submitted to yet. */
export async function stubReviews(page: Page) {
  await page.route(`${COURSE}/rubric-reviews`, (route) =>
    route.fulfill({ json: { pending: [] } }),
  );
  await page.route(`${COURSE}/rubric-appeals`, (route) =>
    route.fulfill({ json: { appeals: [] } }),
  );
  await page.route(`${COURSE}/gate-reviews`, (route) =>
    route.fulfill({ json: { reviews: [] } }),
  );
  await page.route(`${COURSE}/evidence-disputes`, (route) =>
    route.fulfill({ json: { disputes: [], truncated: false } }),
  );
}

/** Stubs Studies with one recruiting study and a free release for a new one. */
export async function stubStudies(page: Page) {
  const release = (n: number, version: string) => ({
    id: uuid(6000 + n),
    version,
    status: "published",
    placementEnabled: true,
    items: [],
  });
  await page.route(`${COURSE}/studies`, (route) =>
    route.fulfill({
      json: {
        canManage: true,
        canExport: true,
        releases: [release(1, "1.0.0"), release(2, "1.1.0")],
        studies: [
          {
            id: uuid(6100),
            releaseId: uuid(6001),
            title: "Worked examples first",
            purpose: "We compare a fixed path with the full supervisor.",
            state: "recruiting",
            revision: 2,
            arms: (["fixed", "supervisor"] as const).map((id) => ({
              id,
              label: id === "fixed" ? "Fixed path" : "Full supervisor",
              behaviour: id,
              explanation: "Assigned at random when the learner consents.",
              consented: 6,
              withdrawn: 0,
            })),
            instruments: { pre: [], post: [], transfer: [], delayed: [] },
            minCellSize: 5,
            usabilityMeasures: false,
            usabilityTrials: null,
            seedDigest: "a".repeat(64),
            consent: {
              eligible: 14,
              consented: 12,
              withdrawn: 0,
              undecided: 2,
            },
            createdAt: iso(9000),
            openedAt: iso(8000),
            closedAt: null,
            warnings: [],
          },
        ],
      },
    }),
  );
}
