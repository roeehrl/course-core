import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiServicesPage } from "../src/components/aiServices/AiServicesPage";
import { specialtyModel } from "../src/components/aiServices/ModelsSection";
import {
  AiServicesError,
  type AiServicesPort,
  type Draft,
  type QualityCheck,
  type QualityStatus,
  type SuggestedPrice,
} from "../src/domain/aiServices";
import type { ProviderSetup } from "../src/domain/providerSetup";
import {
  I18nProvider,
  createAdminTranslator,
  type MessageKey,
} from "../src/i18n";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { actNow, firstSight, withoutAct } from "./raceHelpers";

// The quality check run from the page, prefilled prices and the reasons next to model
// suggestions. The port is a fake: nothing here contacts a server or a provider.
const workspace = "00000000-0000-4000-8000-000000000001";
const english = createAdminTranslator("en"),
  hebrew = createAdminTranslator("he");
const t = (key: string, args?: Record<string, string | number>) =>
  english.t(`aiServices.${key}` as MessageKey, args);
const he = (key: string, args?: Record<string, string | number>) =>
  hebrew.t(`aiServices.${key}` as MessageKey, args);
const usd = (microUsd: number) =>
  english
    .currency(microUsd / 1_000_000, "USD", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    .replace(/[‎‏]/g, "");
const jobPolicy = {
  allowance: { microUsd: 100000, tokens: 600000 },
  durationMs: 300000,
  timeoutMs: 60000,
  maxAttempts: 3,
};
const setup = (revision = 2): ProviderSetup => ({
  revision,
  configuration: {
    registry: { revision: "x", models: [] },
    adapters: [
      {
        id: "connection-1",
        kind: "google",
        credentialEnv: "COURSE_PROVIDER_0123456789ABCDEF_API_KEY",
      },
    ],
    roles: {},
  },
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
  ],
});
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
const role = (
  name: "companion" | "supervisor",
  check: Draft["roles"][number]["check"],
  priced = true,
) => ({
  role: name,
  modelId: `connection-1:${name}`,
  connectionId: "connection-1",
  remoteModel: "gemini-3.8-flash",
  mediaKind: null,
  check,
  priced,
  changed: true,
});
const draft = (waiting: boolean, priced = true): Draft => ({
  id: "00000000-0000-4000-8000-0000000000d1",
  baseRevision: 2,
  source: "models",
  stale: false,
  roles: [
    role("companion", waiting ? "needed" : "passed", priced),
    role("supervisor", waiting ? "needed" : "passed", priced),
  ],
  removedRoles: [],
  jobPolicy,
  waitingForCheck: waiting ? ["companion", "supervisor"] : [],
  updatedAt: new Date().toISOString(),
  secretsIncluded: false,
});
const check = (over: Partial<QualityCheck> = {}): QualityCheck => ({
  id: "00000000-0000-4000-8000-0000000000c1",
  target: "draft",
  draftId: "00000000-0000-4000-8000-0000000000d1",
  state: "running",
  reason: null,
  roles: ["companion", "supervisor"],
  total: 12,
  completed: 0,
  estimateMicroUsd: 72000,
  reservedMicroUsd: 1200000,
  chargedMicroUsd: null,
  outcome: [],
  createdAt: new Date().toISOString(),
  finishedAt: null,
  deadlineAt: new Date().toISOString(),
  ...over,
});
const status = (over: Partial<QualityStatus> = {}): QualityStatus => ({
  target: "draft",
  draftId: "00000000-0000-4000-8000-0000000000d1",
  roles: [
    {
      role: "companion",
      remoteModel: "gemini-3.8-flash",
      conversations: 9,
      priced: true,
      estimateMicroUsd: 54000,
    },
    {
      role: "supervisor",
      remoteModel: "gemini-3.8-flash",
      conversations: 3,
      priced: true,
      estimateMicroUsd: 18000,
    },
  ],
  conversations: 12,
  estimateMicroUsd: 72000,
  reserveMicroUsd: 1200000,
  blocked: null,
  latest: null,
  activeRoles: [],
  ...over,
});
const suggestion = (changeFrom: string | null): SuggestedPrice => ({
  service: "google",
  model: "gemini-3.8-flash",
  checkedOn: "2026-10-21",
  url: "https://ai.google.dev/gemini-api/docs/pricing",
  inputMicroUsdPerMillionTokens: 750000,
  outputMicroUsdPerMillionTokens: 3750000,
  cachedInputMicroUsdPerMillionTokens: 75000,
  promptTokensUpTo: null,
  change: changeFrom
    ? {
        from: changeFrom,
        inputMicroUsdPerMillionTokens: 1500000,
        outputMicroUsdPerMillionTokens: 7500000,
        cachedInputMicroUsdPerMillionTokens: 150000,
      }
    : null,
});
const modelList = (models: string[]) => ({
  connectionId: "connection-1",
  kind: "google",
  models: models.map((remoteModel) => ({
    remoteModel,
    displayName: remoteModel,
    description: "",
    inputTokenLimit: 1000000,
    outputTokenLimit: 8000,
    methods: ["generateContent"],
  })),
  truncated: false,
  roles: (
    ["companion", "supervisor", "research", "reviewer", "media"] as const
  ).map((r) => ({
    role: r,
    needed: r === "companion" || r === "supervisor",
    method: "generateContent",
    videoMethod: null,
    offered: true,
    suggested:
      r === "media"
        ? null
        : r === "reviewer"
          ? "gemini-3.1-pro"
          : "gemini-3.8-flash",
  })),
  generationPerformed: false as const,
});
function fakePort(overrides: Partial<Record<keyof AiServicesPort, unknown>>) {
  const port = {
    setup: vi.fn().mockResolvedValue(setup()),
    connections: vi.fn().mockResolvedValue({
      revision: 1,
      connections: [connection],
      serviceKeys: [],
      keyStorage: "encrypted_server_vault",
    }),
    testKey: vi.fn(),
    addConnection: vi.fn(),
    replaceKey: vi.fn(),
    testConnection: vi.fn(),
    removeConnection: vi.fn(),
    models: vi
      .fn()
      .mockResolvedValue(
        modelList([
          "gemini-3.8-flash",
          "gemini-3.1-pro",
          "gemini-3.5-flash-lite",
          "gemini-3-flash-preview",
          "gemini-3.8-flash-tts",
          "gemini-3.1-flash-image",
        ]),
      ),
    currentDraft: vi.fn().mockResolvedValue(draft(true)),
    draftFromModels: vi.fn(),
    draftFromJson: vi.fn(),
    discardDraft: vi.fn(),
    activate: vi.fn().mockResolvedValue({
      revision: 3,
      configurationSaved: true,
      cancelledPendingJobs: 0,
      evaluation: {},
    }),
    approve: vi.fn(),
    pricing: vi.fn().mockResolvedValue({
      requirePricing: true,
      settingsRevision: 0,
      currency: "USD",
      builtInPrices: false,
      models: [],
    }),
    savePrice: vi.fn(),
    saveCostSettings: vi.fn(),
    budgets: vi.fn().mockResolvedValue(null),
    saveBudget: vi.fn(),
    evals: vi.fn().mockResolvedValue(null),
    spend: vi.fn(),
    setServiceKey: vi.fn(),
    qualityStatus: vi.fn().mockResolvedValue(status()),
    startQualityCheck: vi.fn(),
    qualityCheck: vi.fn(),
    ...overrides,
  };
  return port as unknown as AiServicesPort &
    Record<keyof AiServicesPort, ReturnType<typeof vi.fn>>;
}
const checkRegion = () =>
  screen.findByRole("region", { name: t("section.check") });

describe("running the quality check from the page", () => {
  it("shows the estimate, starts the check for the draft, shows progress, then the result and turns the models on", async () => {
    const port = fakePort({
      startQualityCheck: vi.fn().mockResolvedValue(check({ completed: 2 })),
      qualityCheck: vi.fn().mockResolvedValue(
        check({
          state: "passed",
          completed: 12,
          chargedMicroUsd: 61000,
          outcome: [
            { role: "companion", passed: true, dialogues: 9, failed: [] },
            { role: "supervisor", passed: true, dialogues: 3, failed: [] },
          ],
        }),
      ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="admin" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(
        t("check.run.estimate", { count: 12, amount: usd(72000) }),
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(
        t("check.run.reserve", { amount: usd(1200000) }),
      ),
    ).toBeInTheDocument();
    // Approving without a check stays a secondary, owners-only option.
    expect(
      within(region).getByText(t("check.approveOwnersOnly")),
    ).toBeInTheDocument();
    fireEvent.click(
      within(region).getByRole("button", { name: t("check.run.button") }),
    );
    expect(
      await within(region).findByText(
        t("check.run.progress", { done: 2, total: 12 }),
      ),
    ).toBeInTheDocument();
    expect(port.startQualityCheck).toHaveBeenCalledWith(workspace, {
      draftId: "00000000-0000-4000-8000-0000000000d1",
      idempotencyKey: expect.stringMatching(/^ai-services:/),
    });
    expect(within(region).getByRole("progressbar")).toHaveAttribute(
      "value",
      "2",
    );
    // The poll sees the pass; the page reloads: the draft no longer waits and can be turned on.
    port.currentDraft.mockResolvedValue(draft(false));
    port.qualityStatus.mockResolvedValue(
      status({
        blocked: { code: "PROVIDER_QUALITY_CHECK_NOT_NEEDED" },
        latest: check({ state: "passed", completed: 12 }),
      }),
    );
    const turnOn = await within(region).findByRole(
      "button",
      { name: t("models.turnOn") },
      { timeout: 4000 },
    );
    expect(
      within(region).getByText(t("check.run.passedTurnOn")),
    ).toBeInTheDocument();
    expect(port.qualityCheck).toHaveBeenCalledWith(
      workspace,
      check().id,
      expect.any(AbortSignal),
    );
    fireEvent.click(turnOn);
    await waitFor(() =>
      expect(port.activate).toHaveBeenCalledWith(
        workspace,
        "00000000-0000-4000-8000-0000000000d1",
        expect.objectContaining({ expectedRevision: 2 }),
      ),
    );
  });

  it("says in plain language why it cannot run, and lists the rules a failed check broke", async () => {
    const failed = check({
      state: "failed",
      completed: 12,
      chargedMicroUsd: 58000,
      outcome: [
        {
          role: "companion",
          passed: false,
          dialogues: 9,
          failed: [
            { dialogueId: "a", graders: ["hint_leakage", "authority"] },
            { dialogueId: "b", graders: ["hint_leakage"] },
          ],
        },
        { role: "supervisor", passed: true, dialogues: 3, failed: [] },
      ],
    });
    const port = fakePort({
      qualityStatus: vi.fn().mockResolvedValue(
        status({
          blocked: {
            code: "PROVIDER_QUALITY_CHECK_PRICES_MISSING",
            roles: ["companion"],
          },
          latest: failed,
        }),
      ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(
        t("check.run.pricesMissing", { jobs: t("role.companion.name") }),
      ),
    ).toBeInTheDocument();
    expect(
      within(region).queryByRole("button", { name: t("check.run.button") }),
    ).toBeNull();
    expect(within(region).getByText(t("check.run.failed"))).toBeVisible();
    expect(
      within(region).getByText(
        t("check.run.jobFailed", {
          job: t("role.companion.name"),
          failed: 2,
          count: 9,
        }),
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(t("check.rule.hint_leakage", { count: 2 })),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(t("check.rule.authority", { count: 1 })),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(
        t("check.run.jobPassed", { job: t("role.supervisor.name"), count: 3 }),
      ),
    ).toBeInTheDocument();
    // The owner still has the approval without a check, as a secondary option.
    expect(
      within(region).getByText(t("check.approveTitle")).closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("explains a refused start (budget reached) and a key the provider refused", async () => {
    const port = fakePort({
      qualityStatus: vi.fn().mockResolvedValue(
        status({
          latest: check({
            state: "error",
            reason: "PROVIDER_METADATA_KEY_INVALID",
            chargedMicroUsd: 0,
          }),
        }),
      ),
      startQualityCheck: vi.fn().mockRejectedValue(
        new AiServicesError("PROVIDER_QUALITY_CHECK_BUDGET_REACHED", 409, {
          neededMicroUsd: 1200000,
          availableMicroUsd: 500000,
        }),
      ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(
        t("connect.errRejected", { service: t("service.google") }),
        { exact: false },
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(region).getByRole("button", { name: t("check.run.again") }),
    );
    expect(
      await within(region).findByText(
        t("check.run.budgetReached", {
          needed: usd(1200000),
          available: usd(500000),
        }),
      ),
    ).toBeInTheDocument();
  });

  it("reads right to left in Hebrew with the amount isolated", async () => {
    const port = fakePort({});
    render(
      <I18nProvider value={hebrew}>
        <AiServicesPage workspaceId={workspace} port={port} role="owner" />
      </I18nProvider>,
    );
    const region = await screen.findByRole("region", {
      name: he("section.check"),
    });
    expect(
      within(region).getByRole("button", { name: he("check.run.button") }),
    ).toBeInTheDocument();
    expect(within(region).getByText(/משתמשת במפתח שלכם/)).toBeInTheDocument();
  });
});

describe("prefilled prices", () => {
  const pricing = (changeFrom: string | null) => ({
    requirePricing: true,
    settingsRevision: 0,
    currency: "USD",
    builtInPrices: false,
    models: ["companion", "supervisor"].map((r) => ({
      modelId: `connection-1:${r}`,
      configured: false,
      draft: true,
      roles: [r],
      inForce: null,
      latestVersion: 0,
      coverage: [{ role: r, priced: false }],
      history: [],
      suggested: suggestion(changeFrom),
    })),
  });
  const receipt = (version: number) => ({
    id: "00000000-0000-4000-8000-0000000000e1",
    modelId: "m",
    version,
    status: "active",
    effectiveFrom: new Date().toISOString(),
    inForceNow: true,
    appliesToCallsAlreadyAdmitted: false,
  });
  it("fills in a known model's price with its source; Save records it and the announced change", async () => {
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(true, false)),
      pricing: vi.fn().mockResolvedValue(pricing("2027-01-01")),
      savePrice: vi
        .fn()
        .mockResolvedValueOnce(receipt(1))
        .mockResolvedValueOnce(receipt(2))
        .mockResolvedValueOnce(receipt(1))
        .mockResolvedValueOnce(receipt(2)),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const prices = await screen.findByRole("region", {
      name: t("section.prices"),
    });
    expect(await within(prices).findByDisplayValue("0.75")).toBeInTheDocument();
    expect(within(prices).getByDisplayValue("3.75")).toBeInTheDocument();
    expect(
      within(prices).getByText(
        t("prices.fromTable", {
          service: "Google",
          date: english.date("2026-10-21T12:00:00Z", "medium"),
        }),
        { exact: false },
      ),
    ).toBeInTheDocument();
    // The change is more than 60 days away: a note, not a warning.
    const notes = within(prices).getAllByText(t("prices.changeSaved"), {
      exact: false,
    });
    for (const note of notes) {
      expect(note.closest(".ai-message")).toBeNull();
      expect(note).toHaveClass("ai-muted");
    }
    const save = within(prices).getByRole("button", { name: t("prices.save") });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(port.savePrice).toHaveBeenCalledTimes(4));
    const [current, next] = port.savePrice.mock.calls.map((c) => c[1]);
    expect(current).toMatchObject({
      modelId: "connection-1:companion",
      expectedVersion: 0,
      inputMicroUsdPerMillionTokens: 750000,
      outputMicroUsdPerMillionTokens: 3750000,
      cachedInputMicroUsdPerMillionTokens: 75000,
    });
    expect(current.sourceNote).toContain("ai.google.dev");
    expect(next).toMatchObject({
      modelId: "connection-1:companion",
      expectedVersion: 1,
      inputMicroUsdPerMillionTokens: 1500000,
      outputMicroUsdPerMillionTokens: 7500000,
      effectiveFrom: "2027-01-01T00:00:00.000Z",
    });
  });

  it("keeps a price typed the moment the prices appear", async () => {
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(true, false)),
      pricing: vi.fn().mockResolvedValue(pricing("2027-01-01")),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const input = await withoutAct(() =>
      firstSight(() => screen.queryAllByDisplayValue("0.75")[0] ?? null),
    );
    // Typed in the same task the prices appeared in, before React's pending effects ran.
    await actNow(() => fireEvent.change(input, { target: { value: "0.80" } }));
    expect(input).toHaveValue("0.80");
  });

  it("warns when an announced change is within 60 days, and saves only what the owner changed", async () => {
    const soon = new Date(Date.now() + 20 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(true, false)),
      pricing: vi.fn().mockResolvedValue(pricing(soon)),
      savePrice: vi.fn().mockResolvedValue(receipt(1)),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const prices = await screen.findByRole("region", {
      name: t("section.prices"),
    });
    const warning = await within(prices).findByText(t("prices.changeSaved"), {
      exact: false,
    });
    expect(warning.closest(".ai-message")).toHaveClass("warn");
    // An edited price is the owner's own: the table's announced change is not added.
    fireEvent.change(within(prices).getByDisplayValue("0.75"), {
      target: { value: "0.80" },
    });
    fireEvent.click(
      within(prices).getByRole("button", { name: t("prices.save") }),
    );
    await waitFor(() => expect(port.savePrice).toHaveBeenCalledTimes(2));
    expect(port.savePrice.mock.calls[0]![1]).toMatchObject({
      inputMicroUsdPerMillionTokens: 800000,
      expectedVersion: 0,
    });
  });
});

describe("model suggestions", () => {
  it("gives each suggested model a short reason and hides special-purpose models until asked", async () => {
    const port = fakePort({ currentDraft: vi.fn().mockResolvedValue(null) });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const models = await screen.findByRole("region", {
      name: t("section.models"),
    });
    expect(
      await within(models).findByText(t("models.why.companion"), {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(
      within(models).getByText(t("models.why.reviewer"), { exact: false }),
    ).toBeInTheDocument();
    expect(within(models).getByText(t("models.why.media"))).toBeInTheDocument();
    const tutor = within(models).getByLabelText(
      t("models.modelFor", { job: t("role.companion.name") }),
    );
    const names = () =>
      Array.from(tutor.querySelectorAll("option")).map((o) => o.textContent);
    expect(names().join(" ")).not.toMatch(/lite|preview|tts|image/);
    fireEvent.click(within(models).getByLabelText(t("models.showAll")));
    expect(names().join(" ")).toMatch(/gemini-3.5-flash-lite/);
    expect(names().join(" ")).toMatch(/gemini-3-flash-preview/);
  });

  it("classifies special-purpose models, keeping image models for the images job", () => {
    for (const id of [
      "gemini-3.5-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3.8-flash-tts",
      "gemini-2.5-flash-native-audio",
      "gemini-3.8-live",
      "gemini-embedding-2",
      "gemini-exp-1206",
    ])
      expect(specialtyModel("companion", id), id).toBe(true);
    expect(specialtyModel("companion", "gemini-3.8-flash")).toBe(false);
    expect(specialtyModel("reviewer", "claude-sonnet-5-5")).toBe(false);
    expect(specialtyModel("companion", "gemini-3.1-flash-image")).toBe(true);
    expect(specialtyModel("media", "gemini-3.1-flash-image")).toBe(false);
  });
});

describe("fetch client", () => {
  it("keeps the budget amounts of a refused check and calls the check routes", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(
        JSON.stringify({
          error: "PROVIDER_QUALITY_CHECK_BUDGET_REACHED",
          details: {
            neededMicroUsd: 1200000,
            availableMicroUsd: 500000,
            secret: "dropped",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    });
    const client = createFetchAdminClient({
      baseUrl: "/api",
      fetch: fetcher as unknown as typeof fetch,
    });
    const error = await client
      .aiServices!.startQualityCheck(workspace, {
        idempotencyKey: "ai-services:abc12345",
        draftId: "00000000-0000-4000-8000-0000000000d1",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServicesError);
    expect((error as AiServicesError).details).toEqual({
      neededMicroUsd: 1200000,
      availableMicroUsd: 500000,
    });
    expect(calls[0]).toBe(
      `POST /api/workspaces/${workspace}/provider-setup/quality-check`,
    );
  });
});

describe("jobs that are on and need a check (after an upgrade)", () => {
  const digest = (c: string) => c.repeat(64);
  const activeSetup = (): ProviderSetup => {
    const base = setup();
    return {
      ...base,
      configuration: {
        ...(base.configuration as object),
        registry: {
          revision: "x",
          models: (["companion", "supervisor", "reviewer"] as const).map(
            (r) => ({
              id: `connection-1:${r}`,
              providerId: "connection-1",
              remoteModel: "gemini-3.8-flash",
            }),
          ),
        },
        roles: Object.fromEntries(
          (["companion", "supervisor", "reviewer"] as const).map((r) => [
            r,
            { modelId: `connection-1:${r}` },
          ]),
        ),
      },
    };
  };
  const evalRole = (
    role: "companion" | "supervisor" | "reviewer",
    status: "stale" | "not_evaluated" | "not_covered" | "passed",
    c: string,
  ) => ({
    role,
    strategy: role === "reviewer" ? "host.reviewer.own" : `core.${role}`,
    revisionDigest: digest(c),
    covered: status !== "not_covered",
    status,
    grandfathered: true,
    activatedBy: "unchanged",
  });
  const evals = (statuses: Parameters<typeof evalRole>[1][]) => ({
    suite: {
      id: "core-public",
      version: "2",
      digest: digest("f"),
      dialogues: 18,
      coverage: [{ role: "companion", dialogues: 9 }],
    },
    providerRevision: 2,
    gatedAtActivation: true,
    roles: [
      evalRole("supervisor", statuses[0]!, "a"),
      evalRole("companion", statuses[1]!, "b"),
      evalRole("reviewer", statuses[2]!, "c"),
    ],
    results: [],
    overrides: [],
  });
  const activeStatus = () =>
    status({
      target: "active",
      draftId: null,
      roles: [
        {
          role: "companion",
          remoteModel: "gemini-3.8-flash",
          conversations: 9,
          priced: true,
          estimateMicroUsd: 54000,
        },
        {
          role: "supervisor",
          remoteModel: "gemini-3.8-flash",
          conversations: 2,
          priced: true,
          estimateMicroUsd: 42000,
        },
      ],
      conversations: 11,
      estimateMicroUsd: 96000,
      reserveMicroUsd: 1100000,
      activeRoles: [
        {
          role: "supervisor",
          remoteModel: "gemini-3.8-flash",
          conversations: 2,
          priced: true,
          estimateMicroUsd: 42000,
          reserveMicroUsd: 200000,
          blocked: null,
        },
        {
          role: "companion",
          remoteModel: "gemini-3.8-flash",
          conversations: 9,
          priced: true,
          estimateMicroUsd: 54000,
          reserveMicroUsd: 900000,
          blocked: null,
        },
      ],
    });
  const upgraded = (overrides: Parameters<typeof fakePort>[0] = {}) =>
    fakePort({
      setup: vi.fn().mockResolvedValue(activeSetup()),
      currentDraft: vi.fn().mockResolvedValue(null),
      evals: vi
        .fn()
        .mockResolvedValue(evals(["not_evaluated", "stale", "not_covered"])),
      qualityStatus: vi.fn().mockResolvedValue(activeStatus()),
      ...overrides,
    });

  it("lists the jobs that need a check, says they keep working, and runs the check of what is on", async () => {
    const port = upgraded({
      startQualityCheck: vi
        .fn()
        .mockResolvedValue(
          check({ target: "active", draftId: null, total: 11, completed: 1 }),
        ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(t("check.active.note", { count: 3 })),
    ).toBeInTheDocument();
    for (const [job, state] of [
      ["supervisor", "not_evaluated"],
      ["companion", "stale"],
      ["reviewer", "not_covered"],
    ] as const)
      expect(
        within(region).getAllByText(t(`check.state.${state}`), {
          exact: false,
        }).length,
        job,
      ).toBeGreaterThan(0);
    expect(
      within(region).getByText(
        t("check.active.notCheckable", { jobs: t("role.reviewer.name") }),
      ),
    ).toBeInTheDocument();
    expect(within(region).getByText(t("pill.activeNeedsCheck"))).toBeVisible();
    // The page doesn't say AI services are off because of it: the jobs keep working.
    expect(
      screen.queryByText(t("issue.check", { count: 3 })),
    ).not.toBeInTheDocument();
    expect(
      within(region).queryByText(t("check.nothingWaiting")),
    ).not.toBeInTheDocument();
    expect(
      within(region).getByText(
        t("check.run.estimate", { count: 11, amount: usd(96000) }),
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(region).getByRole("button", { name: t("check.run.button") }),
    );
    expect(
      await within(region).findByText(
        t("check.run.progress", { done: 1, total: 11 }),
      ),
    ).toBeInTheDocument();
    expect(port.startQualityCheck).toHaveBeenCalledWith(workspace, {
      target: "active",
      idempotencyKey: expect.stringMatching(/^ai-services:/),
    });
  });

  it("flags each job that needs a check with its own Run check, which checks that job only", async () => {
    const running = check({
      target: "active",
      draftId: null,
      roles: ["supervisor"],
      total: 2,
      completed: 1,
    });
    const port = upgraded({
      startQualityCheck: vi.fn().mockResolvedValue(running),
      qualityCheck: vi.fn().mockResolvedValue({
        ...running,
        state: "passed",
        completed: 2,
        chargedMicroUsd: 30000,
        outcome: [
          { role: "supervisor", passed: true, dialogues: 2, failed: [] },
        ],
      }),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    const flags = await within(region).findByRole("list", {
      name: t("check.flag.list"),
    });
    // Two jobs need a check, one an owner's approval: each is flagged on its own.
    expect(within(flags).getAllByText(t("check.flag.needsCheck"))).toHaveLength(
      2,
    );
    expect(
      within(flags).getByText(t("check.flag.needsApproval")),
    ).toBeVisible();
    expect(
      within(flags).getByText(t("check.flag.approveInstead")),
    ).toBeVisible();
    expect(
      within(flags).getByText(
        t("check.flag.estimate", { count: 2, amount: usd(42000) }),
      ),
    ).toBeVisible();
    // The job Core can't check has no Run check of its own.
    expect(
      within(flags).queryByRole("button", {
        name: t("check.flag.runFor", { job: t("role.reviewer.name") }),
      }),
    ).toBeNull();
    fireEvent.click(
      within(flags).getByRole("button", {
        name: t("check.flag.runFor", { job: t("role.supervisor.name") }),
      }),
    );
    expect(port.startQualityCheck).toHaveBeenCalledWith(workspace, {
      target: "active",
      role: "supervisor",
      idempotencyKey: expect.stringMatching(/^ai-services:/),
    });
    expect(
      await within(flags).findByRole("progressbar", {
        name: t("check.flag.progressLabel", {
          job: t("role.supervisor.name"),
        }),
      }),
    ).toBeInTheDocument();
    // Nothing else can start while it runs.
    expect(
      within(flags).getByRole("button", {
        name: t("check.flag.runFor", { job: t("role.companion.name") }),
      }),
    ).toBeDisabled();
    expect(
      await within(flags).findByText(
        t("check.run.jobPassed", {
          job: t("role.supervisor.name"),
          count: 2,
        }),
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
  });

  it("says why a flagged job's check can't start, in plain language", async () => {
    const blocked = activeStatus();
    blocked.activeRoles = blocked.activeRoles.map((r) => ({
      ...r,
      blocked:
        r.role === "supervisor"
          ? { code: "PROVIDER_QUALITY_CHECK_LIMIT_MISSING" }
          : null,
    }));
    const port = upgraded({
      qualityStatus: vi.fn().mockResolvedValue(blocked),
      startQualityCheck: vi
        .fn()
        .mockRejectedValue(
          new AiServicesError("PROVIDER_QUALITY_CHECK_RATE_LIMITED", 429),
        ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    const flags = await within(region).findByRole("list", {
      name: t("check.flag.list"),
    });
    expect(within(flags).getByText(t("check.run.limitMissing"))).toBeVisible();
    expect(
      within(flags).queryByRole("button", {
        name: t("check.flag.runFor", { job: t("role.supervisor.name") }),
      }),
    ).toBeNull();
    fireEvent.click(
      within(flags).getByRole("button", {
        name: t("check.flag.runFor", { job: t("role.companion.name") }),
      }),
    );
    expect(
      await within(flags).findByText(t("check.run.rateLimited")),
    ).toBeVisible();
  });

  it("lets an owner approve the exact active revisions without a check", async () => {
    const port = upgraded({
      approve: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-0000000000a1",
        role: "companion",
        revisionDigest: digest("b"),
        suiteDigest: digest("f"),
        createdAt: new Date().toISOString(),
      }),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    fireEvent.click(
      await within(region).findByText(t("check.active.approveTitle")),
    );
    fireEvent.change(
      within(region).getByLabelText(t("check.reasonLabel"), { exact: false }),
      {
        target: { value: "We reviewed these jobs by hand after the upgrade." },
      },
    );
    port.evals.mockResolvedValue(evals(["passed", "passed", "passed"]));
    fireEvent.click(
      within(region).getByRole("button", { name: t("check.active.approve") }),
    );
    expect(
      await within(region).findByText(t("check.active.approved")),
    ).toBeInTheDocument();
    expect(port.approve.mock.calls.map((c) => c[1])).toEqual(
      [
        ["supervisor", "a"],
        ["companion", "b"],
        ["reviewer", "c"],
      ].map(([role, c]) => ({
        role,
        revisionDigest: digest(c!),
        reason: "We reviewed these jobs by hand after the upgrade.",
        idempotencyKey: expect.stringMatching(/^ai-services:/),
      })),
    );
  });

  it("lists course-specific setups as their own approvals and the server's provider file while it is in use", async () => {
    const course = (status: "not_covered" | "override", c: string) => ({
      releaseId: "00000000-0000-4000-8000-0000000000c1",
      courseKey: "number-line",
      version: "1.2.0",
      role: "supervisor" as const,
      strategy: "example.supervisor.read-first",
      strategyVersion: "1.0.0",
      revisionDigest: digest(c),
      status,
    });
    const withCourse = (status: "not_covered" | "override") => ({
      ...evals(["passed", "passed", "passed"]),
      hostFile: {
        inUse: true,
        roles: [
          {
            role: "companion",
            strategy: "core.companion",
            revisionDigest: digest("d"),
            covered: true,
            status: "not_evaluated",
          },
        ],
      },
      courseStrategies: [course(status, "e")],
    });
    const port = upgraded({
      evals: vi.fn().mockResolvedValue(withCourse("not_covered")),
      approve: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-0000000000a2",
        role: "supervisor",
        revisionDigest: digest("e"),
        suiteDigest: digest("f"),
        createdAt: new Date().toISOString(),
      }),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(t("check.course.title")),
    ).toBeVisible();
    expect(
      within(region).getByText(t("check.course.state.not_covered"), {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(
      within(region).getByText("example.supervisor.read-first"),
    ).toBeInTheDocument();
    expect(within(region).getByText(t("check.hostFile.title"))).toBeVisible();
    expect(
      within(region).getByText(
        t("check.hostFile.unchecked", { jobs: t("role.companion.name") }),
      ),
    ).toBeInTheDocument();
    // A short reason is refused before anything is sent.
    const approveButton = within(region).getByRole("button", {
      name: t("check.course.approve", { count: 1 }),
    });
    fireEvent.click(approveButton);
    expect(
      (await within(region).findAllByText(t("check.errReason"))).length,
    ).toBeGreaterThan(0);
    expect(port.approve).not.toHaveBeenCalled();
    fireEvent.change(
      within(region).getByLabelText(t("check.reasonLabel"), { exact: false }),
      {
        target: {
          value:
            "We read the course's narrower supervisor setup and accept it.",
        },
      },
    );
    port.evals.mockResolvedValue(withCourse("override"));
    fireEvent.click(approveButton);
    expect(
      await within(region).findByText(t("check.course.approved")),
    ).toBeInTheDocument();
    expect(port.approve).toHaveBeenCalledWith(workspace, {
      role: "supervisor",
      revisionDigest: digest("e"),
      reason: "We read the course's narrower supervisor setup and accept it.",
      idempotencyKey: expect.stringMatching(/^ai-services:/),
    });
  });

  it("asks an administrator to get an owner's approval for a course-specific setup", async () => {
    const port = upgraded({
      evals: vi.fn().mockResolvedValue({
        ...evals(["passed", "passed", "passed"]),
        courseStrategies: [
          {
            releaseId: "00000000-0000-4000-8000-0000000000c1",
            courseKey: "number-line",
            version: "1.2.0",
            role: "companion",
            strategy: "example.companion.brief",
            strategyVersion: "1.0.0",
            revisionDigest: digest("e"),
            status: "not_covered",
          },
        ],
      }),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="admin" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(t("check.course.title")),
    ).toBeVisible();
    expect(
      within(region).getByText(t("check.approveOwnersOnly")),
    ).toBeInTheDocument();
    expect(
      within(region).queryByRole("button", {
        name: t("check.course.approve", { count: 1 }),
      }),
    ).not.toBeInTheDocument();
  });

  it("asks an administrator to get an owner's approval, and asks to finish an open draft before checking", async () => {
    const port = upgraded({
      currentDraft: vi.fn().mockResolvedValue(draft(false)),
      qualityStatus: vi
        .fn()
        .mockResolvedValue(
          status({ blocked: { code: "PROVIDER_QUALITY_CHECK_NOT_NEEDED" } }),
        ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="admin" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(t("check.active.draftOpen")),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(t("check.approveOwnersOnly")),
    ).toBeInTheDocument();
    expect(
      within(region).queryByRole("button", { name: t("check.run.button") }),
    ).toBeNull();
  });

  it("says the same in Hebrew", async () => {
    render(
      <I18nProvider value={hebrew}>
        <AiServicesPage
          workspaceId={workspace}
          port={upgraded()}
          role="owner"
        />
      </I18nProvider>,
    );
    const region = await screen.findByRole("region", {
      name: he("section.check"),
    });
    expect(
      await within(region).findByText(he("check.active.note", { count: 3 })),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: he("check.run.button") }),
    ).toBeInTheDocument();
  });
});
