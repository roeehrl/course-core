import { it, expect } from "vitest";
import { anthropicMetadataAdapter } from "../src/provider-metadata.js";
import { anthropicModelDraft } from "../src/anthropic-model-setup.js";
import { googleModelDraft } from "../src/google-model-setup.js";
import { composeProviders } from "../src/provider-composition.js";
import { configurationTokenBounds } from "../src/provider-setup.js";
import type { ModelCatalog } from "../src/provider-metadata.js";

// Synthetic Models API pages shaped per GET /v1/models; no live Anthropic call.
const key = "SYNTHETIC_ANTHROPIC_KEY_CANARY";
const yes = { supported: true },
  no = { supported: false };
function info(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "model",
    id,
    display_name: id.replace(/-/g, " "),
    created_at: "2026-09-21T00:00:00Z",
    lifecycle: "active",
    deprecated_at: null,
    retires_at: null,
    line: "haiku",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      batch: yes,
      citations: yes,
      code_execution: yes,
      context_management: { supported: true, clear_thinking_20251015: yes, clear_tool_uses_20250919: yes, compact_20260112: yes },
      effort: { supported: true, low: yes, medium: yes, high: yes, max: yes, xhigh: yes },
      image_input: yes,
      pdf_input: yes,
      server_tools: { supported: true, code_execution: yes, web_search: yes },
      structured_outputs: yes,
      thinking: { supported: true, types: { adaptive: yes, disabled: yes, enabled: no } },
    },
    ...extra,
  };
}
const page = (data: unknown[], more = false) =>
  new Response(
    JSON.stringify({ data, has_more: more, first_id: (data[0] as { id?: string })?.id ?? null, last_id: (data.at(-1) as { id?: string })?.id ?? null }),
    { headers: { "content-type": "application/json" } },
  );
const inspect = (request: typeof fetch) =>
  anthropicMetadataAdapter(request).inspect({ getCredential: () => key, configuration: {}, signal: new AbortController().signal });

it("reads only the Models API with x-api-key and a version header, paginates by after_id and maps capability flags", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const result = await inspect(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return calls.length === 1
      ? page([info("claude-haiku-5-5"), info("claude-opus-5-5", { capabilities: { ...info("x").capabilities, thinking: { supported: true, types: { adaptive: yes, disabled: no, enabled: no } } } })], true)
      : page([info("claude-old", { lifecycle: "deprecated", retires_at: "2026-11-30T00:00:00Z", capabilities: { structured_outputs: no, server_tools: { supported: false, web_search: no } } }), info("claude-gone", { lifecycle: "retired" })]);
  });
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.url.origin + call.url.pathname).toBe("https://api.anthropic.com/v1/models");
    expect(call.init?.method).toBe("GET");
    expect(call.init?.redirect).toBe("error");
    expect(call.init?.body).toBeUndefined();
    const headers = new Headers(call.init?.headers);
    expect(headers.get("x-api-key")).toBe(key);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call.url.search).not.toContain(key);
  }
  expect(calls[0]!.url.searchParams.get("limit")).toBe("100");
  expect(calls[1]!.url.searchParams.get("after_id")).toBe("claude-opus-5-5");
  expect(result.models.map((m) => [m.remoteModel, m.methods])).toEqual([
    ["claude-haiku-5-5", ["messages", "structured_outputs", "web_search", "effort_low", "thinking_disabled"]],
    ["claude-opus-5-5", ["messages", "structured_outputs", "web_search", "effort_low"]],
    ["claude-old", ["messages"]],
  ]);
  expect(result.models[2]!.description).toBe("Deprecated; scheduled to retire 2026-11-30.");
  expect(result.models[0]).toMatchObject({ inputTokenLimit: 1000000, outputTokenLimit: 128000, displayName: "claude haiku 5 5" });
  expect(result).toMatchObject({ pages: 2, truncated: false, generationPerformed: false, capabilitiesVerified: false });
  expect(JSON.stringify(result)).not.toContain(key);
});

it("rejects errors, redirects, bad shapes, repeated cursors, key echo and oversize bodies; caps pages at four", async () => {
  const bad = [
    () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: key } }), { status: 401, headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }),
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () => page([{ ...info("claude-x"), id: "../v1/files" }]),
    () => page([info("claude-x", { display_name: key })]),
    () => page([info("claude-x"), info("claude-x")]),
    () => new Response("x".repeat(1048577), { headers: { "content-type": "application/json" } }),
  ];
  for (const response of bad) await expect(inspect(async () => response())).rejects.toThrow();
  let calls = 0;
  await expect(inspect(async () => { calls++; return new Response(JSON.stringify({ data: [info("m-" + calls)], has_more: true, last_id: "same" }), { headers: { "content-type": "application/json" } }); })).rejects.toThrow();
  expect(calls).toBe(2);
  calls = 0;
  const capped = await inspect(async () => { calls++; return page([info("m-" + calls)], true); });
  expect(calls).toBe(4);
  expect(capped.truncated).toBe(true);
});

const configuration = {
    registry: { revision: "mixed", models: [] },
    adapters: [
      { id: "google", kind: "google", credentialEnv: "GOOGLE_API_KEY" },
      { id: "claude", kind: "anthropic", credentialEnv: "COURSE_PROVIDER_CLAUDE_API_KEY" },
    ],
    roles: {},
  },
  catalog: ModelCatalog = {
    models: [
      { remoteModel: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", description: "", inputTokenLimit: 1000000, outputTokenLimit: 128000,
        methods: ["messages", "structured_outputs", "web_search", "effort_low", "thinking_disabled"] },
      { remoteModel: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: "", inputTokenLimit: 1000000, outputTokenLimit: 128000,
        methods: ["messages", "structured_outputs", "web_search", "effort_low"] },
      { remoteModel: "claude-plain", displayName: "Plain", description: "", inputTokenLimit: 200000, outputTokenLimit: 8000, methods: ["messages"] },
      { remoteModel: "claude-small", displayName: "Small", description: "", inputTokenLimit: 16000, outputTokenLimit: 8000, methods: ["messages", "structured_outputs"] },
    ],
    pages: 1,
    truncated: false,
    generationPerformed: false,
    capabilitiesVerified: false,
  };

it("drafts Anthropic text roles from metadata and keeps another provider's roles for mixed operation", () => {
  const google = googleModelDraft({
    configuration,
    adapterId: "google",
    catalog: { ...catalog, models: [{ remoteModel: "public-text", displayName: "Public", description: "", inputTokenLimit: 120000, outputTokenLimit: 4000, methods: ["generateContent"] }] },
    assignments: { supervisor: "public-text" },
  });
  const draft = anthropicModelDraft({
    configuration: google,
    adapterId: "claude",
    catalog,
    assignments: { companion: "claude-haiku-5-5", reviewer: "claude-opus-5-5", research: "claude-haiku-5-5" },
  });
  expect(draft.roles.supervisor?.modelId).toBe("google:supervisor");
  expect(draft.roles.companion).toEqual({ modelId: "claude:companion", maxInputCharacters: 12000, maxOutputTokens: 1000 });
  expect(draft.roles.reviewer).toEqual({ modelId: "claude:reviewer", maxInputCharacters: 20000, maxOutputTokens: 4000 });
  const models = Object.fromEntries(draft.registry.models.map((m) => [m.id, m]));
  expect(models["claude:companion"]).toMatchObject({ providerId: "claude", remoteModel: "claude-haiku-5-5", capabilities: ["tutoring"], tools: [],
    providerConfig: { transport: "messages", apiVersion: "2023-06-01", maxResponseBytes: 1048576, effort: "low", thinking: "disabled" } });
  expect((models["claude:reviewer"] as { providerConfig: Record<string, unknown> }).providerConfig.thinking).toBeUndefined();
  expect(models["claude:research"]).toMatchObject({ capabilities: ["research"], tools: ["web_search"], providerConfig: { webSearch: { toolType: "web_search_20250305", maxUses: 5 } } });
  const runtime = composeProviders(draft, (name) => (name === "GOOGLE_API_KEY" || name === "COURSE_PROVIDER_CLAUDE_API_KEY" ? "configured" : undefined));
  expect(runtime.status()).toMatchObject({ supervisor: { status: "ready" }, companion: { status: "ready" }, reviewer: { status: "ready" }, research: { status: "ready" } });
  expect(configurationTokenBounds(draft).reviewer).toBe(20000 * 4 + 4000 + 4096);
  const supervisor = anthropicModelDraft({ configuration, adapterId: "claude", catalog, assignments: { supervisor: "claude-haiku-5-5" } });
  expect(supervisor.roles.supervisor).toEqual({ modelId: "claude:supervisor", maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 4 });
});

it("never offers media and rejects missing models, unsupported methods, small contexts and another provider's connection", () => {
  for (const assignments of [
    { media: { remoteModel: "claude-haiku-5-5", kind: "image" as const } },
    { companion: "invented" },
    { supervisor: "claude-plain" },
    { research: "claude-plain" },
    { supervisor: "claude-small" },
  ])
    expect(() => anthropicModelDraft({ configuration, adapterId: "claude", catalog, assignments })).toThrow();
  expect(() => anthropicModelDraft({ configuration, adapterId: "google", catalog, assignments: { companion: "claude-haiku-5-5" } })).toThrow();
  expect(() => googleModelDraft({ configuration, adapterId: "claude", catalog, assignments: { companion: "claude-haiku-5-5" } })).toThrow();
  // Disabling a role is allowed; media disable leaves no Anthropic media model.
  const cleared = anthropicModelDraft({ configuration, adapterId: "claude", catalog, assignments: { media: null } });
  expect(cleared.roles.media).toBeUndefined();
  // A hand-written configuration that binds media to an Anthropic model is refused at composition.
  expect(() =>
    composeProviders(
      {
        registry: { revision: "r", models: [{ id: "m", providerId: "claude", remoteModel: "claude-haiku-5-5", enabled: true, capabilities: ["image"], tools: [],
          providerConfig: { transport: "messages", apiVersion: "2023-06-01", maxResponseBytes: 1048576 }, limits: { maxInputCharacters: 4000, maxOutputTokens: 100 } }] },
        adapters: [{ id: "claude", kind: "anthropic", credentialEnv: "COURSE_PROVIDER_CLAUDE_API_KEY" }],
        roles: { media: { modelId: "m", maxInputCharacters: 2000, maxOutputTokens: 100, mediaKind: "image" } },
      },
      () => "configured",
    ),
  ).toThrow();
  expect(() =>
    composeProviders({ registry: { revision: "r", models: [] }, adapters: [{ id: "claude", kind: "anthropic", subscriptionRef: "sub-1" }], roles: {} }, () => "configured"),
  ).toThrow();
});

it("offers web search for declaration when the listing has no server tool tree, but never when it is reported unsupported", async () => {
  const { server_tools: _omitted, ...withoutServerTools } = info("x").capabilities;
  const result = await inspect(async () =>
    page([
      { ...info("claude-no-tree"), type: undefined, capabilities: withoutServerTools },
      info("claude-no-search", { capabilities: { ...info("x").capabilities, server_tools: { supported: true, web_search: no } } }),
    ]),
  );
  expect(result.models.map((m) => [m.remoteModel, m.methods.includes("web_search")])).toEqual([
    ["claude-no-tree", true],
    ["claude-no-search", false],
  ]);
});
