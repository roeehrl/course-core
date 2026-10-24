import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import type { authService, Actor } from './auth.js';
import { loadEnrollment } from './repository.js';
import { requireCondition } from './errors.js';
import { audienceOf, eventPayloadFor } from './learner-privacy.js';
import type { DatabaseWake } from './database-wake.js';
import { replyDrafts, type DraftFrame, type ReplyDrafts } from './reply-drafts.js';

/**
 * GET /api/enrollments/:enrollmentId/events/stream: a resumable Server-Sent
 * Events stream of the enrollment's learning events, for the same readers as
 * GET .../events. Each event's SSE id is its sequence, so a reconnecting
 * EventSource resumes after the last one it received (Last-Event-ID); `?after=`
 * starts after a known cursor.
 *
 * New events are sent as soon as their transaction commits (a database wake-up), and the
 * learner's own streamed companion drafts as soon as they are released (`companion-draft`
 * events; reply-drafts.ts). Bounded: at most 100 events per read, a read every second while idle, a
 * heartbeat comment every 15 s, access rechecked every 30 s, and the stream
 * closes after 5 minutes with a `reconnect` event (the client reconnects and
 * resumes). Each account may hold 4 streams and each process 200; more are
 * refused with 429 and the client falls back to GET .../events.
 */
export interface EventStreamOptions { pollMs?: number; heartbeatMs?: number; recheckMs?: number; lifetimeMs?: number; perAccount?: number; perProcess?: number;
  /** Commit-time wake-ups (database-wake.ts): a new event of this enrollment is sent at once; the poll stays the backstop. */
  wake?: DatabaseWake;
  /** Streamed companion drafts (reply-drafts.ts), pushed to the enrollment's own learner only. */
  drafts?: ReplyDrafts | null }
const defaults = { pollMs: 1000, heartbeatMs: 15_000, recheckMs: 30_000, lifetimeMs: 300_000, perAccount: 4, perProcess: 200 };
export const EVENT_COLUMNS = `sequence,id,actor_kind,event_type,payload,correlation_id,created_at,schema_version,platform,app_version,client_sequence,occurred_at,
  COALESCE(received_at,created_at) AS received_at,course_digest,activity_instance_id,attempt_id,payload_ref,causation_id`;
const cursor = /^[0-9]{1,18}$/;

export function registerEventStream(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, options: EventStreamOptions = {}) {
  const limits = { ...defaults, ...options };
  const open = new Map<string, number>();
  let total = 0;
  app.get('/api/enrollments/:enrollmentId/events/stream', { schema: {
    params: { type: 'object', required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } },
    querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'string', pattern: '^[0-9]{1,18}$' } } },
  } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor: Actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const context = await loadEnrollment(db, actor, enrollmentId, false, true);
    const audience = audienceOf(actor.id, context.enrollment);
    const resume = request.headers['last-event-id'];
    let after = typeof resume === 'string' && cursor.test(resume) ? resume : (request.query as { after?: string }).after ?? '0';
    requireCondition((open.get(actor.id) ?? 0) < limits.perAccount && total < limits.perProcess, 'EVENT_STREAMS_LIMIT', 429);
    open.set(actor.id, (open.get(actor.id) ?? 0) + 1); total++;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    raw.write(`retry: 3000\n: stream ${enrollmentId}\n\n`);
    let closed = false;
    const started = Date.now();
    let lastWrite = Date.now(), lastCheck = Date.now();
    const finish = () => {
      if (closed) return;
      closed = true;
      const count = (open.get(actor.id) ?? 1) - 1;
      if (count > 0) open.set(actor.id, count); else open.delete(actor.id);
      total--;
      raw.end();
    };
    const stopped = new AbortController();
    request.raw.on('close', () => { stopped.abort(); finish(); });
    const send = (text: string) => { if (!closed) { raw.write(text); lastWrite = Date.now(); } };
    // The learner's own companion drafts, as they are released: pushed, never polled. Staff never
    // receive them (the companion conversation is private to the learner). Not resumable by
    // Last-Event-ID: a (re)connecting stream first gets every current draft whole.
    const drafts = audience === 'learner' && limits.drafts !== null ? limits.drafts ?? replyDrafts() : null;
    const draftFrame = (frame: DraftFrame) => send(`event: companion-draft\ndata: ${JSON.stringify(frame)}\n\n`);
    const unfollow = drafts?.subscribe(enrollmentId, draftFrame);
    stopped.signal.addEventListener('abort', () => unfollow?.(), { once: true });
    if (drafts) for (const frame of drafts.current(enrollmentId)) draftFrame(frame);
    try {
      while (!closed) {
        if (Date.now() - started >= limits.lifetimeMs) { send('event: reconnect\ndata: {}\n\n'); break; }
        if (Date.now() - lastCheck >= limits.recheckMs) {
          // Signed out, membership removed or the enrollment erased: the stream ends.
          try { await auth.authenticate(request); await loadEnrollment(db, actor, enrollmentId, false, true); }
          catch { send('event: closed\ndata: {"reason":"access_changed"}\n\n'); break; }
          lastCheck = Date.now();
        }
        const rows = (await db.query<{ sequence: string; actor_kind: string; event_type: string; payload: unknown }>(`SELECT ${EVENT_COLUMNS} FROM learning_events
          WHERE enrollment_id=$1 AND workspace_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100`, [enrollmentId, context.enrollment.workspace_id, after])).rows;
        // The same privacy rule as GET .../events: staff read only allowlisted payloads.
        for (const row of rows) { send(`id: ${row.sequence}\nevent: learning-event\ndata: ${JSON.stringify({ ...row, ...eventPayloadFor(audience, row.actor_kind, row.event_type, row.payload) })}\n\n`); after = row.sequence; }
        if (rows.length === 100) continue;
        if (Date.now() - lastWrite >= limits.heartbeatMs) send(': heartbeat\n\n');
        if (limits.wake) await limits.wake.wait('course_events', limits.pollMs, { match: id => id === enrollmentId, signal: stopped.signal });
        else await new Promise(resolve => setTimeout(resolve, limits.pollMs));
      }
    } catch {
      send('event: closed\ndata: {"reason":"error"}\n\n');
    } finally { unfollow?.(); finish(); }
  });
}
