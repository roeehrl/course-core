import { describe, expect, it } from "vitest";
import { PROVIDER_FAULTS } from "../src/provider-quality-checks.js";

// Which reason a quality check stopped by a provider error records. Only the provider's own
// "not found" (HTTP 404) says the service lacks the job's model; the runtime's UNKNOWN_MODEL and
// CAPABILITY_MISMATCH are this workspace's setup, never "the model isn't available any more".
describe("quality check fault reasons", () => {
  it("names the service's missing model only for its 404", () => {
    expect(PROVIDER_FAULTS.NOT_FOUND).toBe("PROVIDER_GUIDE_MODEL_UNAVAILABLE");
    expect(Object.entries(PROVIDER_FAULTS).filter(([, reason]) => reason === "PROVIDER_GUIDE_MODEL_UNAVAILABLE").map(([code]) => code))
      .toEqual(["NOT_FOUND"]);
  });
  it("gives the local setup problems their own reasons", () => {
    expect(PROVIDER_FAULTS.UNKNOWN_MODEL).toBe("PROVIDER_QUALITY_CHECK_MODEL_NOT_CONFIGURED");
    expect(PROVIDER_FAULTS.CAPABILITY_MISMATCH).toBe("PROVIDER_QUALITY_CHECK_CAPABILITY_MISSING");
    expect(PROVIDER_FAULTS.INVALID_CONFIG).toBe("PROVIDER_CONFIGURATION_INVALID");
  });
  it("records every reason in the form the check's reason column accepts", () => {
    for (const reason of Object.values(PROVIDER_FAULTS)) expect(reason).toMatch(/^[A-Z][A-Z0-9_]{1,99}$/);
  });
});
