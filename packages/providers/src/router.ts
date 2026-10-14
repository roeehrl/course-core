import { z } from 'zod';
import { callOptionsSchema, imageRequestSchema, textRequestSchema, videoJobSchema, videoRequestSchema,
  type AssessmentRequest, type CallOptions, type ImageJobProvider, type ImageRequest, type ResearchProvider,
  type StructuredAssessmentProvider, type TextRequest, type TutoringProvider, type VideoJob, type VideoJobProvider, type VideoRequest,
  type ProviderCallEnd, type ProviderCallObserver, type ProviderCallStart, type UsageReceipt } from './contracts.js';
import { ensure, ProviderError } from './errors.js';
import { ModelRegistry } from './registry.js';
import { compileOutputSchema, parse } from './validation.js';

function sum(usage: UsageReceipt, key: 'input' | 'output' | 'total') {
  let total = 0;
  for (const attempt of usage.attempts) { const value = attempt.tokens[key]; if (value === null) return null; total += value; }
  return total;
}
function settled(usage: UsageReceipt | undefined, outcome: ProviderCallEnd['outcome'], code: string | null, started: number): ProviderCallEnd {
  return Object.freeze({ outcome, code, providerId: usage?.providerId ?? null, attempts: usage?.attempts.length ?? 0,
    tokens: usage ? Object.freeze({ input: sum(usage, 'input'), output: sum(usage, 'output'), total: sum(usage, 'total') }) : null,
    access: usage?.access?.kind ?? null, elapsedMs: Math.max(0, Date.now() - started) });
}
export interface RouterOptions { observe?: ProviderCallObserver }

/** The core-facing capability port. It imports no provider SDK or native protocol. */
export class ProviderRouter implements TutoringProvider, StructuredAssessmentProvider, ResearchProvider, ImageJobProvider, VideoJobProvider {
  #registry: ModelRegistry;
  #observe: ProviderCallObserver | undefined;
  constructor(registry: ModelRegistry, options: RouterOptions = {}) { this.#registry = registry; this.#observe = options.observe; }
  async #observed<T extends { usage: UsageReceipt }>(start: ProviderCallStart, body: () => Promise<T>): Promise<T> {
    if (!this.#observe) return body();
    let end: ((value: ProviderCallEnd) => void) | void;
    try { end = this.#observe(Object.freeze({ operation: start.operation, modelId: start.modelId })); } catch { /* observation is optional */ }
    const started = Date.now();
    const report = (value: ProviderCallEnd) => { try { end?.(value); } catch { /* cannot fail or replay a paid call */ } };
    try { const result = await body(); report(settled(result.usage, 'response', null, started)); return result; }
    catch (error) {
      report(settled(error instanceof ProviderError ? error.usage : undefined, 'error', error instanceof ProviderError ? error.code : 'UNEXPECTED', started));
      throw error;
    }
  }
  async tutor(input: TextRequest, options: CallOptions = {}) {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#observed({ operation: 'tutor', modelId: request.modelId }, () => this.#registry.port(request.modelId, 'tutoring').tutor(request, call));
  }
  async assess(input: AssessmentRequest, options: CallOptions = {}) {
    const request = parse(textRequestSchema.extend({ outputSchema: z.unknown() }), input), call = parse(callOptionsSchema, options);
    const contract = compileOutputSchema(request.outputSchema as AssessmentRequest['outputSchema']);
    return this.#observed({ operation: 'assess', modelId: request.modelId }, async () => {
      const result = await this.#registry.port(request.modelId, 'structured_assessment').assess(request as AssessmentRequest, call);
      try { return { ...result, output: contract.validate(result.output) }; }
      catch {
        // The adapter already ran; preserve its usage even when core validation fails.
        const error = new ProviderError('INVALID_RESPONSE', { submission: 'unknown' });
        error.usage = structuredClone(result.usage); throw error;
      }
    });
  }
  async research(input: TextRequest, options: CallOptions = {}) {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#observed({ operation: 'research', modelId: request.modelId }, () => this.#registry.port(request.modelId, 'research').research(request, call));
  }
  async startImage(input: ImageRequest, options: CallOptions = {}) {
    const request = parse(imageRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#observed({ operation: 'image', modelId: request.modelId }, () => this.#registry.port(request.modelId, 'image').startImage(request, call));
  }
  async startVideo(input: VideoRequest, options: CallOptions = {}) {
    const request = parse(videoRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#observed({ operation: 'video_submit', modelId: request.modelId }, () => this.#registry.port(request.modelId, 'video').startVideo(request, call));
  }
  async pollVideo(input: VideoJob, options: CallOptions = {}) {
    const job = parse(videoJobSchema, input), call = parse(callOptionsSchema, options);
    return this.#observed({ operation: 'video_poll', modelId: job.modelId }, () => this.#registry.port(job.modelId, 'video', job.providerId).pollVideo(job, call));
  }
  async cancelVideo(input: VideoJob, options: CallOptions = {}) {
    const job = parse(videoJobSchema, input), call = parse(callOptionsSchema, options);
    const port = this.#registry.port(job.modelId, 'video', job.providerId);
    ensure(port.cancelVideo, 'CAPABILITY_MISMATCH');
    return this.#observed({ operation: 'video_cancel', modelId: job.modelId }, () => port.cancelVideo!(job, call));
  }
}
