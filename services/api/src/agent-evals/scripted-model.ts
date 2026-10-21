import { z } from "zod";
import { evalOutputSchema } from "./graders.js";
import { anthropicAdapterFactory, composeProviders } from "../provider-composition.js";

/**
 * An offline scripted model behind the real Anthropic Messages adapter. Core's adapter builds
 * the HTTP request exactly as it would for the live API; this `fetch` answers it from a fixed
 * table instead of the network. Everything above the transport (role binding, strategy, prompt
 * assembly, context minimization, size caps, structured-output validation, refusals) is the
 * production path. Nothing here leaves the process.
 */
export const SCRIPTED_ADAPTER_ID = "eval-scripted";
export const SCRIPTED_MODEL_ID = "eval-scripted";
export const SCRIPTED_CREDENTIAL = "COURSE_PROVIDER_EVAL_SCRIPTED_API_KEY";
/** Not a secret: the adapter requires some credential value and the scripted fetch ignores it. */
export const SCRIPTED_CREDENTIAL_VALUE = "offline-scripted-model";

export const SCRIPTED_RESEARCH_MODEL_ID = "eval-scripted-research";
export const SCRIPTED_IMAGE_MODEL_ID = "eval-scripted-image";
export const SCRIPTED_MEDIA_ADAPTER_ID = "eval-scripted-media";
/**
 * A provider configuration whose roles use the scripted model. `companion`/`supervisor` answer in
 * text and plans (the original suite). `all` binds every role: the supervisor runs its tool loop,
 * research uses the Messages API web-search path, the reviewer drafts notes, and media is bound
 * to an image model whose requests are only assembled and graded, never sent.
 */
export function scriptedConfiguration(model: string, roles: "companion_supervisor" | "all" = "companion_supervisor") {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(model)) throw new Error("Invalid scripted model name");
  const binding = { modelId: SCRIPTED_MODEL_ID, maxInputCharacters: 30000, maxOutputTokens: 2000 };
  const messages = { transport: "messages", apiVersion: "2023-06-01", maxResponseBytes: 1000000 };
  const base = {
    id: SCRIPTED_MODEL_ID, providerId: SCRIPTED_ADAPTER_ID, remoteModel: `course-core-eval-${model}`, providerConfig: messages,
    enabled: true, capabilities: ["tutoring", "structured_assessment"], tools: [] as string[], limits: { maxInputCharacters: 100000, maxOutputTokens: 4000 },
  };
  if (roles === "companion_supervisor")
    return { registry: { revision: "agent-eval-scripted", models: [base] }, adapters: [{ id: SCRIPTED_ADAPTER_ID, kind: "anthropic", credentialEnv: SCRIPTED_CREDENTIAL }],
      roles: { companion: { ...binding }, supervisor: { ...binding } } as Record<string, unknown> };
  return {
    registry: { revision: "agent-eval-scripted-all", models: [base,
      { ...base, id: SCRIPTED_RESEARCH_MODEL_ID, remoteModel: `course-core-eval-${model}-research`, capabilities: ["research"], tools: ["web_search"],
        providerConfig: { ...messages, webSearch: { toolType: "web_search_20250305", maxUses: 3 } } },
      { ...base, id: SCRIPTED_IMAGE_MODEL_ID, providerId: SCRIPTED_MEDIA_ADAPTER_ID, remoteModel: `course-core-eval-${model}-image`, capabilities: ["image"],
        providerConfig: { transport: "generate_content", apiVersion: "v1beta", maxResponseBytes: 1000000 } }] },
    adapters: [{ id: SCRIPTED_ADAPTER_ID, kind: "anthropic", credentialEnv: SCRIPTED_CREDENTIAL },
      { id: SCRIPTED_MEDIA_ADAPTER_ID, kind: "google", credentialEnv: SCRIPTED_CREDENTIAL }],
    roles: { companion: { ...binding }, supervisor: { ...binding, maxToolRounds: 6 },
      research: { modelId: SCRIPTED_RESEARCH_MODEL_ID, maxInputCharacters: 30000, maxOutputTokens: 2000 },
      reviewer: { ...binding }, media: { modelId: SCRIPTED_IMAGE_MODEL_ID, maxInputCharacters: 30000, maxOutputTokens: 1000, mediaKind: "image" } } as Record<string, unknown>,
  };
}

/** What the scripted model answers for one dialogue: a graded output, or for the tool loop,
 * research and reviewer the raw answers the adapter turns into one. */
export const scriptedAnswerSchema = z.union([evalOutputSchema, z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tool_script"), rounds: z.array(z.strictObject({ decision: z.enum(["tool", "finish"]), tool: z.string().max(64),
    argumentsJson: z.string().max(2000), summary: z.string().max(4000) })).min(1).max(8) }),
  z.strictObject({ kind: z.literal("research_answer"), query: z.string().min(1).max(500), text: z.string().min(1).max(8000),
    citations: z.array(z.strictObject({ url: z.string().url().max(500), title: z.string().max(200) })).max(10) }),
  z.strictObject({ kind: z.literal("review_answer"), summary: z.string().max(1000),
    criteria: z.array(z.strictObject({ criterionId: z.string().max(128), met: z.boolean(), quote: z.string().max(800), note: z.string().max(500) })).max(13) }),
])]);
export type ScriptedAnswer = z.infer<typeof scriptedAnswerSchema>;

export interface ScriptedRequest {
  dialogueId: string | undefined;
  system: string | undefined;
  messages: { role: string; content: string }[];
  structured: boolean;
}

export class ScriptedModel {
  /** The dialogue being answered; the runner sets it before each call. */
  current: string | undefined;
  readonly requests: ScriptedRequest[] = [];
  constructor(private readonly outputs: Readonly<Record<string, ScriptedAnswer>>) {}

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages" || init?.method !== "POST")
      throw new Error("scripted model: unexpected request");
    const body = JSON.parse(String(init.body)) as { system?: string; messages: { role: string; content: string }[]; output_config?: { format?: unknown }; model: string };
    this.requests.push({ dialogueId: this.current, system: body.system, messages: body.messages, structured: Boolean(body.output_config?.format) });
    const output = this.current === undefined ? undefined : this.outputs[this.current];
    if (!output || output.kind === "error") return json({ type: "error", error: { type: "api_error", message: "scripted failure" } }, 500);
    // Earlier requests for this dialogue: a tool loop answers round by round.
    const round = this.requests.filter((r) => r.dialogueId === this.current).length - 1;
    if (output.kind === "research_answer")
      return json({ id: "msg_scripted", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "server_tool_use", id: "srvtoolu_scripted", name: "web_search", input: { query: output.query } },
          { type: "text", text: output.text, citations: output.citations.map((c) => ({ type: "web_search_result_location", url: c.url, title: c.title })) }] });
    const text = output.kind === "text" ? output.text : output.kind === "plan" ? JSON.stringify({ summary: output.summary, needs: output.needs })
      : output.kind === "tool_script" ? JSON.stringify(output.rounds[Math.min(round, output.rounds.length - 1)])
      : output.kind === "review_answer" ? JSON.stringify({ summary: output.summary, criteria: output.criteria }) : "";
    const input_tokens = Math.ceil(String(init.body).length / 4), output_tokens = Math.max(1, Math.ceil(text.length / 4));
    return json({ id: "msg_scripted", type: "message", role: "assistant", model: body.model,
      content: output.kind === "refusal" ? [] : [{ type: "text", text }],
      stop_reason: output.kind === "refusal" ? "refusal" : "end_turn", usage: { input_tokens, output_tokens } });
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The scripted model composed into a real provider runtime, ready for `runSuite`. */
export function scriptedRuntime(model: string, outputs: Readonly<Record<string, ScriptedAnswer>>, roles: "companion_supervisor" | "all" = "companion_supervisor") {
  const scripted = new ScriptedModel(outputs), configuration = scriptedConfiguration(model, roles);
  const runtime = composeProviders(configuration, (name) => (name === SCRIPTED_CREDENTIAL ? SCRIPTED_CREDENTIAL_VALUE : undefined),
    { anthropic: anthropicAdapterFactory(scripted.fetch) });
  return { scripted, configuration, runtime };
}
