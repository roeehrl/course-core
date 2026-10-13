import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "../test/fixture.js";

/** Concurrent learners through the real HTTP API and PostgreSQL: sign-in,
 * enrollment, reading, independent answers and gated completion. Reports
 * latency per route, failures, process memory and database connections.
 * It measures this host only; it is not a capacity guarantee elsewhere. */
const levels = (process.env.LOAD_LEVELS ?? "10,50,100").split(",").map(Number);
const url = new URL(process.env.TEST_DATABASE_URL ?? "");
if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
  throw Error("Explicit disposable loopback database required");
const schema = "load_" + randomUUID().replaceAll("-", "");
const root = createDatabase(url.href);
await root.query("CREATE SCHEMA " + schema);
url.searchParams.set("options", "-csearch_path=" + schema);
const db = createDatabase(url.href);
const origin = "http://127.0.0.1";
const timings = new Map<string, number[]>(), failures: string[] = [];
let peakRss = 0, peakConnections = 0;
try {
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  const app = await createServer(db, { origin, secureCookies: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "load-" + workspace, "Load"]);
  const sampler = setInterval(async () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const n = Number((await root.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()").catch(() => ({ rows: [{ count: 0 }] }))).rows[0].count);
    peakConnections = Math.max(peakConnections, n);
  }, 100);
  async function timed(route: string, request: () => Promise<Response>) {
    const started = performance.now(), response = await request();
    (timings.get(route) ?? timings.set(route, []).get(route)!).push(performance.now() - started);
    if (!response.ok) failures.push(`${route} ${response.status} ${(await response.text()).slice(0, 120)}`);
    return response;
  }
  async function user(role: string) {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "load:" + id, role]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    const token = await issueLoginCode(db, id);
    const r = await timed("POST /auth/redeem", () => fetch(base + "/auth/redeem", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) }));
    const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return { cookie, csrf: (await r.json()).csrfToken as string };
  }
  type Who = Awaited<ReturnType<typeof user>>;
  const call = (who: Who, route: string, method: string, path: string, body?: unknown) =>
    timed(route, () => fetch(base + path, { method, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const owner = await user("owner");
  // Pad to a realistic course size: text episodes after the graded first lesson.
  const course = fixture(), extra = Number(process.env.LOAD_EXTRA_EPISODES ?? "60"), words = Array.from({ length: 300 }, (_, i) => "word" + (i % 37)).join(" ");
  course.chapters.push({ id: "more", title: "More", episodes: Array.from({ length: extra }, (_, i) => ({ id: "more-" + i, title: "More " + i, objectiveIds: ["maximum"],
    blocks: [0, 1, 2].map((b) => ({ id: `more-${i}-${b}`, type: "text" as const, markdown: words })) })) });
  const release = (await (await call(owner, "POST release", "POST", `/api/workspaces/${workspace}/releases`, course)).json()).id;
  assert.equal((await call(owner, "POST publish", "POST", `/api/releases/${release}/publish`)).status, 200);
  async function learner() {
    const who = await user("learner");
    const enrollment = (await (await call(who, "POST /api/enrollments", "POST", "/api/enrollments", { releaseId: release })).json()).id;
    const send = async (route: string, action: string, body: Record<string, unknown>) => {
      const revision = (await (await call(who, "GET enrollment", "GET", "/api/enrollments/" + enrollment)).json()).revision;
      return call(who, route, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
    };
    await send("POST read", "read", { episodeId: "min", blockId: "min-text" });
    for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
      const challenge = (await (await send("POST challenges", "challenges", { episodeId: "min", assessmentId, mode: "independent" })).json()).challengeId;
      const result = (await (await send("POST answers", "answers", { challengeId: challenge, answer })).json()).result;
      if (!result?.passed) failures.push("answer not passed");
    }
    const done = await send("POST complete", "complete", { episodeId: "min" });
    if (done.ok && (await (await call(who, "GET enrollment", "GET", "/api/enrollments/" + enrollment)).json()).lessons[0].status !== "completed") failures.push("lesson not completed");
  }
  const report: Record<string, unknown>[] = [];
  for (const level of levels) {
    timings.clear(); failures.length = 0; peakConnections = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: level }, () => learner().catch((e) => failures.push(String(e)))));
    const seconds = (performance.now() - started) / 1000;
    const routes = Object.fromEntries([...timings].map(([route, values]) => {
      const sorted = [...values].sort((a, b) => a - b), at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
      return [route, { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)!) }];
    }));
    const requests = [...timings.values()].reduce((s, v) => s + v.length, 0);
    report.push({ concurrentLearners: level, seconds: Number(seconds.toFixed(2)), requests, requestsPerSecond: Math.round(requests / seconds),
      failures: failures.length, sampleFailures: [...new Set(failures)].slice(0, 5), peakDatabaseConnections: peakConnections, routes });
  }
  clearInterval(sampler);
  const rows = Number((await db.query("SELECT count(*) FROM learning_events")).rows[0].count);
  console.log(JSON.stringify({ episodes: course.chapters.flatMap((c) => c.episodes).length, host: process.platform + "/" + process.arch, node: process.version, poolMax: 8, peakRssMiB: Math.round(peakRss / 1048576), learningEvents: rows, report }, null, 2));
  await app.close();
  assert.equal(report.every((r) => r.failures === 0), true, "load run had failures");
} finally {
  await db.end();
  await root.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
  await root.end();
}
