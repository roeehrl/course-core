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
import { stripBidiControls } from "@course-core/i18n";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";
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
        demonstrated: false,
        retention: "not_scheduled",
        retentionDueAt: null,
        practiceAttempts: 0,
        openDisputes: 0,
        independentFamilies: 1,
        requiredFamilies: 2,
        familiesTruncated: false,
        evidenceRefsTruncated: false,
        evidenceRefs: [
          {
            evidenceId: "evidence-1",
            attemptId: "attempt-1",
            courseDigest: scope.courseDigest,
            evaluator: "deterministic-choice@1",
            decidedBy: "automatic_check",
            recordedAt: "2026-10-20T09:00:00.000Z",
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
      const control = /\/evidence\/([^/]+)\/control$/.exec(url.pathname);
      if (control) {
        const ref = model.understanding[0]!.evidenceRefs.find(
          (row) => row.evidenceId === control[1],
        );
        if (!ref) return response({ error: "EVIDENCE_NOT_FOUND" }, 404);
        if (body.action === "dispute") ref.disputed = true;
        if (body.action === "withdraw_dispute") ref.disputed = false;
        if (body.action === "exclude") ref.excluded = true;
        if (body.action === "include") ref.excluded = false;
        const row = model.understanding[0]!;
        row.openDisputes = ref.disputed ? 1 : 0;
        row.status = ref.disputed ? "disputed" : "needs_evidence";
        model.revision++;
        const receipt = {
          evidenceId: control[1],
          action: body.action,
          eventId: `event-control-${model.revision}`,
          revision: model.revision,
          disputed: !!ref.disputed,
          excluded: !!ref.excluded,
          grantsMastery: false,
          changesCredit: false,
        };
        receipts.set(body.idempotencyKey, receipt as never);
        return response(receipt);
      }
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

  it("renders in Hebrew: translated labels, plurals and error codes, ids kept left to right", async () => {
    const h = harness();
    const snapshot = fixture();
    snapshot.understanding[0] = {
      ...snapshot.understanding[0]!,
      status: "practicing",
      practiceAttempts: 2,
    };
    h.model = snapshot;
    render(
      <I18nProvider value={createLearnerTranslator("he")}>
        <LearnerMemoryPanel {...h.props} />
      </I18nProvider>,
    );
    await screen.findByRole("heading", { name: "מה שהעבודה שלך כבר הוכיחה" });
    expect(screen.getByText("בתרגול")).toBeVisible();
    expect(
      screen.getByText(/עד עכשיו נרשמו שתי תשובות\./),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "היעד שלי בלמידה" }),
    ).toBeVisible();
    const show = screen.getByRole("button", {
      name: (name) =>
        stripBidiControls(name) === `הצגת ההפניות לראיות של ${title}`,
    });
    fireEvent.click(show);
    const reference = screen.getByText(
      (text) => stripBidiControls(text) === "ראיה: evidence-1",
    );
    // The id is isolated left to right inside the right-to-left sentence.
    expect(reference.textContent).toContain("\u2066evidence-1\u2069");
    expect(document.body.textContent).not.toMatch(/Show |Loading saved memory/);
  });

  it("names where each suggestion came from: the course's AI or the connected agent the learner labelled", async () => {
    const snapshot = fixture();
    const first = snapshot.suggestions.items[0]!;
    snapshot.suggestions.items = [first, { ...first, proposalId: "4b2e0c0e-1d1f-4a55-9a0c-1a6c1a3f0b11",
      origin: { kind: "connected_agent", grantId: "a5d1f1a8-2c34-4b8f-9d5e-5b8f0c1d2e3f", label: "My desktop assistant" } }];
    const h = harness(snapshot);
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    expect(screen.getByText("From this course's AI")).toBeVisible();
    expect(screen.getByText("From your connected agent My desktop assistant")).toBeVisible();
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
    // A saved notice can render before perform() releases its write lock and
    // React commits the enabled form. A disabled click is deliberately ignored.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: `Add claim: ${title}` }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Add claim: ${title}` }),
    );
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add a short statement",
    );
    expect(h.posts()).toHaveLength(1);
  });

  it("edits declared languages, experience, depth, weekly time and accessibility needs (C01); invalid entries are explained and never sent", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} onRevision={vi.fn()} />);
    await ready();
    fireEvent.change(goal(), { target: { value: "Learn ordering well" } });
    const languages = screen.getByRole("textbox", { name: "Languages you are comfortable learning in" });
    fireEvent.change(languages, { target: { value: "he, en, not a code" } });
    expect(screen.getByText(/Use up to five language codes/)).toBeVisible();
    const minutes = screen.getByRole("textbox", { name: "Minutes a week you plan to study" });
    fireEvent.change(minutes, { target: { value: "5" } });
    expect(screen.getByText(/from 15 to 1200/)).toBeVisible();
    fireEvent.click(save());
    expect(await screen.findByText("Fix the highlighted details before saving.")).toBeVisible();
    expect(h.posts()).toHaveLength(0);
    fireEvent.change(languages, { target: { value: "he, en" } });
    fireEvent.change(minutes, { target: { value: "90" } });
    fireEvent.click(screen.getByRole("radio", { name: "Some experience" }));
    fireEvent.click(screen.getByRole("radio", { name: "Deep, with the details" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Captions on videos" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Plain language" }));
    expect(screen.getByRole("checkbox", { name: "Captions on videos" })).toBeChecked();
    fireEvent.click(save());
    await screen.findByText("Change saved. Assessment evidence is unchanged.");
    expect(JSON.parse(String(h.posts()[0]![1]!.body)).profile.preferences).toMatchObject({
      languages: ["he", "en"], experience: "some", depth: "deep", weeklyMinutes: 90, accessibility: ["captions", "plain_language"] });
    // Where each piece of evidence came from (C06).
    fireEvent.click(screen.getByRole("button", { name: `Show evidence references for ${title}` }));
    expect(screen.getAllByText(/Decided by an automatic check · recorded/).length).toBeGreaterThan(0);
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

  it("refreshes loaded memory with an indicator in the header instead of a row above the memory", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    const serve = h.fetcher.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.fetcher.mockImplementation(async (input, init = {}) => {
      if ((init.method ?? "GET") === "GET") await held;
      return serve(input, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));
    const indicator = await screen.findByLabelText("Loading learning memory");
    // The decision's controls and the evidence stay on screen while it reloads.
    expect(
      screen.getByRole("heading", { name: "What you have demonstrated" }),
    ).toBeVisible();
    expect(screen.getAllByLabelText("Loading learning memory")).toHaveLength(1);
    // It shares the header's badge column, which is shorter than the header.
    expect(indicator.parentElement).toBe(
      screen.getByText("Learner").parentElement!.parentElement,
    );
    expect(screen.getByText("Loading saved memory…")).toBeInTheDocument();
    release();
    await screen.findByText("Accepted suggestion");
    await waitFor(() =>
      expect(screen.queryByLabelText("Loading learning memory")).toBeNull(),
    );
  });
  it("keeps drafts through stale conflicts, requires refresh, and lets the learner compare before saving", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    // Honest about who reads which goal: this copy is private, the profile goal is not.
    expect(screen.getByText(/This goal is part of your private memory\. The learning goal on your profile .* course staff who can see your enrollment can read it/)).toBeVisible();
    expect(screen.getByText(/Course staff cannot read anything you save here/)).toBeVisible();
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

  it("shows practicing, retained, needs-review and disputed projections with their basis", async () => {
    const gated = fixture().understanding[0]! as Extract<
      MemorySnapshot["understanding"][number],
      { gateId: string }
    >;
    const cases: [MemorySnapshot["understanding"][number], string, RegExp][] = [
      [{ ...gated, status: "practicing", practiceAttempts: 2 }, "Practicing", /2 recorded answers so far/],
      [{ ...gated, status: "retained", demonstrated: true, independentFamilies: 2, retention: "retained" }, "Retained", /later check confirmed you kept it/],
      [{ ...gated, status: "needs_review", demonstrated: true, independentFamilies: 2, retention: "needs_review" }, "Needs review", /suggests reviewing it again/],
      [{ ...gated, status: "disputed", openDisputes: 1 }, "Disputed", /review you asked for is open/],
    ];
    for (const [row, label, copy] of cases) {
      const model = fixture();
      model.understanding = [row];
      const h = harness(model);
      const { unmount } = render(
        <LearnerMemoryPanel {...h.props} />,
      );
      expect(await screen.findByText(label)).toBeVisible();
      expect(screen.getByText(copy)).toBeVisible();
      unmount();
    }
  });
  it("states how uncertain a suggestion is and until when it is offered; an expired one can only be disputed (C06)", async () => {
    const snapshot = fixture();
    const first = snapshot.suggestions.items[0]!;
    snapshot.suggestions.items = [{ ...first, uncertainty: "high", expiresAt: "2026-11-20T09:00:00.000Z" },
      { ...first, proposalId: "4b2e0c0e-1d1f-4a55-9a0c-1a6c1a3f0b11", status: "expired", uncertainty: "low", expiresAt: "2026-10-01T09:00:00.000Z" }];
    const h = harness(snapshot);
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    expect(screen.getByText("Uncertain: based on one of your activities.")).toBeVisible();
    expect(screen.getByText("Fairly certain: based on several of your activities.")).toBeVisible();
    expect(screen.getByText(/^Open for your review until /)).toBeVisible();
    expect(screen.getByText("Expired · not applied")).toBeVisible();
    expect(screen.getByText(/so it was never applied\. You can still dispute it\./)).toBeVisible();
    // Accept and correct only on the open one; dispute on both.
    expect(screen.getAllByRole("button", { name: "Accept suggestion" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Dispute suggestion" })).toHaveLength(2);
    // Unknown uncertainty values or malformed expiry dates are refused, not shown.
    expect(() => parseMemorySnapshot({ ...snapshot, suggestions: { ...snapshot.suggestions, items: [{ ...first, uncertainty: "certain" } as never] } }, scope)).toThrow();
    expect(() => parseMemorySnapshot({ ...snapshot, suggestions: { ...snapshot.suggestions, items: [{ ...first, expiresAt: "soon" } as never] } }, scope)).toThrow();
  });

  it("words the server's coded skill-state reason in the reader's language, never showing server English", async () => {
    // The 0.1.56 qualification found a server sentence on the Hebrew profile: the API now
    // sends the state as a code with its values, and the app words it.
    const snapshot = fixture();
    snapshot.understanding[0] = {
      ...snapshot.understanding[0]!,
      explanation: { code: "needs_evidence", params: { independentFamilies: 1, requiredFamilies: 2 } },
    };
    for (const [locale, expected, absent] of [
      ["en", "The gate needs independent answers from more question families before this counts as demonstrated.", "נקודת הבקרה"],
      ["he", "נקודת הבקרה צריכה תשובות עצמאיות מעוד משפחות שאלות לפני שזה ייחשב כמוכח.", "question families"],
    ] as const) {
      const h = harness(snapshot);
      const { unmount, container } = render(
        <I18nProvider value={createLearnerTranslator(locale)}>
          <LearnerMemoryPanel {...h.props} />
        </I18nProvider>,
      );
      expect(await screen.findByText(expected)).toBeVisible();
      expect(container.textContent).not.toContain(absent);
      unmount();
    }
  });

  it("refuses a skill-state reason that is English text, another state's code or carries unknown values", () => {
    const model = fixture();
    const gated = model.understanding[0]!;
    for (const explanation of [
      "The gate needs independent answers from more question families before this counts as demonstrated.",
      { code: "demonstrated" },
      { code: "needs_evidence", params: { independentFamilies: "one", requiredFamilies: 2 } },
      { code: "needs_evidence", params: { independentFamilies: 1, requiredFamilies: 2, note: "x" } },
      { code: "needs_evidence", text: "More evidence" },
    ])
      expect(() => parseMemorySnapshot({ ...model, understanding: [{ ...gated, explanation } as never] }, scope)).toThrow();
    expect(parseMemorySnapshot({ ...model, understanding: [{ ...gated, explanation: { code: "needs_evidence" } }] }, scope).understanding[0]!.explanation)
      .toEqual({ code: "needs_evidence" });
  });

  it("rejects inconsistent skill projections from the server", () => {
    const model = fixture();
    const gated = model.understanding[0]! as Extract<MemorySnapshot["understanding"][number], { gateId: string }>;
    for (const row of [
      { ...gated, status: "demonstrated" as const },
      { ...gated, status: "disputed" as const, openDisputes: 0 },
      { ...gated, status: "retained" as const, retention: "retained" as const },
      { ...gated, retention: "not_assessed" },
    ]) {
      expect(() => parseMemorySnapshot({ ...model, understanding: [row] }, scope)).toThrow();
    }
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
        demonstrated: false,
        retention: "not_scheduled",
        retentionDueAt: null,
        practiceAttempts: 0,
        openDisputes: 0,
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

  it("disputes and excludes a piece of evidence without implying credit changes", async () => {
    const h = harness();
    render(<LearnerMemoryPanel {...h.props} />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Show evidence references for ${title}`,
      }),
    );
    expect(
      screen.getByText("Your companion and supervisor may use this result."),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Dispute result evidence" }),
    );
    const send = screen.getByRole("button", { name: "Send dispute" });
    expect(send).toBeDisabled();
    await userEvent.type(
      screen.getByRole("textbox", {
        name: "Why should evidence evidence be reviewed?",
      }),
      "The grader missed my working.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send dispute" }));
    await screen.findByText("Disputed");
    expect(
      screen.getByText("Change saved. Assessment evidence is unchanged."),
    ).toBeVisible();
    const [, init] = h.posts().at(-1)!;
    expect(JSON.parse(String(init!.body))).toMatchObject({
      expectedRevision: 7,
      action: "dispute",
      reason: "The grader missed my working.",
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Exclude evidence from AI context" }),
    );
    await screen.findByText(/Not used by your companion or supervisor/);
    expect(JSON.parse(String(h.posts().at(-1)![1]!.body))).toMatchObject({
      expectedRevision: 8,
      action: "exclude",
    });
    expect(JSON.parse(String(h.posts().at(-1)![1]!.body))).not.toHaveProperty(
      "reason",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Withdraw dispute evidence" }),
    );
    await screen.findByText("More independent evidence needed");
  });

  it("rejects an unsafe evidence-control receipt and invalid input", async () => {
    const h = harness();
    await expect(
      h.api.controlEvidence(scope, 7, "evidence-1", "dispute"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      h.api.controlEvidence(scope, 7, "evidence-1", "exclude", "no reason allowed"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    h.failure = (url) =>
      url.pathname.endsWith("/control")
        ? response({
            evidenceId: "evidence-1",
            action: "exclude",
            eventId: "e",
            revision: 8,
            disputed: false,
            excluded: true,
            grantsMastery: false,
            changesCredit: true,
          })
        : undefined;
    await expect(
      h.api.controlEvidence(scope, 7, "evidence-1", "exclude"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
