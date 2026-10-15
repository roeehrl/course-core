import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProviderCostPanel } from "../src/components/ProviderCostPanel";
import {
  ProviderCostError,
  costErrorMessage,
  isDefinitive,
  usd,
  usdField,
  type ProviderCostPort,
} from "../src/domain/providerCosts";

it("converts exact USD strings to integer micro-USD without floating point", () => {
  expect(usdField("", 10)).toBeNull();
  expect(usdField("0.3", 1_000_000_000)).toBe(300_000);
  expect(usdField("0.0375", 1_000_000_000)).toBe(37_500);
  expect(usdField("1000", 1_000_000_000)).toBe(1_000_000_000);
  expect(() => usdField("1000.000001", 1_000_000_000)).toThrow(/largest amount/);
  expect(() => usdField("0.1234567", 1_000_000_000)).toThrow(/six decimal places/);
  expect(() => usdField("-1", 1_000_000_000)).toThrow();
  expect(() => usdField("1e3", 1_000_000_000)).toThrow();
  expect(usd(960)).toBe("0.000960");
  expect(usd("100960")).toBe("0.100960");
  expect(isDefinitive(new ProviderCostError("STALE_PROVIDER_PRICING_VERSION"))).toBe(true);
  expect(isDefinitive(new ProviderCostError("UNAVAILABLE"))).toBe(false);
  expect(costErrorMessage(new ProviderCostError("PROVIDER_PRICING_EFFECTIVE_DATE_INVALID"))).toMatch(/earlier than the version it replaces/);
});

it("retries an unconfirmed price write with the same request identity", async () => {
  const savePrice = vi
    .fn<ProviderCostPort["savePrice"]>()
    .mockRejectedValueOnce(new ProviderCostError("UNAVAILABLE"))
    .mockResolvedValueOnce({ id: crypto.randomUUID(), modelId: "m", version: 1, status: "active", effectiveFrom: new Date().toISOString(), inForceNow: true, appliesToCallsAlreadyAdmitted: false });
  const api: ProviderCostPort = {
    pricing: vi.fn(async () => ({ requirePricing: true, settingsRevision: 0, currency: "USD" as const, builtInPrices: false as const,
      models: [{ modelId: "m", configured: true, roles: ["companion"], inForce: null, latestVersion: 0, coverage: [{ role: "companion", priced: false }], history: [] }] })),
    savePrice,
    saveSettings: vi.fn(),
    spend: vi.fn(async () => { throw new ProviderCostError("UNAVAILABLE"); }),
  };
  render(<ProviderCostPanel workspaceId="w" api={api} />);
  await screen.findByText("No price: paid work refused");
  fireEvent.change(screen.getByLabelText("Input price per 1M tokens (USD)"), { target: { value: "0.3" } });
  fireEvent.change(screen.getByLabelText("Output price per 1M tokens (USD)"), { target: { value: "2.5" } });
  fireEvent.change(screen.getByLabelText("Where these prices come from"), { target: { value: "Synthetic source" } });
  fireEvent.click(screen.getByRole("button", { name: "Save price version" }));
  await screen.findByText(/The request is unconfirmed/);
  expect(screen.getByRole("button", { name: "Save price version" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry unconfirmed pricing request" }));
  await waitFor(() => expect(savePrice).toHaveBeenCalledTimes(2));
  expect(savePrice.mock.calls[1]![1]).toEqual(savePrice.mock.calls[0]![1]);
  expect(savePrice.mock.calls[0]![1]).toMatchObject({ inputMicroUsdPerMillionTokens: 300_000, outputMicroUsdPerMillionTokens: 2_500_000, cachedInputMicroUsdPerMillionTokens: null, expectedVersion: 0 });
  await screen.findByText(/Price version 1 saved for m\./);
});
