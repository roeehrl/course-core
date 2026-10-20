import type { z } from 'zod';
import {
  ackSchema, cancellationDeliveriesSchema, controlDeliveriesSchema, leasesSchema, reconciledSchema, preparedSchema, rpcRequestSchema, snapshotSchema, transitionSchema,
  crossCourseConsentSchema, crossCourseDeliveriesSchema, crossCourseObservedSchema, crossCoursePlanSchema,
  type CancellationDelivery, type Command, type ControlDelivery, type DeliveryCode, type Reconciled, type OutboxEvent, type RunRef, type Snapshot, type Transition,
  type CrossCourseConsent, type CrossCourseDelivery, type CrossCourseObserved, type CrossCoursePlan,
} from './contracts.js';
import { telemetry } from './telemetry.js';

/** Every mutation is a host DB transaction. See BRIDGE.md for mandatory locking/receipt semantics. */
export interface HostBridge {
  load(ref: RunRef): Promise<Snapshot>;
  transition(command: Command): Promise<Transition>;
  claimOutbox(ownerId: string, limit: number, leaseMs: number): Promise<OutboxEvent[]>;
  prepareOutbox(event: OutboxEvent): Promise<RunRef[]>;
  ackOutbox(event: OutboxEvent): Promise<boolean>;
  nackOutbox(event: OutboxEvent, code: DeliveryCode, delayMs: number, quarantine: boolean): Promise<boolean>;
  /** Leases committed supervision-control changes whose wake-up signals are not yet delivered. */
  claimControls(ownerId: string, limit: number, leaseMs: number): Promise<ControlDelivery[]>;
  /** Marks a leased change delivered, or releases it for another attempt. False when the lease was lost. */
  ackControl(delivery: ControlDelivery, delivered: boolean): Promise<boolean>;
  /** Leases committed job cancellations (data erasure, provider change) whose signals are not yet delivered. */
  claimCancellations(ownerId: string, limit: number, leaseMs: number): Promise<CancellationDelivery[]>;
  /** Marks a leased cancellation delivered, or releases it for another attempt. False when the lease was lost. */
  ackCancellation(delivery: CancellationDelivery, delivered: boolean): Promise<boolean>;
  /** Settles uncertain calls whose gateway receipt has since finished, and lists jobs (reconciled,
   * or parked follow-ups now due) moved to a new generation that need a workflow start. */
  reconcile(limit: number): Promise<Reconciled>;
  /** Leases undelivered wake-ups of learner coordinators (consent changes, new evidence, erasure). */
  claimCrossCourse(ownerId: string, limit: number, leaseMs: number): Promise<CrossCourseDelivery[]>;
  /** Marks a leased wake-up delivered, or releases it for another attempt. False when the lease was lost. */
  ackCrossCourse(delivery: CrossCourseDelivery, delivered: boolean): Promise<boolean>;
  /** Whether any opt-in of this learner is in force; the coordinator does nothing without one. */
  crossCourseConsent(learnerId: string): Promise<CrossCourseConsent>;
  /** One planning pass: the host verifies and stores learner-confirmable suggestions from the staff mapping. */
  planCrossCourse(learnerId: string, consentRevision: number): Promise<CrossCoursePlan>;
  /** An enrollment coordinator's job ended: the learner to wake, or null when no opt-in covers the enrollment. */
  observeEnrollment(workspaceId: string, enrollmentId: string): Promise<CrossCourseObserved>;
}
export class BoundaryError extends Error {
  constructor(readonly code: 'bridge_unavailable' | 'bridge_rejected' | 'invalid_response' | 'invalid_request' | 'provider_unavailable') { super(code); }
}
const HOST_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 422]);
/** A host bridge answer that was not a success. Keeps the HTTP status and the host's error code
 * (a bounded upper-case identifier, never free text), so callers can tell a definite rejection,
 * such as a 409 state conflict, from an outage. A transport failure has status 0. */
export class BridgeError extends BoundaryError {
  constructor(readonly status: number, readonly errorCode: string | null) {
    super(BridgeError.rejection(status) ? 'bridge_rejected' : 'bridge_unavailable');
  }
  /** 4xx other than timeout and rate limit: the host decided; repeating the same request will not change it. */
  static rejection(status: number) { return status >= 400 && status < 500 && status !== 408 && status !== 429; }
  get rejected() { return BridgeError.rejection(this.status); }
  /** A permanent state conflict, as opposed to a lost lease (which another delivery resolves). */
  get conflict() { return this.status === 409 && this.errorCode !== 'SUPERVISOR_LEASE_LOST'; }
  /** A definite refusal of this exact request: a state conflict, or a client error the host will
   * repeat (400/422 invalid, 404 not found, 410 gone, for example erased). Authentication and
   * authorization answers (401/403), timeouts (408) and rate limits (429) are not: configuration
   * or time can change them. */
  get refusal() { return this.conflict || REFUSAL_STATUSES.has(this.status); }
}
async function hostErrorCode(response: Response): Promise<string | null> {
  try {
    const body = await readJson(response, 4_096) as { error?: unknown } | null;
    return typeof body?.error === 'string' && HOST_ERROR_CODE.test(body.error) ? body.error : null;
  } catch { return null; }
}
export function parseSafe<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('invalid_response');
  return parsed.data;
}
export function assertEndpoint(value: string): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')))
    throw new BoundaryError('invalid_request');
  return url;
}
export async function readJson(response: Response, limit = 262_144): Promise<unknown> {
  if (!response.body) throw new BoundaryError('invalid_response');
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new BoundaryError('invalid_response');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new BoundaryError('invalid_response'); }
  finally { await reader.cancel().catch(() => {}); }
}
export class HttpHostBridge implements HostBridge {
  private readonly endpoint: string;
  constructor(baseUrl: string, private readonly token: string, private readonly timeoutMs = 10_000,
    private readonly request: typeof fetch = fetch) {
    this.endpoint = new URL('v1/supervisor/bridge', `${assertEndpoint(baseUrl).href.replace(/\/$/, '')}/`).href;
    if (!token) throw new BoundaryError('invalid_request');
  }
  private async rpc<T>(body: z.infer<typeof rpcRequestSchema>, schema: z.ZodType<T>): Promise<T> {
    if (!rpcRequestSchema.safeParse(body).success) throw new BoundaryError('invalid_request');
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
      telemetry().inject(headers);
      const response = await this.request(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers, body: JSON.stringify(body),
      });
      if (!response.ok) throw new BridgeError(response.status, await hostErrorCode(response));
      return parseSafe(schema, await readJson(response));
    } catch (error) {
      if (error instanceof BoundaryError) throw error;
      throw new BridgeError(0, null);
    }
  }
  load(ref: RunRef) { return this.rpc({ method: 'load', ref }, snapshotSchema); }
  transition(command: Command) { return this.rpc({ method: 'transition', command }, transitionSchema); }
  claimOutbox(ownerId: string, limit: number, leaseMs: number) {
    return this.rpc({ method: 'outbox.claim', ownerId, limit, leaseMs }, leasesSchema);
  }
  async prepareOutbox(event: OutboxEvent) {
    return (await this.rpc({ method: 'outbox.prepare', eventId: event.eventId, leaseToken: event.leaseToken }, preparedSchema)).jobs;
  }
  async ackOutbox(event: OutboxEvent) {
    return (await this.rpc({ method: 'outbox.ack', eventId: event.eventId, leaseToken: event.leaseToken }, ackSchema)).accepted;
  }
  async nackOutbox(event: OutboxEvent, code: DeliveryCode, delayMs: number, quarantine: boolean) {
    return (await this.rpc({ method: 'outbox.nack', eventId: event.eventId, leaseToken: event.leaseToken,
      code, delayMs, quarantine }, ackSchema)).accepted;
  }
  claimControls(ownerId: string, limit: number, leaseMs: number) {
    return this.rpc({ method: 'control.claim', ownerId, limit, leaseMs }, controlDeliveriesSchema);
  }
  reconcile(limit: number) { return this.rpc({ method: 'reconcile', limit }, reconciledSchema); }
  claimCancellations(ownerId: string, limit: number, leaseMs: number) {
    return this.rpc({ method: 'cancel.claim', ownerId, limit, leaseMs }, cancellationDeliveriesSchema);
  }
  async ackCancellation(delivery: CancellationDelivery, delivered: boolean) {
    return (await this.rpc({ method: 'cancel.ack', cancellationId: delivery.cancellationId, leaseToken: delivery.leaseToken, delivered }, ackSchema)).accepted;
  }
  async ackControl(delivery: ControlDelivery, delivered: boolean) {
    return (await this.rpc({ method: 'control.ack', changeId: delivery.changeId, leaseToken: delivery.leaseToken, delivered }, ackSchema)).accepted;
  }
  claimCrossCourse(ownerId: string, limit: number, leaseMs: number) {
    return this.rpc({ method: 'crosscourse.claim', ownerId, limit, leaseMs }, crossCourseDeliveriesSchema);
  }
  async ackCrossCourse(delivery: CrossCourseDelivery, delivered: boolean) {
    return (await this.rpc({ method: 'crosscourse.ack', wakeupId: delivery.wakeupId, leaseToken: delivery.leaseToken, delivered }, ackSchema)).accepted;
  }
  crossCourseConsent(learnerId: string) { return this.rpc({ method: 'crosscourse.consent', learnerId }, crossCourseConsentSchema); }
  planCrossCourse(learnerId: string, consentRevision: number) {
    return this.rpc({ method: 'crosscourse.plan', learnerId, consentRevision }, crossCoursePlanSchema);
  }
  observeEnrollment(workspaceId: string, enrollmentId: string) {
    return this.rpc({ method: 'crosscourse.observe', workspaceId, enrollmentId }, crossCourseObservedSchema);
  }
}
