import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderEvalPanel } from "../src/components/ProviderEvalPanel";
import { ProviderSetupPanel } from "../src/components/ProviderSetupPanel";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { AdminError } from "../src/domain/errors";
import type {
  EvalRequired,
  EvalStatus,
  ProviderEvalPort,
} from "../src/domain/providerEvals";
import type { ProviderSetupPort } from "../src/domain/providerSetup";

const hex = (c: string) => c.repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const status = (): EvalStatus => ({
  suite: {
    id: "core.public-agent-evals",
    version: "1.0.0",
    digest: hex("a"),
    dialogues: 12,
    coverage: [
      { role: "companion", dialogues: 9 },
      { role: "supervisor", dialogues: 3 },
    ],
  },
  providerRevision: 3,
  gatedAtActivation: true,
  roles: [
    {
      role: "supervisor",
      strategy: "core.supervisor.plan",
      revisionDigest: hex("b"),
      covered: true,
      status: "not_evaluated",
      grandfathered: true,
      activatedBy: "unchanged",
    },
    {
      role: "companion",
      strategy: "core.companion.tutor",
      revisionDigest: hex("c"),
      covered: true,
      status: "passed",
      grandfathered: false,
      activatedBy: "passed",
      evaluatedAt: "2026-10-19T10:00:00.000Z",
    },
    {
      role: "media",
      strategy: "core.media.video",
      revisionDigest: hex("d"),
      covered: false,
      status: "not_covered",
      grandfathered: false,
      activatedBy: "not_covered",
    },
  ],
  results: [
    {
      id: uuid(1),
      role: "companion",
      revisionDigest: hex("c"),
      suiteDigest: hex("a"),
      mode: "live",
      outcome: "passed",
      actorId: uuid(9),
      createdAt: "2026-10-19T10:00:00.000Z",
      failed: [],
    },
    {
      id: uuid(2),
      role: "companion",
      revisionDigest: hex("e"),
      suiteDigest: hex("a"),
      mode: "scripted",
      outcome: "failed",
      actorId: uuid(9),
      createdAt: "2026-10-18T10:00:00.000Z",
      failed: [
        {
          dialogueId: "companion.terse.endpoint-answer",
          graders: ["hint_leakage", "diagnosis_restraint"],
        },
      ],
    },
  ],
  overrides: [
    {
      id: uuid(3),
      role: "supervisor",
      revisionDigest: hex("f"),
      suiteDigest: hex("a"),
      reason: "Reviewed transcripts by hand before the pilot.",
      actorId: uuid(8),
      createdAt: "2026-10-17T10:00:00.000Z",
    },
  ],
});
function port(): ProviderEvalPort & {
  status: ReturnType<typeof vi.fn>;
  override: ReturnType<typeof vi.fn>;
} {
  return {
    status: vi.fn().mockResolvedValue(status()),
    override: vi.fn().mockResolvedValue({
      id: uuid(4),
      role: "companion",
      revisionDigest: hex("c"),
      suiteDigest: hex("a"),
      createdAt: "2026-10-20T10:00:00.000Z",
    }),
  };
}
const required: EvalRequired = {
  suiteDigest: hex("a"),
  roles: [
    { role: "companion", revisionDigest: hex("9"), reason: "failed" },
    { role: "supervisor", revisionDigest: hex("8"), reason: "not_evaluated" },
  ],
};

describe("agent evaluation panel", () => {
  it("shows each role's status, grandfathered roles, uncovered roles, results with failing graders and overrides", async () => {
    render(<ProviderEvalPanel workspaceId="w" api={port()} />);
    const roles = await screen.findByRole("list", {
      name: "Role evaluation status",
    });
    const items = within(roles).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(
        /^supervisorNot evaluated.*bbbbbbbbbbbb.*Active before the eval gate/,
      ),
      expect.stringMatching(
        /^companionEvaluated · passed.*cccccccccccc.*passed/,
      ),
      expect.stringMatching(/^mediaNo eval suite for this role/),
    ]);
    expect(screen.getByText("companion 9 · supervisor 3")).toBeVisible();
    expect(
      screen.getByText(
        /companion\.terse\.endpoint-answer \(hint_leakage, diagnosis_restraint\)/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Reviewed transcripts by hand before the pilot."),
    ).toBeVisible();
    expect(screen.getByText(/not a real model/)).toBeVisible();
  });

  it("prefills a refused revision and records an owner override only with a valid digest and reason", async () => {
    const api = port();
    render(<ProviderEvalPanel workspaceId="w" api={api} required={required} />);
    await screen.findByRole("list", { name: "Role evaluation status" });
    expect(screen.getByText(/the recorded evaluation failed/)).toBeVisible();
    expect(screen.getByText(/no evaluation recorded/)).toBeVisible();
    expect(screen.getByLabelText("Role")).toHaveValue("companion");
    expect(screen.getByLabelText("Revision digest")).toHaveValue(hex("9"));
    const submit = screen.getByRole("button", {
      name: "Record owner override",
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "too short" },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Accepted after reviewing the held-out transcripts." },
    });
    fireEvent.change(screen.getByLabelText("Revision digest"), {
      target: { value: "not-a-digest" },
    });
    expect(submit).toBeDisabled();
    expect(screen.getByLabelText("Revision digest")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    fireEvent.change(screen.getByLabelText("Revision digest"), {
      target: { value: hex("9") },
    });
    fireEvent.click(submit);
    await screen.findByText(/Override recorded for the companion revision/);
    expect(api.override).toHaveBeenCalledWith(
      "w",
      expect.objectContaining({
        role: "companion",
        revisionDigest: hex("9"),
        reason: "Accepted after reviewing the held-out transcripts.",
      }),
    );
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
  });

  it("explains that only owners can override", async () => {
    const api = port();
    api.override.mockRejectedValue(new AdminError("permission_denied"));
    render(<ProviderEvalPanel workspaceId="w" api={api} required={required} />);
    fireEvent.change(await screen.findByLabelText("Reason"), {
      target: { value: "Accepted after reviewing the held-out transcripts." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Record owner override" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only a workspace owner can record an override.",
    );
  });
});

describe("refused activation", () => {
  const setupPort = (): ProviderSetupPort => ({
    accountId: "one",
    read: vi.fn().mockResolvedValue({
      revision: 1,
      configuration: {
        registry: { revision: "empty", models: [] },
        adapters: [],
        roles: {},
      },
      jobPolicy: {
        allowance: { microUsd: 100000, tokens: 10000 },
        durationMs: 300000,
        timeoutMs: 60000,
        maxAttempts: 3,
      },
      tokenBounds: {},
      credentials: [],
      models: [],
      roles: {},
      verification: "not_run",
      storage: "encrypted_server_vault",
      budgetIsSeparate: true,
      metadataKinds: [],
    }),
    budgets: vi.fn().mockResolvedValue({
      workspace: {
        revision: 0,
        limit_micro_usd: "0",
        limit_tokens: "0",
        used_micro_usd: "0",
        used_tokens: "0",
      },
      enrollments: [],
      maximumEnrollments: 100,
      usedIncludesReservations: true,
      configurationGrantsNoBudget: true,
    }),
    save: vi
      .fn()
      .mockRejectedValueOnce(new AdminError("eval_required", required))
      .mockResolvedValueOnce({
        revision: 2,
        configurationSaved: true,
        verification: "not_run",
        cancelledPendingJobs: 0,
        budgetChanged: false,
      }),
    saveBudget: vi.fn(),
  });
  it("reports the revisions to evaluate, then clears them after a successful save", async () => {
    const api = setupPort(),
      onRequired = vi.fn();
    render(
      <ProviderSetupPanel
        workspaceId="w"
        api={api}
        onEvaluationRequired={onRequired}
      />,
    );
    const save = await screen.findByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    });
    fireEvent.click(save);
    expect(
      await screen.findByText(/has no passing agent evaluation/),
    ).toBeVisible();
    expect(onRequired).toHaveBeenLastCalledWith(required);
    fireEvent.click(save);
    await screen.findByText(/Configuration saved\./);
    expect(onRequired).toHaveBeenLastCalledWith(undefined);
    expect(api.save).toHaveBeenCalledTimes(2);
  });
  it("the fetch client keeps only schema-checked refusal details", async () => {
    const body = {
      error: "PROVIDER_EVAL_REQUIRED",
      details: {
        suiteId: "core.public-agent-evals",
        suiteDigest: hex("a"),
        roles: [
          {
            role: "companion",
            revisionDigest: hex("9"),
            reason: "not_evaluated",
            note: "dropped",
          },
        ],
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(body, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json(
          { ...body, details: { roles: "<script>" } },
          { status: 409 },
        ),
      );
    const client = createFetchAdminClient({ baseUrl: "/api", fetch: fetcher });
    const input = {
      expectedRevision: 1,
      idempotencyKey: "key-12345",
      configuration: {},
      jobPolicy: {
        allowance: { microUsd: 1, tokens: 1 },
        durationMs: 1000,
        timeoutMs: 100,
        maxAttempts: 1,
      },
      credentials: {},
    };
    const first = await client
      .providerSetup!.save("w", input)
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AdminError);
    expect((first as AdminError).code).toBe("eval_required");
    expect((first as AdminError).details).toEqual({
      suiteDigest: hex("a"),
      roles: [
        {
          role: "companion",
          revisionDigest: hex("9"),
          reason: "not_evaluated",
        },
      ],
    });
    const second = await client
      .providerSetup!.save("w", input)
      .catch((e: unknown) => e);
    expect((second as AdminError).code).toBe("eval_required");
    expect((second as AdminError).details).toBeUndefined();
  });
  it("the fetch client reads status and posts overrides to the workspace routes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status()))
      .mockResolvedValueOnce(
        Response.json({
          id: uuid(4),
          role: "companion",
          revisionDigest: hex("c"),
          suiteDigest: hex("a"),
          createdAt: "2026-10-20T10:00:00.000Z",
        }),
      );
    const client = createFetchAdminClient({ baseUrl: "/api", fetch: fetcher });
    expect((await client.providerEvals!.status("w s")).roles).toHaveLength(3);
    expect(fetcher.mock.calls[0]![0]).toBe(
      "/api/workspaces/w%20s/provider-evals",
    );
    await client.providerEvals!.override("w", {
      idempotencyKey: "key-12345",
      role: "companion",
      revisionDigest: hex("c"),
      reason: "A sufficiently long reason.",
    });
    expect(fetcher.mock.calls[1]![0]).toBe(
      "/api/workspaces/w/provider-evals/overrides",
    );
    expect(fetcher.mock.calls[1]![1]!.method).toBe("POST");
  });
});
