import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiServicesPage } from "../src/components/aiServices/AiServicesPage";
import { AdminApp } from "../src/AdminApp";
import { ProvidersView } from "../src/views/ProvidersView";
import {
  AiServicesError,
  pageStatus,
  parseUsd,
  usdInput,
  type AiServicesPort,
  type Connections,
  type Draft,
} from "../src/domain/aiServices";
import type { ProviderSetup } from "../src/domain/providerSetup";
import {
  aiServicesMessages,
  aiTranslator,
  formatMessage,
} from "../src/text/aiServices";
import { firstRunMessages } from "../src/text/firstRun";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { demoSession, demoWorkspace } from "../src/data/fixtures";
import { demo } from "./helpers";

const workspace = "00000000-0000-4000-8000-000000000001";
const key = ["SYNTHETIC", "UNIT", "KEY", "7Q2c"].join("_");
const t = aiTranslator("en").t;
const jobPolicy = {
  allowance: { microUsd: 100000, tokens: 600000 },
  durationMs: 300000,
  timeoutMs: 60000,
  maxAttempts: 3,
};
function setup(
  configuration: unknown = {
    registry: { revision: "x", models: [] },
    adapters: [],
    roles: {},
  },
  revision = 0,
): ProviderSetup {
  return {
    revision,
    configuration,
    jobPolicy,
    tokenBounds: {},
    credentials: [],
    models: [],
    roles: {},
    verification: "not_run",
    storage: "encrypted_server_vault",
    budgetIsSeparate: true,
    metadataKinds: [
      {
        kind: "google",
        label: "Google",
        guided: true,
        pricingUrl: "https://example.org/pricing",
        keyHelpUrl: "https://example.org/key",
      },
      { kind: "anthropic", label: "Anthropic", guided: true },
    ],
  };
}
const activeConfiguration = {
  registry: {
    revision: "x",
    models: [
      {
        id: "connection-1:companion",
        providerId: "connection-1",
        remoteModel: "gemini-9.0-flash",
      },
      {
        id: "connection-1:supervisor",
        providerId: "connection-1",
        remoteModel: "gemini-9.0-flash",
      },
    ],
  },
  adapters: [
    {
      id: "connection-1",
      kind: "google",
      credentialEnv: "COURSE_PROVIDER_0123456789ABCDEF_API_KEY",
    },
  ],
  roles: {
    companion: {
      modelId: "connection-1:companion",
      maxInputCharacters: 12000,
      maxOutputTokens: 1000,
    },
    supervisor: {
      modelId: "connection-1:supervisor",
      maxInputCharacters: 30000,
      maxOutputTokens: 1000,
    },
  },
};
const connection = {
  id: "connection-1",
  kind: "google",
  label: "Google",
  name: "",
  keyEnding: "7Q2c",
  keyStored: true,
  keyStatus: "working" as const,
  keyReason: null,
  testedAt: new Date().toISOString(),
  usedByRoles: [],
};
const noConnections: Connections = {
  revision: 0,
  connections: [],
  serviceKeys: [{ id: "youtube", configured: false }],
  keyStorage: "encrypted_server_vault",
};
const draft: Draft = {
  id: "00000000-0000-4000-8000-0000000000d1",
  baseRevision: 2,
  source: "models",
  stale: false,
  roles: [
    {
      role: "companion",
      modelId: "connection-1:companion",
      connectionId: "connection-1",
      remoteModel: "gemini-9.0-flash",
      mediaKind: null,
      check: "needed",
      priced: true,
      changed: true,
    },
    {
      role: "supervisor",
      modelId: "connection-1:supervisor",
      connectionId: "connection-1",
      remoteModel: "gemini-9.0-flash",
      mediaKind: null,
      check: "not_needed",
      priced: true,
      changed: true,
    },
  ],
  removedRoles: [],
  jobPolicy,
  waitingForCheck: ["companion"],
  updatedAt: new Date().toISOString(),
  secretsIncluded: false,
};
const budgets = (total = "0", learner: string | null = null) => ({
  workspace: {
    revision: total === "0" ? 0 : 1,
    limit_micro_usd: total,
    limit_tokens: "0",
    used_micro_usd: "0",
    used_tokens: "0",
  },
  defaultEnrollment: {
    revision: learner ? 1 : 0,
    limit_micro_usd: learner,
    limit_tokens: learner ? "1000000000" : null,
  },
  enrollments: [],
});
function fakePort(
  overrides: Partial<Record<keyof AiServicesPort, unknown>> = {},
) {
  const port = {
    setup: vi.fn().mockResolvedValue(setup()),
    connections: vi.fn().mockResolvedValue(noConnections),
    testKey: vi.fn().mockResolvedValue({
      kind: "google",
      outcome: "ok",
      modelCount: 3,
      truncated: false,
      stored: false,
      generationPerformed: false,
    }),
    addConnection: vi.fn().mockResolvedValue({
      revision: 1,
      connection: {
        id: "connection-1",
        kind: "google",
        keyEnding: "7Q2c",
        keyStatus: "working",
      },
    }),
    replaceKey: vi.fn(),
    testConnection: vi.fn(),
    removeConnection: vi.fn(),
    models: vi.fn().mockResolvedValue({
      connectionId: "connection-1",
      kind: "google",
      models: [
        {
          remoteModel: "gemini-9.0-flash",
          displayName: "Gemini 9 Flash",
          description: "",
          inputTokenLimit: 1000000,
          outputTokenLimit: 8000,
          methods: ["generateContent"],
        },
      ],
      truncated: false,
      roles: ["companion", "supervisor", "research", "reviewer", "media"].map(
        (role) => ({
          role,
          needed: role === "companion" || role === "supervisor",
          method: "generateContent",
          videoMethod: null,
          offered: true,
          suggested: role === "media" ? null : "gemini-9.0-flash",
        }),
      ),
      generationPerformed: false,
    }),
    currentDraft: vi.fn().mockResolvedValue(null),
    draftFromModels: vi.fn().mockResolvedValue(draft),
    draftFromJson: vi.fn(),
    discardDraft: vi.fn(),
    activate: vi.fn().mockResolvedValue({
      revision: 3,
      configurationSaved: true,
      cancelledPendingJobs: 0,
      evaluation: {},
    }),
    approve: vi.fn().mockResolvedValue({}),
    pricing: vi.fn().mockResolvedValue({
      requirePricing: true,
      settingsRevision: 0,
      currency: "USD",
      builtInPrices: false,
      models: [],
    }),
    savePrice: vi.fn(),
    saveCostSettings: vi.fn(),
    budgets: vi.fn().mockResolvedValue(budgets()),
    saveBudget: vi.fn().mockResolvedValue({
      revision: 1,
      scope: "workspace",
      consentRecorded: true,
    }),
    evals: vi.fn().mockResolvedValue({
      suite: {
        id: "s",
        version: "1",
        digest: "a".repeat(64),
        dialogues: 12,
        coverage: [{ role: "companion", dialogues: 9 }],
      },
      providerRevision: 0,
      gatedAtActivation: true,
      roles: [],
      results: [],
      overrides: [],
    }),
    spend: vi.fn(),
    setServiceKey: vi.fn(),
    ...overrides,
  };
  return port as unknown as AiServicesPort &
    Record<keyof AiServicesPort, ReturnType<typeof vi.fn>>;
}

describe("AI services text", () => {
  it("has every English key in Hebrew with the same arguments", () => {
    const args = (m: string) =>
      [...m.matchAll(/\{(\w+)[,}]/g)].map((x) => x[1]).sort();
    for (const [key, message] of Object.entries(aiServicesMessages.en)) {
      const he =
        aiServicesMessages.he[key as keyof typeof aiServicesMessages.en];
      expect(he, key).toBeTruthy();
      expect(new Set(args(he)), key).toEqual(new Set(args(message)));
    }
    for (const key of Object.keys(firstRunMessages.en))
      expect(
        firstRunMessages.he[key as keyof typeof firstRunMessages.en],
      ).toBeTruthy();
  });
  it("formats ICU plurals in English and Hebrew (one, two, other)", () => {
    expect(
      formatMessage("en", aiServicesMessages.en["issue.prices"], { count: 1 }),
    ).toBe("1 model needs a price");
    expect(
      formatMessage("en", aiServicesMessages.en["issue.prices"], { count: 3 }),
    ).toBe("3 models need a price");
    expect(
      formatMessage("he", aiServicesMessages.he["issue.prices"], { count: 2 }),
    ).toBe("שני מודלים צריכים מחיר");
    expect(
      formatMessage("he", aiServicesMessages.he["issue.prices"], { count: 5 }),
    ).toBe("5 מודלים צריכים מחיר");
  });
  it("isolates left-to-right values only in right-to-left text and formats money", () => {
    expect(aiTranslator("en").ltr("7Q2c")).toBe("7Q2c");
    expect(aiTranslator("he").ltr("7Q2c")).toBe("⁦7Q2c⁩");
    expect(aiTranslator("en").money(25_000_000)).toBe("$25.00");
    expect(aiTranslator("en").money(4_000)).toBe("$0.0040");
    expect(parseUsd("0.30")).toBe(300_000);
    expect(parseUsd("$25")).toBe(25_000_000);
    expect(parseUsd("0.1234567")).toBeNull();
    expect(parseUsd("-1")).toBeNull();
    expect(usdInput(2_000_000)).toBe("2.00");
    expect(usdInput(37_500)).toBe("0.0375");
  });
});

describe("page status", () => {
  it("lists what is missing for an empty workspace and nothing once everything is set", () => {
    const empty = pageStatus({
      connections: noConnections,
      setup: setup(),
      draft: null,
      pricing: null,
      budgets: budgets(),
    });
    expect(empty.on).toBe(false);
    expect(empty.issues.map((i) => i.kind)).toEqual([
      "connect",
      "models",
      "spending",
    ]);
    const waiting = pageStatus({
      connections: { ...noConnections, connections: [connection] },
      setup: setup(),
      draft: {
        ...draft,
        roles: draft.roles.map((r) => ({ ...r, priced: false })),
      },
      pricing: null,
      budgets: budgets("25000000", null),
    });
    expect(waiting.issues.map((i) => i.kind)).toEqual([
      "check",
      "prices",
      "learnerLimit",
    ]);
    expect(waiting.sections.models.pill).toBe("waitingCheck");
    const on = pageStatus({
      connections: { ...noConnections, connections: [connection] },
      setup: setup(activeConfiguration, 3),
      draft: null,
      pricing: {
        requirePricing: true,
        settingsRevision: 0,
        currency: "USD",
        builtInPrices: false,
        models: ["companion", "supervisor"].map((role) => ({
          modelId: `connection-1:${role}`,
          configured: true,
          roles: [role],
          inForce: null,
          latestVersion: 1,
          coverage: [{ role, priced: true }],
          history: [],
        })),
      },
      budgets: budgets("25000000", "2000000"),
    });
    expect(on).toMatchObject({ on: true, issues: [] });
    const rejected = pageStatus({
      connections: {
        ...noConnections,
        connections: [{ ...connection, keyStatus: "rejected" }],
      },
      setup: setup(activeConfiguration, 3),
      draft: null,
      pricing: null,
      budgets: budgets(),
    });
    expect(rejected.sections.connections).toEqual({
      tone: "bad",
      pill: "keyProblem",
      count: 1,
    });
  });
});

describe("AI services page", () => {
  it("refuses an empty key without a request, explains a rejected key and keeps it, then saves the trimmed key", async () => {
    const port = fakePort();
    port.testKey.mockResolvedValueOnce({
      kind: "google",
      outcome: "PROVIDER_METADATA_KEY_INVALID",
      modelCount: null,
      truncated: null,
      stored: false,
      generationPerformed: false,
    });
    render(
      <AiServicesPage
        workspaceId={workspace}
        port={port}
        role="owner"
        locale="en"
      />,
    );
    const save = await screen.findByRole("button", { name: t("connect.save") });
    fireEvent.click(save);
    expect(
      await screen.findAllByText("Enter your Google API key"),
    ).not.toHaveLength(0);
    expect(port.testKey).not.toHaveBeenCalled();
    expect(port.addConnection).not.toHaveBeenCalled();
    const field = screen.getByLabelText(t("connect.keyLabel"));
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("dir", "ltr");
    fireEvent.change(field, { target: { value: "WRONG_SYNTHETIC_KEY" } });
    fireEvent.blur(field);
    expect(
      await screen.findByText(/Google rejected this key/),
    ).toBeInTheDocument();
    expect(field).toHaveValue("WRONG_SYNTHETIC_KEY");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(port.addConnection).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: `  ${key}\n` } });
    port.connections.mockResolvedValue({
      ...noConnections,
      revision: 1,
      connections: [connection],
    });
    fireEvent.click(screen.getByRole("button", { name: t("connect.save") }));
    expect(
      await screen.findByText("Connection saved. Key ending 7Q2c."),
    ).toBeInTheDocument();
    expect(port.addConnection).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({ kind: "google", key, expectedRevision: 0 }),
    );
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("proposes $25 in total and $2 per learner; the button is the consent; a lost answer retries with the same key", async () => {
    const port = fakePort();
    port.saveBudget.mockRejectedValueOnce(
      new AiServicesError("UNAVAILABLE", 0),
    );
    render(
      <AiServicesPage
        workspaceId={workspace}
        port={port}
        role="owner"
        locale="en"
      />,
    );
    const allow = await screen.findByRole("button", {
      name: "Allow spending up to $25.00",
    });
    const learner = screen.getByLabelText(t("spending.perLearner"));
    expect(learner).toHaveValue("2.00");
    fireEvent.change(learner, { target: { value: "30" } });
    fireEvent.click(allow);
    expect(
      await screen.findAllByText(t("spending.errLearnerMore")),
    ).not.toHaveLength(0);
    expect(port.saveBudget).not.toHaveBeenCalled();
    fireEvent.change(learner, { target: { value: "2.00" } });
    fireEvent.click(allow);
    expect(await screen.findByText(t("err.unavailable"))).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Allow spending up to $25.00" }),
    );
    await waitFor(() => expect(port.saveBudget).toHaveBeenCalledTimes(3));
    const [first, second, third] = port.saveBudget.mock.calls.map((c) => c[1]);
    expect(first).toMatchObject({
      scope: "workspace",
      limits: { microUsd: 25_000_000 },
      paidWorkApproved: true,
    });
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(third).toMatchObject({
      scope: "default_enrollment",
      limits: { microUsd: 2_000_000 },
      paidWorkApproved: true,
    });
  });

  it("only an owner approves without checking; approval names the draft and job, then turns it on", async () => {
    const base = {
      setup: vi.fn().mockResolvedValue(setup(activeConfiguration, 2)),
      connections: vi
        .fn()
        .mockResolvedValue({ ...noConnections, connections: [connection] }),
      currentDraft: vi.fn().mockResolvedValue(draft),
    };
    const admin = fakePort(base);
    const { unmount } = render(
      <AiServicesPage
        workspaceId={workspace}
        port={admin}
        role="admin"
        locale="en"
      />,
    );
    expect(
      await screen.findByText(t("check.approveOwnersOnly")),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: t("check.approve") }),
    ).toBeNull();
    unmount();
    const owner = fakePort(base);
    render(
      <AiServicesPage
        workspaceId={workspace}
        port={owner}
        role="owner"
        locale="en"
      />,
    );
    const check = await screen.findByRole("region", {
      name: t("section.check"),
    });
    expect(
      within(check).getAllByText("gemini-9.0-flash")[0]!.closest("bdi"),
    ).toHaveAttribute("dir", "ltr");
    expect(
      within(check).getByText(t("check.explain", { dialogues: 9 })),
    ).toBeInTheDocument();
    fireEvent.change(within(check).getByLabelText(t("check.reasonLabel")), {
      target: { value: "Too short" },
    });
    fireEvent.click(
      within(check).getByRole("button", { name: t("check.approve") }),
    );
    expect(
      await within(check).findAllByText(t("check.errReason")),
    ).not.toHaveLength(0);
    expect(owner.approve).not.toHaveBeenCalled();
    fireEvent.change(within(check).getByLabelText(t("check.reasonLabel")), {
      target: { value: "Synthetic pilot: checked by hand." },
    });
    fireEvent.click(
      within(check).getByRole("button", { name: t("check.approve") }),
    );
    await waitFor(() => expect(owner.activate).toHaveBeenCalled());
    expect(owner.approve).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        draftId: draft.id,
        role: "companion",
        reason: "Synthetic pilot: checked by hand.",
      }),
    );
    expect(owner.approve.mock.calls[0]![1]).not.toHaveProperty(
      "revisionDigest",
    );
    expect(owner.activate).toHaveBeenCalledWith(
      workspace,
      draft.id,
      expect.objectContaining({
        expectedRevision: 2,
        confirmCancelRunning: false,
      }),
    );
  });

  it("asks before stopping unfinished jobs and stops them only when confirmed", async () => {
    const port = fakePort({
      setup: vi.fn().mockResolvedValue(setup(activeConfiguration, 2)),
      connections: vi
        .fn()
        .mockResolvedValue({ ...noConnections, connections: [connection] }),
      currentDraft: vi.fn().mockResolvedValue({
        ...draft,
        waitingForCheck: [],
        roles: draft.roles.map((r) => ({ ...r, check: "passed" })),
      }),
    });
    port.activate.mockRejectedValueOnce(
      new AiServicesError("PROVIDER_JOBS_RUNNING", 409, { count: 2 }),
    );
    render(
      <AiServicesPage
        workspaceId={workspace}
        port={port}
        role="owner"
        locale="en"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: t("models.turnOn") }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: t("confirm.title"),
    });
    expect(dialog).toHaveTextContent(
      "Turning this on stops 2 unfinished jobs.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: t("confirm.go") }),
    );
    await waitFor(() => expect(port.activate).toHaveBeenCalledTimes(2));
    expect(port.activate.mock.calls[1]![2]).toMatchObject({
      confirmCancelRunning: true,
    });
  });

  it("renders right to left in Hebrew with ids and key endings isolated left to right", async () => {
    const port = fakePort({
      setup: vi.fn().mockResolvedValue(setup(activeConfiguration, 2)),
      connections: vi
        .fn()
        .mockResolvedValue({ ...noConnections, connections: [connection] }),
    });
    const { container } = render(
      <AiServicesPage
        workspaceId={workspace}
        port={port}
        role="owner"
        locale="he"
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "חיבורים" }),
    ).toBeInTheDocument();
    const page = container.querySelector(".ai-page")!;
    expect(page).toHaveAttribute("dir", "rtl");
    expect(page).toHaveAttribute("lang", "he");
    expect(screen.getByText("7Q2c").closest("bdi")).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(
      screen.getByText(aiServicesMessages.he["status.off"]),
    ).toBeInTheDocument();
  });
});

describe("where AI services appear", () => {
  it("an owner without a course gets a first-run screen that opens AI services", async () => {
    const port = fakePort();
    const client = {
      ...demo(),
      mode: "connected" as const,
      aiServices: port,
      getSession: vi.fn().mockResolvedValue({
        actor: { id: "a", name: "Owner", role: "member" },
        courses: [],
        workspaces: [{ id: workspace, title: "New school", role: "owner" }],
      }),
    };
    render(<AdminApp client={client} />);
    expect(
      await screen.findByRole("heading", { name: "Welcome to Course Core" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up AI services" }));
    expect(
      await screen.findByRole("heading", { name: t("section.connections") }),
    ).toBeInTheDocument();
    expect(port.setup).toHaveBeenCalledWith(workspace, expect.anything());
  });
  it("staff who cannot configure see a read-only summary with job names", () => {
    render(
      <ProvidersView
        data={{
          ...demoWorkspace(demoSession("observer").courses[0]!, "observer"),
          permissions: ["course.read"],
        }}
        client={demo()}
      />,
    );
    expect(screen.getByText(t("readonly.demo"))).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Request configuration/ }),
    ).toBeNull();
  });
  it("the fetch client keeps exact codes and only allowlisted details", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "PROVIDER_CONNECTION_IN_USE",
            details: { roles: ["companion", "<script>"], note: "x" },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "not a code" }, { status: 500 }),
      );
    const client = createFetchAdminClient({ baseUrl: "/api", fetch: fetcher });
    const error = await client
      .aiServices!.removeConnection("w", "connection-1", {
        expectedRevision: 1,
        idempotencyKey: "key-12345",
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_CONNECTION_IN_USE",
      status: 409,
      details: { roles: ["companion"] },
    });
    expect(fetcher.mock.calls[0]![0]).toBe(
      "/api/workspaces/w/provider-setup/connections/connection-1",
    );
    expect(fetcher.mock.calls[0]![1]!.method).toBe("DELETE");
    await expect(client.aiServices!.connections("w")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});
