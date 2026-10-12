import type { z } from 'zod';
import {
  ackSchema, leasesSchema, preparedSchema, rpcRequestSchema, snapshotSchema, transitionSchema,
  type Command, type DeliveryCode, type OutboxEvent, type RunRef, type Snapshot, type Transition,
} from './contracts.js';

/** Every mutation is a host DB transaction. See BRIDGE.md for mandatory locking/receipt semantics. */
export interface HostBridge {
  load(ref: RunRef): Promise<Snapshot>;
  transition(command: Command): Promise<Transition>;
  claimOutbox(ownerId: string, limit: number, leaseMs: number): Promise<OutboxEvent[]>;
  prepareOutbox(event: OutboxEvent): Promise<RunRef[]>;
  ackOutbox(event: OutboxEvent): Promise<boolean>;
  nackOutbox(event: OutboxEvent, code: DeliveryCode, delayMs: number, quarantine: boolean): Promise<boolean>;
}
export class BoundaryError extends Error {
  constructor(readonly code: 'bridge_unavailable' | 'invalid_response' | 'invalid_request' | 'provider_unavailable') { super(code); }
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
      const response = await this.request(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new BoundaryError('bridge_unavailable');
      return parseSafe(schema, await readJson(response));
    } catch (error) {
      if (error instanceof BoundaryError) throw error;
      throw new BoundaryError('bridge_unavailable');
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
}
