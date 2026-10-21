import { describe, expect, it } from "vitest";
import type { ModelPricing } from "@course-core/providers";
import { publicSuite } from "../src/agent-evals/public-suite.js";
import { dialogueStrategy } from "../src/agent-evals/suite.js";
import { estimateMicroUsd, TOOL_LOOP_ROUND_CAP, TYPICAL_TOKENS, TYPICAL_TOOL_RESULT_TOKENS, typicalUsage } from "../src/provider-quality-checks.js";

// $1 per million input tokens, $5 per million output tokens.
const pricing = { inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 5_000_000 } as ModelPricing;
const withTools = (results: number) => ({ expect: { tools: { results: Object.fromEntries(Array.from({ length: results }, (_, i) => [`tool_${i}`, {}])), allowed: [], forbidden: [] } } }) as never;
const plain = { expect: {} } as never;

describe("quality check estimate", () => {
  it("counts one typical call for a conversation without tools, whatever the round limit", () => {
    expect(typicalUsage(plain)).toEqual({ calls: 1, inputTokens: TYPICAL_TOKENS.input, outputTokens: TYPICAL_TOKENS.output });
    expect(typicalUsage(plain, 6)).toEqual(typicalUsage(plain));
    // 3000 input at $1/M + 600 output at $5/M = $0.006, per conversation.
    expect(estimateMicroUsd(pricing, 3)).toBe(18000);
    expect(estimateMicroUsd(pricing, [typicalUsage(plain), typicalUsage(plain), typicalUsage(plain)])).toBe(18000);
  });

  it("counts one round per expected tool plus the answer, each re-sending the conversation so far", () => {
    const usage = typicalUsage(withTools(2), 6);
    const growth = TYPICAL_TOKENS.output + TYPICAL_TOOL_RESULT_TOKENS;
    // Rounds: 3000, 3000 + 1000, 3000 + 2000 input tokens; 600 output each.
    expect(usage).toEqual({ calls: 3, inputTokens: 3 * TYPICAL_TOKENS.input + 3 * growth, outputTokens: 3 * TYPICAL_TOKENS.output });
    expect(estimateMicroUsd(pricing, [usage])).toBe(12000 + 9000);
  });

  it("never counts more rounds than the binding's limit or Core's cap of eight", () => {
    expect(typicalUsage(withTools(5), 2).calls).toBe(2);
    expect(typicalUsage(withTools(5)).calls).toBe(1);
    expect(typicalUsage(withTools(20), 50).calls).toBe(TOOL_LOOP_ROUND_CAP);
    expect(typicalUsage(withTools(0), 6).calls).toBe(1);
  });

  it("charges a per-request price once per round and rounds up per conversation", () => {
    const perRequest = { inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 0, microUsdPerRequest: 7 } as ModelPricing;
    // 3 rounds × 7 µUSD, plus 12000 tokens × 1 µUSD/M rounded up to 1 µUSD.
    expect(estimateMicroUsd(perRequest, [typicalUsage(withTools(2), 8)])).toBe(22);
    expect(estimateMicroUsd(perRequest, [])).toBe(0);
  });

  it("estimates the public tool-loop conversations above the same number of one-call conversations", () => {
    const loops = publicSuite().dialogues.filter((d) => dialogueStrategy(d) === "core.supervisor.tool-loop");
    expect(loops.length).toBeGreaterThan(0);
    const usages = loops.map((d) => typicalUsage(d, 6));
    expect(usages.every((u) => u.calls >= 2 && u.calls <= 6)).toBe(true);
    expect(estimateMicroUsd(pricing, usages)).toBeGreaterThan(estimateMicroUsd(pricing, loops.length));
  });
});
