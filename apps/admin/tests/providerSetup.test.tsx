import {
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProviderSetupPanel } from "../src/components/ProviderSetupPanel";
import {
  usdToMicro,
  microToUsd,
  type ProviderSetupPort,
  type ProviderSetup,
  type ProviderBudgets,
} from "../src/domain/providerSetup";
import { AdminError } from "../src/domain/errors";
const setup = (): ProviderSetup => ({
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
});
const ledger = (): ProviderBudgets => ({
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
});
function api(): ProviderSetupPort {
  return {
    accountId: "one",
    read: vi.fn().mockResolvedValue(setup()),
    budgets: vi.fn().mockResolvedValue(ledger()),
    save: vi.fn().mockResolvedValue({
      revision: 2,
      configurationSaved: true,
      verification: "not_run",
      cancelledPendingJobs: 1,
      budgetChanged: false,
    }),
    saveBudget: vi.fn().mockResolvedValue({
      revision: 1,
      limits: { microUsd: 0, tokens: 0 },
      scope: "workspace",
      doesNotGrantMastery: true,
      consentRecorded: false,
    }),
  };
}
function mount(port: ProviderSetupPort) {
  return render(<ProviderSetupPanel workspaceId="workspace" api={port} />);
}
async function ready() {
  await screen.findByLabelText("New or replacement API key");
  await screen.findByLabelText("Total cost allowance (USD)");
  await waitFor(() =>
    expect(screen.queryByText("Loading secure settings…")).toBeNull(),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const limit = (microUsd: string, tokens: string, revision = 0) => {
  const value = ledger();
  value.workspace = {
    ...value.workspace,
    revision,
    limit_micro_usd: microUsd,
    limit_tokens: tokens,
  };
  return value;
};
it("does not auto-save or approve a budget; confirmed writes clear credentials and remain unverified", async () => {
  const port = api();
  mount(port);
  await ready();
  expect(port.save).not.toHaveBeenCalled();
  expect(port.saveBudget).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("New or replacement API key"), {
    target: { value: "PRIVATE_KEY_CANARY" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await screen.findByText(/Configuration saved\. 1 unfinished jobs/);
  expect(screen.getByLabelText("New or replacement API key")).toHaveValue("");
  expect(port.save).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({
      credentials: { GOOGLE_API_KEY: "PRIVATE_KEY_CANARY" },
      expectedRevision: 1,
    }),
  );
  expect(port.saveBudget).not.toHaveBeenCalled();
  expect(screen.getByText("Not verified")).toBeVisible();
});
it("subscription fallback defaults off, saves explicit opt-in and can be disabled without raising paid limits", async () => {
  const port = api(),
    current = setup();
  current.configuration = {
    registry: { revision: "empty", models: [] },
    roles: {},
    adapters: [
      {
        id: "subscription-one",
        kind: "future-vendor",
        subscriptionRef: "host-connection",
      },
    ],
  };
  current.credentials = [
    { name: "COURSE_PROVIDER_FUTURE_API_KEY", configured: true },
  ];
  port.read = vi.fn().mockResolvedValue(current);
  port.save = vi.fn().mockImplementation(async (_workspace, input) => {
    current.configuration = structuredClone(input.configuration);
    current.revision++;
    return {
      revision: current.revision,
      configurationSaved: true,
      verification: "not_run",
      cancelledPendingJobs: 0,
      budgetChanged: false,
    };
  });
  mount(port);
  await ready();
  const checkbox = screen.getByRole("checkbox", {
    name: "Automatically use paid API fallback for subscription-one",
  });
  expect(checkbox).not.toBeChecked();
  expect(port.save).not.toHaveBeenCalled();
  fireEvent.click(checkbox);
  fireEvent.change(
    screen.getByLabelText("Fallback credential reference for subscription-one"),
    { target: { value: "COURSE_PROVIDER_FUTURE_API_KEY" } },
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await waitFor(() => expect(port.save).toHaveBeenCalledTimes(1));
  const input = vi.mocked(port.save).mock.calls[0]![1];
  expect((input.configuration as any).adapters[0].automaticFallback).toEqual({
    enabled: true,
    credentialEnv: "COURSE_PROVIDER_FUTURE_API_KEY",
  });
  expect(input.credentials).toEqual({});
  expect(port.saveBudget).not.toHaveBeenCalled();
  await screen.findByText(/Configuration saved/);
  // Reloaded confirmed server state may keep the user's opt-in; turning it off
  // changes the configuration only, never erases reserved costs or enlarges limits.
  expect(
    screen.getByRole("checkbox", {
      name: "Automatically use paid API fallback for subscription-one",
    }),
  ).toBeChecked();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Automatically use paid API fallback for subscription-one",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await waitFor(() => expect(port.save).toHaveBeenCalledTimes(2));
  expect(
    (vi.mocked(port.save).mock.calls[1]![1].configuration as any).adapters[0]
      .automaticFallback.enabled,
  ).toBe(false);
  expect(port.saveBudget).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", {
        name: "Automatically use paid API fallback for subscription-one",
      }),
    ).not.toBeChecked(),
  );
});
it("lost acknowledgement retries exactly the same payload and blocks other edits", async () => {
  const port = api();
  port.save = vi
    .fn()
    .mockRejectedValueOnce(new AdminError("unavailable"))
    .mockResolvedValueOnce({
      revision: 2,
      configurationSaved: true,
      verification: "not_run",
      cancelledPendingJobs: 0,
      budgetChanged: false,
    });
  mount(port);
  await ready();
  fireEvent.change(screen.getByLabelText("New or replacement API key"), {
    target: { value: "KEY_CANARY" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await screen.findByRole("button", { name: "Retry unconfirmed request" });
  expect(screen.getByLabelText("New or replacement API key")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Save paid-work limits" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry unconfirmed request" }),
  );
  await waitFor(() => expect(port.save).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(port.save).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
  await screen.findByText(/Configuration saved/);
});
it("an account switch clears secret drafts even on the same workspace", async () => {
  const first = api(),
    view = mount(first);
  await ready();
  fireEvent.change(screen.getByLabelText("New or replacement API key"), {
    target: { value: "OLD_ACCOUNT_SECRET" },
  });
  const second = { ...api(), accountId: "two" };
  view.rerender(<ProviderSetupPanel workspaceId="workspace" api={second} />);
  await ready();
  expect(screen.getByLabelText("New or replacement API key")).toHaveValue("");
  expect(second.save).not.toHaveBeenCalled();
});
it("does not display raw parsing content, and stale writes require review rather than silent repeat", async () => {
  const port = api();
  mount(port);
  await ready();
  fireEvent.click(screen.getByText("Models and role bindings"));
  fireEvent.change(screen.getByLabelText("Provider configuration JSON"), {
    target: { value: "SECRET_JSON_CANARY invalid" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await screen.findByText(
    "Use valid configuration JSON and a USD allowance with up to six decimal places.",
  );
  expect(port.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Provider configuration JSON"), {
    target: { value: "{}" },
  });
  port.save = vi.fn().mockRejectedValue(new AdminError("stale_revision"));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await screen.findByText(/Settings or budget changed/);
  expect(
    screen.queryByRole("button", { name: "Retry unconfirmed request" }),
  ).toBeNull();
  expect(port.save).toHaveBeenCalledTimes(1);
});
it("sends paid permission only after an explicit choice and converts money without rounding", async () => {
  const port = api();
  mount(port);
  await ready();
  fireEvent.change(screen.getByLabelText("Total cost allowance (USD)"), {
    target: { value: "0.123456" },
  });
  fireEvent.change(screen.getByLabelText("Total token allowance"), {
    target: { value: "600000" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save paid-work limits" }),
  );
  await screen.findByText(
    "Approve paid work explicitly before saving a positive allowance.",
  );
  expect(port.saveBudget).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I authorize paid work within these application limits.",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save paid-work limits" }),
  );
  await waitFor(() => expect(port.saveBudget).toHaveBeenCalledTimes(1));
  expect(port.saveBudget).toHaveBeenLastCalledWith(
    "workspace",
    expect.objectContaining({
      paidWorkApproved: true,
      limits: { microUsd: 123456, tokens: 600000 },
    }),
  );
  expect(usdToMicro("0.000001")).toBe(1);
  expect(microToUsd(123456)).toBe("0.123456");
  for (const bad of ["1e3", "-1", "NaN", "0.0000001", "1000.000001"])
    expect(() => usdToMicro(bad)).toThrow();
});
it("saving a budget preserves the unsaved model and credential drafts", async () => {
  const port = api();
  mount(port);
  await ready();
  fireEvent.change(screen.getByLabelText("New or replacement API key"), {
    target: { value: "UNSAVED_KEY" },
  });
  fireEvent.click(screen.getByText("Models and role bindings"));
  fireEvent.change(screen.getByLabelText("Provider configuration JSON"), {
    target: { value: '{"unsaved":"model draft"}' },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save paid-work limits" }),
  );
  await screen.findByText(/Budget limits saved/);
  expect(screen.getByLabelText("New or replacement API key")).toHaveValue(
    "UNSAVED_KEY",
  );
  expect(screen.getByLabelText("Provider configuration JSON")).toHaveValue(
    '{"unsaved":"model draft"}',
  );
  expect(port.save).not.toHaveBeenCalled();
});

it("an operator can type into budget fields as soon as they appear", async () => {
  // Regression for a CI flake: the drafts used to be seeded by an effect that
  // could run after the first keystroke and reset the allowance to 0. The
  // stall below lets the test resume before React's next scheduler task, as a
  // loaded CI runner did; the drafts must already be seeded by then.
  const port = api();
  port.budgets = vi.fn().mockResolvedValue(limit("5000000", "100"));
  const found = screen.findByLabelText("Total cost allowance (USD)");
  let stalled = false;
  const observer = new MutationObserver(() => {
    if (stalled || !document.getElementById("budget-cost")) return;
    stalled = true;
    let hops = 0;
    const hop = () => {
      if (++hops < 40) return queueMicrotask(hop);
      const start = performance.now();
      while (performance.now() - start < 5);
    };
    queueMicrotask(hop);
  });
  observer.observe(document.body, { subtree: true, childList: true });
  mount(port);
  const field = await found;
  observer.disconnect();
  fireEvent.change(field, { target: { value: "0.123456" } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(field).toHaveValue("0.123456");
  expect(screen.getByLabelText("Total token allowance")).toHaveValue("100");
});
it("a settings refresh keeps an edited budget draft and checks it against the ledger the operator saw", async () => {
  const port = api(),
    refreshed = deferred<ProviderBudgets>();
  port.budgets = vi
    .fn()
    .mockResolvedValueOnce(limit("1000000", "500", 3))
    .mockReturnValueOnce(refreshed.promise);
  mount(port);
  await ready();
  expect(screen.getByLabelText("Total cost allowance (USD)")).toHaveValue(
    "1.000000",
  );
  fireEvent.change(screen.getByLabelText("Total cost allowance (USD)"), {
    target: { value: "0.123456" },
  });
  fireEvent.change(screen.getByLabelText("Total token allowance"), {
    target: { value: "600000" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I authorize paid work within these application limits.",
    }),
  );
  // Saving model settings reloads the setup and ledger; the ledger arrives late
  // and reports a concurrent limit change.
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await waitFor(() => expect(port.budgets).toHaveBeenCalledTimes(2));
  await act(async () => refreshed.resolve(limit("0", "0", 4)));
  await ready();
  expect(screen.getByLabelText("Total cost allowance (USD)")).toHaveValue(
    "0.123456",
  );
  expect(screen.getByLabelText("Total token allowance")).toHaveValue("600000");
  // Any confirmed write still withdraws paid-work approval; re-approve.
  const approval = screen.getByRole("checkbox", {
    name: "I authorize paid work within these application limits.",
  });
  expect(approval).not.toBeChecked();
  fireEvent.click(approval);
  port.saveBudget = vi.fn().mockRejectedValue(new AdminError("stale_revision"));
  fireEvent.click(
    screen.getByRole("button", { name: "Save paid-work limits" }),
  );
  await waitFor(() => expect(port.saveBudget).toHaveBeenCalledTimes(1));
  expect(port.saveBudget).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({
      expectedRevision: 3,
      limits: { microUsd: 123456, tokens: 600000 },
      paidWorkApproved: true,
    }),
  );
  await screen.findByText(/Settings or budget changed/);
  // An explicit reload discards the draft and shows the server's limits.
  port.budgets = vi.fn().mockResolvedValue(limit("0", "0", 4));
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved settings" }),
  );
  await waitFor(() => expect(port.budgets).toHaveBeenCalledTimes(1));
  await ready();
  expect(screen.getByLabelText("Total cost allowance (USD)")).toHaveValue(
    "0.000000",
  );
  expect(screen.getByLabelText("Total token allowance")).toHaveValue("0");
  expect(
    screen.getByRole("checkbox", {
      name: "I authorize paid work within these application limits.",
    }),
  ).not.toBeChecked();
});
it("an unedited budget draft follows a refreshed ledger", async () => {
  const port = api();
  port.budgets = vi
    .fn()
    .mockResolvedValueOnce(limit("1000000", "500", 3))
    .mockResolvedValueOnce(limit("2500000", "900", 4));
  mount(port);
  await ready();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save settings and cancel unfinished jobs",
    }),
  );
  await waitFor(() => expect(port.budgets).toHaveBeenCalledTimes(2));
  await ready();
  await waitFor(() =>
    expect(screen.getByLabelText("Total cost allowance (USD)")).toHaveValue(
      "2.500000",
    ),
  );
  expect(screen.getByLabelText("Total token allowance")).toHaveValue("900");
  fireEvent.change(screen.getByLabelText("Total token allowance"), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText("Total cost allowance (USD)"), {
    target: { value: "0" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save paid-work limits" }),
  );
  await waitFor(() => expect(port.saveBudget).toHaveBeenCalledTimes(1));
  expect(port.saveBudget).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({
      expectedRevision: 4,
      limits: { microUsd: 0, tokens: 0 },
    }),
  );
});
it("switching budget scope shows that scope's saved limits and clears approval", async () => {
  const port = api(),
    ledgers = limit("1000000", "500", 3);
  ledgers.enrollments = [
    {
      enrollmentId: "learner-a",
      revision: 7,
      limit_micro_usd: "250000",
      limit_tokens: "40",
      used_micro_usd: "0",
      used_tokens: "0",
    },
  ];
  port.budgets = vi.fn().mockResolvedValue(ledgers);
  mount(port);
  await ready();
  fireEvent.change(screen.getByLabelText("Total cost allowance (USD)"), {
    target: { value: "9" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I authorize paid work within these application limits.",
    }),
  );
  fireEvent.change(screen.getByLabelText("Budget scope"), {
    target: { value: "learner-a" },
  });
  expect(screen.getByLabelText("Total cost allowance (USD)")).toHaveValue(
    "0.250000",
  );
  expect(screen.getByLabelText("Total token allowance")).toHaveValue("40");
  expect(
    screen.getByRole("checkbox", {
      name: "I authorize paid work within these application limits.",
    }),
  ).not.toBeChecked();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I authorize paid work within these application limits.",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save paid-work limits" }),
  );
  await waitFor(() => expect(port.saveBudget).toHaveBeenCalledTimes(1));
  expect(port.saveBudget).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({
      enrollmentId: "learner-a",
      expectedRevision: 7,
      limits: { microUsd: 250000, tokens: 40 },
    }),
  );
});
