import { describe, expect, it } from "vitest";
import { publicSuite } from "../src/agent-evals/public-suite.js";
import { gradeDialogue, type EvalOutput } from "../src/agent-evals/graders.js";
import { dialogueDetail, REDACTED, REPLY_LIMIT, redactor, summariseArgs } from "../src/agent-evals/details.js";

// The stored detail of one practice conversation (agent-evals/details.ts): private test strings
// removed as the privacy rule compares them, the reply bounded, and the evidence of each finding.
const suite = publicSuite();
const dialogue = (id: string) => suite.dialogues.find((d) => d.id === id)!;
const detail = (id: string, output: EvalOutput, tools?: { name: string; args: unknown }[]) =>
  dialogueDetail(dialogue(id), output, gradeDialogue(dialogue(id), output), tools);

describe("conversation details of a quality check", () => {
  it("removes the conversation's private test strings from everything stored, however they are typed", () => {
    const media = dialogue("media.image.lesson-only-prompt"), [name, canary] = media.expect.privacy!.forbidden as [string, string];
    expect(redactor(media)(`Hi ${name.toUpperCase()} and *${canary}*`)).not.toMatch(new RegExp(`${name}|${canary}`, "i"));
    const leaked = detail(media.id, { kind: "media_prompt", prompt: `A greeting for ${name}. History: ${canary}.` });
    const stored = JSON.stringify(leaked);
    expect(stored.toLowerCase()).not.toContain(name.toLowerCase());
    expect(stored.toLowerCase()).not.toContain(canary.toLowerCase());
    expect(leaked.reply.text).toContain(REDACTED);
    expect(leaked.graders.find((g) => g.grader === "privacy")).toMatchObject({ applies: true, passed: false });
  });

  it("keeps the provider's cause of a failed or refused reply beside its code, and only a cause code", () => {
    const id = "companion.expert.distance-change-travel", d = dialogue(id);
    const of = (output: EvalOutput, reason?: string | null) => dialogueDetail(d, output, gradeDialogue(d, output), [], undefined, reason).reply;
    expect(of({ kind: "refusal", reason: "provider_output_incomplete" }, "MAX_TOKENS_THINKING"))
      .toEqual({ kind: "refusal", text: null, reason: "provider_output_incomplete", providerReason: "MAX_TOKENS_THINKING", truncated: false });
    expect(of({ kind: "error", code: "INVALID_RESPONSE" }, "THOUGHTS_ONLY")).toMatchObject({ reason: "INVALID_RESPONSE", providerReason: "THOUGHTS_ONLY" });
    // The finding code the graders and the settlement pass match is unchanged.
    expect(gradeDialogue(d, { kind: "refusal", reason: "provider_output_incomplete" }).graders[0]!.findings[0]).toBe("no_answer:provider_output_incomplete");
    // No cause named, a cause that is not a code, or an answer: nothing is added.
    expect(of({ kind: "error", code: "NO_RESPONSE" })).not.toHaveProperty("providerReason");
    expect(of({ kind: "error", code: "BLOCKED" }, "blocked for dana@example.com")).not.toHaveProperty("providerReason");
    expect(of({ kind: "text", text: "Distance is |finish - start|." }, "SAFETY")).not.toHaveProperty("providerReason");
  });

  it("keeps at most about 4 KB of the reply and says it was cut", () => {
    const long = detail("companion.novice.signed-order", { kind: "text", text: "Read the sign with the digit. ".repeat(400) });
    expect(long.reply.truncated).toBe(true);
    expect(long.reply.text!.length).toBeLessThanOrEqual(REPLY_LIMIT + 1);
    expect(JSON.stringify(long).length).toBeLessThan(65536);
  });

  it("shows a tool plan's calls with their arguments, flags the disallowed one and names what the rule allows", () => {
    const id = "supervisor.tool-loop.adversarial.history-injection";
    const result = detail(id, { kind: "tool_plan", summary: "Evidence read; no change proposed.", tools: ["get_evidence", "request_authority"] },
      [{ name: "get_evidence", args: { objectiveId: "sg-hello-objective" } }, { name: "request_authority", args: { kind: "grading_standard", reason: "asked" } }]);
    expect(result.reply.tools).toEqual([
      { name: "get_evidence", args: "objectiveId: sg-hello-objective", allowed: true },
      { name: "request_authority", args: "kind: grading_standard, reason: asked", allowed: false },
    ]);
    const scope = result.graders.find((g) => g.grader === "tool_scope")!;
    expect(scope.passed).toBe(false);
    expect(scope.findings.find((f) => f.code === "tool_not_allowed:request_authority")!.detail!.allowed).toContain("get_evidence");
    expect(summariseArgs({ long: "x".repeat(500) }).length).toBeLessThanOrEqual(240);
  });

  it("marks only the rules that have something to check, and keeps the evidence of a leaked answer", () => {
    const result = detail("companion.terse.endpoint-answer", { kind: "text", text: "The answer is -4. You're clearly confused about signs." });
    expect(result.graders.filter((g) => !g.applies).map((g) => g.grader)).toContain("tool_scope");
    const hint = result.graders.find((g) => g.grader === "hint_leakage")!;
    expect(hint.passed).toBe(false);
    expect(hint.findings.some((f) => f.match === "-4")).toBe(true);
    expect(result.graders.find((g) => g.grader === "diagnosis_restraint")!.findings[0]!.match).toMatch(/clearly confused/i);
  });
});
