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
  I18nProvider,
  createAdminTranslator,
  type MessageKey,
} from "../src/i18n";
import type { ReactNode } from "react";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { demoSession, demoWorkspace } from "../src/data/fixtures";
import { demo } from "./helpers";

const workspace = "00000000-0000-4000-8000-000000000001";
const key = ["SYNTHETIC", "UNIT", "KEY", "7Q2c"].join("_");
const english = createAdminTranslator("en"),
  hebrew = createAdminTranslator("he");
const t = (key: string, args?: Record<string, string | number>) =>
  english.t(`aiServices.${key}` as MessageKey, args);
const he = (key: string, args?: Record<string, string | number>) =>
  hebrew.t(`aiServices.${key}` as MessageKey, args);
const inHebrew = (node: ReactNode) => (
  <I18nProvider value={hebrew}>{node}</I18nProvider>
);
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
    qualityStatus: vi.fn().mockResolvedValue(null),
    startQualityCheck: vi.fn(),
    qualityCheck: vi.fn(),
    ...overrides,
  };
  return port as unknown as AiServicesPort &
    Record<keyof AiServicesPort, ReturnType<typeof vi.fn>>;
}

describe("AI services text", () => {
  it("formats plurals in English and Hebrew (one, two, other)", () => {
    expect(t("issue.prices", { count: 1 })).toBe("1 model needs a price");
    expect(t("issue.prices", { count: 3 })).toBe("3 models need a price");
    expect(he("issue.prices", { count: 2 })).toBe("שני מודלים צריכים מחיר");
    expect(he("issue.prices", { count: 5 })).toBe("5 מודלים צריכים מחיר");
  });
  it("parses and shows USD amounts exactly", () => {
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
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
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
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
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
      <AiServicesPage workspaceId={workspace} port={admin} role="admin" />,
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
      <AiServicesPage workspaceId={workspace} port={owner} role="owner" />,
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
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
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

  it("names each character a key can't contain, blocks testing and saving, and fixes look-alikes only when asked", async () => {
    const port = fakePort();
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const field = await screen.findByLabelText(t("connect.keyLabel"));
    // A Gemini "AQ." key whose x became a multiplication sign and a hyphen an en dash.
    const good = ["AQ", "Ab8SYNTHETICxKEY-unit_0", "0000"].join(".");
    const pasted = good.replace("x", "\u00d7").replace("-", "\u2013");
    const at = (c: string) => Array.from(pasted).indexOf(c) + 1;
    fireEvent.change(field, { target: { value: pasted } });
    fireEvent.blur(field);
    expect(
      screen.getByText(
        "This key has 2 characters that API keys never contain. Apps that auto-format text sometimes swap or add them.",
      ),
    ).toBeInTheDocument();
    const list = document.querySelector(".ai-key-chars") as HTMLElement;
    expect(list.querySelectorAll("li")[0]).toHaveTextContent(
      `Character ${at("\u00d7")} is \u00d7 (multiplication sign), not the letter x.`,
    );
    expect(list.querySelectorAll("li")[1]).toHaveTextContent(
      `Character ${at("\u2013")} is \u2013 (en dash), not a plain hyphen -.`,
    );
    expect(list).toHaveTextContent(
      "Copy the key again with the copy button in Google AI Studio, and paste it straight here.",
    );
    // Only the offending characters are shown, never the rest of the key.
    expect(list.textContent).not.toMatch(/SYNTHETIC|Ab8|unit_0/);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(list.id);
    const save = screen.getByRole("button", { name: t("connect.save") });
    expect(save).toBeDisabled();
    expect(screen.getByText(t("keyChars.saveBlocked"))).toBeInTheDocument();
    expect(port.testKey).not.toHaveBeenCalled();
    // Nothing is replaced until the person asks.
    expect(field).toHaveValue(pasted);
    fireEvent.click(
      screen.getByRole("button", { name: t("keyChars.fix", { count: 2 }) }),
    );
    expect(field).toHaveValue(good);
    expect(field).toHaveFocus();
    expect(screen.getByText(t("keyChars.fixed", { count: 2 }))).toHaveAttribute(
      "role",
      "status",
    );
    expect(document.querySelector(".ai-key-chars")).toBeNull();
    // The fixed key is checked like a fresh paste, then saved as usual.
    await waitFor(() =>
      expect(port.testKey).toHaveBeenCalledWith(workspace, {
        kind: "google",
        key: good,
      }),
    );
    expect(
      await screen.findByText(
        t("connect.testOk", { service: "Google", count: 3 }),
      ),
    ).toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("lists at most three characters, counts the rest, and leaves spaces and quotes for a fresh copy", async () => {
    const port = fakePort();
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    const field = await screen.findByLabelText(t("connect.keyLabel"));
    fireEvent.change(field, {
      target: { value: "\u201cAIzaSYN TH\u200bETIC\u2011KEY\u00a0X\u201d" },
    });
    const list = document.querySelector(".ai-key-chars") as HTMLElement;
    const items = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([
      "Character 1 is \u201c (left double quotation mark). API keys never contain quotation marks.",
      "Character 9 is a space.",
      "Character 12 is an invisible zero-width space.",
    ]);
    expect(list).toHaveTextContent("And 3 more characters.");
    // Two of six can be fixed here (the zero-width space and the hyphen).
    expect(
      screen.getByRole("button", { name: t("keyChars.fix", { count: 2 }) }),
    ).toBeInTheDocument();
    expect(list).toHaveTextContent(t("keyChars.fixPartial", { count: 4 }));
    fireEvent.click(
      screen.getByRole("button", { name: t("keyChars.fix", { count: 2 }) }),
    );
    expect(field).toHaveValue("\u201cAIzaSYN THETIC-KEY\u00a0X\u201d");
    expect(screen.getByText(t("keyChars.summary", { count: 4 }))).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Fix / }),
    ).not.toBeInTheDocument();
    expect(port.testKey).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: t("connect.save") }),
    ).toBeDisabled();
  });

  it("checks a replacement key the same way", async () => {
    const port = fakePort({
      connections: vi
        .fn()
        .mockResolvedValue({ ...noConnections, connections: [connection] }),
    });
    render(<AiServicesPage workspaceId={workspace} port={port} role="owner" />);
    fireEvent.click(
      await screen.findByRole("button", { name: t("row.replaceKey") }),
    );
    const field = screen.getByLabelText(/New API key for/);
    fireEvent.change(field, { target: { value: "AQ.ab\u2212cd" } });
    expect(document.querySelector(".ai-key-chars li")).toHaveTextContent(
      "Character 6 is \u2212 (minus sign), not a plain hyphen -.",
    );
    const save = screen.getByRole("button", { name: t("row.replaceSave") });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(port.replaceKey).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: t("keyChars.fix", { count: 1 }) }),
    );
    expect(field).toHaveValue("AQ.ab-cd");
    expect(save).toBeEnabled();
  });

  it("isolates the offending character left to right in Hebrew", async () => {
    const port = fakePort();
    render(
      inHebrew(
        <AiServicesPage workspaceId={workspace} port={port} role="owner" />,
      ),
    );
    const field = await screen.findByLabelText(he("connect.keyLabel"));
    fireEvent.change(field, { target: { value: "AQ.ab\u00d7cd" } });
    const char = document.querySelector(".ai-key-chars .ai-key-char")!;
    expect(char.tagName).toBe("BDI");
    expect(char).toHaveAttribute("dir", "ltr");
    expect(char.textContent?.replace(/[\u2066-\u2069]/g, "")).toBe("\u00d7");
    const line = document.querySelector(".ai-key-chars li")!.textContent!;
    expect(line.replace(/[\u2066-\u2069]/g, "")).toBe(
      "התו במקום 6 הוא \u00d7 (סימן כפל), ולא האות x.",
    );
    expect(
      screen.getByRole("button", { name: he("keyChars.fix", { count: 1 }) }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: he("connect.save") }),
    ).toBeDisabled();
  });

  it("renders right to left in Hebrew with ids and key endings isolated left to right", async () => {
    const port = fakePort({
      setup: vi.fn().mockResolvedValue(setup(activeConfiguration, 2)),
      connections: vi
        .fn()
        .mockResolvedValue({ ...noConnections, connections: [connection] }),
    });
    render(
      inHebrew(
        <AiServicesPage workspaceId={workspace} port={port} role="owner" />,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "חיבורים" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: he("row.replaceKey") }),
    ).toBeInTheDocument();
    expect(screen.getByText("7Q2c").closest("bdi")).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(screen.getByText(he("status.off"))).toBeInTheDocument();
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
