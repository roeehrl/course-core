import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createCourseApi, CourseApiError } from "../src/client/apiClient";
import {
  createMemoryClient,
  parseMemorySnapshot,
  type MemoryChanges,
  type MemoryDecision,
  type MemoryHistory,
  type MemoryProfile,
  type MemoryReceipt,
  type MemoryScope,
  type MemorySnapshot,
} from "../src/client/memoryClient";
import { LearnerMemoryPanel } from "../src/components/LearnerMemoryPanel";
import { connectedSnapshot } from "./connectedFixtures";

const account = { id: "learner-account", displayName: "Learner" };
const scope: MemoryScope = {
  enrollmentId: "enrollment-1",
  workspaceId: "workspace-1",
  episodeId: "intro",
  courseDigest: "a".repeat(64),
};
const title = "Explain a changing pattern.";
const proposalId = "8a632521-8f9a-4d37-884c-b7d2502a547e";
const source = {
  eventId: "source-event",
  cursor: "10",
  eventType: "companion.requested",
  digest: "b".repeat(64),
};
const base = "/api/enrollments/enrollment-1/learner-model";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function fixture(): MemorySnapshot {
  return {
    ...scope,
    workspaceId: "workspace-1",
    revision: 7,
    profileRevision: 2,
    modelRevision: 1,
    scope: {
      episodeId: "intro",
      objectiveIds: ["observe"],
      objectivesTruncated: false,
    },
    understanding: [
      {
        objectiveId: "observe",
        status: "needs_evidence",
        gateId: "check",
        basis: "current_course_independent_gate_evidence",
        retention: "not_assessed",
        independentFamilies: 1,
        requiredFamilies: 2,
        familiesTruncated: false,
        evidenceRefsTruncated: false,
        evidenceRefs: [
          {
            evidenceId: "evidence-1",
            attemptId: "attempt-1",
            courseDigest: scope.courseDigest,
          },
        ],
      },
    ],
    selfReport: {
      trust: "learner_statement_not_evidence",
      preferences: {
        pace: "steady",
        explanationStyle: "worked_example",
        goal: "Notice patterns",
      },
      priorKnowledge: [
        {
          objectiveId: "observe",
          statement: "I have seen these patterns before.",
        },
      ],
      thoughts: "Start with small examples.",
    },
    suggestions: {
      truncated: false,
      items: [
        {
          proposalId,
          status: "pending",
          suggestion: { kind: "explanation_style", value: "step_by_step" },
          originalSuggestion: {
            kind: "explanation_style",
            value: "step_by_step",
          },
          decisionId: null,
          grantsMastery: false,
          sourceEventRefs: [source],
        },
      ],
    },
  };
}
function historyFixture(): MemoryHistory {
  return {
    scope: fixture().scope,
    items: [],
    nextCursor: null,
    scannedEvents: 0,
    maxScannedEvents: 200,
    maxSearchedTextCharacters: 4000,
    maxSnippetCharacters: 1000,
  };
}
function enrollment() {
  return {
    ...connectedSnapshot(),
    workspaceId: scope.workspaceId,
    courseDigest: scope.courseDigest,
  };
}

/** Only the HTTP boundary is mocked: real React Native Web primitives and the
 * actual cookie/CSRF transport + memory client are exercised. PostgreSQL authority
 * tests live with the API; these fixtures do not claim backend/browser acceptance. */
function harness(initial = fixture()) {
  let model = structuredClone(initial);
  let history = historyFixture();
  const changes: MemoryChanges = { items: [], nextCursor: null };
  let failure:
    | ((
        url: URL,
        init: RequestInit,
      ) => Response | Promise<Response> | undefined)
    | undefined;
  const receipts = new Map<string, MemoryReceipt>();
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const intercepted = failure?.(url, init);
    if (intercepted) return intercepted;
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const prior = receipts.get(body.idempotencyKey);
      if (prior) return response(prior);
      if (body.expectedRevision !== model.revision)
        return response({ error: "STALE_REVISION" }, 409);
      const receipt: MemoryReceipt = {
        changeId: `change-${model.modelRevision + 1}`,
        eventId: `event-${model.modelRevision + 1}`,
        revision: model.revision + 1,
        modelRevision: model.modelRevision + 1,
        proposalId: url.pathname.endsWith("/profile") ? null : proposalId,
        grantsMastery: false,
      };
      if (url.pathname === base + "/profile")
        model.selfReport = {
          ...body.profile,
          trust: "learner_statement_not_evidence",
        };
      else if (url.pathname === base + `/proposals/${proposalId}/decision`) {
        const proposal = model.suggestions.items[0]!;
        proposal.status = (
          {
            accept: "accepted",
            correct: "corrected",
            dispute: "disputed",
          } as const
        )[body.action as MemoryDecision["action"]];
        proposal.suggestion = body.correction ?? proposal.originalSuggestion;
        proposal.decisionId = receipt.changeId;
      } else return response({ error: "UNKNOWN_ROUTE" }, 404);
      model.revision = receipt.revision;
      model.modelRevision = receipt.modelRevision;
      model.profileRevision++;
      receipts.set(body.idempotencyKey, receipt);
      return response(receipt);
    }
    if (url.pathname.endsWith("/history")) return response(history);
    if (url.pathname.endsWith("/changes")) return response(changes);
    return response(model);
  });
  const api = createMemoryClient(
    createCourseApi({
      fetch: fetcher,
      csrf: () => "test-csrf",
      accountId: account.id,
    }),
    account.id,
  );
  return {
    api,
    fetcher,
    changes,
    get model() {
      return model;
    },
    set model(value) {
      model = value;
    },
    set history(value: MemoryHistory) {
      history = value;
    },
    set failure(value: typeof failure) {
      failure = value;
    },
    props: { account, enrollment: enrollment(), api, episodeId: "intro" },
    posts: () =>
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
  };
}
async function ready() {
  await screen.findByRole("heading", { name: "What you have demonstrated" });
  await waitFor(()=>expect(screen.queryByText("Loading saved memory…")).not.toBeInTheDocument());
}
const goal = () => screen.getByRole("textbox", { name: "My learning goal" });
const save = () => screen.getByRole("button", { name: "Save my profile" });

describe("learner-owned memory panel through HTTP", () => {
  it("separates earned evidence, self-reports and suggestions, with inspectable references", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    expect(screen.getByText("More independent evidence needed")).toBeVisible();
    expect(
      screen.getByText(/1 independent question families recorded; 2 required/),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Preferences & prior knowledge" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "AI suggestions" }),
    ).toBeVisible();
    expect(
      screen.getByText(/These results come from saved independent checks/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Show evidence references for ${title}`,
      }),
    );
    expect(screen.getByText("Evidence: evidence-1")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Show source references for suggestion ${proposalId}`,
      }),
    );
    expect(screen.getByText("Source event: source-event")).toBeVisible();
    expect(screen.getByText(`Recorded digest: ${source.digest}`)).toBeVisible();
    expect(h.posts()).toHaveLength(0);
    expect(h.fetcher.mock.calls[0]![0]).toBe(base + "?episodeId=intro");
    expect(h.fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("edits and removes self-reports without inventing credit; sends strict profile fields and CSRF", async () => {
    const h = harness(),
      onRevision = vi.fn();
    render(<LearnerMemoryPanel {...h.props} onRevision={onRevision} />);
    await ready();
    fireEvent.change(goal(), { target: { value: "My revised learning goal" } });
    fireEvent.change(
      screen.getByRole("textbox", { name: "My thoughts about learning" }),
      { target: { value: "I want more time to think." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Remove claim for ${title}` }),
    );
    expect(
      screen.getByText(/Earlier edits remain in your change history/),
    ).toBeVisible();
    fireEvent.click(save());
    await screen.findByText("Change saved. Assessment evidence is unchanged.");
    const [, init] = h.posts()[0]!;
    expect(init).toMatchObject({
      credentials: "same-origin",
      headers: { "X-CSRF-Token": "test-csrf" },
    });
    expect(JSON.parse(String(init!.body))).toMatchObject({
      expectedRevision: 7,
      profile: {
        preferences: { goal: "My revised learning goal" },
        priorKnowledge: [],
        thoughts: "I want more time to think.",
      },
    });
    expect(JSON.parse(String(init!.body)).profile).not.toHaveProperty("trust");
    expect(JSON.parse(String(init!.body))).not.toHaveProperty("actorKind");
    expect(onRevision).toHaveBeenCalledWith(8);
    expect(screen.getByText("More independent evidence needed")).toBeVisible();
    expect(
      screen.queryByText("Demonstrated", { exact: true }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: `Add claim: ${title}` }),
    );
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add a short statement",
    );
    expect(h.posts()).toHaveLength(1);
  });

  it("accepts, corrects and disputes suggestions while manual preferences and earned evidence stay separate", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));
    await screen.findByText("Accepted suggestion");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Correct suggestion" }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Correct suggestion" }));
    const editor = screen.getByRole("radiogroup", {
      name: "Corrected suggestion",
    });
    fireEvent.click(within(editor).getByRole("radio", { name: "Concise" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Review note (optional)" }),
      { target: { value: "Brief explanations work better for me." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await screen.findByText("Corrected by you");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Dispute suggestion" }),
      ).not.toBeDisabled(),
    );
    expect(screen.getByText("Suggested explanation: Concise")).toBeVisible();
    const preferences = screen.getByRole("radiogroup", {
      name: "Preferred explanation style",
    });
    expect(
      within(preferences).getByRole("radio", { name: "Worked examples" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Dispute suggestion" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm dispute" }));
    await screen.findByText("Disputed · excluded from AI context");
    expect(
      h.posts().map(([, init]) => JSON.parse(String(init!.body)).action),
    ).toEqual(["accept", "correct", "dispute"]);
    expect(h.posts()[1]![0]).toBe(base + `/proposals/${proposalId}/decision`);
    expect(JSON.parse(String(h.posts()[1]![1]!.body))).toMatchObject({
      correction: { kind: "explanation_style", value: "concise" },
      expectedRevision: 8,
    });
    expect(h.model.selfReport.preferences.explanationStyle).toBe(
      "worked_example",
    );
    expect(screen.getByText("More independent evidence needed")).toBeVisible();
  });

  it("keeps drafts through stale conflicts, requires refresh, and lets the learner compare before saving", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    fireEvent.change(goal(), { target: { value: "My unsaved goal" } });
    h.model.revision = 9;
    h.model.selfReport.preferences.goal = "Changed on another device";
    fireEvent.click(save());
    await screen.findByText(/Your memory or progress changed elsewhere/);
    expect(goal()).toHaveValue("My unsaved goal");
    expect(save()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh & keep draft" }),
    );
    await screen.findByText(/Saved version refreshed/);
    expect(goal()).toHaveValue("My unsaved goal");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show latest saved profile for comparison",
      }),
    );
    expect(screen.getByText("Goal: Changed on another device")).toBeVisible();
    expect(h.posts()).toHaveLength(1);
    fireEvent.click(save());
    await screen.findByText("Change saved. Assessment evidence is unchanged.");
    const bodies = h.posts().map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies[1].expectedRevision).toBe(9);
    expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
  });

  it("preserves a review correction through a stale revision and restores focus after saving", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Correct suggestion" }));
    fireEvent.click(
      within(
        screen.getByRole("radiogroup", { name: "Corrected suggestion" }),
      ).getByRole("radio", { name: "Concise" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Review note (optional)" }),
      { target: { value: "Keep my correction draft" } },
    );
    h.model.revision = 9;
    h.model.suggestions.items[0]!.decisionId = "another-review";
    h.model.suggestions.items[0]!.status = "accepted";
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await screen.findByText(/Your memory or progress changed elsewhere/);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh & keep draft" }),
    );
    await screen.findByText(/The saved review changed/);
    expect(
      screen.getByRole("textbox", { name: "Review note (optional)" }),
    ).toHaveValue("Keep my correction draft");
    expect(
      within(
        screen.getByRole("radiogroup", { name: "Corrected suggestion" }),
      ).getByRole("radio", { name: "Concise" }),
    ).toHaveAttribute("aria-checked", "true");
    // The changed-review warning can render before the refresh's finally block
    // releases its action guard. A user must get an enabled action before the
    // second submission; clicking a disabled button intentionally does nothing.
    await waitFor(()=>expect(screen.getByRole("button",{name:"Save correction"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await screen.findByText("Corrected by you");
    await waitFor(() =>
      expect(
        screen.getByRole("toolbar", { name: "Suggestion review actions" }),
      ).toHaveFocus(),
    );
    expect(JSON.parse(String(h.posts()[1]![1]!.body))).toMatchObject({
      expectedRevision: 9,
      reason: "Keep my correction draft",
    });
  });

  it("retries uncertain writes byte-for-byte, blocks competing changes and survives panel remount", async () => {
    const h = harness();
    let failed = false;
    h.failure = (_url, init) => {
      if (init.method === "POST" && !failed) {
        failed = true;
        return Promise.reject(new Error("SECRET_TRANSPORT_CANARY"));
      }
    };
    const mounted = render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    fireEvent.change(goal(), { target: { value: "Keep exactly this intent" } });
    fireEvent.click(save());
    await screen.findByRole("button", { name: "Retry unconfirmed change" });
    expect(
      screen.queryByText(/SECRET_TRANSPORT_CANARY/),
    ).not.toBeInTheDocument();
    await expect(
      h.api.decide(scope, 7, proposalId, { action: "accept" }),
    ).rejects.toMatchObject({ code: "PENDING_UNCERTAIN" });
    mounted.unmount();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    await waitFor(()=>expect(screen.getByRole("button",{name:"Retry unconfirmed change"})).toBeEnabled());
    fireEvent.click(
      screen.getByRole("button", { name: "Retry unconfirmed change" }),
    );
    await screen.findByText("Change saved. Assessment evidence is unchanged.");
    expect(h.posts()).toHaveLength(2);
    expect(h.posts()[1]![1]!.body).toBe(h.posts()[0]![1]!.body);
    expect(goal()).toHaveValue("Keep exactly this intent");
  });

  it("searches bounded windows explicitly, including empty pages with an earlier cursor", async () => {
    const h = harness();
    h.history = { ...historyFixture(), scannedEvents: 200, nextCursor: "10" };
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search my history" }),
      { target: { value: "50% & pattern" } },
    );
    expect(h.fetcher.mock.calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "My questions" }));
    fireEvent.click(screen.getByRole("button", { name: "Search history" }));
    await screen.findByText(
      "No matches in this window. Earlier history is still available.",
    );
    let request = new URL(
      String(h.fetcher.mock.calls.at(-1)![0]),
      "http://localhost",
    );
    expect(Object.fromEntries(request.searchParams)).toEqual({
      episodeId: "intro",
      q: "50% & pattern",
      kind: "questions",
      limit: "10",
    });
    h.history = {
      ...historyFixture(),
      scannedEvents: 3,
      items: [
        {
          kind: "questions",
          cursor: "9",
          eventId: "old-event",
          messageId: "old-message",
          text: "My 50% & pattern question",
        },
      ],
    };
    fireEvent.click(
      screen.getByRole("button", { name: "Search earlier history" }),
    );
    await screen.findByText("My 50% & pattern question");
    request = new URL(
      String(h.fetcher.mock.calls.at(-1)![0]),
      "http://localhost",
    );
    expect(request.searchParams.get("before")).toBe("10");
    expect(
      screen.queryByRole("button", { name: "Search earlier history" }),
    ).not.toBeInTheDocument();
  });

  it("shows saved correction history, empty proposals and honest unassessed states", async () => {
    const model = fixture();
    model.suggestions.items = [];
    model.understanding = [
      {
        objectiveId: "observe",
        status: "not_assessed",
        gateId: null,
        evidenceRefs: [],
      },
    ];
    const h = harness(model);
    h.changes.items.push({
      cursor: "20",
      id: "review-change",
      eventId: "review-event",
      modelRevision: 2,
      actorKind: "learner",
      action: "proposal.corrected",
      proposalId,
      createdAt: "2026-01-01T12:00:00Z",
      data: {
        originalSuggestion: {
          kind: "explanation_style",
          value: "step_by_step",
        },
        correction: { kind: "explanation_style", value: "concise" },
        reason: "This represents me better.",
      },
    });
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    expect(screen.getByText("Not assessed")).toBeVisible();
    expect(screen.getByText("Nothing to review.")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "View latest changes" }),
    );
    await screen.findByText("Suggestion corrected");
    expect(screen.getByText("This represents me better.")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Show change details 20" }),
    );
    expect(screen.getByText("Event: review-event")).toBeVisible();
    expect(screen.getByText("Suggested explanation: Concise")).toBeVisible();
  });

  it("clears all private state on lost access and supports an unavailable enrollment without fake defaults", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    fireEvent.change(goal(), { target: { value: "PRIVATE_DRAFT_CANARY" } });
    h.failure = () => response({ error: "FORBIDDEN" }, 403);
    fireEvent.click(screen.getByRole("button", { name: "Search history" }));
    await screen.findByText(
      "You no longer have access to this learning memory.",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText("More independent evidence needed"),
    ).not.toBeInTheDocument();
    h.failure = () => response({ error: "ENROLLMENT_NOT_FOUND" }, 404);
    fireEvent.click(screen.getByRole("button", { name: "Check access again" }));
    await screen.findByText(/It may have been removed/);
    expect(screen.queryByText(/PRIVATE_DRAFT_CANARY/)).not.toBeInTheDocument();
  });

  it("aborts old reads and never paints old account/enrollment data after a switch", async () => {
    const old = harness(),
      next = harness({ ...fixture(), enrollmentId: "enrollment-2" });
    let release!: (value: Response) => void;
    old.failure = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const view = render(<LearnerMemoryPanel {...old.props} />);
    await waitFor(() => expect(old.fetcher).toHaveBeenCalled());
    const signal = old.fetcher.mock.calls[0]![1]!.signal!;
    view.rerender(
      <LearnerMemoryPanel
        {...next.props}
        enrollment={{ ...enrollment(), enrollmentId: "enrollment-2" }}
      />,
    );
    await ready();
    const oldModel = fixture();
    oldModel.selfReport.thoughts = "OLD_ACCOUNT_CANARY";
    await act(async () => release(response(oldModel)));
    expect(signal.aborted).toBe(true);
    expect(
      screen.getByRole("textbox", { name: "My thoughts about learning" }),
    ).not.toHaveValue("OLD_ACCOUNT_CANARY");
    view.rerender(
      <LearnerMemoryPanel
        {...next.props}
        account={{ id: "new-account", displayName: "Other" }}
      />,
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Memory is unavailable while your account changes/),
    ).toBeVisible();
    view.rerender(<LearnerMemoryPanel {...next.props} account={null} />);
    expect(
      screen.getByText("Sign in to view your learning memory."),
    ).toBeVisible();
  });

  it("supports keyboard choices and preserves the focused field through responsive resize", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    const user = userEvent.setup();
    const group = screen.getByRole("radiogroup", {
      name: "Preferred learning pace",
    });
    within(group).getByRole("radio", { name: "Gentle" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(within(group).getByRole("radio", { name: "Steady" })).toHaveFocus();
    const input = goal() as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(2, 5);
    fireEvent(window, new Event("resize"));
    expect(goal()).toBe(input);
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2);
    expect(input).toHaveAttribute("maxlength", "2000");
  });
});

describe("memory client scope and safe transport", () => {
  it("retains a pending intent when a success response has the wrong revision", async () => {
    const h = harness();
    h.failure = (_url, init) =>
      init.method === "POST"
        ? response({
            changeId: "bad",
            eventId: "bad",
            revision: 999,
            modelRevision: 2,
            proposalId: null,
            grantsMastery: false,
          })
        : undefined;
    const profile: MemoryProfile = {
      preferences: {},
      priorKnowledge: [],
      thoughts: "Exact intent",
    };
    await expect(h.api.save(scope, 7, profile)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(h.api.pending(scope)).toBe("profile");
    h.failure = undefined;
    await h.api.retry(scope);
    expect(h.posts()[1]![1]!.body).toBe(h.posts()[0]![1]!.body);
    expect(h.api.pending(scope)).toBeNull();
  });

  it("rejects mismatched or dishonest snapshots without replacing missing evidence with zeroes", () => {
    expect(() =>
      parseMemorySnapshot(
        { ...fixture(), enrollmentId: "OTHER_ENROLLMENT" },
        scope,
      ),
    ).toThrow(CourseApiError);
    expect(() =>
      parseMemorySnapshot(
        { ...fixture(), workspaceId: "OTHER_WORKSPACE" },
        scope,
      ),
    ).toThrow(CourseApiError);
    expect(() =>
      parseMemorySnapshot(
        { ...fixture(), courseDigest: "c".repeat(64) },
        scope,
      ),
    ).toThrow(CourseApiError);
    const dishonest = fixture();
    dishonest.understanding[0]!.status = "demonstrated";
    expect(() => parseMemorySnapshot(dishonest, scope)).toThrow(CourseApiError);
    const badSource = fixture();
    badSource.suggestions.items[0]!.grantsMastery = true as false;
    expect(() => parseMemorySnapshot(badSource, scope)).toThrow(CourseApiError);
  });

  it("rejects oversized/malformed history and uses exact receipts for concurrent requests", async () => {
    const h = harness();
    h.history = { ...historyFixture(), nextCursor: "not-a-cursor" };
    await expect(
      h.api.history(scope, { q: "", kind: "all" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      h.api.history(scope, { q: "x".repeat(101), kind: "all" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const profile: MemoryProfile = {
      preferences: {},
      priorKnowledge: [],
      thoughts: "safe duplicate",
    };
    const receipts = await Promise.all([
      h.api.save(scope, 7, profile),
      h.api.save(scope, 7, profile),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(h.posts()).toHaveLength(1);
    expect(h.api.pending(scope)).toBeNull();
  });
});
