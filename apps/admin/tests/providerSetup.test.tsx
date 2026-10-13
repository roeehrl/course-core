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
    save: vi
      .fn()
      .mockResolvedValue({
        revision: 2,
        configurationSaved: true,
        verification: "not_run",
        cancelledPendingJobs: 1,
        budgetChanged: false,
      }),
    saveBudget: vi
      .fn()
      .mockResolvedValue({
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
}
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
