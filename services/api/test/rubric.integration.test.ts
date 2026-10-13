import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { rubricCourse as baseRubricCourse, rubricExplanation } from "./rubric-fixture.js";
const rubricCourse = () => baseRubricCourse(`2.0.${versions++}`);

const origin = "http://localhost:4387",
  schema = "rubric_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>, bare: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, instructor: Session, release: string, enrollment: string, catalog: string, versions = 0;
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
const explanation = rubricExplanation;
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "rubric:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown, server = app) =>
  server.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(who: Session, id: string, action: string, body: Record<string, unknown>) {
  const revision = (await call(who, "GET", "/api/enrollments/" + id)).json().revision;
  return call(who, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
async function submit(who: Session, id: string, text: string) {
  const issued = await send(who, id, "challenges", { episodeId: "min", assessmentId: "min-explain", mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  return send(who, id, "answers", { challengeId: issued.json().challengeId, answer: text });
}
const findings = (over: Record<string, unknown> = {}) => [
  { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
  { criterionId: "every-element", met: true, quote: "compare every next element with it" },
  { criterionId: "edge", met: false, note: "Empty list not discussed." },
].map((f) => (over[f.criterionId] ? { ...f, ...(over[f.criterionId] as object) } : f));
const review = (who: Session, attemptId: string, body: Record<string, unknown>) =>
  call(who, "POST", `/api/admin/rubric-reviews/${attemptId}`, { decision: "met", criteria: findings(), idempotencyKey: "k-" + randomUUID(), ...body });
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
  app = await createServer(db, { origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
  bare = await createServer(db, { origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "rubric-" + workspace, "Rubric"]);
  owner = await session("owner");
  learner = await session("learner");
  instructor = await session("instructor");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
});
afterAll(async () => {
  await app?.close();
  await bare?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  }
});

describe("reviewed rubric assessments", () => {
  it("cannot publish without the installed evaluator, and holds written answers as pending", async () => {
    const draft = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse(), bare)).json().id;
    expect((await call(owner, "POST", `/api/releases/${draft}/publish`, undefined, bare)).json().error).toMatch(/PUBLISH_(CAPABILITY_MISSING|EVALUATOR_RUNTIME_UNAVAILABLE)/);
    const issued = await send(learner, enrollment, "challenges", { episodeId: "min", assessmentId: "min-explain", mode: "independent" });
    expect((await send(learner, enrollment, "answers", { challengeId: issued.json().challengeId, answer: "too short" })).json().error).toBe("INVALID_ANSWER");
    // An invalid answer leaves the same item open; retrying it stays independent.
    const answered = await send(learner, enrollment, "answers", { challengeId: issued.json().challengeId, answer: explanation });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json().result).toMatchObject({ passed: false, pendingReview: true });
    expect((await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBe(0);
    const mine = (await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "pending_review", episodeId: "min" });
    expect(mine[0].criteria.map((c: { met: unknown }) => c.met)).toEqual([null, null, null]);
    expect((await call(learner, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).statusCode).toBe(403);
    const queue = (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ response: explanation, independentEligible: true, ownSubmission: false });
  });

  it("issues evidence only for a consistent review that quotes the learner, then the gate can pass", async () => {
    await submit(learner, enrollment, explanation);
    const attempt = (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending[0].attemptId;
    expect((await review(learner, attempt, {})).statusCode).toBe(403);
    expect((await review(instructor, attempt, { criteria: findings().slice(0, 2) })).json().error).toBe("RUBRIC_CRITERIA_INCOMPLETE");
    expect((await review(instructor, attempt, { criteria: findings({ invariant: { quote: undefined } }) })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    expect((await review(instructor, attempt, { criteria: findings({ invariant: { quote: "the minimum is always the first value" } }) })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    expect((await review(instructor, attempt, { decision: "not_met" })).json().error).toBe("RUBRIC_DECISION_INCONSISTENT");
    expect((await review(instructor, attempt, { decision: "met", criteria: findings({ "every-element": { met: false, quote: undefined } }) })).json().error).toBe("RUBRIC_DECISION_INCONSISTENT");
    const body = { decision: "met", criteria: findings(), idempotencyKey: "k-" + randomUUID() };
    const ok = await call(instructor, "POST", `/api/admin/rubric-reviews/${attempt}`, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await call(instructor, "POST", `/api/admin/rubric-reviews/${attempt}`, body)).json()).toMatchObject({ replayed: true });
    expect((await review(owner, attempt, { decision: "not_met", criteria: findings({ invariant: { met: false, quote: undefined } }) })).json().error).toBe("ALREADY_REVIEWED");
    const reviewed = (await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews[0];
    expect(reviewed).toMatchObject({ status: "met" });
    expect(reviewed.criteria.map((c: { met: boolean }) => c.met)).toEqual([true, true, false]);
    // One family (explain) is now independent evidence; the gate still needs the second family.
    let state = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
    expect(state.lessons[0].gate.passed).toBe(false);
    const choice = await send(learner, enrollment, "challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
    await send(learner, enrollment, "answers", { challengeId: choice.json().challengeId, answer: "two" });
    state = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
    expect(state.lessons[0].gate.passed).toBe(true);
    // The learner's export carries the review; erasure removes the quoted words.
    const exported = (await call(learner, "GET", `/api/enrollments/${enrollment}/export`)).json();
    expect(exported.writtenAnswerReviews).toEqual([expect.objectContaining({ attempt_id: attempt, decision: "met", findings: findings() })]);
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Testing written-answer review erasure." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts.writtenAnswerReviews).toBe(1);
    const stored = (await db.query("SELECT criteria,learner_note,decision FROM rubric_reviews WHERE attempt_id=$1", [attempt])).rows[0];
    expect(stored).toMatchObject({ criteria: { findings: [] }, learner_note: null, decision: "met" });
    expect(JSON.stringify(stored)).not.toContain("never greater");
  });

  it("records clarification without judgement, failures as evidence, and refuses self-review", async () => {
    await submit(learner, enrollment, explanation);
    const attempt = (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending[0].attemptId;
    expect((await review(instructor, attempt, { decision: "needs_clarification" })).json().error).toBe("CLARIFICATION_NOTE_REQUIRED");
    expect((await review(instructor, attempt, { decision: "needs_clarification", criteria: findings({ invariant: { met: false, quote: undefined } }), learnerNote: "Say what stays true after each comparison." })).statusCode).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBe(0);
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews[0]).toMatchObject({ status: "needs_clarification", learnerNote: "Say what stays true after each comparison." });

    // A staff member who is also a learner cannot review their own answer.
    const own = (await call(instructor, "POST", "/api/enrollments", { releaseId: release })).json().id;
    await submit(instructor, own, explanation);
    const pending = (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending;
    const mine = pending.find((p: { ownSubmission: boolean }) => p.ownSubmission);
    expect((await review(instructor, mine.attemptId, {})).json().error).toBe("SELF_REVIEW_FORBIDDEN");
    const failed = await review(owner, mine.attemptId, { decision: "not_met", criteria: findings({ invariant: { met: false, quote: undefined }, "every-element": { met: false, quote: undefined } }) });
    expect(failed.statusCode, failed.body).toBe(200);
    const evidence = (await db.query("SELECT result,independent FROM evidence WHERE enrollment_id=$1", [own])).rows;
    expect(evidence).toEqual([{ result: { passed: false, reviewed: true }, independent: true }]);
  });

  it("continues as a conversation: a neutral probe keeps the reply independent and the reviewer judges the whole exchange", async () => {
    const first = "I keep the smallest value seen so far and compare every next element with it.";
    await submit(learner, enrollment, first);
    const opening = (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending.find((p: { enrollmentId: string }) => p.enrollmentId === enrollment);
    expect((await review(instructor, opening.attemptId, { decision: "met", probeOnly: true })).json().error).toBe("PROBE_ONLY_FOR_CLARIFICATION");
    const asked = await review(instructor, opening.attemptId, { decision: "needs_clarification", probeOnly: true, learnerNote: "Why does the kept value end up being the minimum?",
      criteria: findings({ invariant: { met: false, quote: undefined }, "every-element": { met: true, quote: "compare every next element with it" } }) });
    expect(asked.statusCode, asked.body).toBe(200);
    let mine = (await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews;
    expect(mine[0]).toMatchObject({ status: "needs_clarification", canReply: true, learnerNote: "Why does the kept value end up being the minimum?" });
    const reply = (text: string) => send(learner, enrollment, `reviews/${opening.attemptId}/reply`, { answer: text });
    expect((await reply("short")).json().error).toBe("INVALID_ANSWER");
    const second = "Each comparison keeps the smaller one, so the kept value is never greater than any element seen.";
    const replied = await reply(second);
    expect(replied.statusCode, replied.body).toBe(200);
    expect(replied.json()).toMatchObject({ pendingReview: true, independent: true });
    expect((await reply(second + " Again.")).json().error).toBe("ALREADY_REPLIED");
    mine = (await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews;
    expect(mine.find((r: { attemptId: string }) => r.attemptId === opening.attemptId).canReply).toBe(false);
    // The reviewer sees the earlier turn and may cite either turn of the learner's own words.
    const turn = (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending.find((p: { enrollmentId: string }) => p.enrollmentId === enrollment);
    expect(turn.thread).toEqual([expect.objectContaining({ attemptId: opening.attemptId, response: first, reviewerNote: "Why does the kept value end up being the minimum?", probeOnly: true })]);
    expect(turn.independentEligible).toBe(true);
    const judged = await review(instructor, turn.attemptId, { decision: "met", criteria: findings({ invariant: { quote: "the kept value is never greater than any element" } }) });
    expect(judged.statusCode, judged.body).toBe(200);
    const evidence = (await db.query("SELECT attempt_id,independent,result FROM evidence WHERE enrollment_id=$1", [enrollment])).rows;
    expect(evidence).toEqual([{ attempt_id: turn.attemptId, independent: true, result: { passed: true, reviewed: true } }]);
  });

  it("a hinting clarification or companion help before the reply makes the reply practice, not independent", async () => {
    await submit(learner, enrollment, explanation);
    const opening = (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending.find((p: { enrollmentId: string }) => p.enrollmentId === enrollment);
    await review(instructor, opening.attemptId, { decision: "needs_clarification", learnerNote: "Hint: mention that the kept value never exceeds any element.",
      criteria: findings({ invariant: { met: false, quote: undefined } }) });
    const replied = await send(learner, enrollment, `reviews/${opening.attemptId}/reply`, { answer: "The kept value never exceeds any element, so it is the minimum." });
    expect(replied.json()).toMatchObject({ independent: false });
    const other = await session("instructor");
    expect((await call(other, "POST", `/api/enrollments/${enrollment}/reviews/${opening.attemptId}/reply`, { expectedRevision: 1, idempotencyKey: randomUUID(), answer: "x".repeat(30) })).statusCode).toBe(404);
  });
});
