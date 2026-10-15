import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

/**
 * Client facts for the learning-event envelope (migration 054). A browser or app
 * sends them as headers on its requests; the API keeps them for the duration of
 * that request so every event the request appends records them. They are
 * advisory metadata: a missing or malformed header is ignored, never an error,
 * and never changes what the request may do.
 *
 *   X-Course-Platform         web | ios | android
 *   X-Course-App-Version      1-64 of [0-9A-Za-z.+_-]
 *   X-Course-Client-Sequence  the client's own counter, 0..10^15
 *   X-Course-Occurred-At      ISO time the learner acted; kept only within 7 days of server time
 */
export interface ClientEnvelope { platform?: 'web' | 'ios' | 'android'; appVersion?: string; clientSequence?: number; occurredAt?: string }
const store = new AsyncLocalStorage<ClientEnvelope>();
const header = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);
const WEEK_MS = 7 * 86_400_000;

export function parseClientEnvelope(headers: Record<string, string | string[] | undefined>, nowMs = Date.now()): ClientEnvelope {
  const envelope: ClientEnvelope = {};
  const platform = header(headers['x-course-platform']);
  if (platform === 'web' || platform === 'ios' || platform === 'android') envelope.platform = platform;
  const version = header(headers['x-course-app-version']);
  if (version && /^[0-9A-Za-z.+_-]{1,64}$/.test(version)) envelope.appVersion = version;
  const sequence = header(headers['x-course-client-sequence']);
  if (sequence && /^[0-9]{1,15}$/.test(sequence)) envelope.clientSequence = Number(sequence);
  const occurred = header(headers['x-course-occurred-at']);
  const at = occurred && occurred.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(occurred) ? Date.parse(occurred) : NaN;
  if (Number.isFinite(at) && Math.abs(at - nowMs) <= WEEK_MS) envelope.occurredAt = new Date(at).toISOString();
  return envelope;
}
export function registerClientEnvelope(app: FastifyInstance) {
  app.addHook('onRequest', (request, _reply, done) => {
    store.run(parseClientEnvelope(request.headers), done);
  });
}
/** The current request's client facts; background work has none. */
export const currentClientEnvelope = (): ClientEnvelope => store.getStore() ?? {};
