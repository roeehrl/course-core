import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiServicesPage } from "../src/components/aiServices/AiServicesPage";
import { QUALITY_RULES } from "../src/components/aiServices/CheckSection";
import enAi from "../src/i18n/messages/en/aiServices.json";
import heAi from "../src/i18n/messages/he/aiServices.json";
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
  reasonDetail: null,
  roles: ["companion", "supervisor"],
  total: 12,
  completed: 0,
  estimateMicroUsd: 72000,
  reservedMicroUsd: 1200000,
  chargedMicroUsd: null,
  outcome: [],
  createdAt: new Date().toISOString(),
  finishedAt: null,
  // The server gives a check ten minutes.
  deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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
  onRoles: [],
  onAll: null,
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
/** The latest check, under the list of jobs that are on. */
const latestCheck = (region: HTMLElement) =>
  within(region).findByRole("region", { name: t("check.latest.title") });

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

  it("says the check runs as many conversations as its progress counts to, not the suite's whole coverage", async () => {
    const port = fakePort({
      // The suite covers 23 conversations for these jobs; the check of this draft runs 12.
      evals: vi.fn().mockResolvedValue({
        suite: {
          id: "s",
          version: "1",
          digest: "a".repeat(64),
          dialogues: 30,
          coverage: [
            { role: "companion", dialogues: 18 },
            { role: "supervisor", dialogues: 5 },
          ],
        },
        providerRevision: 0,
        gatedAtActivation: true,
        roles: [],
        results: [],
        overrides: [],
      }),
      startQualityCheck: vi.fn().mockResolvedValue(check({ completed: 4 })),
      qualityCheck: vi.fn().mockResolvedValue(check({ completed: 4 })),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="admin" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(t("check.explain", { dialogues: 12 })),
    ).toBeInTheDocument();
    expect(
      within(region).queryByText(t("check.explain", { dialogues: 23 })),
    ).toBeNull();
    expect(he("check.explain", { dialogues: 12 })).toContain("12 שיחות תרגול");
    fireEvent.click(
      within(region).getByRole("button", { name: t("check.run.button") }),
    );
    expect(
      await within(region).findByText(
        t("check.run.progress", { done: 4, total: 12 }),
      ),
    ).toBeInTheDocument();
  });

  it("every grader of Core's suite has a label and an explanation in English and Hebrew", () => {
    // The server's list of graders (services/api/src/agent-evals/graders.ts GRADERS) is this page's list.
    const source = readFileSync(
      path.join(process.cwd(), "../../services/api/src/agent-evals/graders.ts"),
      "utf8",
    );
    const declared = /export const GRADERS = \[([^\]]*)\]/.exec(source)?.[1];
    expect(declared).toBeTruthy();
    const graders = [...declared!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(graders.length).toBeGreaterThanOrEqual(10);
    expect([...QUALITY_RULES]).toEqual(graders);
    for (const catalog of [enAi, heAi] as Record<string, string>[])
      for (const id of [...graders, "other"]) {
        expect(catalog[`check.rule.${id}`], `check.rule.${id}`).toMatch(/\S/);
        expect(
          catalog[`check.ruleExplain.${id}`],
          `check.ruleExplain.${id}`,
        ).toMatch(/\S/);
      }
    expect(t("check.rule.check_mode", { count: 1 })).toMatch(
      /^In 1 conversation, it handled a question about a graded check/,
    );
    expect(he("check.rule.check_mode", { count: 2 })).toMatch(/^בשתי שיחות: /);
  });

  it("names every rule a failed conversation broke, the check-mode rule and one this page does not know yet included", async () => {
    const failed = check({
      state: "failed",
      completed: 18,
      chargedMicroUsd: 58000,
      outcome: [
        {
          role: "companion",
          passed: false,
          dialogues: 18,
          failed: [
            { dialogueId: "over", graders: ["check_mode"] },
            { dialogueId: "new", graders: ["later_rule"] },
          ],
        },
      ],
    });
    const port = fakePort({
      qualityStatus: vi.fn().mockResolvedValue(status({ latest: failed })),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(
        t("check.run.jobFailed", {
          job: t("role.companion.name"),
          failed: 2,
          count: 18,
        }),
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(t("check.rule.check_mode", { count: 1 })),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(t("check.ruleExplain.check_mode")),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(
        t("check.rule.other", { count: 1, rule: "later_rule" }),
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(t("check.ruleExplain.other")),
    ).toBeInTheDocument();
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

  it("names a refused request with Google's status and reason, not quota or billing, in English and Hebrew", async () => {
    const refused = check({
      state: "error",
      reason: "PROVIDER_REQUEST_REJECTED",
      reasonDetail: {
        role: "supervisor",
        providerCode: "UPSTREAM_REJECTED",
        status: 400,
        providerReason: "INVALID_ARGUMENT",
      },
      chargedMicroUsd: 0,
    });
    const port = fakePort({
      qualityStatus: vi.fn().mockResolvedValue(status({ latest: refused })),
    });
    const { unmount } = render(
      <AiServicesPage workspaceId={workspace} port={port} role="owner" />,
    );
    const region = await checkRegion();
    const google = t("service.google");
    expect(
      await within(region).findByText(
        t("check.run.requestRefused", {
          service: google,
          status: 400,
          reason: "INVALID_ARGUMENT",
        }),
        { exact: false },
      ),
    ).toBeInTheDocument();
    for (const message of ["connect.errQuotaUsed", "connect.errBilling"])
      expect(region.textContent).not.toContain(t(message, { service: google }));
    const technical = within(region)
      .getByText(t("connect.technical"))
      .closest("details")!;
    expect(technical).not.toHaveAttribute("open");
    expect(technical.textContent).toContain("PROVIDER_REQUEST_REJECTED");
    expect(technical.textContent).toContain(t("role.supervisor.name"));
    expect(technical.textContent).toContain("400");
    expect(technical.textContent).toContain("INVALID_ARGUMENT");
    unmount();
    render(
      <I18nProvider value={hebrew}>
        <AiServicesPage workspaceId={workspace} port={port} role="owner" />
      </I18nProvider>,
    );
    const heRegion = await screen.findByRole("region", {
      name: he("section.check"),
    });
    expect(
      await within(heRegion).findByText(
        // The Hebrew keeps the technical part unbroken (no-break spaces); the matcher compares collapsed whitespace.
        he("check.run.requestRefused", {
          service: he("service.google"),
          status: 400,
          reason: "INVALID_ARGUMENT",
        }).replace(/\s+/g, " "),
        { exact: false },
      ),
    ).toBeInTheDocument();
    for (const message of ["connect.errQuotaUsed", "connect.errBilling"])
      expect(heRegion.textContent).not.toContain(
        he(message, { service: he("service.google") }),
      );
  });

  it("names billing for Google's documented billing refusal, and keeps its reason in the details", async () => {
    const port = fakePort({
      qualityStatus: vi.fn().mockResolvedValue(
        status({
          latest: check({
            state: "error",
            reason: "PROVIDER_METADATA_BILLING_REQUIRED",
            reasonDetail: {
              role: "reviewer",
              providerCode: "BILLING_REQUIRED",
              status: 403,
              providerReason: "BILLING_DISABLED",
            },
            chargedMicroUsd: 0,
          }),
        }),
      ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    expect(
      await within(region).findByText(
        t("connect.errBilling", { service: t("service.google") }),
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(region.textContent).toContain("BILLING_DISABLED");
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

// The prices card compares an announced change with today's date (a warning within
// CHANGE_WARNING_DAYS, a note before that). These tests pin the clock to the day the table was
// checked, 72 days before the 1 January 2027 change they use, so they do not change with the
// real date. Only Date is faked: the page's own timers and Testing Library's waits stay real.
const PRICE_TABLE_DAY = "2026-10-21T12:00:00Z";
function pinClockToPriceTableDay() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(PRICE_TABLE_DAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe("prefilled prices", () => {
  pinClockToPriceTableDay();
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

describe("a price change already scheduled", () => {
  pinClockToPriceTableDay();
  const later = "2027-01-01T00:00:00.000Z";
  const version = (
    n: number,
    effectiveFrom: string,
    input: number,
    output: number,
  ) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    version: n,
    status: "active" as const,
    currency: "USD" as const,
    inputMicroUsdPerMillionTokens: input,
    outputMicroUsdPerMillionTokens: output,
    cachedInputMicroUsdPerMillionTokens: 75000,
    microUsdPerRequest: null,
    microUsdPerOutputSecond: null,
    microUsdPerServerToolRequest: null,
    effectiveFrom,
    sourceNote: "Google pricing page",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const current = version(1, "2026-10-01T00:00:00.000Z", 750000, 3750000);
  const scheduled = version(2, later, 1500000, 7500000);
  const pricing = () => ({
    requirePricing: true,
    settingsRevision: 0,
    currency: "USD",
    builtInPrices: false,
    models: ["companion", "supervisor"].map((r) => ({
      modelId: `connection-1:${r}`,
      configured: true,
      roles: [r],
      inForce: current,
      latestVersion: 2,
      coverage: [{ role: r, priced: true }],
      history: [scheduled, current],
      scheduled: [scheduled],
      // The table announces the same change: it is shown once, as the scheduled change.
      suggested: suggestion("2027-01-01"),
    })),
  });
  const receipt = {
    id: "00000000-0000-4000-8000-0000000000e1",
    modelId: "m",
    version: 3,
    status: "active",
    effectiveFrom: later,
    inForceNow: false,
    appliesToCallsAlreadyAdmitted: false,
  };
  const date = english.date(later, "medium");
  async function open(
    port: ReturnType<typeof fakePort>,
    wrap = (n: ReactNode) => n,
  ) {
    render(
      wrap(<AiServicesPage workspaceId={workspace} port={port} role="owner" />),
    );
    return screen.findByRole("region", {
      name: wrap === inHebrew ? he("section.prices") : t("section.prices"),
    });
  }
  const inHebrew = (node: ReactNode) => (
    <I18nProvider value={hebrew}>{node}</I18nProvider>
  );
  it("shows the scheduled change and what saving now does, and saves today's price before it", async () => {
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(false)),
      pricing: vi.fn().mockResolvedValue(pricing()),
      savePrice: vi.fn().mockResolvedValue({ ...receipt, inForceNow: true }),
    });
    const prices = await open(port);
    expect(
      await within(prices).findByText(
        t("prices.scheduledTokens", { date, input: "$1.50", output: "$7.50" }),
      ),
    ).toBeInTheDocument();
    expect(
      within(prices).getByText(t("prices.previewUntil", { date })),
    ).toBeInTheDocument();
    // The table's note about the same change is not repeated.
    expect(
      within(prices).queryByText(t("prices.changeUpdate"), { exact: false }),
    ).toBeNull();
    fireEvent.change(within(prices).getByDisplayValue("0.75"), {
      target: { value: "0.80" },
    });
    const before = Date.now();
    fireEvent.click(
      within(prices).getByRole("button", { name: t("prices.save") }),
    );
    await waitFor(() => expect(port.savePrice).toHaveBeenCalledTimes(2));
    for (const [, request] of port.savePrice.mock.calls) {
      expect(request).toMatchObject({
        expectedVersion: 2,
        inputMicroUsdPerMillionTokens: 800000,
      });
      // From now, not from the scheduled date: the scheduled change still applies on its date.
      expect(Date.parse(request.effectiveFrom)).toBeGreaterThanOrEqual(
        before - 1000,
      );
      expect(Date.parse(request.effectiveFrom)).toBeLessThan(Date.parse(later));
    }
    expect(
      await within(prices).findByText(t("prices.saved")),
    ).toBeInTheDocument();
  });

  it("changes the scheduled price in a dialog that says what will happen, and replaces it at its exact time", async () => {
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(false)),
      pricing: vi.fn().mockResolvedValue(pricing()),
      savePrice: vi
        .fn()
        .mockRejectedValueOnce(
          new AiServicesError("PROVIDER_PRICING_EFFECTIVE_DATE_INVALID", 400, {
            earliest: "2026-10-01T00:00:00.000Z",
            latest: "2027-10-26T00:00:00.000Z",
          }),
        )
        .mockResolvedValue(receipt),
    });
    const prices = await open(port);
    fireEvent.click(
      await within(prices).findByRole("button", {
        name: t("prices.scheduledEdit"),
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: t("prices.dialogTitle", { date }),
    });
    const input = within(dialog).getByLabelText(t("prices.input"));
    const output = within(dialog).getByLabelText(t("prices.output"));
    expect(input).toHaveValue("1.50");
    expect(output).toHaveValue("7.50");
    // Validated before anything is sent.
    fireEvent.change(output, { target: { value: "" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: t("prices.dialogSave") }),
    );
    expect(
      (await within(dialog).findAllByText(t("prices.errBoth"))).length,
    ).toBeGreaterThan(0);
    expect(port.savePrice).not.toHaveBeenCalled();
    fireEvent.change(output, { target: { value: "6.00" } });
    fireEvent.change(input, { target: { value: "1.20" } });
    expect(
      within(dialog).getByText(
        t("prices.dialogPreviewTokens", {
          date,
          input: "$1.20",
          output: "$6.00",
        }),
      ),
    ).toBeInTheDocument();
    // A refused start date is explained with its limits, inside the dialog.
    fireEvent.click(
      within(dialog).getByRole("button", { name: t("prices.dialogSave") }),
    );
    expect(
      await within(dialog).findByText(
        t("err.pricingDate", {
          earliest: english.date("2026-10-01T00:00:00.000Z", "medium"),
          latest: english.date("2027-10-26T00:00:00.000Z", "medium"),
        }),
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: t("prices.dialogSave") }),
    );
    expect(
      await within(prices).findByText(t("prices.scheduledSaved")),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    const calls = port.savePrice.mock.calls.slice(1).map((c) => c[1]);
    expect(calls.map((c) => c.modelId)).toEqual([
      "connection-1:companion",
      "connection-1:supervisor",
    ]);
    for (const request of calls)
      expect(request).toMatchObject({
        effectiveFrom: later,
        expectedVersion: 2,
        status: "active",
        inputMicroUsdPerMillionTokens: 1200000,
        outputMicroUsdPerMillionTokens: 6000000,
        cachedInputMicroUsdPerMillionTokens: 75000,
      });
    // The retry after the refusal is a new request (a definite answer starts fresh).
    expect(calls[0]!.idempotencyKey).not.toBe(
      port.savePrice.mock.calls[0]![1].idempotencyKey,
    );
  });

  it("keeps the current price after a confirmation, by saving it again at the scheduled time", async () => {
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(false)),
      pricing: vi.fn().mockResolvedValue(pricing()),
      savePrice: vi.fn().mockResolvedValue(receipt),
    });
    const prices = await open(port);
    fireEvent.click(
      await within(prices).findByRole("button", {
        name: t("prices.scheduledKeep"),
      }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: t("prices.keepTitle", { date }),
    });
    expect(
      within(confirm).getByText(t("prices.keepBody", { date })),
    ).toBeInTheDocument();
    // Nothing is lost, so the confirmation is not styled as dangerous.
    expect(
      within(confirm).getByRole("button", { name: t("prices.keepGo") }),
    ).toHaveClass("primary");
    fireEvent.click(
      within(confirm).getByRole("button", { name: t("prices.keepGo") }),
    );
    expect(
      await within(prices).findByText(t("prices.kept", { date })),
    ).toBeInTheDocument();
    expect(port.savePrice).toHaveBeenCalledTimes(2);
    for (const [, request] of port.savePrice.mock.calls)
      expect(request).toMatchObject({
        effectiveFrom: later,
        expectedVersion: 2,
        status: "active",
        inputMicroUsdPerMillionTokens: 750000,
        outputMicroUsdPerMillionTokens: 3750000,
        cachedInputMicroUsdPerMillionTokens: 75000,
        sourceNote: t("prices.keepSource", { date }),
      });
  });

  it("hides a later version that only keeps today's price, and moves it along when today's price changes", async () => {
    const kept = { ...version(3, later, 750000, 3750000), sourceNote: "kept" };
    const view = pricing();
    for (const model of view.models) {
      model.scheduled = [kept];
      model.latestVersion = 3;
    }
    let next = 4;
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(false)),
      pricing: vi.fn().mockResolvedValue(view),
      savePrice: vi
        .fn()
        .mockImplementation(async () => ({ ...receipt, version: next++ })),
    });
    const prices = await open(port);
    await within(prices).findByDisplayValue("0.75");
    // Not a change: no scheduled line and no "until" sentence.
    expect(within(prices).queryByText(/Scheduled change from/)).toBeNull();
    expect(within(prices).queryByText(/until/)).toBeNull();
    fireEvent.change(within(prices).getByDisplayValue("0.75"), {
      target: { value: "0.80" },
    });
    fireEvent.click(
      within(prices).getByRole("button", { name: t("prices.save") }),
    );
    await waitFor(() => expect(port.savePrice).toHaveBeenCalledTimes(4));
    const [now, follow] = port.savePrice.mock.calls.map((c) => c[1]);
    expect(now).toMatchObject({
      modelId: "connection-1:companion",
      expectedVersion: 3,
      inputMicroUsdPerMillionTokens: 800000,
    });
    // Saved again at its date with the new price, after the version just saved.
    expect(follow).toMatchObject({
      modelId: "connection-1:companion",
      expectedVersion: 4,
      effectiveFrom: later,
      inputMicroUsdPerMillionTokens: 800000,
      outputMicroUsdPerMillionTokens: 3750000,
    });
  });

  it("explains each pricing refusal in plain words, in English and Hebrew", async () => {
    const { errorText } = await import("../src/components/aiServices/shared");
    const text = (tr: typeof english) => ({
      locale: tr.locale,
      dir: tr.dir,
      t: (k: MessageKey, a?: Record<string, unknown>) => tr.t(k, a as never),
      money: () => "",
      date: (v: string | Date) => tr.date(v, "medium"),
      relative: () => "",
      list: (items: string[]) => tr.list(items),
    });
    const refusal = (details?: Record<string, string>) =>
      new AiServicesError(
        "PROVIDER_PRICING_EFFECTIVE_DATE_INVALID",
        400,
        details,
      );
    const latest = "2027-10-26T00:00:00.000Z";
    expect(errorText(text(english) as never, refusal({ latest }))).toBe(
      t("err.pricingDateLatest", { latest: english.date(latest, "medium") }),
    );
    expect(errorText(text(english) as never, refusal())).toBe(
      t("err.pricingDateGeneric"),
    );
    expect(
      errorText(
        text(hebrew) as never,
        refusal({ earliest: "2026-10-01T00:00:00.000Z", latest }),
      ),
    ).toBe(
      he("err.pricingDate", {
        earliest: hebrew.date("2026-10-01T00:00:00.000Z", "medium"),
        latest: hebrew.date(latest, "medium"),
      }),
    );
    expect(
      errorText(
        text(english) as never,
        new AiServicesError("PROVIDER_PRICING_UNKNOWN_MODEL", 404),
      ),
    ).toBe(t("err.pricingUnknownModel"));
    expect(
      errorText(
        text(english) as never,
        new AiServicesError("PROVIDER_PRICING_INVALID", 400),
      ),
    ).toBe(t("err.pricingInvalid"));
    expect(t("err.pricingDate", { earliest: "a", latest: "b" })).not.toBe(
      t("err.generic"),
    );
  });

  it("reads the start-date limits of a refusal from the server answer", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "PROVIDER_PRICING_EFFECTIVE_DATE_INVALID",
          details: {
            earliest: "2026-10-01T00:00:00.000Z",
            latest: "not a date",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = createFetchAdminClient({
      baseUrl: "/api",
      fetch: fetcher as unknown as typeof fetch,
    });
    const error = await client
      .aiServices!.savePrice(workspace, {
        idempotencyKey: "ai-services:test-key",
        modelId: "m",
        expectedVersion: 0,
        status: "active",
        currency: "USD",
        inputMicroUsdPerMillionTokens: 1,
        outputMicroUsdPerMillionTokens: 1,
        cachedInputMicroUsdPerMillionTokens: null,
        microUsdPerRequest: null,
        microUsdPerOutputSecond: null,
        microUsdPerServerToolRequest: null,
        effectiveFrom: later,
        sourceNote: "note",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiServicesError);
    expect((error as AiServicesError).details).toEqual({
      earliest: "2026-10-01T00:00:00.000Z",
    });
  });

  it("shows the scheduled change in Hebrew", async () => {
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(draft(false)),
      pricing: vi.fn().mockResolvedValue(pricing()),
    });
    const prices = await open(port, inHebrew);
    const heDate = hebrew.date(later, "medium");
    expect(
      await within(prices).findByText(
        he("prices.scheduledTokens", {
          date: heDate,
          input: "$1.50",
          output: "$7.50",
        }),
      ),
    ).toBeInTheDocument();
    expect(
      within(prices).getByText(he("prices.previewUntil", { date: heDate })),
    ).toBeInTheDocument();
    expect(
      within(prices).getByRole("button", { name: he("prices.scheduledEdit") }),
    ).toBeInTheDocument();
    expect(
      within(prices).getByRole("button", { name: he("prices.scheduledKeep") }),
    ).toBeInTheDocument();
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

  it('warns when the chosen model is one the service answered "not found" for, and no longer lists it', async () => {
    // The pilot's case: the draft's tutor model passed models.list but Google answered 404 to the check.
    const waiting: Draft = {
      ...draft(true),
      roles: [
        { ...role("companion", "failed"), remoteModel: "gemini-2.5-pro" },
        role("supervisor", "passed"),
      ],
      waitingForCheck: ["companion"],
    };
    const port = fakePort({
      currentDraft: vi.fn().mockResolvedValue(waiting),
      // The server leaves the refused model out of the list and names it under `unavailable`.
      models: vi.fn().mockResolvedValue({
        ...modelList(["gemini-3.8-flash", "gemini-3.1-pro"]),
        unavailable: [
          { remoteModel: "gemini-2.5-pro", markedAt: new Date().toISOString() },
        ],
      }),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const models = await screen.findByRole("region", {
      name: t("section.models"),
    });
    expect(
      await within(models).findByText(
        t("models.unavailableChoice", {
          service: t("service.google"),
          model: "gemini-2.5-pro",
        }),
      ),
    ).toBeInTheDocument();
    // Only the tutor's row warns: the planner's model is fine.
    expect(
      within(models).getAllByText(
        t("models.unavailableChoice", {
          service: t("service.google"),
          model: "gemini-2.5-pro",
        }),
      ),
    ).toHaveLength(1);
    const tutor = within(models).getByLabelText(
      t("models.modelFor", { job: t("role.companion.name") }),
    );
    // The refused model shows only as the current choice, not as a listed model to pick.
    const listed = Array.from(tutor.querySelectorAll("option")).filter((o) =>
      (o.textContent ?? "").includes("gemini-2.5-pro"),
    );
    expect(listed.map((o) => o.textContent)).toEqual(["gemini-2.5-pro"]);
    fireEvent.click(within(models).getByLabelText(t("models.showAll")));
    expect(
      Array.from(tutor.querySelectorAll("option"))
        .map((o) => o.textContent ?? "")
        .filter((name) => name.includes("gemini-2.5-pro")),
    ).toEqual(["gemini-2.5-pro"]);
  });

  it("says a check stopped because the service doesn't have a job's model, in English and Hebrew", async () => {
    const notFound = check({
      state: "error",
      reason: "PROVIDER_GUIDE_MODEL_UNAVAILABLE",
      reasonDetail: {
        role: "companion",
        providerCode: "NOT_FOUND",
        status: 404,
        providerReason: "NOT_FOUND",
      },
      chargedMicroUsd: 0,
    });
    const port = fakePort({
      qualityStatus: vi.fn().mockResolvedValue(status({ latest: notFound })),
    });
    const { unmount } = render(
      <AiServicesPage workspaceId={workspace} port={port} role="owner" />,
    );
    const region = await checkRegion();
    expect(
      await within(region).findByText(
        t("check.run.modelUnavailable", {
          service: t("service.google"),
          job: t("role.companion.name"),
        }),
        { exact: false },
      ),
    ).toBeInTheDocument();
    unmount();
    render(
      <I18nProvider value={hebrew}>
        <AiServicesPage workspaceId={workspace} port={port} role="owner" />
      </I18nProvider>,
    );
    const heRegion = await screen.findByRole("region", {
      name: he("section.check"),
    });
    expect(
      await within(heRegion).findByText(
        he("check.run.modelUnavailable", {
          service: he("service.google"),
          job: he("role.companion.name"),
        }).replace(/\s+/g, " "),
        { exact: false },
      ),
    ).toBeInTheDocument();
  });

  it("says a check stopped on this workspace's own setup, not the service's model list, in English and Hebrew", async () => {
    const stopped = (reason: string, providerCode: string) =>
      check({
        state: "error",
        reason,
        reasonDetail: {
          role: "supervisor",
          providerCode,
          status: null,
          providerReason: null,
        },
        chargedMicroUsd: 0,
      });
    for (const [reason, providerCode, key] of [
      [
        "PROVIDER_QUALITY_CHECK_MODEL_NOT_CONFIGURED",
        "UNKNOWN_MODEL",
        "check.run.modelNotConfigured",
      ],
      [
        "PROVIDER_QUALITY_CHECK_CAPABILITY_MISSING",
        "CAPABILITY_MISMATCH",
        "check.run.capabilityMissing",
      ],
    ] as const) {
      const port = fakePort({
        qualityStatus: vi
          .fn()
          .mockResolvedValue(status({ latest: stopped(reason, providerCode) })),
      });
      const { unmount } = render(
        <AiServicesPage workspaceId={workspace} port={port} role="owner" />,
      );
      const region = await checkRegion();
      expect(
        await within(region).findByText(
          t(key, { job: t("role.supervisor.name") }),
          { exact: false },
        ),
      ).toBeInTheDocument();
      // Never the service's "model isn't available" message.
      expect(region.textContent).not.toContain(t("err.modelUnavailable"));
      expect(region.textContent).not.toContain(
        t("check.run.modelUnavailable", {
          service: t("service.google"),
          job: t("role.supervisor.name"),
        }),
      );
      unmount();
      render(
        <I18nProvider value={hebrew}>
          <AiServicesPage workspaceId={workspace} port={port} role="owner" />
        </I18nProvider>,
      );
      const heRegion = await screen.findByRole("region", {
        name: he("section.check"),
      });
      expect(
        await within(heRegion).findByText(
          he(key, { job: he("role.supervisor.name") }).replace(/\s+/g, " "),
          { exact: false },
        ),
      ).toBeInTheDocument();
      cleanup();
    }
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
        t("check.on.allEstimate", { count: 11, amount: usd(96000) }),
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(region).getByRole("button", { name: t("check.on.runAll") }),
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
      name: t("check.onTitle"),
    });
    // Two jobs need a check, one an owner's approval: each is flagged on its own, in the one list.
    expect(within(flags).getAllByText(t("check.flag.needsCheck"))).toHaveLength(
      2,
    );
    expect(
      within(flags).getByText(t("check.flag.needsApproval")),
    ).toBeVisible();
    expect(
      within(region).getAllByRole("list", { name: t("check.onTitle") }),
    ).toHaveLength(1);
    expect(flags.querySelectorAll('li[data-role="companion"]')).toHaveLength(1);
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
    // Its progress shows in one place, where its result will show: the latest check.
    expect(
      await within(await latestCheck(region)).findByRole("progressbar", {
        name: t("check.flag.progressLabel", {
          job: t("role.supervisor.name"),
        }),
      }),
    ).toBeInTheDocument();
    expect(within(region).getAllByRole("progressbar")).toHaveLength(1);
    // Nothing else can start while it runs.
    expect(
      within(flags).getByRole("button", {
        name: t("check.flag.runFor", { job: t("role.companion.name") }),
      }),
    ).toBeDisabled();
    expect(
      await within(region).findByText(
        t("check.run.jobPassed", {
          job: t("role.supervisor.name"),
          count: 2,
        }),
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
  });

  // The latest check shows once, under the list of jobs, after every page load (not only right
  // after a run in the same visit), whether it checked one job or all of them, with its result,
  // cost, date and the details of each conversation.
  const failedFor = (roles: ("companion" | "supervisor")[]) =>
    check({
      id: "00000000-0000-4000-8000-0000000000c9",
      target: "active",
      draftId: null,
      state: "failed",
      roles,
      total: 11,
      completed: 11,
      chargedMicroUsd: 10000,
      finishedAt: "2026-10-31T09:30:00.000Z",
      outcome: roles.map((role) => ({
        role,
        passed: role !== "companion",
        dialogues: role === "companion" ? 9 : 2,
        failed:
          role === "companion"
            ? [{ dialogueId: "d1", graders: ["hint_leakage"] }]
            : [],
      })),
    });
  const companionFailed = t("check.run.jobFailed", {
    job: t("role.companion.name"),
    failed: 1,
    count: 9,
  });

  for (const roles of [["companion"], ["companion", "supervisor"]] as const)
    it(`shows the latest check of ${roles.join(" and ")} after a page load, once, with its date, cost and details`, async () => {
      const port = upgraded({
        qualityStatus: vi.fn().mockResolvedValue({
          ...activeStatus(),
          latest: failedFor([...roles]),
        }),
        qualityCheckDetails: vi.fn().mockResolvedValue({
          checkId: "00000000-0000-4000-8000-0000000000c9",
          state: "failed",
          recorded: true,
          roles: [],
        }),
      });
      render(
        <AiServicesPage workspaceId={workspace} port={port} role="owner" />,
      );
      const region = await checkRegion();
      const latest = await within(region).findByRole("region", {
        name: t("check.latest.title"),
      });
      expect(within(latest).getByText(companionFailed)).toBeVisible();
      expect(within(latest).getByText(t("check.run.failed"))).toBeVisible();
      expect(
        within(latest).getByText(
          t("check.on.checkedOn", {
            date: english.date("2026-10-31T09:30:00.000Z", "medium"),
          }),
        ),
      ).toBeVisible();
      expect(
        within(latest).getByText(
          t("check.run.charged", { amount: usd(10000) }),
        ),
      ).toBeVisible();
      expect(
        within(latest).getByText(t("check.details.title")),
      ).toBeInTheDocument();
      // The jobs it failed that are still on can be turned off right there.
      expect(
        within(latest).getByText(t("check.on.failedStillOn", { count: 1 })),
      ).toBeVisible();
      expect(within(region).getAllByText(companionFailed)).toHaveLength(1);
      expect(within(region).getAllByText(t("check.run.failed"))).toHaveLength(
        1,
      );
    });

  it("shows a check that finishes while the page is open where its progress was, without a reload", async () => {
    const running = check({
      target: "active",
      draftId: null,
      roles: ["companion"],
      total: 9,
      completed: 1,
    });
    const finished = failedFor(["companion"]);
    const statusNow = vi.fn().mockResolvedValue(activeStatus());
    const port = upgraded({
      qualityStatus: statusNow,
      startQualityCheck: vi.fn().mockResolvedValue(running),
      qualityCheck: vi.fn().mockImplementation(async () => {
        // The page reloads its status once the check ends: it now names this check as the latest.
        statusNow.mockResolvedValue({ ...activeStatus(), latest: finished });
        return finished;
      }),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    const flags = await within(region).findByRole("list", {
      name: t("check.onTitle"),
    });
    fireEvent.click(
      within(flags).getByRole("button", {
        name: t("check.flag.runFor", { job: t("role.companion.name") }),
      }),
    );
    expect(
      await within(await latestCheck(region)).findByText(
        t("check.run.progress", { done: 1, total: 9 }),
      ),
    ).toBeVisible();
    expect(
      await within(await latestCheck(region)).findByText(
        companionFailed,
        {},
        { timeout: 4000 },
      ),
    ).toBeVisible();
    await waitFor(() => expect(statusNow.mock.calls.length).toBeGreaterThan(1));
    expect(within(region).getAllByText(companionFailed)).toHaveLength(1);
  });

  it("says a check past its deadline didn't finish in time, not that it is still checking", async () => {
    const stuck = check({
      target: "active",
      draftId: null,
      roles: ["companion", "supervisor"],
      total: 20,
      completed: 19,
      deadlineAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const port = upgraded({
      qualityStatus: vi.fn().mockResolvedValue({
        ...activeStatus(),
        blocked: { code: "PROVIDER_QUALITY_CHECK_RUNNING" },
        latest: stuck,
      }),
      qualityCheck: vi.fn().mockResolvedValue(stuck),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    const latest = await within(region).findByRole("region", {
      name: t("check.latest.title"),
    });
    expect(
      within(latest).getByText(t("check.run.overdue", { done: 19, total: 20 })),
    ).toBeVisible();
    expect(
      within(region).queryByText(
        t("check.run.progress", { done: 19, total: 20 }),
      ),
    ).toBeNull();
    // Once the server ends it (its deadline a minute past), it says so in plain words.
    cleanup();
    const ended = {
      ...stuck,
      state: "error" as const,
      reason: "PROVIDER_QUALITY_CHECK_INTERRUPTED",
      finishedAt: new Date().toISOString(),
    };
    render(
      <AiServicesPage
        workspaceId={workspace}
        port={upgraded({
          qualityStatus: vi
            .fn()
            .mockResolvedValue({ ...activeStatus(), latest: ended }),
        })}
        role="owner"
      />,
    );
    const after = await within(await checkRegion()).findByRole("region", {
      name: t("check.latest.title"),
    });
    expect(after).toHaveTextContent(t("check.run.interrupted"));
    expect(after).toHaveTextContent(
      t("check.run.stoppedAt", { done: 19, total: 20 }),
    );
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
      name: t("check.onTitle"),
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

  it("asks an administrator to get an owner's approval while a draft is open", async () => {
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
      await within(region).findByText(t("check.approveOwnersOnly")),
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
      within(region).getByRole("button", { name: he("check.on.runAll") }),
    ).toBeInTheDocument();
  });
});

describe("jobs that are on: check again and turn off", () => {
  const approvedAt = "2026-10-31T09:00:00.000Z";
  // The owner's case: both jobs turned on with "Approve without checking".
  const onSetup = (): ProviderSetup => {
    const base = setup(3);
    return {
      ...base,
      configuration: {
        ...(base.configuration as object),
        registry: {
          revision: "x",
          models: (["companion", "supervisor"] as const).map((r) => ({
            id: `connection-1:${r}`,
            providerId: "connection-1",
            remoteModel: "gemini-3.8-flash",
          })),
        },
        roles: Object.fromEntries(
          (["companion", "supervisor"] as const).map((r) => [
            r,
            { modelId: `connection-1:${r}` },
          ]),
        ),
      },
    };
  };
  const approved = () => ({
    suite: {
      id: "core-public",
      version: "2",
      digest: "f".repeat(64),
      dialogues: 18,
      coverage: [{ role: "companion", dialogues: 9 }],
    },
    providerRevision: 3,
    gatedAtActivation: true,
    roles: (["companion", "supervisor"] as const).map((role, i) => ({
      role,
      strategy: `core.${role}`,
      revisionDigest: String(i).repeat(64),
      covered: true,
      status: "override",
      grandfathered: false,
      activatedBy: "override",
      overrideId: `00000000-0000-4000-8000-00000000000${i}`,
      overriddenAt: approvedAt,
    })),
    results: [],
    overrides: [],
  });
  const plan = (role: "companion" | "supervisor", conversations: number) => ({
    role,
    remoteModel: "gemini-3.8-flash",
    conversations,
    priced: true,
    estimateMicroUsd: conversations * 6000,
    reserveMicroUsd: conversations * 100000,
    blocked: null,
  });
  const onStatus = (over: Partial<QualityStatus> = {}) =>
    status({
      target: null,
      draftId: null,
      roles: [],
      conversations: 0,
      estimateMicroUsd: 0,
      reserveMicroUsd: 0,
      blocked: { code: "PROVIDER_QUALITY_CHECK_NO_DRAFT" },
      onRoles: [plan("companion", 9), plan("supervisor", 3)],
      onAll: {
        conversations: 12,
        estimateMicroUsd: 72000,
        reserveMicroUsd: 1200000,
        blocked: null,
      },
      ...over,
    });
  const failedAll = check({
    target: "active",
    draftId: null,
    state: "failed",
    completed: 12,
    chargedMicroUsd: 40000,
    outcome: [
      {
        role: "companion",
        passed: false,
        dialogues: 9,
        failed: [{ dialogueId: "companion.a", graders: ["hint_leakage"] }],
      },
      { role: "supervisor", passed: true, dialogues: 3, failed: [] },
    ],
  });
  const onPort = (overrides: Parameters<typeof fakePort>[0] = {}) =>
    fakePort({
      setup: vi.fn().mockResolvedValue(onSetup()),
      currentDraft: vi.fn().mockResolvedValue(null),
      evals: vi.fn().mockResolvedValue(approved()),
      qualityStatus: vi.fn().mockResolvedValue(onStatus()),
      turnOff: vi.fn().mockResolvedValue({
        role: "companion",
        revision: 4,
        turnedOff: true,
        cancelledPendingJobs: 0,
      }),
      ...overrides,
    });

  it("shows how each job was approved and when, and checks one job or all of them again", async () => {
    const port = onPort({
      startQualityCheck: vi.fn().mockResolvedValue(
        check({
          target: "active",
          draftId: null,
          roles: ["companion"],
          total: 9,
          completed: 1,
        }),
      ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    const tutor = (await within(region).findAllByRole("listitem")).find(
      (li) => li.getAttribute("data-role") === "companion",
    )!;
    expect(
      within(tutor).getByText(t("check.state.override")),
    ).toBeInTheDocument();
    expect(
      within(tutor).getByText(
        t("check.on.approvedOn", { date: english.date(approvedAt, "medium") }),
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: t("check.on.runAll") }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(tutor).getByRole("button", {
        name: t("check.flag.runFor", { job: t("role.companion.name") }),
      }),
    );
    expect(
      await within(await latestCheck(region)).findByText(
        t("check.run.progress", { done: 1, total: 9 }),
      ),
    ).toBeInTheDocument();
    expect(port.startQualityCheck).toHaveBeenCalledWith(workspace, {
      target: "active",
      role: "companion",
      idempotencyKey: expect.stringMatching(/^ai-services:/),
    });
  });

  it("checks all jobs that are on with one request", async () => {
    const port = onPort({
      startQualityCheck: vi
        .fn()
        .mockResolvedValue(
          check({ target: "active", draftId: null, completed: 2 }),
        ),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="admin" />);
    const region = await checkRegion();
    fireEvent.click(
      await within(region).findByRole("button", { name: t("check.on.runAll") }),
    );
    expect(
      await within(region).findByText(
        t("check.run.progress", { done: 2, total: 12 }),
      ),
    ).toBeInTheDocument();
    expect(port.startQualityCheck).toHaveBeenCalledWith(workspace, {
      target: "active",
      idempotencyKey: expect.stringMatching(/^ai-services:/),
    });
  });

  it("keeps a job that failed on, offers to turn it off and asks first in plain words", async () => {
    const port = onPort({
      qualityStatus: vi.fn().mockResolvedValue(onStatus({ latest: failedAll })),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const region = await checkRegion();
    const job = t("role.companion.name");
    const still = (
      await within(region).findByText(t("check.on.failedStillOn", { count: 1 }))
    ).closest(".ai-message") as HTMLElement;
    // Only the job that failed is offered, right under the result; the check turned nothing off.
    expect(
      within(still).queryByRole("button", {
        name: t("check.on.turnOffFor", { job: t("role.supervisor.name") }),
      }),
    ).toBeNull();
    expect(port.turnOff).not.toHaveBeenCalled();
    fireEvent.click(
      within(still).getByRole("button", {
        name: t("check.on.turnOffFor", { job }),
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: t("check.on.turnOffTitle", { job }),
    });
    expect(dialog).toHaveAccessibleDescription(t("check.on.turnOffBody"));
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: t("check.on.turnOffConfirm"),
      }),
    );
    await waitFor(() =>
      expect(port.turnOff).toHaveBeenCalledWith(workspace, {
        expectedRevision: 3,
        role: "companion",
        idempotencyKey: expect.stringMatching(/^ai-services:/),
      }),
    );
  });

  it("says the same in Hebrew", async () => {
    render(
      <I18nProvider value={hebrew}>
        <AiServicesPage workspaceId={workspace} port={onPort()} role="owner" />
      </I18nProvider>,
    );
    const region = await screen.findByRole("region", {
      name: he("section.check"),
    });
    expect(
      await within(region).findByRole("button", {
        name: he("check.on.turnOffFor", { job: he("role.companion.name") }),
      }),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole("button", { name: he("check.on.runAll") }),
    ).toBeInTheDocument();
  });
});
