import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  toVisualExperience,
  VisualRuntime,
} from "@course-core/visuals/headless";
import { sortingDemo } from "@course-core/visuals/demos";
import { RunsView } from "../src/views/RunsView";
import { LearnerViewScreen } from "../src/components/LearnerViewScreen";
import {
  sceneImageAssets,
  VisualStatePanel,
} from "../src/components/LearnerInspector";
import { createFetchAdminClient } from "../src/client/fetchClient";
import {
  RunInspectorError,
  runInspectorErrorMessage,
  type PayloadReveal,
  type RunInspectorPort,
  type RunReplay,
} from "../src/domain/runInspector";
import type {
  AdminClient,
  CourseWorkspace,
  SupervisorRun,
} from "../src/domain/contracts";
import type { LearnerView } from "../src/domain/learnerView";

const RUN = "7d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60";
const summary = {
  id: RUN,
  label: "supervisor run",
  status: "ready" as const,
  startedAt: "2026-10-14T00:00:00.000Z",
  contextVersion: "enrollment-3",
  toolCalls: 2,
  providerAttempts: 1,
  artifactCount: 1,
};
const run: SupervisorRun = {
  ...summary,
  summary: "Persisted ready job.",
  events: [],
  context: [],
  decisions: [],
  artifacts: [],
  payload: "withheld",
  workflow: {
    workflowId: "enrollment-e/job-j",
    generation: 1,
    truncated: false,
    nodes: [
      {
        id: "event:1",
        kind: "input_event",
        facts: { eventType: "episode.help_requested", sequence: 41 },
        status: "recorded",
        parentId: null,
      },
      {
        id: "run:1",
        kind: "run",
        facts: { role: "supervisor", workflowId: "enrollment-e/job-j" },
        status: "ready",
        parentId: "event:1",
      },
      {
        id: "checkpoint:generate",
        kind: "checkpoint",
        facts: { checkpointId: "generate" },
        status: "succeeded",
        parentId: "run:1",
      },
      {
        id: "operation:1",
        kind: "operation",
        facts: { attempt: 1, providerState: "completed" },
        status: "succeeded",
        parentId: "checkpoint:generate",
      },
      {
        id: "tool:1",
        kind: "tool_call",
        facts: { step: 0, tool: "list_support" },
        status: "recorded",
        parentId: "operation:1",
      },
      {
        id: "tool:2",
        kind: "tool_call",
        // An older server sent English labels; they still show.
        label: "Step 1: choose_support",
        status: "recorded",
        parentId: "operation:1",
      },
    ],
  },
  policies: {
    fence: {
      enrollmentRevision: 3,
      profileRevision: 1,
      policyRevision: 1,
      ledgerRevision: 0,
      courseDigest: "c".repeat(64),
      enrollmentRevisionNow: 5,
    },
    deadline: "2026-10-14T00:10:00.000Z",
    jobBudget: { microUsd: 900, tokens: 800 },
    checkpoints: [
      {
        id: "generate",
        allowance: { microUsd: 900, tokens: 800 },
        timeoutMs: 1000,
        maxAttempts: 2,
      },
    ],
    operations: [
      {
        id: "j/generate",
        attempt: 1,
        status: "succeeded",
        reservation: { microUsd: 900, tokens: 800 },
        usage: { microUsd: 300, tokens: 120 },
        usageBasis: null,
      },
    ],
    charged: { microUsd: 300, tokens: 120 },
    enrollmentBudget: {
      limit: { microUsd: 5000, tokens: 4000 },
      used: { microUsd: 300, tokens: 120 },
      daily: { microUsd: 2000, tokens: null },
      perArtifact: { microUsd: null, tokens: null },
    },
    workspaceBudget: null,
    providerConfiguration: "host fallback",
    providerSource: "host_file",
    strategies: [
      {
        operationId: "j/generate",
        strategyId: "example.supervisor.read-first",
        version: "1.0.0",
        source: "course",
        revisionDigest: "e".repeat(64),
        evalStanding: "not_checked",
      },
    ],
    supervision: { state: "paused", revision: 2 },
    reason: null,
  },
  sync: {
    inputEvent: {
      sequence: "41",
      actorKind: "learner",
      recordedAt: "2026-10-14T00:00:00.000Z",
      platform: "web",
      appVersion: "1.4.2",
      clientSequence: "17",
      occurredAt: "2026-10-13T23:59:58.500Z",
      receivedAt: null,
      courseDigest: null,
      clockSkewMs: 1500,
    },
    eventsSince: 2,
    latestSequence: "43",
    enrollmentRevisionAtRun: 3,
    enrollmentRevisionNow: 5,
    delivery: {
      attempts: 1,
      deliveredAt: "2026-10-14T00:00:00.500Z",
      quarantined: false,
      lastErrorCode: null,
    },
    run: {
      state: "ready",
      generation: 1,
      snapshotVersion: 4,
      cancellationRequested: false,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:02.000Z",
    },
  },
};
const reveal: PayloadReveal = {
  receipt: {
    id: "1d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60",
    eventId: "2d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60",
    reason: "quality_review",
    payloadDigest: "d".repeat(64),
  },
  payload: {
    inputs: [
      {
        id: "i1",
        checkpointId: "generate",
        context: { kind: "learning_event", episodeId: "min" },
      },
    ],
    toolCalls: [
      {
        id: "t1",
        operationId: "j/generate",
        step: 0,
        tool: "choose_support",
        arguments: { entryId: "number-line" },
        result: { selected: true },
        withheld: false,
      },
      {
        id: "t2",
        operationId: "j/generate",
        step: 1,
        tool: "get_profile",
        arguments: null,
        result: null,
        withheld: true,
      },
    ],
    artifacts: [
      {
        id: "a1",
        kind: "supervised_plan",
        sha256: "e".repeat(64),
        content: { summary: "Offer the number line." },
        withheld: false,
      },
    ],
  },
  withheld: [{ ref: "tool:t2", category: "learner-model" }],
  rule: {
    id: "run-payloads",
    label: "Supervisor run payloads",
    reason: "Shown only to owners and admins on an audited reveal.",
    withheld: ["companion", "learner-model", "hypothesis-tool-text"],
  },
};
const replay: RunReplay = {
  replayRunId: "3d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60",
  sourceRunId: RUN,
  outcome: "matches",
  reason: null,
  sideEffects: "stubbed",
  progressWrites: "denied",
  providerCalls: 0,
  steps: [
    {
      step: 0,
      tool: "list_support",
      recordedReceiptId: "t0",
      argumentsDigest: "a".repeat(64),
      resultDigest: "b".repeat(64),
    },
  ],
  recordedPlanDigest: "f".repeat(64),
  replayedPlanDigest: "f".repeat(64),
};
const port = (): RunInspectorPort => ({
  revealPayload: vi.fn(async () => reveal),
  replay: vi.fn(async () => replay),
  enrollmentRuns: vi.fn(async () => ({
    courseId: "4d0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60",
    runs: [
      {
        id: RUN,
        label: "supervisor run",
        status: "ready",
        startedAt: "2026-10-14T00:00:00.000Z",
        episodeId: "one",
        blockId: null,
      },
    ],
  })),
});
const workspace = (permissions: string[]) =>
  ({
    course: { id: "c1" },
    runs: [summary],
    permissions,
  }) as unknown as CourseWorkspace;

describe("run inspector completion", () => {
  it("draws the workflow graph, policies and budgets, and client and sync state", async () => {
    render(
      <RunsView
        data={workspace(["run.inspect"])}
        client={
          {
            getRun: vi.fn(async () => run),
            runInspector: port(),
          } as unknown as AdminClient
        }
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Workflow graph" }),
    );
    const graph = screen.getByRole("navigation", { name: "Workflow graph" });
    const operation = within(graph)
      .getByText("Attempt 1 · provider completed")
      .closest("li")!;
    expect(within(operation).getByText("Step 1: choose_support")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Policies & budgets" }),
    );
    expect(screen.getByText("changed since the run")).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Reservations and usage per attempt" }),
    ).toHaveTextContent("900 micro-USD · 800 tokens300 micro-USD · 120 tokens");
    expect(screen.getByText("paused · revision 2")).toBeVisible();
    // Which AI setup answered, and that nobody had checked it when it ran (B08).
    expect(screen.getByText(/The server's provider file/)).toBeVisible();
    expect(
      screen.getByText(
        "The course's narrower setup example.supervisor.read-first (version 1.0.0)",
        { exact: false },
      ),
    ).toBeVisible();
    expect(screen.getByText("Not checked when it ran")).toBeVisible();
    expect(
      screen.getByText(/had no passing quality check and no owner approval/),
    ).toBeVisible();
    // U04: every amount is labelled as an estimate, never as a billed figure.
    const usage = screen.getByRole("table", {
      name: "Reservations and usage per attempt",
    });
    expect(
      within(usage).getByRole("columnheader", { name: "Reserved (estimated)" }),
    ).toBeVisible();
    expect(
      within(usage).getByRole("columnheader", { name: "Used (estimated)" }),
    ).toBeVisible();
    expect(screen.getByText("Charged (estimated)")).toBeVisible();
    expect(
      screen.getByText(
        /Every amount here is an estimate .* not a provider invoice/,
      ),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Client & sync" }),
    );
    expect(screen.getByText(/web 1\.4\.2 · client sequence 17/)).toBeVisible();
    expect(screen.getByText(/1500 ms between/)).toBeVisible();
    expect(screen.getByText("r3 at the run · r5 now")).toBeVisible();
  });

  it("withholds the payload without run.payload and reveals it only for a chosen reason", async () => {
    const inspector = port();
    const { unmount } = render(
      <RunsView
        data={workspace(["run.inspect"])}
        client={
          {
            getRun: vi.fn(async () => run),
            runInspector: inspector,
          } as unknown as AdminClient
        }
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Payload" }),
    );
    expect(screen.getByText(/needs the run\.payload permission/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Reveal payload/ })).toBeNull();
    unmount();
    render(
      <RunsView
        data={workspace(["run.inspect", "run.payload"])}
        client={
          {
            getRun: vi.fn(async () => run),
            runInspector: inspector,
          } as unknown as AdminClient
        }
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Payload" }),
    );
    const button = screen.getByRole("button", {
      name: "Reveal payload with audit receipt",
    });
    expect(button).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByLabelText("Reason for revealing"),
      "quality_review",
    );
    await userEvent.click(button);
    await waitFor(() =>
      expect(inspector.revealPayload).toHaveBeenCalledWith(
        "c1",
        RUN,
        "quality_review",
      ),
    );
    expect(
      await screen.findByText(
        /is on the learner's record and in the audit log/,
      ),
    ).toBeVisible();
    expect(
      screen.getByLabelText("Step 0 arguments and result"),
    ).toHaveTextContent('"entryId": "number-line"');
    expect(
      screen.getByText("Not revealed: the learner's private model."),
    ).toBeVisible();
  });

  it("replays in the sandbox and reports the verdict and new run id", async () => {
    const inspector = port();
    render(
      <RunsView
        data={workspace(["run.inspect"])}
        client={
          {
            getRun: vi.fn(async () => run),
            runInspector: inspector,
          } as unknown as AdminClient
        }
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Replay" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Replay in sandbox" }),
    );
    expect(
      await screen.findByText("Replay matches the recorded plan"),
    ).toBeVisible();
    expect(screen.getByText(replay.replayRunId)).toBeVisible();
    expect(
      screen.getByText(
        /tools stubbed · progress writes denied · 0 provider calls/,
      ),
    ).toBeVisible();
  });

  it("calls the payload, replay and enrollment-run routes and maps refusals", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return Response.json({ error: "FORBIDDEN" }, { status: 403 });
      },
    });
    const refused = await client
      .runInspector!.revealPayload("c1", RUN, "bug_report")
      .catch((e) => e);
    expect(refused).toBeInstanceOf(RunInspectorError);
    expect(runInspectorErrorMessage(refused)).toMatch(
      /run\.payload permission/,
    );
    await client.runInspector!.replay("c1", RUN).catch(() => undefined);
    await client
      .runInspector!.enrollmentRuns("e1", "one")
      .catch(() => undefined);
    expect(calls).toEqual([
      {
        url: `/api/admin/courses/c1/runs/${RUN}/payload`,
        method: "POST",
        body: { reason: "bug_report" },
      },
      {
        url: `/api/admin/courses/c1/runs/${RUN}/replay`,
        method: "POST",
        body: {},
      },
      { url: "/api/admin/enrollments/e1/runs?episodeId=one", method: "GET" },
    ]);
  });
});

function learnerView(): LearnerView {
  const visual = toVisualExperience(sortingDemo);
  return {
    readOnly: true,
    view: {
      id: "0b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f61",
      viewedAt: "2026-10-14T10:00:00.000Z",
      viewer: { id: "owner", name: "Owner", role: "owner" },
      visibleToLearner: true,
    },
    learner: { displayName: "Sam" },
    snapshot: {
      enrollmentId: "e1",
      revision: 4,
      status: "active",
      profile: { displayName: "Sam" },
      planRevision: 0,
      adaptationRequirements: [],
      lessons: [
        {
          id: "one",
          requirement: "required",
          status: "available",
          completedBlockIds: [],
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
    visualRenderers: [
      {
        visualId: visual.id,
        rendererId: "course-core-svg-v1",
        declared: { version: "0.4.0", integrity: `sha256-${"d".repeat(64)}` },
        installed: { version: "0.4.0", integrity: `sha256-${"d".repeat(64)}` },
        served: "installed",
      },
    ],
    withheld: [],
  } as unknown as LearnerView;
}

describe("inspector reachable from the learner's activity", () => {
  it("opens a pane on a block with the visual's live scene, timeline, bindings and hashes, and the lesson's runs", async () => {
    const inspector = port();
    const client = {
      runInspector: inspector,
      getRun: vi.fn(async () => run),
    } as unknown as AdminClient;
    render(
      <LearnerViewScreen
        view={learnerView()}
        inspector={{ client, enrollmentId: "e1", permissions: ["run.inspect"] }}
      />,
    );
    const opener = screen.getByRole("button", { name: "Inspect part 2" });
    await userEvent.click(opener);
    const pane = screen.getByRole("complementary", { name: "Debug inspector" });
    expect(
      within(pane).getByRole("heading", { name: "Part 2: Illustration" }),
    ).toHaveFocus();
    expect(
      within(pane).getByText(
        /read only for learner data; reveals and replays are logged/,
      ),
    ).toBeVisible();
    const state = within(pane).getByRole("region", { name: "Visual state" });
    expect(
      within(state).getByText(sortingDemo.id, { exact: false }),
    ).toBeVisible();
    expect(
      within(state).getByRole("table", {
        name: "Bindings: state the scene reads",
      }),
    ).toBeVisible();
    expect(within(state).getByText(/^\d+-[0-9a-f]+-[0-9a-f]+$/)).toBeVisible();
    await waitFor(() =>
      expect(within(state).getByText(/^[0-9a-f]{64}$/)).toBeVisible(),
    );
    // L11: renderer build identity, declared and installed.
    const build = within(state).getByTestId("renderer-build");
    expect(within(build).getByText("course-core-svg-v1")).toBeVisible();
    expect(
      within(build).getAllByText(`0.4.0 · sha256-${"d".repeat(64)}`),
    ).toHaveLength(2);
    expect(
      within(build).getByText(
        "The course runs on exactly the build it declares.",
      ),
    ).toBeVisible();
    expect(
      within(state).getByText("This scene has no image assets."),
    ).toBeVisible();
    await userEvent.click(
      await within(pane).findByRole("button", { name: /supervisor run/ }),
    );
    expect(inspector.enrollmentRuns).toHaveBeenCalledWith(
      "e1",
      "one",
      expect.anything(),
    );
    expect(
      await within(pane).findByRole("button", { name: "Workflow graph" }),
    ).toBeVisible();
    await userEvent.click(
      within(pane).getByRole("button", { name: "Close the debug inspector" }),
    );
    expect(
      screen.queryByRole("complementary", { name: "Debug inspector" }),
    ).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("lists a scene's image assets with their SHA-256 and size, and says when a renderer is unknown or unserved", () => {
    const png = "iVBORw0KGgo="; // 8 bytes
    const hash = `sha256-${"a".repeat(64)}`;
    const experience = {
      ...toVisualExperience(sortingDemo),
      scene: {
        defs: {
          images: [
            {
              id: "logo",
              mediaType: "image/png",
              sha256: hash,
              data: `data:image/png;base64,${png}`,
            },
            {
              id: "broken",
              mediaType: "image/png",
              sha256: "not-a-hash",
              data: "https://example.org/x.png",
            },
            { nope: true },
          ],
        },
      },
    };
    expect(sceneImageAssets(experience)).toEqual([
      { id: "logo", mediaType: "image/png", sha256: hash, bytes: 8 },
      { id: "broken", mediaType: "image/png", sha256: "", bytes: null },
    ]);
    expect(sceneImageAssets(null)).toEqual([]);
    expect(sceneImageAssets({ scene: { defs: { images: "x" } } })).toEqual([]);
    const runtime = new VisualRuntime(sortingDemo);
    const { rerender } = render(
      <VisualStatePanel runtime={runtime} experience={experience} />,
    );
    const table = screen.getByRole("table", { name: "Image assets" });
    expect(within(table).getByText(hash)).toBeVisible();
    expect(within(table).getByText("8 bytes")).toBeVisible();
    expect(within(table).getByText("unavailable")).toBeVisible();
    expect(screen.getByText("Not reported for this visual.")).toBeVisible();
    rerender(
      <VisualStatePanel
        runtime={runtime}
        experience={experience}
        renderer={{
          visualId: "v",
          rendererId: "course-core-svg-v1",
          declared: { version: "0.9.0", integrity: hash },
          installed: null,
          served: "unavailable",
        }}
      />,
    );
    expect(screen.getByText("none")).toBeVisible();
    expect(
      screen.getByText(/No installed build serves this declaration/),
    ).toBeVisible();
  });

  it("offers no inspector without run.inspect", () => {
    render(<LearnerViewScreen view={learnerView()} />);
    expect(screen.queryByRole("button", { name: /Inspect part/ })).toBeNull();
  });
});
