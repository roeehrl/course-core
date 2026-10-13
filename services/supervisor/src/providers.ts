import { z } from 'zod';
import { availabilitySchema, outcomeSchema, providerRequestSchema,runRefSchema, type Availability, type Outcome, type ProviderRequest,type RunRef } from './contracts.js';
import { assertEndpoint, BoundaryError, parseSafe, readJson } from './bridge.js';

/** Trusted adapter only. Implementations must not load/evaluate model, learner or course supplied code. */
export interface ProviderGateway {
  availability(capability: ProviderRequest['checkpoint']['capability'], signal: AbortSignal, ref?:RunRef): Promise<Availability>;
  invoke(request: ProviderRequest, signal: AbortSignal): Promise<Outcome>;
}
export class UnconfiguredProvider implements ProviderGateway {
  async availability(): Promise<Availability> { return { status: 'configuration_missing' }; }
  async invoke(): Promise<Outcome> { return { status: 'not_started', retryable: false }; }
}
const capabilitiesSchema = z.strictObject({
  supervisor: availabilitySchema, companion: availabilitySchema, research: availabilitySchema, media: availabilitySchema,
  // Optional so a gateway that predates written-answer assistance reports it as missing.
  reviewer: availabilitySchema.optional(),
});
/** Optional neutral gateway; no SDK dependency on the separately owned providers package. */
export class HttpProviderGateway implements ProviderGateway {
  private readonly base: string;
  constructor(baseUrl: string, private readonly token: string, private readonly request: typeof fetch = fetch) {
    this.base = `${assertEndpoint(baseUrl).href.replace(/\/$/, '')}/`;
    if (!token) throw new BoundaryError('invalid_request');
  }
  async availability(capability: ProviderRequest['checkpoint']['capability'], signal: AbortSignal,ref?:RunRef): Promise<Availability> {
    try {
      const url=new URL('v1/capabilities',this.base);if(ref)url.searchParams.set('workspaceId',parseSafe(runRefSchema,ref).workspaceId);
      const response = await this.request(url, {
        redirect: 'error', signal, headers: { authorization: `Bearer ${this.token}` },
      });
      if (!response.ok) throw new BoundaryError('provider_unavailable');
      return parseSafe(capabilitiesSchema, await readJson(response))[capability] ?? { status: 'capability_missing' };
    } catch { throw new BoundaryError('provider_unavailable'); }
  }
  async invoke(input: ProviderRequest, signal: AbortSignal): Promise<Outcome> {
    const body = parseSafe(providerRequestSchema, input);
    try {
      const response = await this.request(new URL('v1/operations', this.base), {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'idempotency-key': body.operationId },
        body: JSON.stringify(body),
      });
      // Neither an HTTP failure nor a broken body proves that billable work did not happen.
      if (!response.ok) return { status: 'uncertain' };
      return parseSafe(outcomeSchema, await readJson(response));
    } catch { return { status: 'uncertain' }; }
  }
}
