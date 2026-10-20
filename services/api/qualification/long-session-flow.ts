import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "../test/fixture.js";

/** One learner keeps one signed-in session through a long run against the real
 * HTTP API and PostgreSQL 17: repeated reads, idempotent replays, session checks
 * and many short-lived event streams (client aborts and server lifetime ends).
 * It fails on any request failure, duplicated or skipped stream event, leaked
 * stream slot, pool growth past its bound, waiting pool clients, or heap growth
 * past a budget between a warmed-up baseline and the end. It measures resource
 * stability on this host only; it is not a capacity or latency guarantee.
 *
 *   TEST_DATABASE_URL=postgres://…/course_core_test_<name> \
 *   node --expose-gc --import tsx qualification/long-session-flow.ts
 */
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw Error("Run with node --expose-gc so heap measurements are comparable");
const rounds = Number(process.env.LONG_SESSION_ROUNDS ?? "600");
const heapBudgetMiB = Number(process.env.LONG_SESSION_HEAP_BUDGET_MIB ?? "48");
if (!Number.isSafeInteger(rounds) || rounds < 100 || rounds > 100_000) throw Error("LONG_SESSION_ROUNDS must be an integer from 100 to 100000");
if (!Number.isFinite(heapBudgetMiB) || heapBudgetMiB <= 0) throw Error("LONG_SESSION_HEAP_BUDGET_MIB must be positive");
const url = new URL(process.env.TEST_DATABASE_URL ?? "");
if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
  throw Error("Explicit disposable loopback database required");
const POOL_MAX = 8, PER_ACCOUNT_STREAMS = 4, warmup = 50, streamEvery = 10;
const schema = "long_session_" + randomUUID().replaceAll("-", "");
const root = createDatabase(url.href);
await root.query("CREATE SCHEMA " + schema);
url.searchParams.set("options", "-csearch_path=" + schema);
const db = createDatabase(url.href);
const origin = "http://127.0.0.1";
const failures: string[] = [];
let peakConnections = 0;
const heapMiB = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1048576; };
try {
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  // Short stream lifetime and poll so a long session also crosses many server-side stream ends.
  const app = await createServer(db, { loginCodes: true, origin, secureCookies: false, eventStream: { pollMs: 20, lifetimeMs: 400, perAccount: PER_ACCOUNT_STREAMS } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "long-" + workspace, "Long session"]);
  const sampler = setInterval(async () => {
    const n = Number((await root.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()").catch(() => ({ rows: [{ count: 0 }] }))).rows[0].count);
    peakConnections = Math.max(peakConnections, n);
  }, 50);
  async function user(role: string) {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "long:" + id, role]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    const r = await fetch(base + "/auth/redeem", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: await issueLoginCode(db, id) }) });
    assert.equal(r.status, 200, "sign-in failed");
    return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), csrf: (await r.json()).csrfToken as string };
  }
  type Who = Awaited<ReturnType<typeof user>>;
  const call = async (who: Who, method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) failures.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} ${response.status}`);
    return response;
  };
  const owner = await user("owner");
  const release = (await (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json()).id;
  assert.equal((await call(owner, "POST", `/api/releases/${release}/publish`)).status, 200);
  const learner = await user("learner");
  const enrollment = (await (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json()).id as string;
  const revision = async () => (await (await call(learner, "GET", "/api/enrollments/" + enrollment)).json()).revision as number;
  const command = async (action: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) =>
    call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: await revision(), idempotencyKey, ...body });
  assert.equal((await command("read", { episodeId: "min", blockId: "min-text" })).status, 200, "first read failed");
  for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
    const challenge = (await (await command("challenges", { episodeId: "min", assessmentId, mode: "independent" })).json()).challengeId;
    assert.equal((await (await command("answers", { challengeId: challenge, answer })).json()).result?.passed, true, "answer did not pass");
  }
  assert.equal((await command("complete", { episodeId: "min" })).status, 200, "gated completion failed");

  // Streams resume from the last delivered sequence. Every sequence must arrive exactly once, in order.
  let lastSeen = "0", streamOpens = 0, lifetimeEnds = 0;
  const delivered: string[] = [];
  async function stream(abortAfterMs: number | undefined) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/enrollments/${enrollment}/events/stream`, { headers: { origin, cookie: learner.cookie, "last-event-id": lastSeen }, signal: controller.signal });
    if (response.status !== 200) { failures.push(`stream ${response.status}`); await response.body?.cancel(); return; }
    streamOpens++;
    const timer = abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(), abortAfterMs);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const id = /^id: ([0-9]+)$/m.exec(frame)?.[1];
          if (id) { if (BigInt(id) <= BigInt(lastSeen)) failures.push("stream replayed an earlier event"); delivered.push(id); lastSeen = id; }
          if (/^event: reconnect$/m.test(frame)) lifetimeEnds++;
          if (/^event: closed$/m.test(frame)) failures.push("stream closed unexpectedly");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) failures.push("stream error " + String(error).slice(0, 80));
    } finally { clearTimeout(timer); }
  }

  let baselineHeap = 0;
  const replayKey = randomUUID();
  for (let round = 1; round <= rounds; round++) {
    if ((await call(learner, "GET", "/auth/session")).status !== 200) failures.push("session lost");
    // Re-sending one idempotency key must replay its receipt, not append another event.
    await command("read", { episodeId: "min", blockId: "min-text" }, round % 25 === 0 ? replayKey : randomUUID());
    if (round % streamEvery === 0) await stream(round % (2 * streamEvery) === 0 ? undefined : 30);
    if (round === warmup) baselineHeap = heapMiB();
  }
  // Drain whatever the last stream did not reach, through a lifetime-ended stream.
  await stream(undefined);

  // Leaked per-account slots would refuse these. The limit itself must still hold.
  const held = Array.from({ length: PER_ACCOUNT_STREAMS }, () => new AbortController());
  const opened = await Promise.all(held.map((controller) => fetch(`${base}/api/enrollments/${enrollment}/events/stream`, { headers: { origin, cookie: learner.cookie, "last-event-id": lastSeen }, signal: controller.signal })));
  assert.deepEqual(opened.map((r) => r.status), Array(PER_ACCOUNT_STREAMS).fill(200), "event stream slots leaked over the session");
  const extra = await fetch(`${base}/api/enrollments/${enrollment}/events/stream`, { headers: { origin, cookie: learner.cookie } });
  assert.equal(extra.status, 429, "per-account stream limit was not enforced");
  await extra.body?.cancel();
  for (const controller of held) controller.abort();
  await Promise.allSettled(opened.map((r) => r.body?.cancel()));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const endHeap = heapMiB();

  const sequences = (await db.query<{ sequence: string }>("SELECT sequence FROM learning_events WHERE enrollment_id=$1 ORDER BY sequence", [enrollment])).rows.map((r) => r.sequence);
  const reads = Number((await db.query("SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND event_type='block.read'", [enrollment])).rows[0].count);
  const replays = Math.floor(rounds / 25);
  // Signing out ends the session for commands and streams alike.
  assert.equal((await call(learner, "POST", "/auth/logout")).status, 200);
  const afterLogout = await fetch(`${base}/api/enrollments/${enrollment}`, { headers: { origin, cookie: learner.cookie } });
  const streamAfterLogout = await fetch(`${base}/api/enrollments/${enrollment}/events/stream`, { headers: { origin, cookie: learner.cookie } });
  await afterLogout.body?.cancel(); await streamAfterLogout.body?.cancel();
  clearInterval(sampler);
  const result = {
    rounds, streamOpens, lifetimeEnds, eventsDelivered: delivered.length, events: sequences.length, reads,
    peakDatabaseConnections: peakConnections, pool: { total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
    heapMiB: { baseline: Math.round(baselineHeap), end: Math.round(endHeap), growth: Math.round(endHeap - baselineHeap), budget: heapBudgetMiB },
    failures: failures.length, sampleFailures: [...new Set(failures)].slice(0, 5), host: process.platform + "/" + process.arch, node: process.version,
  };
  console.log(JSON.stringify(result, null, 2));
  await app.close();
  assert.deepEqual(failures, [], "long session had failed requests");
  assert.equal(reads, rounds - replays + 2, "idempotent replays appended events or reads were lost");
  assert.deepEqual(delivered, sequences, "streams did not deliver every event exactly once in order");
  assert.ok(lifetimeEnds > 0 && streamOpens >= rounds / streamEvery, "streams did not cycle through both client aborts and server lifetime ends");
  assert.equal([afterLogout.status, streamAfterLogout.status].join(), "401,401", "a signed-out session still had access");
  assert.ok(db.totalCount <= POOL_MAX && db.waitingCount === 0, "database pool exceeded its bound or left waiting clients");
  assert.ok(peakConnections <= POOL_MAX + 1, "database connections exceeded the pool bound");
  assert.ok(endHeap - baselineHeap <= heapBudgetMiB, `heap grew ${Math.round(endHeap - baselineHeap)} MiB over the session`);
} finally {
  await db.end();
  await root.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
  await root.end();
}
