import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { offsetClock } from "../src/clock.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { allocateArm, pseudonym } from "../src/study.js";
import { studyCourse } from "./study-fixture.js";

// Real HTTP and PostgreSQL 17: educational evaluation studies, consent, arms and the research export.
const origin = "http://localhost:4396",
  schema = "study_" + randomUUID().replaceAll("-", "");
const DAY = 86_400_000;
const clock = offsetClock();
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string; name: string }
let workspace: string, owner: Session, admin: Session, instructor: Session, reviewer: Session, observer: Session, course: string, release: string;

const ARMS = [
  { id: "fixed", label: "Fixed path", behaviour: "fixed" },
  { id: "chat", label: "Chat-only companion", behaviour: "chat_only" },
  { id: "full", label: "Full supervisor", behaviour: "supervisor" },
];
const definition = (overrides: Record<string, unknown> = {}) => ({
  releaseId: release, title: "Ordering study", purpose: "We compare three versions of this course to learn which helps people learn ordering best.",
  arms: ARMS, instruments: { pre: ["pre-min"], post: ["post-min"], transfer: ["xfer-min"], delayed: ["min-later-1"] }, minCellSize: 3, ...overrides,
});

async function person(role: string, name = role + " person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, `study:${id.slice(0, 8)}@example.com`, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, name, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const ok = async (p: ReturnType<typeof call>) => {
  const r = await p;
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
interface Learner extends Session { enrollment: string }
async function learnerOf(name = "Learner " + randomUUID().slice(0, 6)): Promise<Learner> {
  const who = await person("learner", name);
  const enrollment = (await ok(call(who, "POST", "/api/enrollments", { releaseId: release }))).id as string;
  return { ...who, enrollment };
}
const revision = async (l: Learner) => (await ok(call(l, "GET", "/api/enrollments/" + l.enrollment))).revision as number;
const send = async (l: Learner, action: string, body: Record<string, unknown>) =>
  call(l, "POST", `/api/enrollments/${l.enrollment}/${action}`, { expectedRevision: await revision(l), idempotencyKey: "k-" + randomUUID(), ...body });
const studyView = (l: Learner) => ok(call(l, "GET", `/api/enrollments/${l.enrollment}/study`));
async function join(l: Learner) {
  const view = await studyView(l);
  return ok(send(l, "study/consent", { studyId: view.study.id, consentDigest: view.study.consentDigest }));
}
const withdraw = async (l: Learner, studyId: string) => ok(send(l, "study/withdraw", { studyId }));
async function answer(l: Learner, assessmentId: string, value: unknown) {
  const issued = await send(l, "challenges", { episodeId: "min", assessmentId, mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  const answered = await send(l, "answers", { challengeId: issued.json().challengeId, answer: value });
  expect(answered.statusCode, answered.body).toBe(200);
}
async function createStudy(overrides: Record<string, unknown> = {}, open = true) {
  const created = await ok(call(owner, "POST", `/api/admin/courses/${course}/studies`, definition(overrides)));
  if (!open) return created.study;
  return (await ok(call(owner, "POST", `/api/admin/studies/${created.study.id}/open`, { expectedRevision: created.study.revision }))).study;
}
const summary = async (who = owner) => (await ok(call(who, "GET", `/api/admin/courses/${course}/studies`)));
async function exportOf(studyId: string, format: "json" | "csv", who = owner) {
  const r = await call(who, "GET", `/api/admin/studies/${studyId}/export?format=${format}`);
  expect(r.statusCode, r.body).toBe(200);
  return r;
}
/** Prepares one supervised event through the real bridge and returns its stored disposition. */
async function prepared(l: Learner, type: string, payload: Record<string, unknown> = {}) {
  const options = { serviceToken: "synthetic-test-service-token-not-a-credential", workspaceIds: [workspace],
    jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } };
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: l.enrollment }, { microUsd: 10_000, tokens: 10_000 });
  const bridge = createPostgresSupervisorBridge(db, options);
  const id = await transaction(db, async (client) => (await appendEvent(client, { workspaceId: workspace, enrollmentId: l.enrollment, actorId: l.userId,
    actorKind: "learner", type, payload, idempotencyKey: randomUUID(), supervise: true })).id);
  return dispositionOf(bridge, id);
}
async function dispositionOf(bridge: ReturnType<typeof createPostgresSupervisorBridge>, eventId: string) {
  const lease = (await bridge.claimOutbox(randomUUID(), 100, 30_000)).find((row) => row.eventId === eventId)!;
  expect(lease, "event leased").toBeTruthy();
  const refs = await bridge.prepareOutbox(lease);
  await bridge.ackOutbox(lease);
  const row = (await db.query("SELECT disposition FROM supervisor_preparations WHERE event_id=$1", [eventId])).rows[0];
  return { disposition: row.disposition as string, jobs: refs.length };
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, clock });
}, 30000);
beforeEach(async () => {
  clock.set(0);
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "study-" + workspace, "Study"]);
  owner = await person("owner");
  admin = await person("admin");
  instructor = await person("instructor");
  reviewer = await person("reviewer");
  observer = await person("observer");
  release = (await ok(call(owner, "POST", `/api/workspaces/${workspace}/releases`, studyCourse()))).id;
  await ok(call(owner, "POST", `/api/releases/${release}/publish`));
  course = (await ok(call(owner, "GET", "/api/admin/session"))).courses[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("allocation", () => {
  it("is deterministic per seed and index, and balanced within every block", () => {
    const seed = Buffer.alloc(32, 7), other = Buffer.alloc(32, 8), arms = ["a", "b", "c"];
    const sequence = Array.from({ length: 600 }, (_, i) => allocateArm(seed, i, arms));
    expect(Array.from({ length: 600 }, (_, i) => allocateArm(seed, i, arms))).toEqual(sequence);
    for (let n = 1; n <= 600; n++) {
      const counts = arms.map((a) => sequence.slice(0, n).filter((x) => x === a).length);
      // Never more than one apart among assignments made, at any point.
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
    // Blocks are permuted, not a fixed rotation, and another seed gives another sequence.
    expect(new Set(Array.from({ length: 200 }, (_, b) => sequence.slice(b * 3, b * 3 + 3).join(""))).size).toBeGreaterThan(1);
    expect(Array.from({ length: 600 }, (_, i) => allocateArm(other, i, arms))).not.toEqual(sequence);
    expect(pseudonym(seed, "e1")).toMatch(/^P[0-9A-F]{10}$/);
    expect(pseudonym(seed, "e1")).not.toBe(pseudonym(other, "e1"));
  });
});

describe("study administration", () => {
  it("role matrix: owners and admins manage and export; instructors and reviewers read aggregates; others nothing", async () => {
    for (const who of [instructor, reviewer, observer]) expect((await call(who, "POST", `/api/admin/courses/${course}/studies`, definition())).statusCode).toBe(403);
    const draft = (await ok(call(admin, "POST", `/api/admin/courses/${course}/studies`, definition()))).study;
    for (const who of [instructor, reviewer]) {
      const view = await summary(who);
      expect(view).toMatchObject({ canManage: false, canExport: false });
      expect(view.studies[0]).toMatchObject({ id: draft.id, state: "draft" });
    }
    expect((await call(observer, "GET", `/api/admin/courses/${course}/studies`)).statusCode).toBe(403);
    const learner = await learnerOf();
    expect((await call(learner, "GET", `/api/admin/courses/${course}/studies`)).statusCode).toBe(403);
    for (const who of [instructor, reviewer, observer, learner]) {
      expect((await call(who, "POST", `/api/admin/studies/${draft.id}/open`, { expectedRevision: draft.revision })).statusCode).toBe(403);
      expect((await call(who, "GET", `/api/admin/studies/${draft.id}/allocation-check`)).statusCode).toBe(403);
    }
    const opened = (await ok(call(admin, "POST", `/api/admin/studies/${draft.id}/open`, { expectedRevision: draft.revision }))).study;
    for (const who of [instructor, reviewer, observer, learner]) expect((await call(who, "GET", `/api/admin/studies/${draft.id}/export?format=csv`)).statusCode).toBe(403);
    expect((await summary(owner))).toMatchObject({ canManage: true, canExport: true });
    await exportOf(opened.id, "json", admin);
    // Only staff/system study events show a payload in the audit log.
    const audit = await ok(call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=study.exported`));
    expect(audit.events[0]).toMatchObject({ type: "study.exported", actorKind: "staff", payload: expect.objectContaining({ studyId: draft.id, format: "json" }) });
  });

  it("validates instrument sets against the release and freezes the definition once recruiting", async () => {
    const invalid = async (instruments: Record<string, string[]>, problem: string) => {
      const r = await call(owner, "POST", `/api/admin/courses/${course}/studies`, definition({ instruments: { pre: [], post: [], transfer: [], delayed: [], ...instruments } }));
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().details.problems).toContain(problem);
    };
    await invalid({ pre: ["no-such-item"] }, "STUDY_ITEM_UNKNOWN");
    await invalid({ pre: ["pre-min"], post: ["pre-min"] }, "STUDY_ITEM_IN_TWO_SETS");
    await invalid({ delayed: ["post-min"] }, "STUDY_DELAYED_NOT_RETENTION");
    await invalid({ transfer: ["recog-min"] }, "STUDY_TRANSFER_ROLE");
    expect((await call(owner, "POST", `/api/admin/courses/${course}/studies`, definition({ arms: [ARMS[0], ARMS[0]] }))).json().details.problems).toContain("STUDY_ARM_DUPLICATE");
    expect((await call(owner, "POST", `/api/admin/courses/${course}/studies`, definition({ minCellSize: 1 }))).statusCode).toBe(400);
    // A draft may lack sets, but cannot open without a pre-test and a post-test.
    const draft = (await ok(call(owner, "POST", `/api/admin/courses/${course}/studies`, definition({ instruments: { pre: [], post: [], transfer: ["min-a"], delayed: [] } })))).study;
    expect((await summary()).studies[0].warnings).toContainEqual({ code: "TRANSFER_ROLE_UNDECLARED", params: { item: "min-a" } });
    const refused = await call(owner, "POST", `/api/admin/studies/${draft.id}/open`, { expectedRevision: draft.revision });
    expect(refused.json().details.problems).toEqual(expect.arrayContaining(["STUDY_PRE_REQUIRED", "STUDY_POST_REQUIRED"]));
    expect((await call(owner, "POST", `/api/admin/courses/${course}/studies`, definition())).json().error).toBe("STUDY_ALREADY_OPEN");
    const { releaseId: _r, ...body } = definition();
    const edited = (await ok(call(owner, "PUT", `/api/admin/studies/${draft.id}`, { ...body, expectedRevision: draft.revision }))).study;
    expect((await call(owner, "PUT", `/api/admin/studies/${draft.id}`, { ...body, expectedRevision: draft.revision })).json().error).toBe("STALE_REVISION");
    const opened = (await ok(call(owner, "POST", `/api/admin/studies/${draft.id}/open`, { expectedRevision: edited.revision }))).study;
    expect(opened).toMatchObject({ state: "recruiting", instruments: definition().instruments, seedDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await call(owner, "PUT", `/api/admin/studies/${draft.id}`, { ...body, expectedRevision: opened.revision })).json().error).toBe("STUDY_DEFINITION_LOCKED");
    // The database refuses it too, and never lets the secrets change.
    await expect(db.query("UPDATE studies SET arms='[]'::jsonb WHERE id=$1", [draft.id])).rejects.toThrow(/STUDY_DEFINITION_IMMUTABLE/);
    await expect(db.query("UPDATE studies SET pseudonym_salt=$2 WHERE id=$1", [draft.id, Buffer.alloc(32)])).rejects.toThrow(/STUDY_DEFINITION_IMMUTABLE/);
    await expect(db.query("DELETE FROM studies WHERE id=$1", [draft.id])).rejects.toThrow(/STUDY_RETAINED/);
    // The definition is never shown to a learner while it is a draft, and a closed study cannot reopen.
    const closed = (await ok(call(owner, "POST", `/api/admin/studies/${draft.id}/close`, { expectedRevision: opened.revision }))).study;
    expect((await call(owner, "POST", `/api/admin/studies/${draft.id}/open`, { expectedRevision: closed.revision })).json().error).toBe("STUDY_NOT_DRAFT");
  });
});

describe("consent and arms", () => {
  it("consent is explicit, separate from enrollment and learner-only", async () => {
    const learner = await learnerOf();
    expect(await studyView(learner)).toMatchObject({ study: null, participation: null });
    const draft = await createStudy({}, false);
    // A draft is invisible and cannot be joined.
    expect((await studyView(learner)).study).toBeNull();
    expect((await send(learner, "study/consent", { studyId: draft.id, consentDigest: "a".repeat(64) })).json().error).toBe("STUDY_NOT_RECRUITING");
    await ok(call(owner, "POST", `/api/admin/studies/${draft.id}/open`, { expectedRevision: draft.revision }));
    const view = await studyView(learner);
    expect(view).toMatchObject({ study: { id: draft.id, state: "recruiting", versions: expect.arrayContaining(["fixed"]) }, participation: null });
    // Codes the learner app words in the learner's language; never English prose from the server.
    expect(view.study.collected).toEqual(["study_code", "course_version", "check_scores", "lessons_completed"]);
    expect(view.study.neverCollected).toEqual(["profile", "written_content", "companion_conversations"]);
    // Enrolling did not enrol the learner in the study: nothing is assigned until they agree.
    expect((await db.query("SELECT count(*)::int AS n FROM study_participants WHERE enrollment_id=$1", [learner.enrollment])).rows[0].n).toBe(0);
    expect((await send(learner, "study/consent", { studyId: draft.id, consentDigest: "b".repeat(64) })).json().error).toBe("STUDY_CONSENT_TEXT_CHANGED");
    // Staff cannot consent for the learner, nor read the learner's consent view.
    const staffConsent = await call(owner, "POST", `/api/enrollments/${learner.enrollment}/study/consent`,
      { expectedRevision: await revision(learner), idempotencyKey: "k-" + randomUUID(), studyId: draft.id, consentDigest: view.study.consentDigest });
    expect([403, 404]).toContain(staffConsent.statusCode);
    expect((await call(owner, "GET", `/api/enrollments/${learner.enrollment}/study`)).statusCode).toBe(404);
    const joined = await join(learner);
    expect(joined.participation).toMatchObject({ consent: "consented", participantCode: expect.stringMatching(/^P[0-9A-F]{10}$/),
      version: { behaviour: expect.stringMatching(/^(fixed|chat_only|supervisor)$/) } });
    expect(joined.participation.version).not.toHaveProperty("explanation");
    expect((await db.query("SELECT event_type,actor_kind FROM learning_events WHERE enrollment_id=$1 AND event_type LIKE 'study.%'", [learner.enrollment])).rows)
      .toEqual([{ event_type: "study.consented", actor_kind: "learner" }]);
  });

  it("assignment is stable and balanced; withdrawal lifts the arm; rejoining keeps the same arm", async () => {
    const study = await createStudy();
    const learners = await Promise.all(Array.from({ length: 9 }, () => learnerOf()));
    const arms = new Map<string, string>();
    for (const l of learners) arms.set(l.enrollment, (await join(l)).participation.version.behaviour);
    const counts = (await summary()).studies[0].arms.map((a: { consented: number }) => a.consented);
    expect(counts).toEqual([3, 3, 3]);
    // Joining again is a no-op; withdrawing then rejoining returns to the same arm.
    const first = learners[0]!;
    expect((await join(first)).participation.version.behaviour).toBe(arms.get(first.enrollment));
    const left = await withdraw(first, study.id);
    expect(left.participation).toMatchObject({ consent: "withdrawn", version: null });
    expect((await ok(call(first, "GET", "/api/enrollments/" + first.enrollment))).studyArm).toBeNull();
    expect((await summary()).studies[0].consent).toMatchObject({ consented: 8, withdrawn: 1, eligible: 9, undecided: 0 });
    expect((await join(first)).participation.version.behaviour).toBe(arms.get(first.enrollment));
    // Every assignment recomputes from the seed; the database refuses to change one.
    expect(await ok(call(owner, "GET", `/api/admin/studies/${study.id}/allocation-check`))).toMatchObject({ checked: 9, mismatches: 0, allocated: 9 });
    await expect(db.query("UPDATE study_participants SET arm_id=arm_id||'x' WHERE enrollment_id=$1", [first.enrollment])).rejects.toThrow(/STUDY_ASSIGNMENT_IMMUTABLE/);
    await expect(db.query("DELETE FROM study_participants WHERE enrollment_id=$1", [first.enrollment])).rejects.toThrow(/STUDY_PARTICIPANT_RETAINED/);
    await expect(db.query("DELETE FROM study_consent_changes WHERE enrollment_id=$1", [first.enrollment])).rejects.toThrow(/STUDY_CONSENT_HISTORY_IMMUTABLE/);
    expect((await db.query("SELECT action FROM study_consent_changes WHERE enrollment_id=$1 ORDER BY consent_revision", [first.enrollment])).rows.map((r) => r.action))
      .toEqual(["consented", "withdrawn", "consented"]);
  });

  it("each arm actually changes behaviour through the existing switches, and only while it applies", async () => {
    const study = await createStudy();
    const learners = await Promise.all(Array.from({ length: 3 }, () => learnerOf()));
    const by: Record<string, Learner> = {};
    for (const l of learners) by[(await join(l)).participation.version.behaviour] = l;
    const fixed = by.fixed!, chat = by.chat_only!, full = by.supervisor!;
    const ask = (l: Learner) => send(l, "companion", { episodeId: "min", content: "Why is the minimum unique?" });

    // Fixed path: no companion, no supervision, adaptive teaching cannot be switched on.
    expect((await ok(call(fixed, "GET", "/api/enrollments/" + fixed.enrollment))).studyArm).toMatchObject({ behaviour: "fixed", companion: false, supervision: false });
    expect((await ask(fixed)).json().error).toBe("STUDY_ARM_NO_COMPANION");
    expect((await db.query("SELECT count(*)::int AS n FROM companion_messages WHERE enrollment_id=$1", [fixed.enrollment])).rows[0].n).toBe(0);
    expect(await prepared(fixed, "learning.updated")).toEqual({ disposition: "study_arm", jobs: 0 });
    expect((await send(fixed, "supervision", { adaptiveTeaching: true })).json().error).toBe("STUDY_ARM_NO_SUPERVISION");
    expect((await ok(call(fixed, "GET", `/api/enrollments/${fixed.enrollment}/supervision`))).lockedByStudy).toBe(true);
    const staff = await ok(call(owner, "GET", `/api/admin/enrollments/${fixed.enrollment}/supervision`));
    expect(staff.studyArm).toMatchObject({ behaviour: "fixed" });

    // Chat-only: the companion answers, proactive supervision and research do not run.
    expect((await ok(call(chat, "GET", "/api/enrollments/" + chat.enrollment))).studyArm).toMatchObject({ companion: true, supervision: false });
    const asked = await ask(chat);
    expect(asked.statusCode, asked.body).toBe(200);
    const bridge = createPostgresSupervisorBridge(db, { serviceToken: "synthetic-test-service-token-not-a-credential", workspaceIds: [workspace],
      jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
    await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10_000, tokens: 10_000 });
    await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: chat.enrollment }, { microUsd: 10_000, tokens: 10_000 });
    expect(await dispositionOf(bridge, asked.json().eventId)).toEqual({ disposition: "prepared", jobs: 1 });
    expect(await prepared(chat, "learning.updated")).toEqual({ disposition: "study_arm", jobs: 0 });

    // Full supervisor: unchanged.
    expect((await ok(call(full, "GET", "/api/enrollments/" + full.enrollment))).studyArm).toMatchObject({ companion: true, supervision: true });
    expect(await prepared(full, "learning.updated")).toEqual({ disposition: "prepared", jobs: 1 });
    expect((await send(full, "supervision", { adaptiveTeaching: true })).statusCode).toBe(200);

    // Withdrawal lifts the arm at once.
    await withdraw(fixed, study.id);
    expect((await ask(fixed)).statusCode).toBe(200);
    expect((await ok(call(fixed, "GET", "/api/enrollments/" + fixed.enrollment))).studyArm).toBeNull();
    expect(await prepared(fixed, "learning.updated")).toMatchObject({ disposition: "prepared" });
    // Closing the study lifts every arm.
    const current = (await summary()).studies[0];
    await ok(call(owner, "POST", `/api/admin/studies/${study.id}/close`, { expectedRevision: current.revision }));
    expect((await ok(call(chat, "GET", "/api/enrollments/" + chat.enrollment))).studyArm).toBeNull();
    expect(await prepared(chat, "learning.updated")).toMatchObject({ disposition: "prepared" });
  });

  it("gate next actions never offer the companion in an arm without it; they offer the lesson and a fresh check instead", async () => {
    const study = await createStudy();
    const learners = await Promise.all(Array.from({ length: 3 }, () => learnerOf()));
    const by: Record<string, Learner> = {};
    for (const l of learners) by[(await join(l)).participation.version.behaviour] = l;
    const gate = async (l: Learner) => (await ok(call(l, "GET", "/api/enrollments/" + l.enrollment))).lessons.find((x: { id: string }) => x.id === "min").gate;
    const kinds = (g: { nextActions: { kind: string }[] }) => g.nextActions.map((a) => a.kind);
    for (const [behaviour, l] of Object.entries(by)) {
      await answer(l, "min-a", "five");
      const first = await gate(l);
      expect(first.status, behaviour).toBe("needs_evidence");
      if (behaviour === "fixed") {
        expect(kinds(first)).not.toContain("request_help");
        expect(kinds(first)).toEqual(expect.arrayContaining(["attempt_check", "review_material"]));
        expect(JSON.stringify(first.nextActions)).not.toMatch(/companion/i);
      } else expect(kinds(first)).toContain("request_help");
      await answer(l, "min-b", 9);
      const stuck = await gate(l);
      expect(stuck.status, behaviour).toBe("needs_help");
      if (behaviour === "fixed") {
        expect(kinds(stuck)[0]).toBe("review_material");
        expect(stuck.nextActions[0].label).toMatch(/^Your last 2 attempts on this checkpoint did not succeed\. Review “Minimum”/);
        expect(kinds(stuck)).not.toContain("request_help");
        expect(JSON.stringify(stuck.nextActions)).not.toMatch(/companion/i);
      } else expect(kinds(stuck)[0]).toBe("request_help");
    }
    // Leaving the study restores the companion help in the very next decision.
    await withdraw(by.fixed!, study.id);
    expect(kinds(await gate(by.fixed!))[0]).toBe("request_help");
  });

  it("joining an arm without supervision turns adaptive teaching off and cancels running supervisor work", async () => {
    await createStudy();
    // Fill a block so the next learner's arm is known only after joining; repeat until one lands in a non-supervisor arm.
    for (let i = 0; i < 6; i++) {
      const l = await learnerOf();
      expect((await send(l, "supervision", { adaptiveTeaching: true })).statusCode).toBe(200);
      const job = await prepared(l, "learning.updated");
      expect(job.jobs).toBe(1);
      const behaviour = (await join(l)).participation.version.behaviour;
      const permission = (await db.query("SELECT adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1", [l.enrollment])).rows[0];
      const cancelled = (await db.query("SELECT bool_and(cancellation_requested) AS c FROM supervisor_jobs WHERE enrollment_id=$1 AND role='supervisor'", [l.enrollment])).rows[0].c;
      if (behaviour === "supervisor") {
        expect(permission.adaptive_teaching).toBe(true);
        expect(cancelled).toBe(false);
      } else {
        expect(permission.adaptive_teaching).toBe(false);
        expect(cancelled).toBe(true);
      }
    }
  });
});

describe("research export", () => {
  it("is pseudonymous: arm, instrument scores, timings and completion only; never names, emails, free text or chat", async () => {
    const study = await createStudy();
    const canary = "CANARY-" + randomUUID();
    const learners: Learner[] = [];
    for (let i = 0; i < 9; i++) learners.push(await learnerOf(`Named Person ${i} ${canary}`));
    for (const l of learners) {
      await join(l);
      expect((await send(l, "profile", { profile: { displayName: "Display " + canary, goal: "Private goal " + canary, pace: "steady" } })).statusCode).toBe(200);
    }
    const scored = learners[0]!;
    await answer(scored, "pre-min", 3);
    await answer(scored, "post-min", 5);
    await answer(scored, "min-a", "two");
    await answer(scored, "min-b", 4);
    // The delayed check is scheduled and offered by the retention machinery once due.
    clock.advance(DAY + 1000);
    expect((await ok(call(scored, "GET", `/api/enrollments/${scored.enrollment}/retention`))).items[0]).toMatchObject({ objectiveId: "minimum", due: true });
    const issued = await send(scored, "retention/check", { objectiveId: "minimum" });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().question.id ?? issued.json().question.assessmentId).toBe("min-later-1");
    expect((await send(scored, "answers", { challengeId: issued.json().challengeId, answer: 7 })).statusCode).toBe(200);
    // Chat content exists for some participant.
    for (const l of learners) {
      const r = await send(l, "companion", { episodeId: "min", content: "Chat " + canary });
      if (r.statusCode === 200) break;
    }

    const json = await exportOf(study.id, "json");
    const csv = await exportOf(study.id, "csv");
    expect(json.headers["content-disposition"]).toMatch(/^attachment; filename="study-[0-9a-f]{8}\.json"$/);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(json.headers["cache-control"]).toBe("no-store");
    for (const body of [json.body, csv.body]) {
      expect(body).not.toContain(canary);
      expect(body).not.toContain("Named Person");
      expect(body).not.toContain("@example.com");
      for (const l of learners) {
        expect(body).not.toContain(l.enrollment);
        expect(body).not.toContain(l.userId);
      }
    }
    const document = JSON.parse(json.body);
    expect(document).toMatchObject({ schema: "course-core.study-export/1", included: 9, arms: [{ included: 3 }, { included: 3 }, { included: 3 }] });
    expect(document.participants).toHaveLength(9);
    const code = (await studyView(scored)).participation.participantCode;
    const row = document.participants.find((p: { participant: string }) => p.participant === code);
    expect(row.sets.pre).toMatchObject({ items: 1, attempted: 1, correct: 1, score: 1, complete: true, outcomes: { "pre-min": "correct" } });
    expect(row.sets.post).toMatchObject({ attempted: 1, correct: 0, score: 0, outcomes: { "post-min": "incorrect" } });
    expect(row.sets.transfer).toMatchObject({ attempted: 0, complete: false, firstMinutes: null, outcomes: { "xfer-min": "not_attempted" } });
    expect(row.sets.delayed).toMatchObject({ attempted: 1, correct: 1, outcomes: { "min-later-1": "correct" } });
    // Timings are minutes from consent (stored submission times; the test clock only decides due-ness).
    expect(row.sets.pre.firstMinutes).toBeGreaterThanOrEqual(0);
    expect(row.sets.delayed.lastMinutes).toBeGreaterThanOrEqual(row.sets.pre.firstMinutes);
    // CSV: same rows, fixed columns.
    const lines = csv.body.trim().split("\r\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^participant,arm,behaviour,consentedDay,pre_items,.*pre:pre-min,.*delayed:min-later-1,episodes_completed,episodes_total,course_completed$/);
    // Each export is recorded (who, format, rows, digest) and audit-logged without content.
    const records = (await db.query("SELECT format,included,suppressed_arms,digest,requested_by FROM study_exports WHERE study_id=$1 ORDER BY created_at", [study.id])).rows;
    expect(records).toEqual([
      expect.objectContaining({ format: "json", included: 9, suppressed_arms: 0, requested_by: owner.userId }),
      expect.objectContaining({ format: "csv", included: 9, suppressed_arms: 0, requested_by: owner.userId }),
    ]);
    expect(records[1].digest).toBe(csv.headers["x-export-digest"]);
    const events = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='study.exported'", [workspace])).rows;
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it("suppresses arms below the minimum cell size and withholds the total", async () => {
    const study = await createStudy({ minCellSize: 3 });
    const learners = await Promise.all(Array.from({ length: 7 }, () => learnerOf()));
    for (const l of learners) await join(l);
    // 7 consented: arms of 3, 2 and 2 (permuted blocks). Withdraw one from a full arm too.
    const document = JSON.parse((await exportOf(study.id, "json")).body);
    const suppressed = document.arms.filter((a: { suppressed: boolean }) => a.suppressed);
    expect(suppressed).toHaveLength(2);
    expect(suppressed.every((a: { included: number | null }) => a.included === null)).toBe(true);
    expect(document.included).toBeNull();
    const kept = document.arms.find((a: { suppressed: boolean }) => !a.suppressed);
    expect(kept.included).toBe(3);
    expect(document.participants).toHaveLength(3);
    expect(document.participants.every((p: { arm: string }) => p.arm === kept.id)).toBe(true);
    expect((await db.query("SELECT suppressed_arms FROM study_exports WHERE study_id=$1", [study.id])).rows[0].suppressed_arms).toBe(2);
    // Withdrawn participants are left out entirely: the kept arm drops below the minimum.
    const member = (await Promise.all(learners.map(async (l) => ({ l, v: await studyView(l) })))).find((x) => x.v.participation.version.label === kept.label)!.l;
    await withdraw(member, study.id);
    const after = JSON.parse((await exportOf(study.id, "csv").then(() => exportOf(study.id, "json"))).body);
    expect(after.participants).toHaveLength(0);
    expect(after.arms.every((a: { suppressed: boolean }) => a.suppressed)).toBe(true);
  });

  it("erasure removes study data; the allocation sequence and other assignments are unaffected", async () => {
    const study = await createStudy();
    const learners = await Promise.all(Array.from({ length: 4 }, () => learnerOf()));
    for (const l of learners) await join(l);
    const gone = learners[1]!;
    const code = (await studyView(gone)).participation.participantCode;
    const erased = await call(gone, "POST", `/api/enrollments/${gone.enrollment}/erase`, { confirmation: `ERASE ${gone.enrollment.slice(0, 8)}`, reason: "Remove my study data as well." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts).toMatchObject({ studyParticipants: 1, studyConsentChanges: 1 });
    for (const table of ["study_participants", "study_consent_changes"])
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE enrollment_id=$1`, [gone.enrollment])).rows[0].n).toBe(0);
    expect(await ok(call(owner, "GET", `/api/admin/studies/${study.id}/allocation-check`))).toMatchObject({ checked: 3, mismatches: 0, allocated: 4 });
    const next = await learnerOf();
    await join(next);
    expect((await db.query("SELECT allocation_index FROM study_participants WHERE enrollment_id=$1", [next.enrollment])).rows[0].allocation_index).toBe(4);
    const study2 = await ok(call(owner, "GET", `/api/admin/courses/${course}/studies`));
    expect(study2.studies[0].consent).toMatchObject({ consented: 4, eligible: 4 });
    expect((await exportOf(study.id, "json")).body).not.toContain(code);
  });
});
