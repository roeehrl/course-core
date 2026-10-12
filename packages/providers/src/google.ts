import { z } from 'zod';
import { callOptionsSchema, id, imageRequestSchema, textRequestSchema, videoRequestSchema,
  type AccountingInput, type AssessmentRequest, type CallOptions, type Capability, type ImageJobProvider, type ImageOutput, type ImageRequest,
  type CapabilityPorts, type Json, type ModelConfig, type Operation, type ProviderAdapter, type ProviderResult, type ResearchOutput, type ResearchProvider, type StructuredAssessmentProvider,
  type TextRequest, type TutoringProvider, type UsageReceipt, type VideoJob, type VideoJobProvider, type VideoRequest } from './contracts.js';
import { googleVideoJobSchema, requireGoogleModel, type GoogleResolvedModel, type GoogleVideoJob, type GoogleVideoOutput } from './google-contracts.js';
import { ensure, ProviderError, safeError } from './errors.js';
import { candidate, imageOutput, operationOutput, researchOutput, responseText, validateOperationName } from './google-response.js';
import { abortable, abortScope, GoogleTransport, waitAbortable, type GoogleTransportOptions } from './http.js';
import { ModelRegistry } from './registry.js';
import { compileOutputSchema, parse } from './validation.js';

export interface GoogleProviderOptions extends GoogleTransportOptions { providerId: string; registry: ModelRegistry }
export class GoogleProvider implements ProviderAdapter, TutoringProvider, StructuredAssessmentProvider, ResearchProvider, ImageJobProvider, VideoJobProvider {
  readonly videoCancellation = 'local_abort_only' as const;
  #id: string; #registry: ModelRegistry; #transport: GoogleTransport;
  constructor(options: GoogleProviderOptions) {
    this.#id = parse(id, options.providerId, 'INVALID_CONFIG');
    ensure(options.registry instanceof ModelRegistry, 'INVALID_CONFIG'); this.#registry = options.registry;
    this.#transport = new GoogleTransport(options);
  }
  get providerId(): string { return this.#id; }
  get ports(): CapabilityPorts { return { tutoring: this, structured_assessment: this, research: this, image: this, video: this }; }
  validateModel(model: ModelConfig): void { ensure(model.providerId === this.#id, 'INVALID_CONFIG'); requireGoogleModel(model); }
  #require(modelId: string, capability: Capability): GoogleResolvedModel {
    return requireGoogleModel(this.#registry.require(modelId, capability, this.#id));
  }
  capabilities(modelId: string): Capability[] {
    // Configured availability, not proof of a working key, model or live account.
    const model = this.#registry.list().find(m => m.id === modelId && m.providerId === this.#id && m.enabled);
    if (model) this.validateModel(model);
    return model ? model.capabilities : [];
  }
  #usage(model: Pick<ModelConfig, 'id'>, operation: Operation, accounting: AccountingInput, inputCharacters = 0, maxOutputTokens: number | null = null, videoSeconds: number | null = null): UsageReceipt {
    return { accounting, providerId: this.#id, modelId: model.id, operation, attempts: [], inputCharacters,
      requestedMaxOutputTokens: maxOutputTokens, requestedVideoSeconds: videoSeconds, observedImageCount: null, observedVideoCount: null, cost: null };
  }
  async #run<T>(usage: UsageReceipt, operation: () => Promise<T>, job?: VideoJob): Promise<ProviderResult<T>> {
    try { return { output: await operation(), usage: structuredClone(usage) }; }
    catch (error) {
      const safe = safeError(error);
      const sanitized = new ProviderError(safe.code, { ...(safe.status === null ? {} : { status: safe.status }),
        ...(safe.retryAfterMs === null ? {} : { retryAfterMs: safe.retryAfterMs }),
        submission: usage.attempts.length > 0 && safe.submission === 'not_sent' ? 'unknown' : safe.submission });
      sanitized.usage = structuredClone(usage); if (job ?? safe.job) sanitized.job = structuredClone((job ?? safe.job)!);
      throw sanitized;
    }
  }
  async #generate<T>(input: TextRequest, capability: Capability, operation: Operation, decode: (raw: Record<string, unknown>) => T,
    options: CallOptions, format?: unknown): Promise<ProviderResult<T>> {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    const model = this.#require(request.modelId, capability), config = model.providerConfig;
    const characters = request.messages.reduce((n, m) => n + m.text.length, request.systemInstruction?.length ?? 0)
      + (format === undefined ? 0 : JSON.stringify(format).length);
    ensure(characters <= model.limits.maxInputCharacters && request.maxOutputTokens <= (model.limits.maxOutputTokens ?? 0));
    const usage = this.#usage(model, operation, request.accounting, characters, request.maxOutputTokens);
    return this.#run(usage, async () => {
      const data = await this.#transport.request(`/${config.apiVersion}/models/${model.remoteModel}:generateContent`, 'POST', {
        contents: request.messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.text }] })),
        ...(request.systemInstruction === undefined ? {} : { systemInstruction: { parts: [{ text: request.systemInstruction }] } }),
        generationConfig: { candidateCount: 1, maxOutputTokens: request.maxOutputTokens,
          ...(format === undefined ? {} : { responseFormat: { text: { mimeType: 'application/json', schema: format } } }) },
        ...(capability === 'research' ? { tools: [{ googleSearch: {} }] } : {}),
      }, usage, config.maxResponseBytes, call);
      return decode(data);
    });
  }
  tutor(request: TextRequest, options: CallOptions = {}): Promise<ProviderResult<{ text: string }>> {
    return this.#generate(request, 'tutoring', 'tutor', raw => ({ text: responseText(candidate(raw)) }), options);
  }
  async assess(input: AssessmentRequest, options: CallOptions = {}): Promise<ProviderResult<Json>> {
    const request = parse(textRequestSchema.extend({ outputSchema: z.unknown() }), input);
    const contract = compileOutputSchema(request.outputSchema as AssessmentRequest['outputSchema']);
    const { outputSchema: _schema, ...textRequest } = request;
    return this.#generate(textRequest, 'structured_assessment', 'assess', raw => {
      const text = responseText(candidate(raw)); let json: unknown;
      try { json = JSON.parse(text); } catch { throw new ProviderError('INVALID_RESPONSE'); }
      return contract.validate(json);
    }, options, contract.jsonSchema);
  }
  research(request: TextRequest, options: CallOptions = {}): Promise<ProviderResult<ResearchOutput>> {
    return this.#generate(request, 'research', 'research', raw => researchOutput(candidate(raw)), options);
  }
  async startImage(input: ImageRequest, options: CallOptions = {}): Promise<ProviderResult<ImageOutput>> {
    const request = parse(imageRequestSchema, input), call = parse(callOptionsSchema, options);
    const model = this.#require(request.modelId, 'image'), config = model.providerConfig;
    ensure(request.prompt.length <= model.limits.maxInputCharacters && request.maxOutputTokens <= (model.limits.maxOutputTokens ?? 0));
    const usage = this.#usage(model, 'image', request.accounting, request.prompt.length, request.maxOutputTokens);
    return this.#run(usage, async () => {
      const raw = await this.#transport.request(`/${config.apiVersion}/models/${model.remoteModel}:generateContent`, 'POST', {
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: { candidateCount: 1, maxOutputTokens: request.maxOutputTokens, responseModalities: ['TEXT', 'IMAGE'] },
      }, usage, config.maxResponseBytes, call);
      const output = imageOutput(candidate(raw)); usage.observedImageCount = output.images.length; return output;
    });
  }
  async startVideo(input: VideoRequest, options: CallOptions = {}): Promise<ProviderResult<GoogleVideoOutput>> {
    const request = parse(videoRequestSchema, input), call = parse(callOptionsSchema, options);
    const model = this.#require(request.modelId, 'video'), config = model.providerConfig;
    ensure(config.transport === 'video_lro', 'INVALID_CONFIG');
    ensure(request.prompt.length <= model.limits.maxInputCharacters && config.video.durationSeconds.includes(request.durationSeconds)
      && config.video.aspectRatios.includes(request.aspectRatio) && config.video.resolutions.includes(request.resolution), 'CAPABILITY_MISMATCH');
    const usage = this.#usage(model, 'video_submit', request.accounting, request.prompt.length, null, request.durationSeconds);
    return this.#run(usage, async () => {
      const raw = await this.#transport.request(`/${config.apiVersion}/models/${model.remoteModel}:predictLongRunning`, 'POST', {
        instances: [{ prompt: request.prompt }], parameters: { durationSeconds: request.durationSeconds, aspectRatio: request.aspectRatio, resolution: request.resolution },
      }, usage, config.maxResponseBytes, call);
      const name = parse(z.string(), raw.name, 'INVALID_RESPONSE'); validateOperationName(name, model.remoteModel);
      const job: GoogleVideoJob = { kind: 'video', providerId: this.#id, modelId: model.id,
        registryRevision: this.#registry.revision,
        providerState: { adapter: 'google_video_lro', apiVersion: config.apiVersion, operationName: name, remoteModel: model.remoteModel },
        accounting: request.accounting, requestedDurationSeconds: request.durationSeconds };
      try {
        const output = operationOutput(raw, job, model);
        if (output.state === 'completed') usage.observedVideoCount = output.videos.length;
        return output;
      } catch (error) { const safe = safeError(error); safe.job = job; throw safe; }
    });
  }
  async pollVideo(input: VideoJob, options: CallOptions = {}): Promise<ProviderResult<GoogleVideoOutput>> {
    const job = parse(googleVideoJobSchema, input), call = parse(callOptionsSchema, options);
    const model = this.#require(job.modelId, 'video'), config = model.providerConfig, native = job.providerState;
    ensure(job.providerId === this.#id && native.remoteModel === model.remoteModel && native.apiVersion === config.apiVersion, 'CAPABILITY_MISMATCH');
    validateOperationName(native.operationName, model.remoteModel);
    const usage = this.#usage(model, 'video_poll', job.accounting);
    return this.#run(usage, async () => {
      const raw = await this.#transport.request(`/${native.apiVersion}/${native.operationName}`, 'GET', undefined, usage, config.maxResponseBytes, call);
      const output = operationOutput(raw, job, model);
      if (output.state === 'completed') usage.observedVideoCount = output.videos.length;
      return output;
    }, job);
  }
  /** Convenience only; persist the submitted job before calling. Parent owns durable orchestration. */
  async waitForVideo(input: VideoJob, options: CallOptions & { maxPolls: number; pollIntervalMs: number }) {
    const args = parse(callOptionsSchema.extend({ maxPolls: z.number().int().min(1).max(1000), pollIntervalMs: z.number().int().min(1).max(60_000) }), options);
    const job = parse(googleVideoJobSchema, input);
    const receipts: UsageReceipt[] = [];
    const wait = abortScope(args.signal, args.timeoutMs ?? 60_000);
    try {
      for (let poll = 0; poll < args.maxPolls; poll++) {
        if (poll > 0) await abortable(() => waitAbortable(args.pollIntervalMs, wait.signal), wait.signal, wait.error);
        const result = await this.pollVideo(job, { signal: wait.signal, ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) });
        receipts.push(result.usage);
        if (result.output.state === 'completed') return { ...result, pollUsage: receipts };
      }
      throw new ProviderError('POLL_LIMIT');
    } catch (error) {
      const original = safeError(error), safe = wait.signal.aborted ? wait.error() : original;
      if (original.usage) safe.usage = original.usage;
      safe.job = job;
      // Prior poll receipts remain available even when the next poll is aborted.
      Object.defineProperty(safe, 'pollUsage', { value: structuredClone(receipts), enumerable: false });
      throw safe;
    } finally { wait.dispose(); }
  }
}
