import { z } from 'zod';
import { callOptionsSchema, id, textRequestSchema, type AccountingInput, type AssessmentRequest, type CallOptions, type Capability,
  type CapabilityPorts, type Json, type ModelConfig, type Operation, type ProviderAdapter, type ProviderResult, type ResearchOutput,
  type ResearchProvider, type StructuredAssessmentProvider, type TextDeltaListener, type TextRequest, type TutoringOutput, type TutoringProvider, type UsageReceipt, MIN_CUT_SHORT_CHARACTERS } from './contracts.js';
import { requireAnthropicModel, type AnthropicResolvedModel } from './anthropic-contracts.js';
import { anthropicMessage, anthropicResearch, anthropicStream, anthropicText, anthropicTokens, anthropicTutoring } from './anthropic-response.js';
import { callSubmission, classifyHttpError, ensure, ProviderError, safeError } from './errors.js';
import { JsonTransport, type JsonProtocol, type TransportOptions } from './http.js';
import { ModelRegistry } from './registry.js';
import { compileOutputSchema, parse } from './validation.js';

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
const errorSchema = z.object({ type: z.literal('error'), error: z.object({ type: z.string().max(128),
  details: z.object({ error_code: z.string().max(128).optional() }).nullable().optional() }) });

/** The key is sent only to the fixed HTTPS API origin, in `x-api-key`, with redirects refused. */
export const anthropicProtocol: JsonProtocol = {
  adapter: 'anthropic', origin: ANTHROPIC_ORIGIN,
  path: (path, method) => method === 'POST' && path === '/v1/messages',
  headers: key => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }),
  tokens: anthropicTokens,
  refineError(status, body, retryAfterMs) {
    const parsed = errorSchema.safeParse(body);
    if (!parsed.success) return undefined;
    // A monthly spend-cap 429 keeps failing until access resumes; it is not a transient throttle.
    if (status === 429 && parsed.data.error.details?.error_code === 'enforced_spend_limit_reached')
      return new ProviderError('UPSTREAM_REJECTED', { status, submission: 'rejected' });
    // 529 overloaded and 504 timeout follow the status rules: unavailable, outcome uncertain.
    return classifyHttpError(status, retryAfterMs);
  },
};

/** The Messages API accepts a JSON Schema subset. Numeric bounds and array sizes other than
 * `minItems` 0/1 are not accepted, so they are left out of the sent schema and enforced by the
 * full local contract on the returned JSON instead. */
export function anthropicOutputSchema(schema: unknown): Record<string, unknown> {
  const walk = (node: unknown): Record<string, unknown> => {
    ensure(node !== null && typeof node === 'object' && !Array.isArray(node), 'INVALID_INPUT');
    const source = node as Record<string, unknown>, out: Record<string, unknown> = {};
    for (const key of ['type', 'enum', 'const', 'required']) if (source[key] !== undefined) out[key] = structuredClone(source[key]);
    if (source.type === 'object') {
      const properties = (source.properties ?? {}) as Record<string, unknown>;
      out.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, walk(child)]));
      out.additionalProperties = false;
      out.required ??= [];
    }
    if (source.type === 'array') {
      out.items = walk(source.items);
      if (source.minItems === 1) out.minItems = 1;
    }
    if (Array.isArray(source.anyOf)) out.anyOf = source.anyOf.map(walk);
    return out;
  };
  return walk(schema);
}

/** The Messages API request body: output limit (`max_tokens`, which includes thinking), effort,
 * thinking type and format. Shared by every call path (plain and streamed), so thinking and
 * limits are configured in one place. */
export function messagesRequestBody(model: AnthropicResolvedModel, request: TextRequest, capability: Capability, format?: Record<string, unknown>) {
  const config = model.providerConfig;
  const outputConfig = { ...(config.effort ? { effort: config.effort } : {}),
    ...(format === undefined ? {} : { format: { type: 'json_schema', schema: format } }) };
  return {
    model: model.remoteModel, max_tokens: request.maxOutputTokens,
    ...(request.systemInstruction === undefined ? {} : { system: request.systemInstruction }),
    messages: request.messages.map(message => ({ role: message.role, content: message.text })),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
    ...(capability === 'research' && config.webSearch
      ? { tools: [{ type: config.webSearch.toolType, name: 'web_search', max_uses: config.webSearch.maxUses }] } : {}),
  };
}
export interface AnthropicProviderOptions extends TransportOptions { providerId: string; registry: ModelRegistry }
export class AnthropicTransport extends JsonTransport {
  constructor(options: TransportOptions) { super(options, anthropicProtocol); }
}

/** Messages API adapter for text roles. No image or video generation exists on this API. */
export class AnthropicProvider implements ProviderAdapter, TutoringProvider, StructuredAssessmentProvider, ResearchProvider {
  #id: string; #registry: ModelRegistry; #transport: AnthropicTransport;
  constructor(options: AnthropicProviderOptions) {
    this.#id = parse(id, options.providerId, 'INVALID_CONFIG');
    ensure(options.registry instanceof ModelRegistry, 'INVALID_CONFIG'); this.#registry = options.registry;
    this.#transport = new AnthropicTransport(options);
  }
  get providerId(): string { return this.#id; }
  get ports(): Partial<CapabilityPorts> { return { tutoring: this, structured_assessment: this, research: this }; }
  validateModel(model: ModelConfig): void { ensure(model.providerId === this.#id, 'INVALID_CONFIG'); requireAnthropicModel(model); }
  #require(modelId: string, capability: Capability): AnthropicResolvedModel {
    return requireAnthropicModel(this.#registry.require(modelId, capability, this.#id));
  }
  capabilities(modelId: string): Capability[] {
    // Configured availability, not proof of a working key, model or live account.
    const model = this.#registry.list().find(m => m.id === modelId && m.providerId === this.#id && m.enabled);
    if (model) this.validateModel(model);
    return model ? model.capabilities : [];
  }
  #usage(model: Pick<ModelConfig, 'id'>, operation: Operation, accounting: AccountingInput, inputCharacters: number, maxOutputTokens: number): UsageReceipt {
    return { accounting, providerId: this.#id, modelId: model.id, operation, attempts: [], inputCharacters,
      requestedMaxOutputTokens: maxOutputTokens, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
  }
  async #generate<T>(input: TextRequest, capability: Capability, operation: Operation, decode: (raw: Record<string, unknown>) => T,
    options: CallOptions, format?: Record<string, unknown>): Promise<ProviderResult<T>> {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    const model = this.#require(request.modelId, capability), config = model.providerConfig;
    const characters = request.messages.reduce((n, m) => n + m.text.length, request.systemInstruction?.length ?? 0)
      + (format === undefined ? 0 : JSON.stringify(format).length);
    ensure(characters <= model.limits.maxInputCharacters && request.maxOutputTokens <= (model.limits.maxOutputTokens ?? 0));
    const usage = this.#usage(model, operation, request.accounting, characters, request.maxOutputTokens);
    try {
      const data = await this.#transport.request('/v1/messages', 'POST', messagesRequestBody(model, request, capability, format), usage, config.maxResponseBytes, call);
      return { output: decode(data), usage: structuredClone(usage) };
    } catch (error) {
      const safe = safeError(error);
      const sanitized = new ProviderError(safe.code, { ...(safe.status === null ? {} : { status: safe.status }),
        ...(safe.retryAfterMs === null ? {} : { retryAfterMs: safe.retryAfterMs }),
        submission: callSubmission(usage, safe) });
      sanitized.usage = structuredClone(usage);
      throw sanitized;
    }
  }
  tutor(request: TextRequest, options: CallOptions = {}): Promise<ProviderResult<TutoringOutput>> {
    return this.#generate(request, 'tutoring', 'tutor', raw => anthropicTutoring(anthropicMessage(raw, false, request.allowCutShort === true), MIN_CUT_SHORT_CHARACTERS), options);
  }
  /** `tutor` with `stream: true`: the same body (`messagesRequestBody`), answered as Messages API
   * server-sent events. Text deltas go to `onText` as they arrive; the assembled turn is then
   * judged by `anthropicMessage` and `anthropicTutoring` like a whole reply (a `refusal` stop is
   * BLOCKED, `max_tokens` is cut short only when allowed). A stream without `message_stop`, or
   * an `error` event (for example `overloaded_error`), is a failure whose outcome is unknown. */
  async tutorStream(input: TextRequest, options: CallOptions, onText: TextDeltaListener): Promise<ProviderResult<TutoringOutput>> {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    const model = this.#require(request.modelId, 'tutoring'), config = model.providerConfig;
    const characters = request.messages.reduce((n, m) => n + m.text.length, request.systemInstruction?.length ?? 0);
    ensure(characters <= model.limits.maxInputCharacters && request.maxOutputTokens <= (model.limits.maxOutputTokens ?? 0));
    const usage = this.#usage(model, 'tutor', request.accounting, characters, request.maxOutputTokens);
    try {
      const stream = anthropicStream(onText);
      await this.#transport.stream('/v1/messages', { ...messagesRequestBody(model, request, 'tutoring'), stream: true },
        usage, config.maxResponseBytes, call, stream);
      const output = anthropicTutoring(anthropicMessage(stream.message(), false, request.allowCutShort === true), MIN_CUT_SHORT_CHARACTERS);
      return { output, usage: structuredClone(usage) };
    } catch (error) {
      const safe = safeError(error);
      const sanitized = new ProviderError(safe.code, { ...(safe.status === null ? {} : { status: safe.status }),
        ...(safe.retryAfterMs === null ? {} : { retryAfterMs: safe.retryAfterMs }),
        submission: callSubmission(usage, safe) });
      sanitized.usage = structuredClone(usage);
      throw sanitized;
    }
  }
  async assess(input: AssessmentRequest, options: CallOptions = {}): Promise<ProviderResult<Json>> {
    const request = parse(textRequestSchema.extend({ outputSchema: z.unknown() }), input);
    const contract = compileOutputSchema(request.outputSchema as AssessmentRequest['outputSchema']);
    const { outputSchema: _schema, ...textRequest } = request;
    return this.#generate(textRequest, 'structured_assessment', 'assess', raw => {
      const text = anthropicText(anthropicMessage(raw, false)); let json: unknown;
      try { json = JSON.parse(text); } catch { throw new ProviderError('INVALID_RESPONSE'); }
      return contract.validate(json);
    }, options, anthropicOutputSchema(contract.jsonSchema));
  }
  research(request: TextRequest, options: CallOptions = {}): Promise<ProviderResult<ResearchOutput>> {
    return this.#generate(request, 'research', 'research', raw => anthropicResearch(anthropicMessage(raw, true)), options);
  }
}
