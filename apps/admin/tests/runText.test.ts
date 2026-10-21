import { expect, it } from "vitest";
import { createAdminTranslator } from "../src/i18n";
import {
  artifactName,
  contextText,
  decisionText,
  runName,
  runOutcomeSentences,
} from "../src/domain/runText";
import { privacyRuleText } from "../src/domain/privacyRules";
import type { SupervisorRun } from "../src/domain/contracts";

const en = createAdminTranslator("en"),
  he = createAdminTranslator("he");

it("names runs, outcomes, references, decisions and artifacts from server codes in both languages", () => {
  expect(runName(en, { id: "r", role: "supervisor" })).toBe(
    "Lesson planner run",
  );
  expect(runName(en, { id: "r", label: "supervisor run" })).toBe(
    "supervisor run",
  );
  const run = {
    outcome: {
      runtimeReason: "verification_rejected",
      refusal: "tool_loop_invalid_decision",
      refusalBy: "core",
    },
  } as SupervisorRun;
  expect(runOutcomeSentences(en, run)).toEqual([
    "Runtime reason: verification_rejected.",
    "Core refused the model output: tool_loop_invalid_decision.",
    "Debug output is a metadata-only projection; no private reasoning or credentials are included.",
  ]);
  expect(runOutcomeSentences(he, run)[1]).toContain("ה-Core דחה");
  expect(
    contextText(en, {
      id: "x",
      kind: "tool_receipts",
      facts: { count: 1, more: "no" },
    }).version,
  ).toBe("1 recorded tool");
  expect(
    contextText(en, {
      id: "x",
      kind: "provider_binding",
      facts: { providerRevision: "host" },
    }).version,
  ).toBe("Host fallback");
  expect(
    contextText(en, {
      id: "x",
      kind: "checkpoint_input",
      facts: { checkpointId: "generate" },
    }),
  ).toMatchObject({
    label: "Checkpoint generate",
    version: "Unavailable fence",
  });
  expect(
    decisionText(en, {
      code: "support_delivered",
      params: { planRevision: 4 },
    }),
  ).toBe("Selected support delivered in plan revision 4. No mastery granted.");
  expect(decisionText(he, { code: "hypothesis_recorded" })).toContain(
    "השערת ההוראה",
  );
  // An older server's English, and a code this app does not know yet.
  expect(decisionText(he, "Persisted scoped tool receipt.")).toBe(
    "Persisted scoped tool receipt.",
  );
  expect(decisionText(en, { code: "brand_new_reason" })).toBe(
    "brand new reason",
  );
  expect(
    artifactName(en, {
      id: "a1",
      nameCode: "refused_output",
      mediaType: "application/json",
      status: "rejected",
      preview: "{}",
    }),
  ).toBe("Refused model output a1");
});

it("words learner-privacy rules by id, falling back to the server's text for new rules", () => {
  expect(
    privacyRuleText(he, { id: "drafts", label: "x", reason: "y" }).label,
  ).toBe("טיוטות של תשובות והודעות שלא נשלחו");
  expect(
    privacyRuleText(he, { id: "new-rule", label: "New", reason: "Why" }),
  ).toEqual({ label: "New", reason: "Why" });
});
