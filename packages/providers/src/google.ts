import { z } from 'zod';
import { callOptionsSchema, id, imageRequestSchema, textRequestSchema, videoRequestSchema,
  type AccountingInput, type AssessmentRequest, type CallOptions, type Capability, type ImageJobProvider, type ImageOutput, type ImageRequest,
  type CapabilityPorts, type Json, type ModelConfig, type Operation, type ProviderAdapter, type ProviderResult, type ResearchOutput, type ResearchProvider, type StructuredAssessmentProvider,
  type TextDeltaListener, type TextRequest, type TutoringProvider, type UsageReceipt, type VideoJob, type VideoJobProvider, type VideoRequest,
  type DownloadOptions, type VideoAsset, MAX_VIDEO_DOWNLOAD_BYTES,
  type CostEstimate, type MediaCapabilities, type MediaPrice, type TutoringOutput, MIN_CUT_SHORT_CHARACTERS, priceMediaUnits } from './contracts.js';
import { googleVideoJobSchema, requireGoogleModel, type GoogleResolvedModel, type GoogleVideoJob, type GoogleVideoOutput } from './google-contracts.js';
import { callSubmission, ensure, ProviderError, safeError } from './errors.js';
import { candidate, generationConfig, imageOutput, interactionImageOutput, operationOutput, researchOutput, responseText, streamedCandidate, tutoringText, validateOperationName } from './google-response.js';
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
  /** Declared from trusted registry configuration and the provider's documentation: Veo keeps a
   * generated video for 2 days; images are returned inline and nothing is stored (`store: false`). */
  discoverCapabilities(modelId: string): MediaCapabilities {
    const model = requireGoogleModel(this.#registry.list().find(m => m.id === modelId && m.providerId === this.#id && m.enabled)
      ?? (() => { throw new ProviderError('CAPABILITY_MISMATCH'); })()), config = model.providerConfig;
    const base = { modelId: model.id, providerId: this.#id, maxPromptCharacters: model.limits.maxInputCharacters };
    if (config.transport === 'video_lro') return { ...base, kind: 'video', cancellation: 'local_abort_only', billing: 'per_output_second',
      video: { durationSeconds: [...config.video.durationSeconds], aspectRatios: [...config.video.aspectRatios], resolutions: [...config.video.resolutions] },
      retention: { outputHours: 48, providerStoresRequest: true } };
    ensure(model.capabilities.includes('image'), 'CAPABILITY_MISMATCH');
    if (config.transport === 'image_interaction') return { ...base, kind: 'image', cancellation: 'not_applicable', billing: 'per_image',
      image: { aspectRatios: [...config.image.aspectRatios], imageSizes: [...config.image.imageSizes], mimeTypes: [...config.image.mimeTypes], maxImagesPerRequest: 1 },
      retention: { outputHours: null, providerStoresRequest: false } };
    return { ...base, kind: 'image', cancellation: 'not_applicable', billing: 'per_image',
      image: { aspectRatios: [], imageSizes: [], mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImagesPerRequest: 1 },
      retention: { outputHours: null, providerStoresRequest: false } };
  }
  estimateCost(input: VideoRequest | ImageRequest, price: MediaPrice | null): CostEstimate {
    if ('durationSeconds' in input) {
      const request = parse(videoRequestSchema, input), model = this.#require(request.modelId, 'video'), config = model.providerConfig;
      ensure(config.transport === 'video_lro' && config.video.durationSeconds.includes(request.durationSeconds)
        && config.video.aspectRatios.includes(request.aspectRatio) && config.video.resolutions.includes(request.resolution), 'CAPABILITY_MISMATCH');
      return priceMediaUnits({ outputSeconds: request.durationSeconds, images: 0, requests: 1 }, price);
    }
    const request = parse(imageRequestSchema, input);
    this.#imageSettings(this.#require(request.modelId, 'image'), request);
    return priceMediaUnits({ outputSeconds: 0, images: 1, requests: 1 }, price);
  }
  /** Output settings for an image request; values the model does not declare are refused before sending. */
  #imageSettings(model: GoogleResolvedModel, request: ImageRequest) {
    const config = model.providerConfig;
    if (config.transport !== 'image_interaction') {
      ensure(request.aspectRatio === undefined && request.imageSize === undefined, 'CAPABILITY_MISMATCH');
      return null;
    }
    const aspectRatio = request.aspectRatio ?? config.image.aspectRatios[0]!, imageSize = request.imageSize ?? config.image.imageSizes[0]!;
    ensure((config.image.aspectRatios as string[]).includes(aspectRatio) && (config.image.imageSizes as string[]).includes(imageSize), 'CAPABILITY_MISMATCH');
    return { aspectRatio, imageSize, mimeType: config.image.mimeTypes[0]!, maxImageBytes: config.image.maxImageBytes };
  }
  #usage(model: Pick<ModelConfig, 'id'>, operation: Operation, accounting: AccountingInput, inputCharacters = 0, maxOutputTokens: number | null = null, videoSeconds: number | null = null): UsageReceipt {
    return { accounting, providerId: this.#id, modelId: model.id, operation, attempts: [], inputCharacters,
      requestedMaxOutputTokens: maxOutputTokens, requestedVideoSeconds: videoSeconds, observedImageCount: null, observedVideoCount: null, cost: null };
  }
  async #run<T>(usage: UsageReceipt, operation: () => Promise<T>, job?: VideoJob): Promise<ProviderResult<T>> {
    try { return { output: await operation(), usage: structuredClone(usage) }; }
    catch (error) {
      const safe = safeError(error);
      const sanitized = new ProviderError(safe.code, { ...(safe.status === null ? {} : { status: safe.status }), reason: safe.reason,
        ...(safe.retryAfterMs === null ? {} : { retryAfterMs: safe.retryAfterMs }),
        submission: callSubmission(usage, safe) });
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
        generationConfig: generationConfig(config, request.maxOutputTokens, format),
        ...(capability === 'research' ? { tools: [{ googleSearch: {} }] } : {}),
      }, usage, config.maxResponseBytes, call);
      return decode(data);
    });
  }
  tutor(request: TextRequest, options: CallOptions = {}): Promise<ProviderResult<TutoringOutput>> {
    return this.#generate(request, 'tutoring', 'tutor', raw => tutoringText(candidate(raw, request.allowCutShort === true), MIN_CUT_SHORT_CHARACTERS), options);
  }
  /** `tutor` over streamGenerateContent with `alt=sse`: the same body (`generationConfig`, so the
   * thinking setting and output limit apply), each chunk a GenerateContentResponse. Visible text
   * goes to `onText` as it arrives; the chunks are then assembled and judged by `candidate` and
   * `tutoringText` like a whole reply, including a reply cut short at the output limit. */
  async tutorStream(input: TextRequest, options: CallOptions, onText: TextDeltaListener): Promise<ProviderResult<TutoringOutput>> {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    const model = this.#require(request.modelId, 'tutoring'), config = model.providerConfig;
    const characters = request.messages.reduce((n, m) => n + m.text.length, request.systemInstruction?.length ?? 0);
    ensure(characters <= model.limits.maxInputCharacters && request.maxOutputTokens <= (model.limits.maxOutputTokens ?? 0));
    const usage = this.#usage(model, 'tutor', request.accounting, characters, request.maxOutputTokens);
    return this.#run(usage, async () => {
      const stream = streamedCandidate(onText);
      await this.#transport.stream(`/${config.apiVersion}/models/${model.remoteModel}:streamGenerateContent?alt=sse`, {
        contents: request.messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.text }] })),
        ...(request.systemInstruction === undefined ? {} : { systemInstruction: { parts: [{ text: request.systemInstruction }] } }),
        generationConfig: generationConfig(config, request.maxOutputTokens),
      }, usage, config.maxResponseBytes, call, stream);
      return tutoringText(candidate(stream.response(), request.allowCutShort === true), MIN_CUT_SHORT_CHARACTERS);
    });
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
    const settings = this.#imageSettings(model, request);
    if (settings) return this.#run(usage, async () => {
      // Inline delivery and `store: false`: the image comes back in the response and the provider keeps no copy for retrieval.
      const raw = await this.#transport.request(`/${config.apiVersion}/interactions`, 'POST', {
        model: model.remoteModel, input: [{ type: 'text', text: request.prompt }], store: false,
        response_format: { type: 'image', mime_type: settings.mimeType, aspect_ratio: settings.aspectRatio, image_size: settings.imageSize, delivery: 'inline' },
      }, usage, config.maxResponseBytes, call);
      const output = interactionImageOutput(raw, settings.maxImageBytes); usage.observedImageCount = output.images.length; return output;
    });
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
  async downloadVideo(input: VideoJob, uri: string, options: DownloadOptions): Promise<VideoAsset> {
    const job = parse(googleVideoJobSchema, input);
    const call = parse(callOptionsSchema.extend({ maxBytes: z.number().int().min(1).max(MAX_VIDEO_DOWNLOAD_BYTES) }), options);
    const model = this.#require(job.modelId, 'video'), config = model.providerConfig;
    ensure(config.transport === 'video_lro' && job.providerId === this.#id && job.providerState.remoteModel === model.remoteModel, 'CAPABILITY_MISMATCH');
    const usage = this.#usage(model, 'video_poll', job.accounting);
    const { maxBytes, ...rest } = call;
    return (await this.#run(usage, () => this.#transport.download(uri, config.video.downloadHosts, maxBytes, usage, rest), job)).output;
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
