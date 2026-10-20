import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  toVisualExperience,
  fromVisualExperience,
  VisualRuntime,
} from "@course-core/visuals/headless";
import { sortingDemo } from "@course-core/visuals/demos";
import {
  EmbeddedInspector,
  type CourseInspectorBridge,
} from "../src/components/EmbeddedInspector";
import { RegradeDialogBody } from "../src/components/RegradeDialog";
import { RunsView } from "../src/views/RunsView";
import { EnrollmentsView } from "../src/views/EnrollmentsView";
import { createFetchAdminClient } from "../src/client/fetchClient";
import {
  RegradeError,
  type RegradePort,
  type RegradeResult,
  type RegradeView,
} from "../src/domain/corrections";
import {
  RunInspectorError,
  type RetryResult,
  type RunInspectorPort,
} from "../src/domain/runInspector";
import type {
  AdminClient,
  CourseWorkspace,
  SupervisorRun,
} from "../src/domain/contracts";
import type { LearnerView } from "../src/domain/learnerView";
import type { WorkspaceActions } from "../src/hooks/useAdmin";

const ENROLLMENT = "5d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f61",
  RUN = "7d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60",
  ATTEMPT = "8d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f62";
const visual = toVisualExperience(sortingDemo);
function learnerView(): LearnerView {
  return {
    readOnly: true,
    view: {
      id: "0b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f61",
      viewedAt: "2026-10-20T10:00:00.000Z",
      viewer: { id: "owner", name: "Owner", role: "owner" },
      visibleToLearner: true,
    },
    learner: { displayName: "Owner" },
    snapshot: {
      enrollmentId: ENROLLMENT,
      revision: 4,
      status: "active",
      profile: { displayName: "Owner" },
      planRevision: 0,
      adaptationRequirements: [],
      lessons: [
        {
          id: "one",
          requirement: "required",
          status: "available",
          completedBlockIds: ["one-text"],
          gate: null,
        },
      ],
      complete: false,
      nextEpisodeId: "one",
      course: {
        title: "Public course",
        summary: "",
        objectives: [{ id: "o1", description: "Compare values." }],
        chapters: [
          {
            id: "c",
            title: "Chapter",
            episodes: [
              {
                id: "one",
                title: "First lesson",
                objectiveIds: ["o1"],
                blocks: [
                  { id: "one-text", type: "text", markdown: "Hello." },
                  { id: "one-visual", type: "visual", visualId: visual.id },
                ],
              },
            ],
          },
        ],
        visuals: [visual],
        media: [],
        sources: [],
      },
      recovery: [],
      inaccessibleEpisodeIds: [],
      closureReport: null,
      activeChallenges: [],
    },
    personalChanges: [],
    reviews: [],
    generatedMedia: [],
    withheld: [],
  } as unknown as LearnerView;
}
const runsPort = (): RunInspectorPort => ({
  revealPayload: vi.fn(),
  replay: vi.fn(),
  enrollmentRuns: vi.fn(async () => ({
    courseId: "4d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60",
    runs: [],
  })),
});
function stubAccess(body: unknown) {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe("inspector framed by the learner app (U01)", () => {
  const search = `?enrollment=${ENROLLMENT}&episode=one&block=one-visual`;

  it("opens nothing, and records nothing, when the server does not authorize the account", async () => {
    const fetch = stubAccess({ available: false, permissions: [] });
    const open = vi.fn();
    render(
      <EmbeddedInspector
        search={search}
        client={
          {
            learnerView: { open },
            runInspector: runsPort(),
          } as unknown as AdminClient
        }
      />,
    );
    expect(
      await screen.findByText(/needs owner or admin access to this enrollment/),
    ).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      `/api/enrollments/${ENROLLMENT}/debug-inspector`,
      expect.objectContaining({ credentials: "include" }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("reads the audited learner view once and shows the current part with the learner app's live visual state", async () => {
    stubAccess({
      available: true,
      role: "owner",
      permissions: ["learner.view", "run.inspect", "run.payload", "made.up"],
      path: "/admin/inspector",
      receipt: "learner.viewed_by_staff",
    });
    const open = vi.fn(async () => learnerView()),
      runs = runsPort();
    const runtime = new VisualRuntime(fromVisualExperience(visual));
    const bridge: CourseInspectorBridge = {
      version: 1,
      visual: vi.fn(() => ({ runtime, experience: visual })),
      close: vi.fn(),
    };
    render(
      <EmbeddedInspector
        search={search}
        bridge={bridge}
        client={
          {
            learnerView: { open },
            runInspector: runs,
            getRun: vi.fn(),
          } as unknown as AdminClient
        }
      />,
    );
    const pane = await screen.findByRole("complementary", {
      name: "Inspected part",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(ENROLLMENT, expect.anything());
    expect(
      screen.getByText(/This open is recorded and the learner can see it/),
    ).toBeVisible();
    expect(
      screen.getByRole("main", { name: "Debug inspector" }),
    ).toContainElement(pane);
    expect(
      within(pane).getByRole("heading", { name: "Part 2: Illustration" }),
    ).toBeVisible();
    // The learner app's own runtime, not a copy: scene, timeline, bindings and hashes.
    expect(bridge.visual).toHaveBeenCalledWith("one", "one-visual");
    const state = within(pane).getByRole("region", { name: "Visual state" });
    expect(
      within(state).getByText(sortingDemo.id, { exact: false }),
    ).toBeVisible();
    expect(
      within(state).getByRole("table", {
        name: "Bindings: state the scene reads",
      }),
    ).toBeVisible();
    // The learner app owns closing: no second close button here, Escape asks it to close.
    expect(
      within(pane).queryByRole("button", { name: "Close the debug inspector" }),
    ).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(bridge.close).toHaveBeenCalled();
    // The lesson's runs come from the same enrollment route as the staff learner view.
    await waitFor(() =>
      expect(runs.enrollmentRuns).toHaveBeenCalledWith(
        ENROLLMENT,
        "one",
        expect.anything(),
      ),
    );
    // Moving to another part does not read (or record) the view again.
    await userEvent.selectOptions(
      screen.getByLabelText("Part of this lesson"),
      "one-text",
    );
    expect(
      within(
        screen.getByRole("complementary", { name: "Inspected part" }),
      ).getByRole("heading", { name: "Part 1: Reading" }),
    ).toBeVisible();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("explains a visual without a live runtime, and refuses a page opened without an enrollment", async () => {
    stubAccess({
      available: true,
      role: "admin",
      permissions: ["learner.view"],
      path: "/admin/inspector",
      receipt: "learner.viewed_by_staff",
    });
    render(
      <EmbeddedInspector
        search={search}
        client={
          {
            learnerView: { open: vi.fn(async () => learnerView()) },
            runInspector: runsPort(),
          } as unknown as AdminClient
        }
      />,
    );
    expect(await screen.findByText(/no live runtime here/)).toBeVisible();
    expect(screen.getByText(/need the run.inspect permission/)).toBeVisible();
  });

  it("refuses a page opened without an enrollment", () => {
    render(
      <EmbeddedInspector search="?episode=one" client={{} as AdminClient} />,
    );
    expect(
      screen.getByText(/Open the debug inspector from a lesson/),
    ).toBeVisible();
  });
});

const failedRun = (over: Partial<SupervisorRun> = {}): SupervisorRun =>
  ({
    id: RUN,
    label: "supervisor run",
    status: "failed",
    startedAt: "2026-10-20T00:00:00.000Z",
    contextVersion: "enrollment-3",
    toolCalls: 0,
    providerAttempts: 1,
    artifactCount: 0,
    summary: "Persisted failed job.",
    events: [],
    context: [],
    decisions: [],
    artifacts: [],
    payload: "withheld",
    retry: { retryOf: null, retriedBy: null },
    ...over,
  }) as SupervisorRun;
const workspace = (permissions: string[]) =>
  ({
    course: { id: "c1" },
    runs: [failedRun()],
    permissions,
  }) as unknown as CourseWorkspace;

describe("scoped retry of one run (U07)", () => {
  it("needs run.retry, takes a reason, sends one idempotency key and reports the queued retry", async () => {
    const result: RetryResult = {
      runId: RUN,
      retryEventId: "9d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f63",
      outcome: "failed",
      previousState: "failed",
      previousReason: "attempts_exhausted",
      state: "queued",
      replayed: false,
    };
    const retry = vi.fn(async () => result);
    const client = {
      getRun: vi.fn(async () => failedRun()),
      runInspector: { ...runsPort(), retry },
    } as unknown as AdminClient;
    const { unmount } = render(
      <RunsView data={workspace(["run.inspect"])} client={client} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(screen.getByText(/needs the run.retry permission/)).toBeVisible();
    unmount();
    render(
      <RunsView
        data={workspace(["run.inspect", "run.retry"])}
        client={client}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const submit = screen.getByRole("button", { name: "Retry as a new run" });
    expect(submit).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Reason for the retry"),
      "Provider outage ended.",
    );
    await userEvent.click(submit);
    await waitFor(() =>
      expect(retry).toHaveBeenCalledWith("c1", RUN, {
        idempotencyKey: expect.stringMatching(/^retry-/),
        reason: "Provider outage ended.",
      }),
    );
    expect(await screen.findByText("Retried")).toBeVisible();
    expect(screen.getByText(result.retryEventId)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry as a new run" }),
    ).toBeNull();
  });

  it("shows the links between a run and its retry, maps refusals, and offers nothing for a run that cannot be retried", async () => {
    const next = "6d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f64";
    const retry = vi.fn(async () => {
      throw new RunInspectorError("RUN_ALREADY_RETRIED");
    });
    const linked = failedRun({
      retry: {
        retryOf: "1d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f65",
        retriedBy: null,
      },
    });
    const { unmount } = render(
      <RunsView
        data={workspace(["run.inspect", "run.retry"])}
        client={
          {
            getRun: vi.fn(async () => linked),
            runInspector: { ...runsPort(), retry },
          } as unknown as AdminClient
        }
      />,
    );
    expect(await screen.findByText("Retry of 1d0e4c2a")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText(/This run is a retry of run/)).toBeVisible();
    await userEvent.type(
      screen.getByLabelText("Reason for the retry"),
      "Second try after a fix.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Retry as a new run" }),
    );
    expect(await screen.findByText(/already retried once/)).toBeVisible();
    unmount();
    const retried = failedRun({
      retry: {
        retryOf: null,
        retriedBy: {
          eventId: "9d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f63",
          runId: next,
          outcome: "failed",
          at: "2026-10-20T00:01:00.000Z",
        },
      },
    });
    const { unmount: done } = render(
      <RunsView
        data={workspace(["run.inspect", "run.retry"])}
        client={
          {
            getRun: vi.fn(async () => retried),
            runInspector: { ...runsPort(), retry },
          } as unknown as AdminClient
        }
      />,
    );
    expect(await screen.findByText("Retried as 6d0e4c2a")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText(next)).toBeVisible();
    expect(screen.queryByLabelText("Reason for the retry")).toBeNull();
    done();
    render(
      <RunsView
        data={workspace(["run.inspect", "run.retry"])}
        client={
          {
            getRun: vi.fn(async () => failedRun({ status: "applied" })),
            runInspector: { ...runsPort(), retry },
          } as unknown as AdminClient
        }
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      screen.getByText(
        /Only a run that failed, or ended with an uncertain provider call/,
      ),
    ).toBeVisible();
  });
});

const automatedView: RegradeView = {
  attemptId: ATTEMPT,
  assessmentId: "min-a",
  kind: "automated",
  current: { kind: "attempt", id: ATTEMPT, passed: false, decision: null },
  history: [],
};
const rubricView: RegradeView = {
  attemptId: ATTEMPT,
  assessmentId: "min-explain",
  kind: "rubric",
  current: {
    kind: "review",
    id: "2d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f66",
    passed: true,
    decision: "met",
  },
  history: [
    {
      regradeId: "3d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f67",
      kind: "rubric",
      outcome: "upheld",
      passed: true,
      previousPassed: true,
      supersedes: {
        kind: "review",
        id: "2d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f66",
      },
      evaluatorRef: "reviewed-rubric-regrade@1",
      reason: "Checked again.",
      actor: "Admin",
      at: "2026-10-19T00:00:00.000Z",
    },
  ],
  rubric: {
    prompt: "Explain the minimum.",
    criteria: [
      { id: "invariant", description: "States the invariant.", required: true },
      { id: "edge", description: "Mentions the empty list.", required: false },
    ],
    answers: ["The kept value is never greater than any element we saw."],
  },
};
const regradeResult = (over: Partial<RegradeResult> = {}): RegradeResult => ({
  regradeId: "4d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f68",
  attemptId: ATTEMPT,
  kind: "automated",
  outcome: "changed",
  passed: true,
  previousPassed: false,
  supersedes: { kind: "attempt", id: ATTEMPT },
  eventId: "5d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f69",
  evidence: { invalidated: 1, created: 1 },
  replayed: false,
  ...over,
});

describe("scoped regrade of one attempt (U07)", () => {
  it("grades an automated attempt again with a reason and reports the linked new decision", async () => {
    const port: RegradePort = {
      view: vi.fn(async () => automatedView),
      submit: vi.fn(async () => regradeResult()),
    };
    const done = vi.fn();
    render(
      <RegradeDialogBody
        port={port}
        enrollmentId={ENROLLMENT}
        attemptId={ATTEMPT}
        onDone={done}
      />,
    );
    expect(
      await screen.findByText(/not passed — the original automated result/),
    ).toBeVisible();
    const submit = screen.getByRole("button", { name: "Grade again" });
    expect(submit).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Reason for the regrade"),
      "Evaluator fixed upstream.",
    );
    await userEvent.click(submit);
    await waitFor(() =>
      expect(port.submit).toHaveBeenCalledWith(ENROLLMENT, ATTEMPT, {
        idempotencyKey: expect.stringMatching(/^regrade-/),
        reason: "Evaluator fixed upstream.",
      }),
    );
    expect(await screen.findByText("Decision changed")).toBeVisible();
    expect(screen.getByText(/Evidence withdrawn: 1; added: 1/)).toBeVisible();
    expect(done).toHaveBeenCalledWith(regradeResult());
  });

  it("takes a second person's quoted findings for a written answer, shows the history and maps refusals", async () => {
    const port: RegradePort = {
      view: vi.fn(async () => rubricView),
      submit: vi.fn(async () => {
        throw new RegradeError("SECOND_REVIEWER_REQUIRED");
      }),
    };
    render(
      <RegradeDialogBody
        port={port}
        enrollmentId={ENROLLMENT}
        attemptId={ATTEMPT}
        onDone={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("table", { name: /Earlier regrades/ }),
    ).toHaveTextContent("Admin");
    expect(
      screen.getByRole("region", { name: "Learner answer 1" }),
    ).toHaveTextContent("never greater");
    // Leaving the required criterion unmet changes the decision.
    expect(screen.getByText("changes the decision")).toBeVisible();
    await userEvent.click(
      screen.getAllByRole("checkbox", { name: "The answer shows this" })[0]!,
    );
    await userEvent.type(
      screen.getByLabelText("Exact quotation from the answer"),
      "never greater than any element",
    );
    expect(screen.getByText("keeps the decision")).toBeVisible();
    await userEvent.type(
      screen.getByLabelText("Reason for the regrade"),
      "A second look on request.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Record the new decision" }),
    );
    await waitFor(() =>
      expect(port.submit).toHaveBeenCalledWith(ENROLLMENT, ATTEMPT, {
        idempotencyKey: expect.any(String),
        reason: "A second look on request.",
        decision: "met",
        criteria: [
          {
            criterionId: "invariant",
            met: true,
            quote: "never greater than any element",
          },
          { criterionId: "edge", met: false },
        ],
      }),
    );
    expect(
      await screen.findByText(/A different person must regrade it/),
    ).toBeVisible();
  });

  it("offers the action only with evidence.regrade on evidence that is still in force", async () => {
    const enrollment = {
      id: ENROLLMENT,
      learnerRef: "u1",
      revision: 3,
      profile: { displayName: "Sam", goal: "", pace: "steady" },
      releaseVersion: "1.0.0",
      status: "active",
      completed: 0,
      required: 2,
      evidence: [
        {
          id: "ev1",
          objective: "Compare values.",
          summary: "Recorded.",
          status: "rejected",
          version: "c",
          rubricVersion: "choice@1",
          receiptId: null,
          attemptId: ATTEMPT,
          regradable: true,
        },
        {
          id: "ev2",
          objective: "Order values.",
          summary: "Recorded.",
          status: "rejected",
          version: "c",
          rubricVersion: "choice@1",
          receiptId: null,
          attemptId: ATTEMPT,
          regradable: false,
        },
      ],
    };
    const data = (permissions: string[]) =>
      ({
        course: { id: "c1" },
        revision: 1,
        permissions,
        enrollments: [enrollment],
      }) as unknown as CourseWorkspace;
    const actions = {
      pending: false,
      clear: vi.fn(),
      resync: vi.fn(),
      run: vi.fn(),
    } as unknown as WorkspaceActions;
    const port: RegradePort = {
      view: vi.fn(async () => automatedView),
      submit: vi.fn(),
    };
    const { unmount } = render(
      <EnrollmentsView
        data={data(["enrollment.read", "evidence.review"])}
        client={{ regrade: port } as unknown as AdminClient}
        actions={actions}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Regrade the attempt/ }),
    ).toBeNull();
    unmount();
    render(
      <EnrollmentsView
        data={data(["enrollment.read", "evidence.regrade"])}
        client={{ regrade: port } as unknown as AdminClient}
        actions={actions}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: /Regrade the attempt/ }),
    ).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Regrade the attempt behind: Compare values.",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Regrade: Compare values." }),
    ).toBeVisible();
    expect(port.view).toHaveBeenCalledWith(
      ENROLLMENT,
      ATTEMPT,
      expect.anything(),
    );
  });

  it("calls the retry and regrade routes", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return Response.json({ error: "ENROLLMENT_CLOSED" }, { status: 409 });
      },
    });
    const refused = await client
      .regrade!.submit(ENROLLMENT, ATTEMPT, {
        idempotencyKey: "regrade-1",
        reason: "A reason here.",
      })
      .catch((e) => e);
    expect(refused).toEqual(new RegradeError("ENROLLMENT_CLOSED"));
    await client.regrade!.view(ENROLLMENT, ATTEMPT).catch(() => undefined);
    await client.runInspector!.retry!("c1", RUN, {
      idempotencyKey: "retry-1",
      reason: "A reason here.",
    }).catch(() => undefined);
    expect(calls).toEqual([
      {
        url: `/api/admin/enrollments/${ENROLLMENT}/attempts/${ATTEMPT}/regrade`,
        method: "POST",
        body: { idempotencyKey: "regrade-1", reason: "A reason here." },
      },
      {
        url: `/api/admin/enrollments/${ENROLLMENT}/attempts/${ATTEMPT}/regrade`,
        method: "GET",
      },
      {
        url: `/api/admin/courses/c1/runs/${RUN}/retry`,
        method: "POST",
        body: { idempotencyKey: "retry-1", reason: "A reason here." },
      },
    ]);
  });
});
