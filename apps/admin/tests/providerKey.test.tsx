import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProviderSetupPanel } from "../src/components/ProviderSetupPanel";
import { ProviderModelGuide } from "../src/components/ProviderModelGuide";
import {
  credentialTargets,
  trimKey,
  type ProviderSetup,
  type ProviderSetupPort,
} from "../src/domain/providerSetup";
import { AdminError } from "../src/domain/errors";
import { createFetchAdminClient } from "../src/client/fetchClient";
import {
  providerSetupText as text,
  reasonMessage,
} from "../src/text/providerSetup";

// The pilot's shape: one guided Google connection whose key is bound to a generated name.
const binding = "COURSE_PROVIDER_BDA347CA2B94479E_API_KEY",
  typed = ["SYNTHETIC", "TYPED", "KEY"].join("_");
const setup = (adapters: unknown[] = []): ProviderSetup => ({
  revision: 1,
  configuration: {
    registry: { revision: "empty", models: [] },
    adapters,
    roles: {},
  },
  jobPolicy: {
    allowance: { microUsd: 100000, tokens: 10000 },
    durationMs: 300000,
    timeoutMs: 60000,
    maxAttempts: 3,
  },
  tokenBounds: {},
  credentials: adapters.length ? [{ name: binding, configured: true }] : [],
  models: [],
  roles: {},
  verification: "not_run",
  storage: "encrypted_server_vault",
  budgetIsSeparate: true,
  metadataKinds: [{ kind: "google", label: "Google", guided: true }],
});
const connected = () =>
  setup([
    { id: "connection-aa4471e1", kind: "google", credentialEnv: binding },
  ]);
function port(current: ProviderSetup = setup()) {
  return {
    accountId: "one",
    read: vi.fn().mockResolvedValue(current),
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
    save: vi.fn().mockResolvedValue({
      revision: 2,
      configurationSaved: true,
      verification: "not_run",
      cancelledPendingJobs: 0,
      budgetChanged: false,
    }),
    saveBudget: vi.fn(),
    testKey: vi.fn().mockResolvedValue({
      kind: "google",
      outcome: "ok",
      modelCount: 42,
      truncated: false,
      stored: false,
      generationPerformed: false,
    }),
    inspectModels: vi.fn().mockResolvedValue({
      id: "inspection",
      state: "failed",
      result: null,
      reason: "PROVIDER_METADATA_CREDENTIAL_MISSING",
    }),
    previewModels: vi.fn(),
  } satisfies ProviderSetupPort;
}
async function ready() {
  await screen.findByLabelText("Total cost allowance (USD)");
  await waitFor(() =>
    expect(screen.queryByText("Loading secure settings…")).toBeNull(),
  );
}

it("trims pasted keys of surrounding whitespace and invisible characters only", () => {
  expect(trimKey(" \t" + typed + "\r\n​﻿")).toBe(typed);
  expect(trimKey("A B")).toBe("A B");
  expect(trimKey("   ")).toBe("");
});

it("saves a guided connection with the trimmed key under the new adapter's own binding", async () => {
  const api = port();
  render(<ProviderSetupPanel workspaceId="w" api={api} />);
  await ready();
  const save = screen.getByRole("button", { name: "Save new connection" });
  // Nothing to save until a key is typed; whitespace alone is not a key.
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("API key for new connection"), {
    target: { value: "   " },
  });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("API key for new connection"), {
    target: { value: "  " + typed + " \t" },
  });
  expect(save).toBeEnabled();
  // Untested keys may be saved, with a visible warning.
  expect(screen.getByText(text.untestedWarning)).toBeVisible();
  fireEvent.click(save);
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  const input = api.save.mock.calls[0]![1];
  const adapter = (
    input.configuration as {
      adapters: { id: string; kind: string; credentialEnv: string }[];
    }
  ).adapters[0]!;
  expect(adapter.kind).toBe("google");
  expect(adapter.credentialEnv).toMatch(
    /^COURSE_PROVIDER_[A-Z0-9]{16}_API_KEY$/,
  );
  expect(input.credentials).toEqual({ [adapter.credentialEnv]: typed });
});

it("tests the typed key before saving and reports success or the precise refusal", async () => {
  const api = port();
  render(<ProviderSetupPanel workspaceId="w" api={api} />);
  await ready();
  const test = screen.getByRole("button", { name: "Test key" });
  expect(test).toBeDisabled();
  fireEvent.change(screen.getByLabelText("API key for new connection"), {
    target: { value: typed + "\n" },
  });
  fireEvent.click(test);
  expect(await screen.findByText(text.keyWorks(42, false))).toBeVisible();
  expect(api.testKey).toHaveBeenCalledWith("w", { kind: "google", key: typed });
  expect(api.save).not.toHaveBeenCalled();
  expect(screen.queryByText(text.untestedWarning)).toBeNull();
  // A different key is a new, untested key.
  fireEvent.change(screen.getByLabelText("API key for new connection"), {
    target: { value: typed + "_OTHER" },
  });
  expect(screen.queryByText(text.keyWorks(42, false))).toBeNull();
  expect(screen.getByText(text.untestedWarning)).toBeVisible();
  for (const outcome of [
    "PROVIDER_METADATA_KEY_INVALID",
    "PROVIDER_METADATA_API_NOT_ENABLED",
    "PROVIDER_METADATA_RATE_LIMITED",
    "PROVIDER_METADATA_TIMEOUT",
    "PROVIDER_METADATA_NETWORK",
  ]) {
    api.testKey.mockResolvedValueOnce({
      kind: "google",
      outcome,
      modelCount: null,
      truncated: null,
      stored: false,
      generationPerformed: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText(reasonMessage(outcome)!)).toBeVisible();
  }
  // Endpoint refusals carry their reason too.
  api.testKey.mockRejectedValueOnce(
    new AdminError("unavailable", undefined, "PROVIDER_KEY_TEST_RATE_LIMITED"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Test key" }));
  expect(
    await screen.findByText(reasonMessage("PROVIDER_KEY_TEST_RATE_LIMITED")!),
  ).toBeVisible();
  api.testKey.mockRejectedValueOnce(new AdminError("unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Test key" }));
  expect(await screen.findByText(text.testIncomplete)).toBeVisible();
  expect(api.save).not.toHaveBeenCalled();
});

it("shows the specific inspection failure instead of the general text, and offers to enter the key again for that connection", async () => {
  const api = port(connected());
  render(<ProviderSetupPanel workspaceId="w" api={api} />);
  await ready();
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect model metadata" }),
  );
  expect(
    await screen.findByText(
      "No key is stored for this connection. Enter the key again and save.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(text.inspectionFailed)).toBeNull();
  const replace = screen.getByLabelText(
    text.replaceKeyLabel("connection-aa4471e1"),
  );
  fireEvent.change(replace, { target: { value: " " + typed + " " } });
  fireEvent.click(screen.getByRole("button", { name: text.replaceKeySave }));
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  expect(api.save.mock.calls[0]![1]).toMatchObject({
    expectedRevision: 1,
    configuration: connected().configuration,
    credentials: { [binding]: typed },
  });
});

it("every inspection reason has its own message; an unknown one falls back to the general text", async () => {
  for (const reason of [
    "PROVIDER_METADATA_CREDENTIAL_MALFORMED",
    "PROVIDER_METADATA_KEY_INVALID",
    "PROVIDER_METADATA_API_NOT_ENABLED",
    "PROVIDER_METADATA_KEY_RESTRICTED",
    "PROVIDER_METADATA_PERMISSION_DENIED",
    "PROVIDER_METADATA_RATE_LIMITED",
    "PROVIDER_METADATA_REJECTED",
    "PROVIDER_METADATA_UPSTREAM_ERROR",
    "PROVIDER_METADATA_NETWORK",
    "PROVIDER_METADATA_TIMEOUT",
    "PROVIDER_METADATA_INVALID",
    "PROVIDER_METADATA_TOO_LARGE",
    "PROVIDER_METADATA_UNAVAILABLE",
    "PROVIDER_METADATA_SCOPE_CHANGED",
    "PROVIDER_METADATA_INTERRUPTED",
    "SOMETHING_NEW",
  ]) {
    const api = port(connected());
    api.inspectModels.mockResolvedValue({
      id: "inspection",
      state: "failed",
      result: null,
      reason,
    });
    const view = render(
      <ProviderModelGuide
        workspaceId="w"
        setup={connected()}
        api={api}
        disabled={false}
        onConnection={() => {}}
        onDraft={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect model metadata" }),
    );
    const expected = reasonMessage(reason) ?? text.inspectionFailed;
    expect(await screen.findByText(expected)).toBeVisible();
    if (reason !== "SOMETHING_NEW")
      expect(expected).not.toBe(text.inspectionFailed);
    view.unmount();
  }
});

it("the advanced key field binds to the connection's actual binding, not a stale default", async () => {
  const api = port(connected());
  render(<ProviderSetupPanel workspaceId="w" api={api} />);
  await ready();
  expect(screen.getByLabelText("Credential binding")).toHaveValue(binding);
  const target = screen.getByLabelText(text.bindingTarget);
  expect(target).toHaveValue(binding);
  expect(target).toHaveDisplayValue(
    text.bindingConnection("Google", "connection-aa4471e1"),
  );
  fireEvent.change(screen.getByLabelText("New or replacement API key"), {
    target: { value: typed + "\n" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  expect(api.save.mock.calls[0]![1].credentials).toEqual({ [binding]: typed });
  // Choosing "Another binding name" keeps a typed custom name.
  fireEvent.change(target, { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Credential binding"), {
    target: { value: "COURSE_PROVIDER_YOUTUBE_DATA_API_KEY" },
  });
  expect(target).toHaveValue("");
});

it("a refused key save says what is wrong with the key", async () => {
  const api = port(connected());
  api.save.mockRejectedValueOnce(
    new AdminError("validation", undefined, "PROVIDER_CREDENTIAL_EMPTY"),
  );
  render(<ProviderSetupPanel workspaceId="w" api={api} />);
  await ready();
  fireEvent.change(screen.getByLabelText("New or replacement API key"), {
    target: { value: "   " },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  expect(
    await screen.findByText(reasonMessage("PROVIDER_CREDENTIAL_EMPTY")!),
  ).toBeVisible();
  expect(api.save.mock.calls[0]![1].credentials).toEqual({ [binding]: "" });
});

it("lists connection, fallback and stored bindings once each", () => {
  expect(
    credentialTargets(
      {
        adapters: [
          {
            id: "a",
            kind: "google",
            credentialEnv: "COURSE_PROVIDER_A_API_KEY",
          },
          {
            id: "s",
            kind: "subscription",
            subscriptionRef: "host",
            automaticFallback: {
              enabled: true,
              credentialEnv: "COURSE_PROVIDER_B_API_KEY",
            },
          },
        ],
      },
      [
        { name: "COURSE_PROVIDER_A_API_KEY" },
        { name: "COURSE_PROVIDER_YOUTUBE_DATA_API_KEY" },
      ],
    ),
  ).toEqual([
    {
      name: "COURSE_PROVIDER_A_API_KEY",
      source: "connection",
      adapterId: "a",
      kind: "google",
    },
    { name: "COURSE_PROVIDER_B_API_KEY", source: "fallback", adapterId: "s" },
    { name: "COURSE_PROVIDER_YOUTUBE_DATA_API_KEY", source: "stored" },
  ]);
});

it("the fetch client posts key tests and keeps only PROVIDER_* reason codes from refusals", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          kind: "google",
          outcome: "ok",
          modelCount: 3,
          truncated: false,
          stored: false,
          generationPerformed: false,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "PROVIDER_CREDENTIAL_MALFORMED" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "SOME other text" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
  const client = createFetchAdminClient({
    baseUrl: "/api/admin",
    fetch: fetcher,
  });
  const setupPort = client.providerSetup!;
  await expect(
    setupPort.testKey!("w", { kind: "google", key: typed }),
  ).resolves.toMatchObject({ outcome: "ok", modelCount: 3 });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("/api/admin/workspaces/w/provider-setup/test-key");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ kind: "google", key: typed });
  await expect(
    setupPort.testKey!("w", { kind: "google", key: "A B" }),
  ).rejects.toMatchObject({
    code: "validation",
    reason: "PROVIDER_CREDENTIAL_MALFORMED",
  });
  await expect(
    setupPort.testKey!("w", { kind: "google", key: typed }),
  ).rejects.toMatchObject({ code: "unavailable", reason: undefined });
});
