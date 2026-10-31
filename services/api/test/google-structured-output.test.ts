import { describe, expect, it } from "vitest";
import { ModelRegistry, type OutputSchema } from "@course-core/providers";
import { GoogleProvider } from "@course-core/providers/google";
import { supervisorPlanSchema } from "../src/agent-strategies.js";
import { CHECK_JUDGE_SCHEMA } from "../src/companion-check-judge.js";
import { rubricAssistOutputSchema } from "../src/rubric-assist-contracts.js";
import { supervisorToolDecisionSchema } from "../src/supervisor-tool-loop.js";
import { geminiRoleThinking } from "../src/google-model-setup.js";

// The generateContent request every structured-output job sends to Gemini: the supervisor (plan
// and tool loop), answer review drafts and the check-mode judge. Google refuses
// `generationConfig.responseFormat.text.mimeType: "application/json"` with 400 INVALID_ARGUMENT
// (that field is an enum, APPLICATION_JSON); the documented fields are `responseMimeType` plus
// `responseJsonSchema`. A local fetch captures the request; nothing is sent.
const remoteModel = "gemini-3.8-flash";
function capture(thinking?: { level: string }) {
  const bodies: Record<string, unknown>[] = [];
  const registry = new ModelRegistry({ revision: "contract", models: [{ id: "gemini", providerId: "google", remoteModel, enabled: true,
    capabilities: ["tutoring", "structured_assessment"], tools: [], limits: { maxInputCharacters: 30000, maxOutputTokens: 8192 },
    providerConfig: { transport: "generate_content", apiVersion: "v1beta", maxResponseBytes: 1_000_000, ...(thinking ? { thinking } : {}) } }] });
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "{}" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const client = new GoogleProvider({ providerId: "google", registry, getApiKey: () => "contract-test-key", fetch,
    settings: { maxAttempts: 1, attemptTimeoutMs: 1000, totalTimeoutMs: 1000, baseDelayMs: 1, maxDelayMs: 10 } });
  registry.registerAdapter(client);
  return { client, bodies };
}
const walk = (node: unknown, visit: (key: string, value: unknown) => void) => {
  if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) { visit(key, value); walk(value, visit); }
};

describe("Gemini structured-output request contract", () => {
  it.each([
    ["supervisor plan", supervisorPlanSchema],
    ["supervisor tool loop", supervisorToolDecisionSchema],
    ["answer review drafts", rubricAssistOutputSchema],
    ["check-mode judge", CHECK_JUDGE_SCHEMA],
  ] as [string, OutputSchema][])("%s sends responseMimeType + responseJsonSchema and never responseFormat", async (_job, schema) => {
    const { client, bodies } = capture(geminiRoleThinking("supervisor", remoteModel) as { level: string });
    await client.assess({ modelId: "gemini", accounting: { accountingKey: "contract" }, maxOutputTokens: 8192, outputSchema: schema,
      systemInstruction: "Answer with JSON.", messages: [{ role: "user", text: "{}" }] }).catch(() => undefined);
    expect(bodies).toHaveLength(1);
    const generation = bodies[0]!.generationConfig as Record<string, unknown>;
    expect(Object.keys(generation).sort()).toEqual(["candidateCount", "maxOutputTokens", "responseJsonSchema", "responseMimeType", "thinkingConfig"]);
    expect(generation.responseMimeType).toBe("application/json");
    expect((generation.responseJsonSchema as { type: string }).type).toBe("object");
    expect(generation.thinkingConfig).toEqual({ thinkingLevel: "medium" });
    expect(bodies[0]!.tools).toBeUndefined();
    walk(bodies[0], (key, value) => {
      expect(key).not.toBe("responseFormat");
      if (key === "minimum" || key === "maximum") expect(Math.abs(value as number)).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });
  });
});

describe("Gemini thinking levels", () => {
  it("sends only levels Google documents for the model and the model default for one Core does not know", () => {
    expect(geminiRoleThinking("supervisor", "gemini-3.8-flash")).toEqual({ level: "medium" });
    expect(geminiRoleThinking("companion", "gemini-3.8-flash")).toEqual({ level: "low" });
    expect(geminiRoleThinking("supervisor", "gemini-2.5-pro")).toEqual({ budget: -1 });
    // A newer model than Core's table: no thinkingConfig, so the model's own default applies and no level can be refused.
    expect(geminiRoleThinking("supervisor", "gemini-3.9-flash")).toBeUndefined();
    expect(geminiRoleThinking("companion", "gemini-5-pro")).toBeUndefined();
  });
});
