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
  fireEvent.click(button);
}
it("shows a supervisor preference as pending learner review and records the learner correction without credit", async () => {
  for (const [delivery, label] of [
    ["pending_learner_review", "Ready for your review · open Learning memory"],
    ["learner_corrected", "Corrected by you · no completion credit granted"],
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
      await screen.findByText("Suggest a learning preference"),
    ).toBeVisible();
    expect(await screen.findByText(label)).toBeVisible();
    view.unmount();
  }
});
it("requires an explicit choice and shows confirmed saved permission without granting completion", async () => {
  const api = client(),
    revised = vi.fn();
  mount(api, revised);
  await screen.findByRole("button", { name: "Enable personal support" });
  expect(api.setPermission).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      /independent checks and completion requirements stay the same/,
    ),
  ).toBeVisible();
  // The consent names what reaches the model: the learner's open ideas, their own words included.
  expect(
    screen.getByText(
      /the AI model your course uses also receives your open ideas about what may help you, including ones you wrote and your corrections.*Ideas you reject or that lapse are not sent, and nothing from other learners is included/,
    ),
  ).toBeVisible();
  await clickEnabled("Enable personal support");
  await screen.findByRole("button", { name: "Turn off personal support" });
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
  await clickEnabled("Enable personal support");
  await clickEnabled("Retry permission change");
  await screen.findByRole("button", { name: "Turn off personal support" });
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
});
it("does not retry an acknowledged write when refreshing course progress fails", async () => {
  const api = client();
  mount(api, vi.fn().mockRejectedValue(Error("GET failed")));
  await clickEnabled("Enable personal support");
  await screen.findByText(
    "Permission was saved. Refresh your course to see its current progress.",
  );
  expect(api.setPermission).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Retry permission change" }),
  ).toBeNull();
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
  await screen.findByRole("button", { name: "Enable personal support" });
  await act(async () => resolve(permission(true)));
  expect(
    screen.queryByRole("button", { name: "Turn off personal support" }),
  ).toBeNull();
});
it("leaves a stale write refreshable instead of silently resubmitting and rejects malformed receipts", async () => {
  const api = client();
  api.setPermission = vi
    .fn()
    .mockRejectedValue(new CourseApiError("STALE_REVISION", 409));
  mount(api);
  await clickEnabled("Enable personal support");
  await screen.findByText(/changed on another request/);
  expect(
    screen.queryByRole("button", { name: "Retry permission change" }),
  ).toBeNull();
  await clickEnabled("Refresh supervisor information");
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
  await screen.findByText("Added to your lesson · plan 2");
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
      "Draft rejected by reference checks · revision needed",
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
  await clickEnabled("Enable personal support");
  const refresh = screen.getByRole("button", {
    name: "Refresh supervisor information",
  });
  expect(refresh).toBeDisabled();
  fireEvent.click(refresh);
  expect(api.permission).toHaveBeenCalledTimes(1);
  await act(async () => reject(new CourseApiError("STALE_REVISION", 409)));
  await clickEnabled("Refresh supervisor information");
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
  expect(await screen.findByText("Research request could not run · nothing was collected")).toBeVisible();
  expect(screen.getByText("Research request ended · nothing will be collected")).toBeVisible();
  expect(screen.queryByText(/Public-source research queued/)).toBeNull();
});
