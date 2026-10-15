import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import { SDK_VERSION } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

/** Digests the published SDK 0.4.0 compiler produces for these unchanged packs. SDK 0.5.0 must
 * compile them byte-identically, and Core must keep publishing and running them. */
const DIGESTS_0_4_0 = {
  "spanish-greetings": "1600494a38e4b3afc81aec8b7072ee97ab3f0c7d6dac6112b163b68c77a01d79",
  "number-line": "42890306f6d9f99cdf27b5116206fed2bc7cd137a2296d5e0da7f59b3b786446",
};
const pack = (name: keyof typeof DIGESTS_0_4_0) => JSON.parse(readFileSync(new URL(`../../../examples/courses/packs/${name}.json`, import.meta.url), "utf8"));
const origin = "http://localhost:4398", schema = "sdk_compat_" + randomUUID().replaceAll("-", ""), workspace = randomUUID();
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "compat:" + id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(url.href);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "compat", "Compat"]);
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await root.end();
  }
});

describe("courses compiled for SDK 0.4.0 under SDK 0.5.0", () => {
  it("pins SDK 0.5.0 and compiles 0.4.0 packs byte-identically", () => {
    expect(SDK_VERSION).toBe("0.5.0");
    for (const [name, digest] of Object.entries(DIGESTS_0_4_0)) expect(compileCourse(pack(name as keyof typeof DIGESTS_0_4_0)).digest, name).toBe(digest);
  });
  it("still publishes and runs an unchanged 0.4.0 example course with its 0.4 recognition-only gates", async () => {
    const owner = await session("owner"), learner = await session("learner");
    const imported = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, pack("spanish-greetings"));
    expect(imported.json()).toMatchObject({ digest: DIGESTS_0_4_0["spanish-greetings"], status: "draft" });
    expect((await call(owner, "POST", `/api/releases/${imported.json().id}/publish`)).statusCode).toBe(200);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: imported.json().id })).json().id;
    const send = async (action: string, body: Record<string, unknown>) => call(learner, "POST", `/api/enrollments/${enrollment}/${action}`,
      { expectedRevision: (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().revision, idempotencyKey: randomUUID(), ...body });
    for (const blockId of ["sg-hello-text-1", "sg-hello-text-2"]) expect((await send("read", { episodeId: "sg-hello", blockId })).statusCode).toBe(200);
    // 0.4 refusal shape is unchanged (plus the decision and next actions).
    const early = await send("complete", { episodeId: "sg-hello" });
    expect(early.json()).toMatchObject({ error: "EVIDENCE_REQUIRED", details: { missing: [{ objectiveId: "sg-hello-objective", independentFamilies: 0, requiredFamilies: 2 }], status: "needs_evidence" } });
    for (const [assessmentId, answer] of [["sg-hello-meaning-1", "b"], ["sg-hello-response-1", "c"]] as const) {
      const issued = await send("challenges", { episodeId: "sg-hello", assessmentId, mode: "independent" });
      expect(issued.json().question).toMatchObject({ allowAbstain: true });
      expect((await send("answers", { challengeId: issued.json().challengeId, answer })).json().result).toMatchObject({ passed: true, independent: true });
    }
    const lesson = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().lessons[0];
    expect(lesson.gate).toMatchObject({ passed: true, status: "ready", gateVersion: "legacy-0.4" });
    const done = await send("complete", { episodeId: "sg-hello" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().lessons.map((l: { status: string }) => l.status).slice(0, 2)).toEqual(["completed", "available"]);
  });
  it("keeps the 0.4 fixture's digest and legacy gate semantics", async () => {
    const course = fixture();
    expect(course.gates.every((gate) => !("version" in gate))).toBe(true);
    expect(compileCourse(course).server.gates).toEqual(course.gates);
  });
});
