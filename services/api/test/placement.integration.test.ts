import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { placementPlan, type RunAttempt } from "../src/placement.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";
import { reviewedRubricEvaluator, rubricDigest } from "../src/rubric-evaluator.js";
import { maximumExplanation, placementWrittenCourse, rubricCourse, rubricExplanation } from "./rubric-fixture.js";

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
async function course(change: (c: CourseManifest) => void = () => {}, base: () => CourseManifest = fixture) {
  const manifest = base();
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
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
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

describe("the placement walk with a high score but a missing prerequisite", () => {
  const answered = (assessmentId: string, passed: boolean): RunAttempt => {
    const item = fixture().assessments.find((a) => a.id === assessmentId)!;
    return { episodeId: item.objectiveIds[0] === "minimum" ? "min" : "max", assessmentId, familyId: item.familyId, objectiveIds: item.objectiveIds, passed, independent: true,
      evidence: [{ id: "e-" + assessmentId, objectiveId: item.objectiveIds[0]!, passed }] };
  };
  it("never places out of a later episode past an unproven prerequisite, whatever the average", () => {
    // Three of four right, all later ones perfect: the wrong prerequisite answer still stops the walk.
    const plan = placementPlan(fixture(), "d", [answered("min-a", true), answered("min-b", false), answered("max-a", true), answered("max-b", true)], [], { allowNextItem: false });
    expect(plan).toMatchObject({ exemptEpisodeIds: [], stopReason: "not_demonstrated", startEpisodeId: "min" });
  });
  it("stops at an episode whose prerequisite was taught off the path and never shown", () => {
    const course = fixture();
    course.chapters[0]!.episodes[0]!.requirement = "optional";
    const plan = placementPlan(course, "d", [answered("max-a", true), answered("max-b", true)], [], { allowNextItem: true });
    expect(plan).toMatchObject({ exemptEpisodeIds: [], stopReason: "not_placeable", startEpisodeId: "max", nextItem: null });
  });
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
    // A placed-out episode stays open to revisit; reading it records the visit and keeps the exemption.
    const revisit = await c.send("read", { episodeId: "min", blockId: "min-text" });
    expect(revisit.statusCode, revisit.body).toBe(200);
    expect((await call("GET", "/api/enrollments/" + c.enrollment)).json().lessons.map((l: { status: string; completedBlockIds: string[] }) => [l.status, l.completedBlockIds])).toEqual([["placed", ["min-text"]], ["placed", []]]);
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

  it("counts the question allowance within the current run only", async () => {
    const c = await course();
    // Declining first and starting later is the same, fresh run.
    expect((await c.send("placement/decline")).statusCode).toBe(200);
    // Placement-mode rows issued before this run began (e.g. left by an earlier run) use none of its allowance.
    for (let i = 0; i < 4; i++)
      await db.query(
        `INSERT INTO assessment_challenges (id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,issued_at,expires_at)
         SELECT $1,$2,'min','retired-item',r.digest,'placement',true,now()-interval '2 days',now()-interval '2 days'
         FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=$2`,
        [randomUUID(), c.enrollment],
      );
    await c.send("placement/start");
    expect([await c.take(), await c.take(), await c.take(), await c.take()]).toEqual(["min-a", "min-b", "max-a", "max-b"]);
    expect((await c.state()).run).toMatchObject({ itemsUsed: 4, nextItem: null });
    // The cap still holds inside the run.
    expect((await c.send("challenges", { episodeId: "max", assessmentId: "max-b", mode: "placement" })).json().error).toBe("PLACEMENT_ITEM_LIMIT");
  });

  it("gives each enrollment's run its own allowance", async () => {
    // The same learner in two versions of the course: two runs, two allowances.
    const first = await course((m) => { m.placement!.maxItems = 2; });
    const second = await course((m) => { m.placement!.maxItems = 2; });
    await first.send("placement/start");
    expect([await first.take(), await first.take()]).toEqual(["min-a", "min-b"]);
    expect((await first.state()).run).toMatchObject({ itemsUsed: 2, nextItem: null, stopReason: "item_limit" });
    expect((await first.send("challenges", { episodeId: "max", assessmentId: "max-a", mode: "placement" })).json().error).toBe("PLACEMENT_ITEM_LIMIT");
    await second.send("placement/start");
    expect((await second.state()).run).toMatchObject({ itemsUsed: 0, nextItem: { episodeId: "min", assessmentId: "min-a" } });
    expect([await second.take(), await second.take()]).toEqual(["min-a", "min-b"]);
    expect((await second.state()).run).toMatchObject({ itemsUsed: 2, stopReason: "item_limit" });
  });

  it("spends an item left to expire once, moves on to a fresh one, and never offers an item it would refuse", async () => {
    // A third first-topic item, so the run can still demonstrate both families after one expires.
    const c = await course((m) => {
      m.assessments.push({ id: "min-c", type: "numeric", objectiveIds: ["minimum"], familyId: "compare", prompt: "Minimum of 7 and 3?", grading: { expected: 3, absoluteTolerance: 0, explanation: "3 is below 7." } } as never);
      m.gates.find((g) => g.id === "min-gate")!.assessmentIds.push("min-c");
      m.placement!.assessmentIds.push("min-c");
    });
    const answers = { ...correct, "min-c": 3 };
    await c.send("placement/start");
    const shown = await c.send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "placement" });
    expect(shown.statusCode, shown.body).toBe(200);
    expect((await c.state()).run).toMatchObject({ itemsUsed: 0, pendingChallengeId: shown.json().challengeId });
    // The learner walks away; the item expires unanswered.
    await db.query("UPDATE assessment_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [shown.json().challengeId]);
    let run = (await c.state()).run;
    // It is spent once and not offered again: it is no longer fresh evidence.
    expect(run).toMatchObject({ itemsUsed: 1, pendingChallengeId: null, nextItem: { episodeId: "min", assessmentId: "min-b" } });
    expect(await c.take(answers)).toBe("min-b");
    expect(await c.take(answers)).toBe("min-c");
    run = (await c.state()).run;
    expect(run).toMatchObject({ itemsUsed: 3, nextItem: { episodeId: "max", assessmentId: "max-a" } });
    expect(run.proposal.exempt.map((e: { episodeId: string }) => e.episodeId)).toEqual(["min"]);
    // Every item the view offered was issued as fresh, independent evidence.
    expect((await db.query("SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1 AND mode='placement' AND NOT independent_eligible", [c.enrollment])).rows).toEqual([]);
    expect(await c.take(answers)).toBe("max-a");
    // The view and the server agree on the cap: nothing is offered, and nothing more is issued.
    run = (await c.state()).run;
    expect(run).toMatchObject({ itemsUsed: 4, nextItem: null, stopReason: "item_limit" });
    expect((await c.send("challenges", { episodeId: "max", assessmentId: "max-b", mode: "placement" })).json().error).toBe("PLACEMENT_ITEM_LIMIT");
    const finished = await c.send("placement/finish");
    expect(finished.json()).toMatchObject({ exemptEpisodeIds: ["min"], startEpisodeId: "max", stopReason: "item_limit" });
    expect((await c.state()).run.itemsUsed).toBe(4);
  });

  it("does not count an item cut short by finishing the run", async () => {
    const c = await course();
    await c.send("placement/start");
    await c.take();
    const shown = await c.send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "placement" });
    expect(shown.statusCode, shown.body).toBe(200);
    const finished = await c.send("placement/finish");
    expect(finished.json()).toMatchObject({ stopReason: "stopped_by_learner" });
    expect((await c.state()).run).toMatchObject({ itemsUsed: 1, pendingChallengeId: null });
    expect((await c.send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "placement" })).json().error).toBe("PLACEMENT_RUN_REQUIRED");
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

  describe("an answer awaiting evaluation", () => {
    // The first gate takes a choice item and a reviewed written explanation (two families).
    const withWritten = () => course((m) => { m.placement!.assessmentIds = ["min-a", "min-explain", "max-a", "max-b"]; m.placement!.maxItems = 5; }, () => rubricCourse());
    async function answerWritten(c: Awaited<ReturnType<typeof course>>) {
      expect(await c.take()).toBe("min-a");
      const next = (await c.state()).run.nextItem;
      expect(next).toEqual({ episodeId: "min", assessmentId: "min-explain" });
      const issued = await c.send("challenges", { ...next, mode: "placement" });
      expect(issued.statusCode, issued.body).toBe(200);
      const answered = await c.send("answers", { challengeId: issued.json().challengeId, answer: rubricExplanation });
      expect(answered.json().result).toMatchObject({ pendingReview: true });
      return (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 AND assessment_id='min-explain'", [c.enrollment])).rows[0].id as string;
    }
    async function review(attemptId: string, decision: "met" | "not_met") {
      const reviewer = await session("instructor");
      const criteria = decision === "met"
        ? [{ criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
          { criterionId: "every-element", met: true, quote: "compare every next element with it" }, { criterionId: "edge", met: false, note: "Not discussed." }]
        : [{ criterionId: "invariant", met: false, note: "Missing." }, { criterionId: "every-element", met: false, note: "Missing." }, { criterionId: "edge", met: false, note: "Missing." }];
      const r = await call("POST", `/api/admin/rubric-reviews/${attemptId}`, { decision, criteria, idempotencyKey: "k-" + randomUUID() }, reviewer);
      expect(r.statusCode, r.body).toBe(200);
    }

    it("is undecided rather than wrong: placement pauses, and finishing keeps that topic on the path", async () => {
      const c = await withWritten();
      await c.send("placement/start");
      await answerWritten(c);
      const waiting = (await c.state()).run;
      expect(waiting).toMatchObject({ nextItem: null, stopReason: "pending_evaluation" });
      expect(waiting.proposal.pending).toEqual([{ objectiveId: "minimum", description: "Find a minimum." }]);
      expect(waiting.proposal.exempt).toEqual([]);
      const finished = await c.send("placement/finish");
      expect(finished.json()).toMatchObject({ state: "finished", exemptEpisodeIds: [], startEpisodeId: "min", stopReason: "pending_evaluation", pendingObjectiveIds: ["minimum"] });
      // Nothing undecided is skipped; the learner starts at the undecided topic.
      expect((await c.send("placement/accept", {})).json().error).toBe("PLACEMENT_START_NOT_ALLOWED");
      const accepted = await c.send("placement/accept", { startEpisodeId: "min" });
      expect(accepted.json()).toMatchObject({ placedEpisodeIds: [], nextEpisodeId: "min" });
    });

    it("continues once the answer is reviewed as met, and stops as not demonstrated only when it is judged not met", async () => {
      const met = await withWritten();
      await met.send("placement/start");
      await review(await answerWritten(met), "met");
      const after = (await met.state()).run;
      expect(after.stopReason).toBe("continuing");
      expect(after.proposal.exempt.map((e: { episodeId: string }) => e.episodeId)).toEqual(["min"]);
      expect(after.nextItem).toEqual({ episodeId: "max", assessmentId: "max-a" });

      const notMet = await withWritten();
      await notMet.send("placement/start");
      await review(await answerWritten(notMet), "not_met");
      expect((await notMet.state()).run).toMatchObject({ nextItem: null, stopReason: "not_demonstrated", proposal: { exempt: [], pending: [] } });
    });
  });

  describe("a reviewer's question about a written placement answer for a later episode", () => {
    const later = () => course(() => {}, () => placementWrittenCourse());
    const replyTo = async (enrollment: string, attemptId: string, answer: string, who = learner) => {
      const revision = (await call("GET", "/api/enrollments/" + enrollment, undefined, who)).json().revision ?? 1;
      return call("POST", `/api/enrollments/${enrollment}/reviews/${attemptId}/reply`, { expectedRevision: revision, idempotencyKey: randomUUID(), answer }, who);
    };
    const ask = async (attemptId: string, probeOnly: boolean, reviewer: Session) => {
      const r = await call("POST", `/api/admin/rubric-reviews/${attemptId}`, {
        decision: "needs_clarification", probeOnly, learnerNote: "Why is the kept value the maximum at the end?", idempotencyKey: "k-" + randomUUID(),
        criteria: [{ criterionId: "invariant", met: false }, { criterionId: "every-element", met: true, quote: "compare every next element with it" }],
      }, reviewer);
      expect(r.statusCode, r.body).toBe(200);
    };
    /** Places out of "min", then answers the written question for the still-locked "max". */
    async function writtenForLockedEpisode(c: Awaited<ReturnType<typeof later>>) {
      await c.send("placement/start");
      expect([await c.take(), await c.take()]).toEqual(["min-a", "min-b"]);
      const next = (await c.state()).run.nextItem;
      expect(next).toEqual({ episodeId: "max", assessmentId: "max-explain" });
      const issued = await c.send("challenges", { ...next, mode: "placement" });
      expect(issued.statusCode, issued.body).toBe(200);
      expect((await c.send("answers", { challengeId: issued.json().challengeId, answer: maximumExplanation })).json().result).toMatchObject({ pendingReview: true });
      expect((await call("GET", "/api/enrollments/" + c.enrollment)).json().lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
      return (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 AND assessment_id='max-explain'", [c.enrollment])).rows[0].id as string;
    }
    const reply = "The kept value is never less than any element seen, because each comparison keeps the larger of the two values.";

    it("can be answered although the episode is locked, without using a placement question, and a neutral probe keeps it independent", async () => {
      const c = await later(), reviewer = await session("instructor");
      const opening = await writtenForLockedEpisode(c);
      await ask(opening, true, reviewer);
      const listed = (await call("GET", `/api/enrollments/${c.enrollment}/reviews`)).json().reviews.find((r: { attemptId: string }) => r.attemptId === opening);
      expect(listed).toMatchObject({ episodeId: "max", status: "needs_clarification", canReply: true, placement: true });
      const replied = await replyTo(c.enrollment, opening, reply);
      expect(replied.statusCode, replied.body).toBe(200);
      expect(replied.json()).toMatchObject({ pendingReview: true, independent: true });
      // The reply continues the same question: still three of four used, and the next item can be issued.
      const during = (await c.state()).run;
      expect(during).toMatchObject({ itemsUsed: 3, nextItem: { episodeId: "max", assessmentId: "max-a" } });
      expect(await c.take()).toBe("max-a");
      expect((await c.state()).run).toMatchObject({ itemsUsed: 4 });
      // The reviewer judges the conversation as a whole; the learner's own reply words count.
      const pending = (await db.query("SELECT id FROM attempts WHERE continues_attempt_id=$1", [opening])).rows[0].id as string;
      const judged = await call("POST", `/api/admin/rubric-reviews/${pending}`, {
        decision: "met", idempotencyKey: "k-" + randomUUID(),
        criteria: [{ criterionId: "invariant", met: true, quote: "never less than any element seen" }, { criterionId: "every-element", met: true, quote: "compare every next element with it" }],
      }, reviewer);
      expect(judged.statusCode, judged.body).toBe(200);
      const finished = await c.send("placement/finish");
      expect(finished.json()).toMatchObject({ exemptEpisodeIds: ["min", "max"], pendingObjectiveIds: [] });
      // A second reply to the same request is refused.
      expect((await replyTo(c.enrollment, opening, reply)).json().error).toBe("ALREADY_REPLIED");
    });

    it("can still be answered after the run is accepted while the episode stays locked", async () => {
      const c = await later(), reviewer = await session("instructor");
      const opening = await writtenForLockedEpisode(c);
      await ask(opening, true, reviewer);
      expect((await c.send("placement/finish")).statusCode).toBe(200);
      // Starting from the beginning places nothing, so the questioned episode stays locked.
      expect((await c.send("placement/accept", { startEpisodeId: "min" })).json()).toMatchObject({ state: "accepted", placedEpisodeIds: [] });
      expect((await call("GET", "/api/enrollments/" + c.enrollment)).json().lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
      const listed = (await call("GET", `/api/enrollments/${c.enrollment}/reviews`)).json().reviews.find((r: { attemptId: string }) => r.attemptId === opening);
      expect(listed).toMatchObject({ placement: true, canReply: true });
      const replied = await replyTo(c.enrollment, opening, reply);
      expect(replied.statusCode, replied.body).toBe(200);
      expect(replied.json()).toMatchObject({ pendingReview: true, independent: true });
      expect((await replyTo(c.enrollment, opening, reply)).json().error).toBe("ALREADY_REPLIED");
      // The reply continues the run's question: the finished run neither gains an item nor changes.
      const before = await c.state();
      expect(before).toMatchObject({ state: "accepted", run: { itemsUsed: 3, acceptedStartEpisodeId: "min" } });
      const pending = (await db.query("SELECT id FROM attempts WHERE continues_attempt_id=$1", [opening])).rows[0].id as string;
      const judged = await call("POST", `/api/admin/rubric-reviews/${pending}`, {
        decision: "met", idempotencyKey: "k-" + randomUUID(),
        criteria: [{ criterionId: "invariant", met: true, quote: "never less than any element seen" }, { criterionId: "every-element", met: true, quote: "compare every next element with it" }],
      }, reviewer);
      expect(judged.statusCode, judged.body).toBe(200);
      // A judgement after acceptance places nothing: the accepted start point stands.
      expect(await c.state()).toMatchObject({ state: "accepted", run: { itemsUsed: 3, proposal: before.run.proposal } });
      expect((await call("GET", "/api/enrollments/" + c.enrollment)).json().lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
      expect((await c.send("placement/finish")).json().error).toBe("PLACEMENT_NOT_IN_PROGRESS");
      expect((await c.send("challenges", { episodeId: "max", assessmentId: "max-a", mode: "placement" })).json().error).toBe("PLACEMENT_RUN_REQUIRED");
    });

    it("lets the reviewer ask again after acceptance, and the learner answer that too", async () => {
      const c = await later(), reviewer = await session("instructor");
      const opening = await writtenForLockedEpisode(c);
      await ask(opening, true, reviewer);
      await c.send("placement/finish");
      expect((await c.send("placement/accept", { startEpisodeId: "min" })).statusCode).toBe(200);
      expect((await replyTo(c.enrollment, opening, reply)).statusCode).toBe(200);
      const first = (await db.query("SELECT id FROM attempts WHERE continues_attempt_id=$1", [opening])).rows[0].id as string;
      await ask(first, true, reviewer);
      const again = await replyTo(c.enrollment, first, reply + " So at the end it is at least every element.");
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ pendingReview: true, independent: true });
      expect((await c.state()).run.itemsUsed).toBe(3);
    });

    it("keeps a reply after a non-neutral question assisted, so it cannot place the learner out", async () => {
      const c = await later(), reviewer = await session("instructor");
      const opening = await writtenForLockedEpisode(c);
      await ask(opening, false, reviewer);
      const replied = await replyTo(c.enrollment, opening, reply);
      expect(replied.statusCode, replied.body).toBe(200);
      expect(replied.json().independent).toBe(false);
    });

    it("is refused for another learner and for answers outside the learner's own placement run", async () => {
      const c = await later(), reviewer = await session("instructor");
      const opening = await writtenForLockedEpisode(c);
      await ask(opening, true, reviewer);
      // Another learner can neither reply in this enrollment nor attach the attempt to their own.
      const stranger = await session("learner");
      expect((await replyTo(c.enrollment, opening, reply, stranger)).statusCode).toBeGreaterThanOrEqual(403);
      const strangerCourse = (await db.query("SELECT course_release_id FROM enrollments WHERE id=$1", [c.enrollment])).rows[0].course_release_id;
      const own = (await call("POST", "/api/enrollments", { releaseId: strangerCourse }, stranger)).json().id as string;
      expect((await replyTo(own, opening, reply, stranger)).json().error).toBe("NO_CLARIFICATION_REQUESTED");
      expect((await db.query("SELECT 1 FROM attempts WHERE continues_attempt_id=$1", [opening])).rowCount).toBe(0);

      // A learner without a placement run: a written answer for the locked episode
      // (not one placement could have given them) stays refused, whatever its mode says.
      const plain = await later();
      expect((await plain.send("placement/decline")).statusCode).toBe(200);
      const { digest, server_bundle: bundle } = (await db.query("SELECT r.digest,r.server_bundle FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=$1", [plain.enrollment])).rows[0];
      const item = bundle.assessments.find((a: { id: string }) => a.id === "max-explain");
      for (const mode of ["independent", "placement"]) {
        const attemptId = randomUUID();
        await db.query(`INSERT INTO attempts (id,enrollment_id,assessment_id,course_digest,family_id,mode,assistance,response,result,idempotency_key) VALUES ($1,$2,'max-explain',$3,'explain',$4,'none',$5,$6,$7)`,
          [attemptId, plain.enrollment, digest, mode, JSON.stringify(maximumExplanation), JSON.stringify({ status: "pending_review", passed: false, evaluator: "reviewed-rubric@1", rubricDigest: rubricDigest(item), independentEligible: true }), "forged-" + attemptId]);
        await db.query(`INSERT INTO assessment_challenges (id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,expires_at,attempt_id) VALUES ($1,$2,'max','max-explain',$3,$4,true,now(),$5)`,
          [randomUUID(), plain.enrollment, digest, mode, attemptId]);
        await ask(attemptId, true, reviewer);
        const refused = await replyTo(plain.enrollment, attemptId, reply);
        expect(refused.json().error, mode).toBe("PREREQUISITE_NOT_READY");
      }
    });
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
