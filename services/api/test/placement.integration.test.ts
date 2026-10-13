import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4386",
  schema = "placement_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, versions = 0;
interface Session {
  cookie: string;
  csrf: string;
}
const correct: Record<string, string | number> = { "min-a": "two", "min-b": 4, "max-a": 9, "max-b": -3 };
const wrong: Record<string, string | number> = { "min-a": "five", "min-b": 9, "max-a": 4, "max-b": -8 };
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "placement:" + id, "Placement " + role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (method: "GET" | "POST", url: string, payload?: unknown, who = learner) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function course(change: (c: CourseManifest) => void = () => {}) {
  const manifest = fixture();
  manifest.version = `1.0.${versions++}`;
  change(manifest);
  const id = (await call("POST", `/api/workspaces/${workspace}/releases`, manifest, owner)).json().id;
  expect((await call("POST", `/api/releases/${id}/publish`, undefined, owner)).statusCode).toBe(200);
  const enrollment = (await call("POST", "/api/enrollments", { releaseId: id })).json().id as string;
  const send = async (action: string, body: Record<string, unknown> = {}) => {
    const revision = (await call("GET", "/api/enrollments/" + enrollment)).json().revision;
    return call("POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
  };
  const state = async () => (await call("GET", `/api/enrollments/${enrollment}/placement`)).json();
  /** Take the item the server proposes and answer it. */
  const take = async (answers: Record<string, string | number> = correct) => {
    const next = (await state()).run.nextItem;
    expect(next, "server proposed no item").toBeTruthy();
    const issued = await send("challenges", { episodeId: next.episodeId, assessmentId: next.assessmentId, mode: "placement" });
    expect(issued.statusCode, issued.body).toBe(200);
    const answered = await send("answers", { challengeId: issued.json().challengeId, answer: answers[next.assessmentId] });
    expect(answered.statusCode, answered.body).toBe(200);
    return next.assessmentId as string;
  };
  return { enrollment, send, state, take };
}
beforeAll(async () => {
  const connection = process.env.TEST_DATABASE_URL ?? "";
  const url = new URL(connection);
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(connection);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, directory);
  app = await createServer(db, { origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "place-" + workspace, "Placement"]);
  owner = await session("owner");
  learner = await session("learner");
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  }
});

describe("optional placement runs", () => {
  it("can be declined without penalty and later taken before study begins", async () => {
    const c = await course();
    expect(await c.state()).toMatchObject({ available: true, state: "offered", declinable: true, run: null, grantsCompletion: false });
    expect((await c.send("placement/decline")).statusCode).toBe(200);
    expect((await c.state()).state).toBe("declined");
    const snapshot = (await call("GET", "/api/enrollments/" + c.enrollment)).json();
    expect(snapshot.lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
    expect((await c.send("placement/start")).statusCode).toBe(200);
    expect((await c.send("placement/decline")).json().error).toBe("PLACEMENT_ALREADY_STARTED");
    expect((await c.send("placement/start")).json().error).toBe("PLACEMENT_ALREADY_TAKEN");
  });

  it("places out of the whole demonstrated path only on acceptance, without inventing lesson visits", async () => {
    const c = await course();
    await c.send("placement/start");
    const taken = [await c.take(), await c.take(), await c.take(), await c.take()];
    expect(taken).toEqual(["min-a", "min-b", "max-a", "max-b"]);
    let view = await c.state();
    expect(view.run.nextItem).toBeNull();
    expect(view.run.proposal.exempt.map((e: { episodeId: string }) => e.episodeId)).toEqual(["min", "max"]);
    // Nothing is exempt until the learner finishes and accepts.
    expect((await call("GET", "/api/enrollments/" + c.enrollment)).json().lessons[0].status).toBe("available");
    expect((await c.send("placement/accept", {})).json().error).toBe("PLACEMENT_NOT_FINISHED");
    expect((await c.send("placement/finish")).statusCode).toBe(200);
    view = await c.state();
    expect(view.state).toBe("finished");
    expect(view.run.proposal.demonstrated.map((d: { objectiveId: string }) => d.objectiveId)).toEqual(["minimum", "maximum"]);
    // Probing later episodes started no study clocks for them.
    expect((await db.query("SELECT scope_id FROM scope_anchors WHERE enrollment_id=$1 AND scope_id LIKE 'episode:%' ORDER BY scope_id", [c.enrollment])).rows.map((r) => r.scope_id)).not.toContain("episode:max");
    const accepted = await c.send("placement/accept", {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().placedEpisodeIds).toEqual(["min", "max"]);
    const after = (await call("GET", "/api/enrollments/" + c.enrollment)).json();
    expect(after.lessons.map((l: { status: string; completedBlockIds: string[] }) => [l.status, l.completedBlockIds])).toEqual([["placed", []], ["placed", []]]);
    const events = (await db.query("SELECT event_type FROM learning_events WHERE enrollment_id=$1 AND event_type LIKE 'placement.%' OR (enrollment_id=$1 AND event_type='episode.placed') ORDER BY sequence", [c.enrollment])).rows.map((r) => r.event_type);
    expect(events).toEqual(["placement.started", "placement.finished", "episode.placed", "episode.placed", "placement.accepted"]);
    // Staff see which evidence-backed decision placed the learner, not a global label.
    const catalog = (await call("GET", "/api/admin/session", undefined, owner)).json().courses[0].id;
    const staff = (await call("GET", "/api/admin/courses/" + catalog, undefined, owner)).json();
    expect(staff.enrollments.find((e: { id: string }) => e.id === c.enrollment).placement).toMatchObject({ state: "accepted", exemptEpisodeIds: ["min", "max"], items: 4 });
  });

  it("stops at the first unproven episode and lets the learner start earlier but never later", async () => {
    const c = await course();
    await c.send("placement/start");
    await c.take();
    await c.take();
    await c.take(wrong);
    const view = await c.state();
    expect(view.run.stopReason).toBe("not_demonstrated");
    expect(view.run.nextItem).toBeNull();
    await c.send("placement/finish");
    const finished = await c.state();
    expect(finished.run.proposal).toMatchObject({ startEpisodeId: "max", exempt: [{ episodeId: "min" }] });
    // The learner cannot skip the unproven episode, nor place out of everything.
    expect((await c.send("placement/accept", {})).json().error).toBe("PLACEMENT_START_NOT_ALLOWED");
    // Choosing to start earlier exempts nothing; the evidence remains recorded.
    const earlier = await c.send("placement/accept", { startEpisodeId: "min" });
    expect(earlier.statusCode, earlier.body).toBe(200);
    expect(earlier.json().placedEpisodeIds).toEqual([]);
    expect((await call("GET", "/api/enrollments/" + c.enrollment)).json().lessons[0].status).toBe("available");
    expect((await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1", [c.enrollment])).rows[0].n).toBe(3);
  });

  it("resumes an interrupted item, treats unanswered or assisted items as unknown, and respects the item cap", async () => {
    const c = await course((m) => {
      m.placement!.maxItems = 3;
    });
    await c.send("placement/start");
    const next = (await c.state()).run.nextItem;
    const issued = await c.send("challenges", { episodeId: next.episodeId, assessmentId: next.assessmentId, mode: "placement" });
    // Interrupted: the same item is what the learner resumes; no second one is issued.
    expect((await c.state()).run.pendingChallengeId).toBe(issued.json().challengeId);
    expect((await c.send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "placement" })).json().error).toBe("PLACEMENT_ITEM_PENDING");
    await c.send("answers", { challengeId: issued.json().challengeId, answer: correct[next.assessmentId] });
    // A revealed solution makes the item assisted: it cannot place anyone out.
    const second = (await c.state()).run.nextItem;
    const helped = await c.send("challenges", { episodeId: second.episodeId, assessmentId: second.assessmentId, mode: "placement" });
    await c.send("solution", { challengeId: helped.json().challengeId });
    await c.send("answers", { challengeId: helped.json().challengeId, answer: correct[second.assessmentId] });
    expect((await c.state()).run.stopReason).toBe("not_demonstrated");
    await c.send("placement/finish");
    expect((await c.state()).run.proposal.exempt).toEqual([]);

    const capped = await course((m) => {
      m.placement!.maxItems = 2;
    });
    await capped.send("placement/start");
    await capped.take();
    await capped.take();
    expect((await capped.state()).run).toMatchObject({ nextItem: null, stopReason: "item_limit" });
    expect((await capped.send("challenges", { episodeId: "max", assessmentId: "max-a", mode: "placement" })).json().error).toBe("PLACEMENT_ITEM_LIMIT");
  });

  it("honours protected episodes, disabled placement and the start-before-study rule", async () => {
    const guarded = await course((m) => {
      m.placement!.protectedEpisodeIds = ["max"];
    });
    await guarded.send("placement/start");
    await guarded.take();
    await guarded.take();
    expect((await guarded.state()).run).toMatchObject({ nextItem: null, stopReason: "protected_episode" });

    const off = await course((m) => {
      m.placement!.enabled = false;
    });
    expect((await off.state())).toMatchObject({ available: false, state: "unavailable" });
    expect((await off.send("placement/start")).json().error).toBe("PLACEMENT_UNAVAILABLE");

    const studied = await course();
    expect((await studied.send("read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
    expect((await studied.send("placement/start")).json().error).toBe("PLACEMENT_AFTER_STUDY");
  });
});
