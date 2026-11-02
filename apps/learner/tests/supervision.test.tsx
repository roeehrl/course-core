import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createCourseApi, CourseApiError } from "../src/client/apiClient";
import {
  createSupervisionClient,
  parseToolCalls,
  type SupervisionClient,
  type SupervisionPermission,
} from "../src/client/supervisionClient";
import { SupervisionPanel } from "../src/components/SupervisionPanel";
import { connectedSnapshot } from "./connectedFixtures";
import { pressWhenReady } from "./pressWhenReady";
const permission = (
  adaptiveTeaching = false,
  revision = 3,
): SupervisionPermission => ({
  revision,
  permissionRevision: 1,
  adaptiveTeaching,
  authority: "learner_opt_in",
});
const response = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200 });
const snapshot = () => ({ ...connectedSnapshot(), revision: 3 });
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
function client(): SupervisionClient {
  return {
    permission: vi.fn().mockResolvedValue(permission()),
    tools: vi.fn().mockResolvedValue([]),
    setPermission: vi.fn().mockResolvedValue(permission(true, 4)),
  };
}
function mount(
  api: SupervisionClient,
  onRevision = vi.fn(),
  mode: "settings" | "timeline" = "settings",
) {
  return render(
    <SupervisionPanel
      accountId="one"
      enrollment={snapshot()}
      client={api}
      mode={mode}
      onRevision={onRevision}
    />,
  );
}
async function clickEnabled(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  await pressWhenReady(button);
}
it("shows a supervisor preference as pending learner review and records the learner correction without credit", async () => {
  for (const [delivery, label] of [
    ["pending_learner_review", "Ready for your review in Learning memory."],
    ["learner_corrected", "You corrected it. It doesn't count toward your progress."],
  ] as const) {
    const api = client();
    api.tools = vi.fn().mockResolvedValue(
      parseToolCalls({
        calls: [
          {
            id: "receipt",
            jobId: "job",
            step: 1,
            tool: "suggest_model",
            createdAt: "2026-01-01T00:00:00Z",
            jobState: "applied",
            appliedPlanRevision: null,
            outcome: {
              available: null,
              reason: null,
              selected: false,
              profileId: null,
              entryId: null,
              modelSuggestion: true,
              delivery,
            },
            contextRefs: {
              messageIds: [],
              sourceIds: [],
              modelSourceEventIds: ["event"],
            },
          },
        ],
      }),
    );
    const view = mount(api, vi.fn(), "timeline");
    expect(
      await screen.findByText("Suggested a learning preference"),
    ).toBeVisible();
    expect(await screen.findByText(label)).toBeVisible();
    view.unmount();
  }
});
it("holds the badge and button footprint while the permission loads, without a placeholder control", async () => {
  const api = client();
  let resolve!: (value: SupervisionPermission) => void;
  api.permission = vi.fn(
    () => new Promise<SupervisionPermission>((r) => (resolve = r)),
  );
  const { container } = mount(api);
  expect(
    screen.getAllByLabelText("Loading your companion's work"),
  ).toHaveLength(1);
  // Only the disclosure is offered (no bare Refresh under the card); the reserved button is inert
  // and hidden.
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "What this shares",
  ]);
  // Icons are drawn aria-hidden; the reserved chip and button are the only other hidden elements,
  // and neither says anything a screen reader could reach.
  const hidden = container.querySelectorAll('[aria-hidden="true"]:not(svg)');
  expect(hidden).toHaveLength(2);
  expect(hidden[1]!.textContent?.trim()).toBe("");
  expect(hidden[0]!.querySelector(".cc-prof-placeholder")).not.toBeNull();
  await act(async () => resolve(permission()));
  expect(screen.getByText("Off")).toBeVisible();
  expect(screen.getByRole("button", { name: "Turn on" })).toBeEnabled();
  expect(screen.queryByLabelText("Loading your companion's work")).toBeNull();
  // Only the chip slot's width keeper stays hidden ("On" is the widest chip, so the title line wraps
  // the same whether the chip says On or Off); the reserved button is gone.
  const kept = container.querySelectorAll('[aria-hidden="true"]:not(svg)');
  expect(kept).toHaveLength(1);
  expect(kept[0]!.querySelector(".cc-prof-placeholder")).not.toBeNull();
});
it("requires an explicit choice and shows confirmed saved permission without granting completion", async () => {
  const api = client(),
    revised = vi.fn();
  mount(api, revised);
  await screen.findByRole("button", { name: "Turn on" });
  expect(api.setPermission).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      "While this is on, your companion can add reviewed explanations and practice for you, within your course's limits. You can turn it off at any time.",
    ),
  ).toBeVisible();
  // "What this shares" names what reaches the model: the open ideas, the learner's own words included.
  const shares = screen.getByRole("button", { name: "What this shares" });
  expect(shares).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/also sees your open ideas/)).toBeNull();
  await pressWhenReady(shares);
  expect(shares).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("While it's on, your companion also sees your open ideas.")).toBeVisible();
  expect(
    screen.getByText(
      /includes ideas you wrote and your corrections\. Ideas you reject or that lapse aren't shared, nothing from other learners is included, and your checks and what finishing the course needs stay the same/,
    ),
  ).toBeVisible();
  await clickEnabled("Turn on");
  await screen.findByRole("button", { name: "Turn off" });
  expect(api.setPermission).toHaveBeenCalledWith(
    expect.objectContaining({ revision: 3 }),
    true,
  );
  await waitFor(() => expect(revised).toHaveBeenCalledWith(4));
});
it("retries a lost permission acknowledgement with exactly the original id and revision", async () => {
  let posts = 0;
  const payloads: unknown[] = [],
    fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        payloads.push(JSON.parse(String(init.body)));
        if (!posts++) throw Error("lost ack");
        return response(permission(true, 4));
      }
      return response(permission());
    });
  const api = createSupervisionClient(
    createCourseApi({
      fetch: fetcher as typeof fetch,
      pending: memory(),
      accountId: "one",
    }),
  );
  mount(api);
  await clickEnabled("Turn on");
  await clickEnabled("Try again");
  await screen.findByRole("button", { name: "Turn off" });
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
});
it("does not retry an acknowledged write when refreshing course progress fails", async () => {
  const api = client();
  mount(api, vi.fn().mockRejectedValue(Error("GET failed")));
  await clickEnabled("Turn on");
  await screen.findByText(
    "Your choice was saved. Refresh your course to see its current progress.",
  );
  expect(api.setPermission).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});
it("clears private state on account switch even if the old read ignores cancellation", async () => {
  let resolve!: (v: SupervisionPermission) => void;
  const old = client();
  old.permission = vi.fn(
    () =>
      new Promise<SupervisionPermission>((done) => {
        resolve = done;
      }),
  );
  const view = mount(old),
    next = client();
  view.rerender(
    <SupervisionPanel
      accountId="two"
      enrollment={snapshot()}
      client={next}
      mode="settings"
      onRevision={() => {}}
    />,
  );
  await screen.findByRole("button", { name: "Turn on" });
  await act(async () => resolve(permission(true)));
  expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
});
it("leaves a stale write refreshable instead of silently resubmitting and rejects malformed receipts", async () => {
  const api = client();
  api.setPermission = vi
    .fn()
    .mockRejectedValue(new CourseApiError("STALE_REVISION", 409));
  mount(api);
  await clickEnabled("Turn on");
  await screen.findByText(/changed on another request/);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await clickEnabled("Refresh");
  await waitFor(() => expect(api.permission).toHaveBeenCalledTimes(2));
  expect(api.setPermission).toHaveBeenCalledTimes(1);
  expect(() =>
    parseToolCalls({
      calls: [{ tool: "get_profile", outcome: { markdown: "private" } }],
    }),
  ).toThrow();
});
it("shows actual delivery status without rendering provider or hidden text", async () => {
  const calls = parseToolCalls({
    calls: [
      {
        id: "receipt",
        jobId: "job",
        step: 1,
        tool: "choose_support",
        createdAt: "2026-01-01T00:00:00Z",
        jobState: "applied",
        appliedPlanRevision: 2,
        outcome: {
          available: null,
          reason: null,
          selected: true,
          profileId: "p",
          entryId: "e",
          delivery: "applied",
          markdown: "HIDDEN_CONTENT",
        },
        contextRefs: { messageIds: [], sourceIds: [] },
        secret: "SECRET",
      },
    ],
  });
  expect(JSON.stringify(calls)).not.toContain("HIDDEN_CONTENT");
  expect(JSON.stringify(calls)).not.toContain("SECRET");
  const api = client();
  api.tools = vi.fn().mockResolvedValue(calls);
  mount(api, vi.fn(), "timeline");
  await screen.findByText("Added to your lesson.");
  // One row: an icon, the line, the status chip and the time.
  expect(screen.getByText("Picked a reviewed explanation for you")).toBeVisible();
  expect(screen.queryByText("HIDDEN_CONTENT")).toBeNull();
  expect(api.setPermission).not.toHaveBeenCalled();
});
it("reference feedback remains distinct from lesson delivery and cannot smuggle private checker output into the timeline", async () => {
  const call = {
    id: "receipt",
    jobId: "job",
    step: 2,
    tool: "check_teaching",
    createdAt: "2026-01-01T00:00:00Z",
    jobState: "applied",
    appliedPlanRevision: null,
    outcome: {
      available: null,
      reason: null,
      selected: false,
      profileId: null,
      entryId: null,
      delivery: "feedback_only",
      verification: "rejected",
      failedCheckIds: ["reference"],
      privateProgram: "WITHHELD_CHECKER_CANARY",
    },
    contextRefs: { messageIds: [], sourceIds: [] },
  };
  const parsed = parseToolCalls({ calls: [call] });
  expect(JSON.stringify(parsed)).not.toContain("WITHHELD_CHECKER_CANARY");
  const api = client();
  api.tools = vi.fn().mockResolvedValue(parsed);
  mount(api, vi.fn(), "timeline");
  expect(
    await screen.findByText(
      "The draft didn't pass the course's checks, so it needs revising.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(/Added to your lesson/)).toBeNull();
  for (const changed of [
    { verification: "proven_mastery" },
    { failedCheckIds: Array(65).fill("reference") },
  ])
    expect(() =>
      parseToolCalls({
        calls: [{ ...call, outcome: { ...call.outcome, ...changed } }],
      }),
    ).toThrow();
});

it("does not refresh while a permission write is pending, then permits explicit refresh after its rejection", async () => {
  let reject!: (error: Error) => void;
  const api = client();
  api.setPermission = vi.fn(
    () =>
      new Promise<SupervisionPermission>((_, failed) => {
        reject = failed;
      }),
  );
  mount(api);
  await clickEnabled("Turn on");
  // While the write is pending nothing offers to read again.
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(api.permission).toHaveBeenCalledTimes(1);
  await act(async () => reject(new CourseApiError("STALE_REVISION", 409)));
  // The error line offers it.
  expect(screen.getByRole("alert")).toContainElement(screen.getByRole("button", { name: "Refresh" }));
  await clickEnabled("Refresh");
  await waitFor(() => expect(api.permission).toHaveBeenCalledTimes(2));
  expect(api.setPermission).toHaveBeenCalledTimes(1);
});
it("a research request that ended without running says so instead of looking queued", async () => {
  const call = (researchState: string, id: string) => ({
    id,
    jobId: "job",
    step: 3,
    tool: "request_research",
    createdAt: "2026-01-01T00:00:00Z",
    jobState: "applied",
    appliedPlanRevision: null,
    outcome: {
      available: null,
      reason: null,
      selected: false,
      profileId: null,
      entryId: null,
      delivery: null,
      researchState,
    },
    contextRefs: { messageIds: [], sourceIds: [] },
  });
  const parsed = parseToolCalls({ calls: [call("refused", "a"), call("cancelled", "b")] });
  expect(parsed.map((c) => c.outcome.researchState)).toEqual(["refused", "cancelled"]);
  expect(() => parseToolCalls({ calls: [call("granted_mastery", "c")] })).toThrow();
  const api = client();
  api.tools = vi.fn().mockResolvedValue(parsed);
  mount(api, vi.fn(), "timeline");
  expect(await screen.findByText("Couldn't look for sources, so nothing was collected.")).toBeVisible();
  expect(screen.getByText("Stopped looking for sources. Nothing will be collected.")).toBeVisible();
  expect(screen.queryByText(/Looking for public sources/)).toBeNull();
});
it("shows the receipts of a run that ended without delivery as ended, never as pending", async () => {
  const receipt = (id: string, tool: string, jobState: string, outcome: Record<string, unknown>) => ({
    id, jobId: "job", step: 1, tool, createdAt: "2026-01-01T00:00:00Z", jobState, appliedPlanRevision: null,
    outcome: { available: true, reason: null, selected: false, profileId: null, entryId: null, modelSuggestion: false, delivery: null, ...outcome },
    contextRefs: { messageIds: [], sourceIds: [], modelSourceEventIds: [] },
  });
  for (const [jobState, research, check, selection] of [
    ["failed", "Didn't look for sources, so nothing was collected.", "The draft passed the course's checks but wasn't added.", "This choice wasn't added."],
    ["running", "Getting ready to look for sources. This needs a review first.", "The draft passed the course's checks. It still needs a final review.", "Picked. It's checked before it's added."],
  ] as const) {
    const api = client();
    api.tools = vi.fn().mockResolvedValue(parseToolCalls({ calls: [
      receipt("research", "request_research", jobState, { researchState: "staged" }),
      receipt("check", "check_teaching", jobState, { verification: "passed", failedCheckIds: [] }),
      receipt("choose", "choose_support", jobState, { selected: true, profileId: "profile", entryId: "entry" }),
    ] }));
    const view = mount(api, vi.fn(), "timeline");
    expect(await screen.findByText(research)).toBeVisible();
    expect(screen.getByText(check)).toBeVisible();
    expect(screen.getByText(selection)).toBeVisible();
    view.unmount();
  }
});

it("says what paid supervisor work still runs while personal support is off, and that it changes nothing", async () => {
  mount(client());
  await screen.findByRole("button", { name: "Turn on" });
  await pressWhenReady(screen.getByRole("button", { name: "What this shares" }));
  // Supervisor review is admitted by the course's settings and spending limits, not by this opt-in.
  expect(
    screen.getByText(
      /Even while it's off, your companion may review your answers, results and saved questions, within the AI spending limits your course team set.*It can't change your lessons while it's off/,
    ),
  ).toBeVisible();
  mount(client(), vi.fn(), "timeline");
  expect(screen.getAllByText(/Even while it's off/)).toHaveLength(1);
});

it("names the panel and its states in Hebrew: one name for the helper, chips and verbal-noun buttons", async () => {
  const { I18nProvider, createLearnerTranslator } = await import("../src/i18n");
  const api = client();
  api.tools = vi.fn().mockResolvedValue(
    parseToolCalls({
      calls: [
        {
          id: "receipt", jobId: "job", step: 1, tool: "get_history", createdAt: "2026-01-01T00:00:00Z", jobState: "applied", appliedPlanRevision: null,
          outcome: { available: null, reason: "independent_assessment_active", selected: false, profileId: null, entryId: null, delivery: null },
          contextRefs: { messageIds: ["m1"], sourceIds: [] },
        },
      ],
    }),
  );
  render(
    <I18nProvider value={createLearnerTranslator("he")}>
      <SupervisionPanel accountId="one" enrollment={snapshot()} client={api} mode="settings" onRevision={() => {}} />
      <SupervisionPanel accountId="one" enrollment={snapshot()} client={api} mode="timeline" onRevision={() => {}} />
    </I18nProvider>,
  );
  expect(await screen.findByRole("heading", { name: "תמיכה אישית בשיעורים" })).toBeVisible();
  expect(await screen.findByText("כבויה")).toBeVisible();
  expect(screen.getByRole("button", { name: "הפעלה" })).toBeEnabled();
  expect(screen.getByRole("heading", { name: "פעולות המנחה" })).toBeVisible();
  expect(await screen.findByText("קריאת השיחה השמורה")).toBeVisible();
  expect(screen.getByText("אין שינוי בזמן בדיקה.")).toBeVisible();
  // No jargon counts of what was read.
  expect(screen.queryByText(/הקשר:/)).toBeNull();
});
