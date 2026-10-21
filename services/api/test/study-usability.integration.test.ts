import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { offsetClock } from "../src/clock.js";
import { consentDigest, usabilitySummary } from "../src/study.js";
import { rehearseStudy, scriptedAnswer } from "../src/study-rehearsal.js";
import { studyCourse } from "./study-fixture.js";

// Real HTTP and PostgreSQL 17: opt-in usability timings of a study (P15) and the scripted
// end-to-end rehearsal of a course's study definition (W01).
const origin = "http://localhost:4397",
  schema = "study_ux_" + randomUUID().replaceAll("-", "");
const clock = offsetClock();
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
interface Learner extends Session { enrollment: string }
let workspace: string, owner: Session, course: string, release: string;

const ARMS = [
  { id: "fixed", label: "Fixed path", behaviour: "fixed" },
  { id: "chat", label: "Chat-only companion", behaviour: "chat_only" },
  { id: "full", label: "Full supervisor", behaviour: "supervisor" },
];
const definition = (overrides: Record<string, unknown> = {}) => ({
  title: "Ordering study", purpose: "We compare three versions of this course to learn which helps people learn ordering best.",
  arms: ARMS, instruments: { pre: ["pre-min"], post: ["post-min"], transfer: ["xfer-min"], delayed: ["min-later-1"] }, minCellSize: 3, ...overrides,
});
async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `ux:${id.slice(0, 8)}@example.com`, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const ok = async (p: ReturnType<typeof call>) => {
  const r = await p;
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
async function learnerOf(): Promise<Learner> {
  const who = await person("learner");
  return { ...who, enrollment: (await ok(call(who, "POST", "/api/enrollments", { releaseId: release }))).id };
}
const revision = async (l: Learner) => (await ok(call(l, "GET", "/api/enrollments/" + l.enrollment))).revision as number;
const send = async (l: Learner, action: string, body: Record<string, unknown>) =>
  call(l, "POST", `/api/enrollments/${l.enrollment}/${action}`, { expectedRevision: await revision(l), idempotencyKey: "k-" + randomUUID(), ...body });
async function join(l: Learner) {
  const view = (await ok(call(l, "GET", `/api/enrollments/${l.enrollment}/study`))).study;
  return ok(send(l, "study/consent", { studyId: view.id, consentDigest: view.consentDigest }));
}
async function createStudy(overrides: Record<string, unknown> = {}, open = true) {
  const created = await ok(call(owner, "POST", `/api/admin/courses/${course}/studies`, { releaseId: release, ...definition(overrides) }));
  if (!open) return created.study;
  return (await ok(call(owner, "POST", `/api/admin/studies/${created.study.id}/open`, { expectedRevision: created.study.revision }))).study;
}
const trial = (overrides: Record<string, unknown> = {}) => ({
  kind: "next_action", place: "course_page", deviceClass: "phone", outcome: "reached", elapsedMs: 4200, wrongTurns: 0, contextKept: null, ...overrides,
});
const post = (l: Learner, trials: unknown[], batchId: string = randomUUID()) =>
  call(l, "POST", `/api/enrollments/${l.enrollment}/study/usability`, { batchId, trials });

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, clock });
}, 30000);
beforeEach(async () => {
  clock.set(0);
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ux-" + workspace, "Usability"]);
  owner = await person("owner");
  release = (await ok(call(owner, "POST", `/api/workspaces/${workspace}/releases`, studyCourse()))).id;
  await ok(call(owner, "POST", `/api/releases/${release}/publish`));
  course = (await ok(call(owner, "GET", "/api/admin/session"))).courses[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("usability measures (P15)", () => {
  it("are off unless the study asks; asking changes the consent text and is frozen once recruiting", async () => {
    const draft = await createStudy({ usabilityMeasures: true }, false);
    expect(draft).toMatchObject({ usabilityMeasures: true, usabilityTrials: 0 });
    const row = (await db.query("SELECT * FROM studies WHERE id=$1", [draft.id])).rows[0];
    // The learner agrees to a different text when timings are asked for.
    expect(consentDigest({ ...row, usability_measures: false })).not.toBe(consentDigest(row));
    const opened = (await ok(call(owner, "POST", `/api/admin/studies/${draft.id}/open`, { expectedRevision: draft.revision }))).study;
    const { releaseId: _r, ...body } = { releaseId: release, ...definition({ usabilityMeasures: false }) };
    expect((await call(owner, "PUT", `/api/admin/studies/${draft.id}`, { ...body, expectedRevision: opened.revision })).json().error).toBe("STUDY_DEFINITION_LOCKED");
    await expect(db.query("UPDATE studies SET usability_measures=false WHERE id=$1", [draft.id])).rejects.toThrow(/STUDY_DEFINITION_IMMUTABLE/);
    const learner = await learnerOf();
    const view = (await ok(call(learner, "GET", `/api/enrollments/${learner.enrollment}/study`))).study;
    expect(view.usabilityMeasures).toBe(true);
    // A study created without the field has none.
    await ok(call(owner, "POST", `/api/admin/studies/${draft.id}/close`, { expectedRevision: opened.revision }));
    expect(await createStudy()).toMatchObject({ usabilityMeasures: false, usabilityTrials: null });
  });

  it("are stored only for a consented participant of a study that asked, once per batch, within limits", async () => {
    const plain = await createStudy();
    const learner = await learnerOf();
    // Not a participant, then a participant of a study without measures: refused, nothing stored.
    expect((await post(learner, [trial()])).json().error).toBe("STUDY_USABILITY_OFF");
    await join(learner);
    expect((await post(learner, [trial()])).json().error).toBe("STUDY_USABILITY_OFF");
    expect((await ok(call(learner, "GET", `/api/enrollments/${learner.enrollment}`))).studyArm).toMatchObject({ measuresUsability: false });
    await ok(call(owner, "POST", `/api/admin/studies/${plain.id}/close`, { expectedRevision: plain.revision }));

    const study = await createStudy({ usabilityMeasures: true });
    const other = await learnerOf();
    await join(other);
    expect((await ok(call(other, "GET", `/api/enrollments/${other.enrollment}`))).studyArm).toMatchObject({ measuresUsability: true });
    const batch = randomUUID();
    expect(await ok(post(other, [trial(), trial({ kind: "detour_return", place: "lesson", contextKept: true, elapsedMs: 9000 })], batch))).toEqual({ accepted: 2, dropped: 0 });
    // A retried batch is not counted twice.
    expect(await ok(post(other, [trial(), trial({ kind: "detour_return", place: "lesson", contextKept: true, elapsedMs: 9000 })], batch))).toEqual({ accepted: 0, dropped: 0 });
    // Shapes are checked: unknown fields, free text, out-of-range numbers, a detour without its context flag.
    for (const bad of [trial({ note: "free text" }), trial({ place: "anywhere" }), trial({ elapsedMs: -1 }), trial({ wrongTurns: 1000 }),
      trial({ kind: "detour_return", contextKept: null }), trial({ contextKept: true })])
      expect((await post(other, [bad])).statusCode).toBe(400);
    expect((await post(other, Array.from({ length: 51 }, () => trial()))).statusCode).toBe(400);
    // Only the learner's own enrollment: staff and other learners cannot send for them.
    expect((await call(owner, "POST", `/api/enrollments/${other.enrollment}/study/usability`, { batchId: randomUUID(), trials: [trial()] })).statusCode).toBe(404);
    expect((await call(learner, "POST", `/api/enrollments/${other.enrollment}/study/usability`, { batchId: randomUUID(), trials: [trial()] })).statusCode).toBe(404);
    // The per-participant limit holds.
    await db.query(`INSERT INTO study_usability_trials(id,study_id,enrollment_id,workspace_id,batch_id,position,kind,place,device_class,outcome,elapsed_ms,wrong_turns)
      SELECT gen_random_uuid(),$1,$2,$3,gen_random_uuid(),0,'next_action','lesson','desktop','reached',1000,0 FROM generate_series(1,1997)`, [study.id, other.enrollment, workspace]);
    expect(await ok(post(other, [trial(), trial(), trial()]))).toEqual({ accepted: 1, dropped: 2 });
    // Trials are never edited.
    await expect(db.query("UPDATE study_usability_trials SET wrong_turns=0 WHERE enrollment_id=$1", [other.enrollment])).rejects.toThrow(/STUDY_USABILITY_TRIAL_IMMUTABLE/);
    // Leaving the study stops recording at once.
    await ok(send(other, "study/withdraw", { studyId: study.id }));
    expect((await post(other, [trial()])).json().error).toBe("STUDY_USABILITY_OFF");
  });

  it("are summarised per participant in the export, and erased with the enrollment", async () => {
    const study = await createStudy({ usabilityMeasures: true });
    const learners: Learner[] = [];
    for (let i = 0; i < 9; i++) learners.push(await learnerOf());
    for (const l of learners) await join(l);
    const first = learners[0]!;
    await ok(post(first, [
      trial({ elapsedMs: 3000 }), trial({ elapsedMs: 5000, wrongTurns: 2, place: "lesson", deviceClass: "desktop" }), trial({ outcome: "abandoned", elapsedMs: 60_000, wrongTurns: 1 }),
      trial({ kind: "detour_return", place: "lesson", contextKept: true }), trial({ kind: "detour_return", place: "lesson", contextKept: false }),
      trial({ kind: "detour_return", place: "after_detour", outcome: "abandoned", contextKept: false }),
    ]));
    const code = (await ok(call(first, "GET", `/api/enrollments/${first.enrollment}/study`))).participation.participantCode;
    const document = JSON.parse((await call(owner, "GET", `/api/admin/studies/${study.id}/export?format=json`)).body);
    expect(document.study.usabilityMeasures).toBe(true);
    expect(document.fields).toHaveProperty("ux_next_first_try");
    expect(document.participants.find((p: { participant: string }) => p.participant === code).usability).toEqual({
      nextTrials: 3, nextReached: 2, nextFirstTry: 1, nextMedianSeconds: 4, wrongTurns: 3, detours: 3, detoursReturned: 2, contextKept: 1, devices: "desktop+phone",
    });
    const csv = (await call(owner, "GET", `/api/admin/studies/${study.id}/export?format=csv`)).body.trim().split("\r\n");
    expect(csv[0]).toMatch(/,course_completed,ux_next_trials,ux_next_reached,ux_next_first_try,ux_next_median_s,ux_wrong_turns,ux_detours,ux_detours_returned,ux_context_kept,ux_devices$/);
    expect(csv.find((line) => line.startsWith(code))).toMatch(/,3,2,1,4,3,3,2,1,desktop\+phone$/);
    // Staff see only how many trials arrived.
    const summary = await ok(call(owner, "GET", `/api/admin/courses/${course}/studies`));
    expect(summary.studies[0]).toMatchObject({ usabilityMeasures: true, usabilityTrials: 6 });
    // The learner's own data export lists them; erasure removes them.
    const own = await ok(call(first, "GET", `/api/enrollments/${first.enrollment}/export`));
    expect(own.studyUsabilityTrials).toHaveLength(6);
    const erased = await call(first, "POST", `/api/enrollments/${first.enrollment}/erase`, { confirmation: `ERASE ${first.enrollment.slice(0, 8)}`, reason: "Remove my course data please." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts).toMatchObject({ studyUsabilityTrials: 6 });
    expect((await db.query("SELECT count(*)::int AS n FROM study_usability_trials WHERE enrollment_id=$1", [first.enrollment])).rows[0].n).toBe(0);
  });

  it("summarises nothing for a participant without trials", () => {
    expect(usabilitySummary([])).toEqual({ nextTrials: 0, nextReached: 0, nextFirstTry: 0, nextMedianSeconds: null, wrongTurns: 0, detours: 0, detoursReturned: 0, contextKept: 0, devices: null });
  });
});

describe("study rehearsal with scripted participants (W01)", () => {
  it("scripted answers grade as intended, and items Core does not grade itself are skipped", () => {
    const items = studyCourse().assessments;
    for (const item of items.filter((a) => ["numeric", "choice"].includes(a.type))) {
      expect(scriptedAnswer(item, true), item.id).not.toBeNull();
      expect(scriptedAnswer(item, false), item.id).not.toBeNull();
    }
    expect(scriptedAnswer({ id: "w", type: "rubric", objectiveIds: [], prompt: "p", familyId: "f", grading: { evaluatorId: "e", rubric: [] } }, true)).toBeNull();
  });

  it("runs a course's study definition end to end and every analyst check passes", async () => {
    let csv = "";
    const report = await rehearseStudy({ app, db, clock, origin, course: studyCourse(), participants: 13, seed: "fixed-seed", onExport: (body) => { csv = body; },
      study: { definition: definition({ usabilityMeasures: true }) } });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.participants).toEqual({ scripted: 13, withdrew: 1 });
    expect(report.study.arms.map((a) => a.consented).sort()).toEqual([4, 4, 5]);
    for (const set of ["pre", "post", "transfer", "delayed"] as const) {
      expect(report.answered[set].skipped, set).toEqual([]);
      expect(report.answered[set].reached, set).toBe(13);
    }
    expect(report.export).toMatchObject({ rows: 12, suppressedArms: [], included: 12 });
    expect(csv.split("\r\n")[0]).toContain("ux_context_kept");
    // Repeating with the same seed scripts the same outcomes.
    const again = await rehearseStudy({ app, db, clock, origin, course: studyCourse(), participants: 13, seed: "fixed-seed", study: { definition: definition() } });
    expect(again.ok).toBe(true);
  }, 120_000);

  it("reports a refused definition instead of running", async () => {
    await expect(rehearseStudy({ app, db, clock, origin, course: studyCourse(), participants: 3,
      study: { definition: definition({ instruments: { pre: ["no-such-item"], post: [], transfer: [], delayed: [] } }) } }))
      .rejects.toMatchObject({ checks: [{ name: "definition accepted", ok: false }] });
  });
});
