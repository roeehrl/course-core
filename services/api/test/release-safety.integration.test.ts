import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { paidWorkPolicy } from "../src/supervisor-bridge.js";
import { publicTopicWithin } from "../src/research-store.js";
import { releaseDiff, replacementItems } from "../src/release-safety.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: rollback impact confirmation, archive, release diff and
// defective items, plus delivery that continues for learners pinned to an archived release.
const origin = "http://localhost:4397",
  schema = "release_safety_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, learner: Session, instructor: Session, catalog: string, v1: string, v2: string, enrollment: string;

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "rs:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
const revision = async () => (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json().revision as string;
const command = async (url: string, payload: unknown, who = owner) =>
  call(who, "POST", `/api/admin/courses/${catalog}${url}`, payload, { "if-match": await revision(), "idempotency-key": "cmd-" + randomUUID() });
const transition = (releaseId: string, body: Record<string, unknown>) => command(`/releases/${releaseId}/transitions`, body);
function course(version: string, change = false): CourseManifest {
  const c = fixture();
  c.version = version;
  (c as unknown as { research: unknown }).research = { publicTopics: [{ id: "minimum-research", objectiveIds: ["minimum"], queryText: "Public explanation of finding the minimum", allowedDomains: ["docs.python.org"] }] };
  if (change) c.assessments.find((a) => a.id === "min-b")!.prompt = "Minimum of 6 and 3?";
  return c;
}
async function publish(manifest: CourseManifest) {
  const id = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest)).json().id as string;
  expect((await call(owner, "POST", `/api/releases/${id}/publish`)).statusCode).toBe(200);
  return id;
}
async function learnerSend(action: string, body: Record<string, unknown>, id = enrollment) {
  const rev = (await call(learner, "GET", `/api/enrollments/${id}`)).json().revision;
  return call(learner, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: rev, idempotencyKey: randomUUID(), ...body });
}
async function answer(assessmentId: string, value: unknown) {
  const issued = await learnerSend("challenges", { episodeId: "min", assessmentId, mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  const answered = await learnerSend("answers", { challengeId: issued.json().challengeId, answer: value });
  expect(answered.statusCode, answered.body).toBe(200);
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "rs-" + workspace, "Release safety"]);
  owner = await person("owner");
  learner = await person("learner");
  instructor = await person("instructor");
  v1 = await publish(course("1.0.0"));
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: v1 })).json().id;
  expect((await learnerSend("read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
  await answer("min-a", "two");
  await answer("min-b", 4);
  v2 = await publish(course("1.1.0", true));
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("release diff", () => {
  it("reports changed entities by digest", async () => {
    const r = await call(owner, "GET", `/api/admin/courses/${catalog}/releases/${v2}/diff?against=${v1}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ identical: false, kinds: { assessments: { changed: ["min-b"], added: [], removed: [], unchanged: 3 } } });
    expect(r.json().kinds.episodes).toMatchObject({ changed: [], unchanged: 2 });
    expect((await call(owner, "GET", `/api/admin/courses/${catalog}/releases/${v2}/diff?against=${v2}`)).json()).toMatchObject({ identical: true, changes: 0 });
    expect((await call(owner, "GET", `/api/admin/courses/${catalog}/releases/${v2}/diff?against=nope`)).statusCode).toBe(400);
    expect((await call(learner, "GET", `/api/admin/courses/${catalog}/releases/${v2}/diff?against=${v1}`)).statusCode).toBe(403);
  });
  it("covers added and removed entities and scalar sections", () => {
    const a = course("1.0.0"), b = course("1.0.1");
    b.assessments = b.assessments.filter((x) => x.id !== "max-b");
    b.assessments.push({ ...b.assessments[0]!, id: "min-c" } as never);
    b.placement!.maxItems = 3;
    const diff = releaseDiff({ id: "a", version: "1", digest: "x", status: "published", server_bundle: a, created_at: new Date() },
      { id: "b", version: "2", digest: "y", status: "published", server_bundle: b, created_at: new Date() });
    expect(diff.kinds.assessments).toMatchObject({ added: ["min-c"], removed: ["max-b"] });
    expect(diff.kinds.placement).toMatchObject({ changed: ["placement"] });
  });
});

describe("rollback", () => {
  it("requires confirming the exact impact, and refuses a changed impact", async () => {
    const impact = await call(owner, "GET", `/api/admin/courses/${catalog}/releases/${v1}/rollback-impact`);
    expect(impact.statusCode, impact.body).toBe(200);
    expect(impact.json().impact).toMatchObject({ from: { id: v2 }, to: { id: v1 }, learnersPinnedToActive: 0, learnersPinnedToTarget: 1,
      changedOrRemovedItems: ["min-b"], existingLearnersMove: false, targetDefectiveItems: [] });
    const missing = await transition(v1, { action: "activate" });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ error: "IMPACT_CONFIRMATION_REQUIRED", details: { impactDigest: impact.json().impactDigest } });
    // Someone on v2 earns evidence on the changed item: the impact changes and the old digest is refused.
    const other = await person("learner");
    const otherEnrollment = (await call(other, "POST", "/api/enrollments", { releaseId: v2 })).json().id;
    const send = async (action: string, body: Record<string, unknown>) => {
      const rev = (await call(other, "GET", `/api/enrollments/${otherEnrollment}`)).json().revision;
      return call(other, "POST", `/api/enrollments/${otherEnrollment}/${action}`, { expectedRevision: rev, idempotencyKey: randomUUID(), ...body });
    };
    await send("read", { episodeId: "min", blockId: "min-text" });
    const issued = (await send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" })).json();
    expect((await send("answers", { challengeId: issued.challengeId, answer: 3 })).statusCode).toBe(200);
    const stale = await transition(v1, { action: "activate", impactDigest: impact.json().impactDigest });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "IMPACT_CHANGED", details: { impact: { evidenceOnChangedItems: 1, learnersPinnedToActive: 1 } } });
    const confirmed = await transition(v1, { action: "activate", impactDigest: stale.json().details.impactDigest });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((await call(owner, "GET", `/api/admin/courses/${catalog}`)).json().releases.find((r: { id: string }) => r.id === v1).availableForNewLearners).toBe(true);
    // Moving forward again is not a rollback and needs no confirmation.
    expect((await transition(v2, { action: "activate" })).statusCode).toBe(200);
  });
});

describe("archive", () => {
  it("refuses the active release, archives another, and keeps supervisor and research delivery for its pinned learners", async () => {
    expect((await transition(v2, { action: "archive" })).json().error).toBe("ACTIVE_RELEASE_ARCHIVE_FORBIDDEN");
    const archived = await transition(v1, { action: "archive" });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().message).toMatch(/1 learner/);
    expect((await db.query("SELECT status FROM course_releases WHERE id=$1", [v1])).rows[0].status).toBe("archived");
    expect((await transition(v1, { action: "activate" })).json().error).toBe("PUBLISHED_RELEASE_REQUIRED");
    expect((await transition(v1, { action: "archive" })).json().error).toBe("PUBLISHED_RELEASE_REQUIRED");
    // The pinned learner keeps learning on the archived release...
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}`)).statusCode).toBe(200);
    // ...and keeps supervision and research delivery.
    await transaction(db, async (client) => {
      const policy = await paidWorkPolicy(client, { workspaceId: workspace, enrollmentId: enrollment, episodeId: "min" }, "admit_job");
      expect(policy.active).toBe(true);
      expect((await publicTopicWithin(client, enrollment, workspace, "minimum-research", "min")).topic.id).toBe("minimum-research");
    });
    // A draft release is still not live.
    const draft = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course("2.0.0"))).json().id;
    await db.query("UPDATE enrollments SET course_release_id=$2 WHERE id=$1", [enrollment, draft]);
    try {
      await transaction(db, async (client) => {
        expect((await paidWorkPolicy(client, { workspaceId: workspace, enrollmentId: enrollment, episodeId: "min" }, "admit_job")).active).toBe(false);
        await expect(publicTopicWithin(client, enrollment, workspace, "minimum-research", "min")).rejects.toThrow(/RESEARCH_SCOPE_UNAVAILABLE/);
      });
    } finally {
      await db.query("UPDATE enrollments SET course_release_id=$2 WHERE id=$1", [enrollment, v1]);
    }
  });
});

describe("defective items", () => {
  const preview = (assessmentId: string, who = owner) => call(who, "POST", `/api/admin/courses/${catalog}/releases/${v1}/defective-items/preview`, { assessmentId });
  const apply = (body: Record<string, unknown>) => command(`/releases/${v1}/defective-items`, body);
  const reason = "The correct option text was swapped with a distractor.";

  it("previews, applies with the preview digest, invalidates evidence with the reason and refreshes the gate decision", async () => {
    const before = (await call(learner, "GET", `/api/enrollments/${enrollment}/gates/min-gate/decision`));
    const p = await preview("min-a");
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().preview).toMatchObject({ assessmentId: "min-a", evidenceToInvalidate: 1, affectedEnrollments: 1, alreadyDefective: false, replacement: { available: true, itemIds: ["min-b"] } });
    expect((await preview("unknown-item")).statusCode).toBe(404);
    expect((await preview("min-a", instructor)).statusCode).toBe(403);
    expect((await apply({ assessmentId: "min-a", reason: "short", previewDigest: p.json().previewDigest })).json().error).toBe("INVALID_REQUEST");
    expect((await apply({ assessmentId: "min-a", reason, previewDigest: "0".repeat(64) })).json()).toMatchObject({ error: "IMPACT_CHANGED", details: { previewDigest: p.json().previewDigest } });
    const applied = await apply({ assessmentId: "min-a", reason, previewDigest: p.json().previewDigest });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().message).toMatch(/1 evidence record\(s\) for 1 learner/);
    const evidence = (await db.query(`SELECT ev.invalidated_at,ev.invalidation_reason FROM evidence ev JOIN attempts a ON a.id=ev.attempt_id WHERE a.enrollment_id=$1 AND a.assessment_id='min-a'`, [enrollment])).rows;
    expect(evidence).toEqual([expect.objectContaining({ invalidated_at: expect.any(Date), invalidation_reason: `Item marked defective: ${reason}` })]);
    const after = (await call(learner, "GET", `/api/enrollments/${enrollment}/gates/min-gate/decision`));
    if (before.statusCode === 200) expect(after.json().decision.decisionId).not.toBe(before.json().decision.decisionId);
    // The item is never issued again on this release; the default pick skips it.
    expect((await learnerSend("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" })).json().error).toBe("ITEM_DEFECTIVE");
    // Marking it again is refused, and the list shows it.
    expect((await preview("min-a")).json().preview.alreadyDefective).toBe(true);
    expect((await apply({ assessmentId: "min-a", reason, previewDigest: p.json().previewDigest })).json().error).toBe("ITEM_ALREADY_DEFECTIVE");
    expect((await call(instructor, "GET", `/api/admin/courses/${catalog}/releases/${v1}/defective-items`)).json().items).toEqual([expect.objectContaining({ assessmentId: "min-a", reason })]);
    // The rollback impact to this release now names it.
    expect((await call(owner, "GET", `/api/admin/courses/${catalog}/releases/${v1}/rollback-impact`)).json().impact.targetDefectiveItems).toEqual(["min-a"]);
    await expect(db.query("DELETE FROM release_defective_items")).rejects.toThrow(/DEFECTIVE_ITEM_IMMUTABLE/);
  });

  it("never reopens a completed course: the learner is told what was withdrawn and why, and the amendment is audited", async () => {
    // A second, still active learner on the same release for contrast.
    const active = await person("learner");
    const activeId = (await call(active, "POST", "/api/enrollments", { releaseId: v1 })).json().id as string;
    await db.query("UPDATE enrollments SET status='completed',closed_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [enrollment]);
    const before = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    expect(before.closedRecordNotices).toEqual([]);
    const p = (await preview("min-a")).json();
    expect((await apply({ assessmentId: "min-a", reason, previewDigest: p.previewDigest })).statusCode).toBe(200);
    const after = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json();
    expect(after.status).toBe("completed");
    expect(after.closureReport).toEqual(before.closureReport);
    expect(after.closedRecordNotices).toEqual([expect.objectContaining({ assessmentId: "min-a", objectiveId: "minimum", reason: `Item marked defective: ${reason}` })]);
    const audit = (await db.query("SELECT enrollment_id,actor_kind,payload FROM learning_events WHERE workspace_id=$1 AND event_type='enrollment.closed_record_amended'", [workspace])).rows;
    expect(audit).toEqual([{ enrollment_id: enrollment, actor_kind: "system",
      payload: { source: "item_defective", assessmentId: "min-a", evidence: 1, statusBefore: "completed", statusAfter: "completed", reopened: false, closureReportKept: true, learnerNotified: true } }]);
    expect((await call(active, "GET", `/api/enrollments/${activeId}`)).json().closedRecordNotices).toEqual([]);
  });

  it("requires acknowledging that no replacement item exists", async () => {
    const first = (await preview("min-a")).json();
    expect((await apply({ assessmentId: "min-a", reason, previewDigest: first.previewDigest })).statusCode).toBe(200);
    const p = (await preview("min-b")).json();
    expect(p.preview.replacement).toEqual({ available: false, itemIds: [] });
    const refused = await apply({ assessmentId: "min-b", reason, previewDigest: p.previewDigest });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("NO_REPLACEMENT_ITEM");
    expect((await apply({ assessmentId: "min-b", reason, previewDigest: p.previewDigest, acknowledgeNoReplacement: true })).statusCode).toBe(200);
    expect((await db.query("SELECT acknowledged_no_replacement FROM release_defective_items WHERE release_id=$1 AND assessment_id='min-b'", [v1])).rows[0].acknowledged_no_replacement).toBe(true);
  });

  it("closes open challenges for the item; a learner on another release is unaffected", async () => {
    const open = await learnerSend("challenges", { episodeId: "min", assessmentId: "min-a", mode: "practice" });
    expect(open.statusCode, open.body).toBe(200);
    const p = (await preview("min-a")).json();
    expect(p.preview.openChallengesToClose).toBe(1);
    await apply({ assessmentId: "min-a", reason, previewDigest: p.previewDigest });
    expect((await learnerSend("answers", { challengeId: open.json().challengeId, answer: "two" })).statusCode).not.toBe(200);
    const other = await person("learner");
    const id = (await call(other, "POST", "/api/enrollments", { releaseId: v2 })).json().id;
    const rev = (await call(other, "GET", `/api/enrollments/${id}`)).json().revision;
    expect((await call(other, "POST", `/api/enrollments/${id}/read`, { expectedRevision: rev, idempotencyKey: randomUUID(), episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
    const rev2 = (await call(other, "GET", `/api/enrollments/${id}`)).json().revision;
    expect((await call(other, "POST", `/api/enrollments/${id}/challenges`, { expectedRevision: rev2, idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-a", mode: "independent" })).statusCode).toBe(200);
  });

  it("replacement items must cover the objectives and stay inside the same gate", () => {
    const c = course("1.0.0");
    expect(replacementItems(c, "min-a", new Set())).toEqual(["min-b"]);
    expect(replacementItems(c, "max-a", new Set(["max-b"]))).toEqual([]);
    expect(replacementItems(c, "nope", new Set())).toEqual([]);
  });
});
