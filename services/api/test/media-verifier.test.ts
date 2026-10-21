import { describe, expect, it } from "vitest";
import { captionText, quantities, referenceStatements, rulesCheck, verifyModelCheck } from "../src/media-verifier.js";
import { largeVisual } from "./large-course-fixture.js";

const script = "Narrated diagram: the list is [5, 3, 8]. After two comparisons the running minimum is 3. The list length is 3.";
describe("rules check of generated media against its approved script", () => {
  it("reads stated quantities by subject", () => {
    expect([...quantities("The running minimum is 3. n = 5; Total: 12.5. The minimum becomes 2")])
      .toEqual([["running minimum", new Set(["3"])], ["n", new Set(["5"])], ["total", new Set(["12.5"])], ["minimum", new Set(["2"])]]);
  });
  it("passes a clip whose narration agrees with the script", () => {
    const result = rulesCheck({ script }, { transcript: "We compare values; the minimum is 3 at the end.", visualDescription: "Three boxes; the box with 3 stays highlighted." });
    expect(result).toEqual({ verifier: "rules", verdict: "consistent", findings: [] });
  });
  it("rejects a clip that states a different value for a quantity the script states (F12)", () => {
    const result = rulesCheck({ script }, { transcript: "At the end the running minimum is 8.", captionsVtt: "WEBVTT\n\n00:00.000 --> 00:02.000\nThe list length is 4.\n" });
    expect(result.verdict).toBe("contradicted");
    expect(result.findings).toEqual([
      { code: "QUANTITY_CONTRADICTED", source: "script", subject: "running minimum", expected: "3", found: "8" },
      { code: "QUANTITY_CONTRADICTED", source: "script", subject: "list length", expected: "3", found: "4" },
    ]);
  });
  it("reports numbers the sources never state without blocking", () => {
    const result = rulesCheck({ script }, { transcript: "The speed is 42 steps." });
    expect(result.verdict).toBe("consistent");
    expect(result.findings).toEqual([{ code: "QUANTITY_UNSUPPORTED", source: "script", subject: "speed", expected: null, found: "42" }]);
  });
  it("checks against a verified reference scene as well as the script", () => {
    const reference = referenceStatements(largeVisual(2));
    expect(reference).toContain("Amount = 2");
    expect(reference).toContain("Observe the starting value.");
    const result = rulesCheck({ script, reference }, { transcript: "The amount is 7 at the start." });
    expect(result.verdict).toBe("contradicted");
    expect(result.findings[0]).toMatchObject({ code: "QUANTITY_CONTRADICTED", source: "reference", subject: "amount", expected: "2", found: "7" });
  });
  it("reads caption cues only", () => {
    expect(captionText("WEBVTT\n\nNOTE hidden\n\n1\n00:00.000 --> 00:01.000\n<b>Hello</b> there\n")).toBe("Hello there");
    expect(captionText(null)).toBe("");
  });
});

describe("model check verification", () => {
  it("counts a contradiction only with a quote that is in the sources", () => {
    const quoted = verifyModelCheck({ script }, { claims: [
      { claim: "The minimum ends at 8", status: "contradicted", sourceQuote: "After two comparisons the running minimum is 3." },
      { claim: "Values are compared", status: "supported", sourceQuote: "the list is [5, 3, 8]" },
    ] });
    expect(quoted.verdict).toBe("contradicted");
    expect(quoted.findings[0]).toMatchObject({ code: "CLAIM_CONTRADICTED", source: "model" });
    const invented = verifyModelCheck({ script }, { claims: [{ claim: "The minimum ends at 8", status: "contradicted", sourceQuote: "The minimum is always 3 in every list." }] });
    expect(invented).toMatchObject({ verdict: "consistent", findings: [{ code: "MODEL_QUOTE_NOT_FOUND" }] });
    expect(verifyModelCheck({ script }, { nothing: true })).toEqual({ verifier: "model", verdict: "unverified", findings: [] });
    expect(verifyModelCheck({ script }, { claims: [{ claim: "Uses colour", status: "not_in_source", sourceQuote: "" }] }).findings[0]!.code).toBe("CLAIM_UNSUPPORTED");
  });
});
