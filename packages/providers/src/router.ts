import { z } from 'zod';
import { callOptionsSchema, imageRequestSchema, textRequestSchema, videoJobSchema, videoRequestSchema,
  type AssessmentRequest, type CallOptions, type ImageJobProvider, type ImageRequest, type ResearchProvider,
  type StructuredAssessmentProvider, type TextRequest, type TutoringProvider, type VideoJob, type VideoJobProvider, type VideoRequest } from './contracts.js';
import { ensure, ProviderError } from './errors.js';
import { ModelRegistry } from './registry.js';
import { compileOutputSchema, parse } from './validation.js';

/** The core-facing capability port. It imports no provider SDK or native protocol. */
export class ProviderRouter implements TutoringProvider, StructuredAssessmentProvider, ResearchProvider, ImageJobProvider, VideoJobProvider {
  #registry: ModelRegistry;
  constructor(registry: ModelRegistry) { this.#registry = registry; }
  async tutor(input: TextRequest, options: CallOptions = {}) {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#registry.port(request.modelId, 'tutoring').tutor(request, call);
  }
  async assess(input: AssessmentRequest, options: CallOptions = {}) {
    const request = parse(textRequestSchema.extend({ outputSchema: z.unknown() }), input), call = parse(callOptionsSchema, options);
    const contract = compileOutputSchema(request.outputSchema as AssessmentRequest['outputSchema']);
    const result = await this.#registry.port(request.modelId, 'structured_assessment').assess(request as AssessmentRequest, call);
    try { return { ...result, output: contract.validate(result.output) }; }
    catch {
      // The adapter already ran; preserve its usage even when core validation fails.
      const error = new ProviderError('INVALID_RESPONSE', { submission: 'unknown' });
      error.usage = structuredClone(result.usage); throw error;
    }
  }
  async research(input: TextRequest, options: CallOptions = {}) {
    const request = parse(textRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#registry.port(request.modelId, 'research').research(request, call);
  }
  async startImage(input: ImageRequest, options: CallOptions = {}) {
    const request = parse(imageRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#registry.port(request.modelId, 'image').startImage(request, call);
  }
  async startVideo(input: VideoRequest, options: CallOptions = {}) {
    const request = parse(videoRequestSchema, input), call = parse(callOptionsSchema, options);
    return this.#registry.port(request.modelId, 'video').startVideo(request, call);
  }
  async pollVideo(input: VideoJob, options: CallOptions = {}) {
    const job = parse(videoJobSchema, input), call = parse(callOptionsSchema, options);
    return this.#registry.port(job.modelId, 'video', job.providerId).pollVideo(job, call);
  }
  async cancelVideo(input: VideoJob, options: CallOptions = {}) {
    const job = parse(videoJobSchema, input), call = parse(callOptionsSchema, options);
    const port = this.#registry.port(job.modelId, 'video', job.providerId);
    ensure(port.cancelVideo, 'CAPABILITY_MISMATCH');
    return port.cancelVideo(job, call);
  }
}
