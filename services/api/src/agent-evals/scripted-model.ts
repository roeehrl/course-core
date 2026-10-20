import type { EvalOutput } from "./graders.js";
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

/** A provider configuration whose companion and supervisor roles use the scripted model. */
export function scriptedConfiguration(model: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(model)) throw new Error("Invalid scripted model name");
  const binding = { modelId: SCRIPTED_MODEL_ID, maxInputCharacters: 30000, maxOutputTokens: 2000 };
  return {
    registry: { revision: "agent-eval-scripted", models: [{
      id: SCRIPTED_MODEL_ID, providerId: SCRIPTED_ADAPTER_ID, remoteModel: `course-core-eval-${model}`,
      providerConfig: { transport: "messages", apiVersion: "2023-06-01", maxResponseBytes: 1000000 },
      enabled: true, capabilities: ["tutoring", "structured_assessment"], tools: [],
      limits: { maxInputCharacters: 100000, maxOutputTokens: 4000 },
    }] },
    adapters: [{ id: SCRIPTED_ADAPTER_ID, kind: "anthropic", credentialEnv: SCRIPTED_CREDENTIAL }],
    roles: { companion: { ...binding }, supervisor: { ...binding } },
  };
}

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
  constructor(private readonly outputs: Readonly<Record<string, EvalOutput>>) {}

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages" || init?.method !== "POST")
      throw new Error("scripted model: unexpected request");
    const body = JSON.parse(String(init.body)) as { system?: string; messages: { role: string; content: string }[]; output_config?: { format?: unknown }; model: string };
    this.requests.push({ dialogueId: this.current, system: body.system, messages: body.messages, structured: Boolean(body.output_config?.format) });
    const output = this.current === undefined ? undefined : this.outputs[this.current];
    if (!output || output.kind === "error") return json({ type: "error", error: { type: "api_error", message: "scripted failure" } }, 500);
    const text = output.kind === "text" ? output.text : output.kind === "plan" ? JSON.stringify({ summary: output.summary, needs: output.needs }) : "";
    const input_tokens = Math.ceil(String(init.body).length / 4), output_tokens = Math.max(1, Math.ceil(text.length / 4));
    return json({ id: "msg_scripted", type: "message", role: "assistant", model: body.model,
      content: output.kind === "refusal" ? [] : [{ type: "text", text }],
      stop_reason: output.kind === "refusal" ? "refusal" : "end_turn", usage: { input_tokens, output_tokens } });
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The scripted model composed into a real provider runtime, ready for `runSuite`. */
export function scriptedRuntime(model: string, outputs: Readonly<Record<string, EvalOutput>>) {
  const scripted = new ScriptedModel(outputs), configuration = scriptedConfiguration(model);
  const runtime = composeProviders(configuration, (name) => (name === SCRIPTED_CREDENTIAL ? SCRIPTED_CREDENTIAL_VALUE : undefined),
    { anthropic: anthropicAdapterFactory(scripted.fetch) });
  return { scripted, configuration, runtime };
}
