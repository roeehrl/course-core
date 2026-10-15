import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { digestJson } from "../src/repository.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { rubricCourse, rubricExplanation } from "./rubric-fixture.js";

// Real PostgreSQL only: a fresh random schema per run.
const origin = "http://localhost:4392",
  schema = "learner_view_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, release: string, owner: Session, admin: Session, learner: Session, enrollment: string, canary: string;
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
async function session(role: string, workspaceId = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "view:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session | undefined, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { origin, ...(who ? { cookie: who.cookie, "x-csrf-token": who.csrf } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
const viewUrl = (id = enrollment) => `/api/admin/enrollments/${id}/learner-view`;
const learnerState = async () => (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
async function command(action: string, body: Record<string, unknown>) {
  const r = await call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, {
    expectedRevision: (await learnerState()).revision,
    idempotencyKey: randomUUID(),
    ...body,
  });
  expect(r.statusCode, action + " " + r.body).toBe(200);
  return r.json();
}
const auditRows = async () =>
  (await db.query("SELECT viewer_id,viewer_role,enrollment_revision,workspace_id FROM staff_learner_views WHERE enrollment_id=$1 ORDER BY created_at", [enrollment])).rows;
/** Row counts of every application table except the view audit and the workspace event stream. */
async function tableCounts() {
  const tables = (
    await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name")
  ).rows.map((r) => r.table_name as string);
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = (await db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;
  return counts;
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
});
beforeEach(async () => {
  workspace = randomUUID();
  canary = "CANARY-" + randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "view-" + workspace, "Learner view"]);
  owner = await session("owner");
  admin = await session("admin");
  learner = await session("learner");
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse());
  expect(created.statusCode, created.body).toBe(200);
  release = created.json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await command("profile", { profile: { displayName: "Viewed learner", goal: "Understand comparisons.", pace: "steady" } });
  await command("read", { episodeId: "min", blockId: "min-text" });
  const choice = await command("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
  await command("answers", { challengeId: choice.challengeId, answer: "two" });
  const written = await command("challenges", { episodeId: "min", assessmentId: "min-explain", mode: "independent" });
  await command("answers", { challengeId: written.challengeId, answer: rubricExplanation });
  // An open practice check the learner has not answered yet.
  await command("challenges", { episodeId: "min", assessmentId: "min-a", mode: "practice" });
  // Private to the learner: companion conversation and their own learner-model notes.
  await command("companion", { episodeId: "min", content: "Private question " + canary });
  await command("learner-model/profile", {
    profile: { preferences: { goal: "Model goal " + canary }, priorKnowledge: [{ objectiveId: "minimum", statement: "I know " + canary }], thoughts: "Thoughts " + canary },
  });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("read-only view as learner", () => {
  it("shows an owner or admin exactly the learner's snapshot, without private conversation or notes, a session or any learner-state change", async () => {
    const before = await learnerState();
    const sessions = (await db.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n;
    for (const viewer of [owner, admin]) {
      const r = await call(viewer, "GET", viewUrl());
      expect(r.statusCode, r.body).toBe(200);
      // No learner session or cookie is ever issued.
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.headers["cache-control"]).toBe("no-store");
      const view = r.json();
      expect(view).toMatchObject({ readOnly: true, learner: { displayName: "Viewed learner" }, view: { viewer: { id: viewer.userId }, visibleToLearner: true } });
      // The snapshot is the learner app's own payload.
      expect(view.snapshot).toEqual(await learnerState());
      expect(view.snapshot.lessons.find((l: { id: string }) => l.id === "min").gate.objectives[0]).toMatchObject({ id: "minimum", families: ["compare"], required: 2, passed: false });
      expect(view.snapshot.activeChallenges).toHaveLength(1);
      expect(JSON.stringify(view.snapshot.activeChallenges)).not.toContain("correctOptionId");
      expect(view.reviews).toEqual((await call(learner, "GET", `/api/enrollments/${enrollment}/reviews`)).json().reviews);
      expect(view.reviews).toEqual([expect.objectContaining({ assessmentId: "min-explain", status: "pending_review" })]);
      expect(view.personalChanges).toEqual((await call(learner, "GET", `/api/enrollments/${enrollment}/personal-changes`)).json().changes);
      expect(view.withheld.map((w: { id: string }) => w.id)).toEqual(["companion", "learner-model", "drafts", "gate-review-reason", "written-answer-appeal-reason"]);
      expect(r.body).not.toContain(canary);
    }
    expect((await db.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n).toBe(sessions);
    const after = await learnerState();
    expect(after.revision).toBe(before.revision);
    expect(after).toEqual(before);
  });

  it("audits every view (who, role, enrollment, revision, when) in an append-only record and the workspace stream", async () => {
    const revision = (await learnerState()).revision;
    const first = (await call(admin, "GET", viewUrl())).json();
    await call(owner, "GET", viewUrl());
    await call(admin, "GET", viewUrl());
    const rows = await auditRows();
    expect(rows).toEqual([
      { viewer_id: admin.userId, viewer_role: "admin", enrollment_revision: revision, workspace_id: workspace },
      { viewer_id: owner.userId, viewer_role: "owner", enrollment_revision: revision, workspace_id: workspace },
      { viewer_id: admin.userId, viewer_role: "admin", enrollment_revision: revision, workspace_id: workspace },
    ]);
    const saved = (await db.query("SELECT created_at FROM staff_learner_views WHERE id=$1", [first.view.id])).rows[0];
    expect(new Date(first.view.viewedAt).getTime()).toBe(saved.created_at.getTime());
    const events = (await db.query("SELECT enrollment_id,actor_id,actor_kind,payload FROM learning_events WHERE workspace_id=$1 AND event_type='learner.viewed_by_staff' ORDER BY sequence", [workspace])).rows;
    expect(events).toHaveLength(3);
    // Kept out of the learner's activity feed and supervision; no learner content.
    expect(events[0]).toEqual({ enrollment_id: null, actor_id: admin.userId, actor_kind: "staff", payload: { enrollmentId: enrollment, viewId: first.view.id, viewerRole: "admin" } });
    expect((await db.query("SELECT count(*)::int AS n FROM outbox WHERE payload->>'eventId'=ANY($1::text[])", [events.map((e) => e.payload.viewId)])).rows[0].n).toBe(0);
    // Append-only for every role, including the schema owner.
    await expect(db.query("UPDATE staff_learner_views SET viewer_role='owner' WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/STAFF_VIEW_AUDIT_IMMUTABLE/);
    await expect(db.query("DELETE FROM staff_learner_views WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/STAFF_VIEW_AUDIT_IMMUTABLE/);
    await expect(db.query("INSERT INTO staff_learner_views(id,enrollment_id,workspace_id,viewer_id,viewer_role,enrollment_revision) VALUES($1,$2,$3,$4,'instructor',1)",
      [randomUUID(), enrollment, workspace, admin.userId])).rejects.toThrow(/check constraint/);
  });

  it("refuses other workspace roles (403), other workspaces and unknown enrollments (404) and anonymous callers (401), recording nothing", async () => {
    for (const role of ["instructor", "reviewer", "author", "observer", "learner"]) {
      const r = await call(await session(role), "GET", viewUrl());
      expect(r.statusCode, role).toBe(403);
      expect(r.json().error).toBe("FORBIDDEN");
    }
    // The enrolled learner cannot use the staff route on their own enrollment either.
    expect((await call(learner, "GET", viewUrl())).statusCode).toBe(403);
    const elsewhere = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [elsewhere, "other-" + elsewhere, "Other"]);
    const foreignOwner = await session("owner", elsewhere);
    const foreign = await call(foreignOwner, "GET", viewUrl());
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe("ENROLLMENT_NOT_FOUND");
    expect((await call(owner, "GET", viewUrl(randomUUID()))).statusCode).toBe(404);
    expect((await call(owner, "GET", "/api/admin/enrollments/not-a-uuid/learner-view")).statusCode).toBe(400);
    expect((await call(undefined, "GET", viewUrl())).statusCode).toBe(401);
    expect(await auditRows()).toEqual([]);
  });

  it("refuses an erased learner's record (410) without recording a view", async () => {
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, {
      confirmation: `ERASE ${enrollment.slice(0, 8)}`,
      reason: "Learner asked for their data to be removed.",
    });
    expect(erased.statusCode, erased.body).toBe(200);
    const r = await call(admin, "GET", viewUrl());
    expect(r.statusCode).toBe(410);
    expect(r.json().error).toBe("ENROLLMENT_ERASED");
    expect(await auditRows()).toEqual([]);
  });

  it("offers no way to act as the learner: the view is GET-only and every learner command still refuses staff", async () => {
    const viewed = await call(admin, "GET", viewUrl());
    expect(viewed.statusCode).toBe(200);
    const counts = await tableCounts();
    const state = await learnerState();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) expect((await call(admin, method, viewUrl(), {})).statusCode, method).toBe(404);
    const challenge = viewed.json().snapshot.activeChallenges[0].challengeId;
    const body = (extra: Record<string, unknown>) => ({ expectedRevision: state.revision, idempotencyKey: randomUUID(), ...extra });
    const commands: [string, Record<string, unknown>][] = [
      ["profile", { profile: { displayName: "Changed by staff", goal: "", pace: "steady" } }],
      ["read", { episodeId: "min", blockId: "min-text" }],
      ["challenges", { episodeId: "min", assessmentId: "min-a", mode: "practice" }],
      ["answers", { challengeId: challenge, answer: "two" }],
      ["solution", { challengeId: challenge }],
      ["complete", { episodeId: "min" }],
      ["companion", { episodeId: "min", content: "Sent as the learner?" }],
      ["learner-model/profile", { profile: { preferences: {}, priorKnowledge: [], thoughts: "staff" } }],
      ["personal-changes/visibility", { episodeId: "min", blockId: "min-text", hidden: true }],
      ["placement/decline", {}],
      ["review-assist", { granted: true }],
      ["supervision", { adaptiveTeaching: true }],
    ];
    for (const [action, extra] of commands) {
      const r = await call(admin, "POST", `/api/enrollments/${enrollment}/${action}`, body(extra));
      expect(r.statusCode, `${action}: ${r.body}`).toBe(404);
      expect(r.json().error).toBe("ENROLLMENT_NOT_FOUND");
    }
    // Learner-only reads stay closed too: the view does not widen the admin's access.
    for (const path of ["companion", "staff-views"]) expect((await call(admin, "GET", `/api/enrollments/${enrollment}/${path}`)).statusCode, path).toBe(404);
    expect(await learnerState()).toEqual(state);
    expect(await tableCounts()).toEqual(counts);
  });

  it("shows the learner who viewed their record and includes every view in their data export", async () => {
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}/staff-views`)).json()).toEqual({ views: [], exports: [] });
    const first = (await call(admin, "GET", viewUrl())).json(), second = (await call(owner, "GET", viewUrl())).json();
    const listed = await call(learner, "GET", `/api/enrollments/${enrollment}/staff-views`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().views).toEqual([
      { id: first.view.id, viewedAt: first.view.viewedAt, viewerName: "admin person", viewerRole: "admin" },
      { id: second.view.id, viewedAt: second.view.viewedAt, viewerName: "owner person", viewerRole: "owner" },
    ]);
    // Another learner cannot read this list.
    expect((await call(await session("learner"), "GET", `/api/enrollments/${enrollment}/staff-views`)).statusCode).toBe(404);
    const exported = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json().staffViews).toEqual([
      { id: first.view.id, viewedAt: first.view.viewedAt, viewerId: admin.userId, viewerName: "admin person", viewerRole: "admin" },
      { id: second.view.id, viewedAt: second.view.viewedAt, viewerId: owner.userId, viewerName: "owner person", viewerRole: "owner" },
    ]);
    // An owner's export on request carries the same records; erasure keeps the audit skeleton.
    expect((await call(owner, "GET", `/api/admin/enrollments/${enrollment}/export`)).json().staffViews).toHaveLength(2);
    await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Learner asked for their data to be removed." });
    expect(await auditRows()).toHaveLength(2);
  });
});

describe("staff exports of a learner's data", () => {
  const exportRows = async () =>
    (await db.query("SELECT id,requested_by,actor_kind,requester_role,digest,workspace_id FROM data_exports WHERE enrollment_id=$1 ORDER BY created_at,id", [enrollment])).rows;
  const staffExport = (who: Session, id = enrollment) => call(who, "GET", `/api/admin/enrollments/${id}/export`);
  const exportEvents = async () =>
    (await db.query("SELECT actor_id,actor_kind,payload FROM learning_events WHERE workspace_id=$1 AND event_type='data.exported' ORDER BY sequence", [workspace])).rows;

  it("records every staff export append-only with who, role and digest, and nothing for refused calls", async () => {
    const byOwner = await staffExport(owner), byAdmin = await staffExport(admin), own = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    for (const response of [byOwner, byAdmin, own]) expect(response.statusCode, response.body).toBe(200);
    const rows = await exportRows();
    expect(rows.map((r) => [r.requested_by, r.actor_kind, r.requester_role, r.workspace_id])).toEqual([
      [owner.userId, "staff", "owner", workspace],
      [admin.userId, "staff", "admin", workspace],
      [learner.userId, "learner", null, workspace],
    ]);
    // The digest is of the exact file that was returned; the record holds no learner content.
    expect(rows[0].digest).toBe(digestJson(byOwner.json()));
    // Staff copies leave out the learner's private conversation and notes; the learner's own copy has them.
    expect(byOwner.body).not.toContain(canary);
    expect(byAdmin.body).not.toContain(canary);
    expect(own.body).toContain(canary);
    expect(JSON.stringify(rows)).not.toContain(canary);
    const events = await exportEvents();
    expect(events.map((e) => [e.actor_id, e.actor_kind, e.payload.requesterRole ?? null])).toEqual([
      [owner.userId, "staff", "owner"],
      [admin.userId, "staff", "admin"],
      [learner.userId, "learner", null],
    ]);
    expect(events.map((e) => e.payload.exportId)).toEqual(rows.map((r) => r.id));
    expect(JSON.stringify(events)).not.toContain(canary);
    // Refused callers leave no record: other roles and other workspaces (404, as before), anonymous (401).
    const otherWorkspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [otherWorkspace, "other-" + otherWorkspace, "Other"]);
    for (const role of ["instructor", "reviewer", "author", "observer", "learner"]) expect((await staffExport(await session(role))).statusCode, role).toBe(404);
    expect((await staffExport(await session("owner", otherWorkspace))).statusCode).toBe(404);
    expect((await staffExport(owner, randomUUID())).statusCode).toBe(404);
    expect((await call(undefined, "GET", `/api/admin/enrollments/${enrollment}/export`)).statusCode).toBe(401);
    expect(await exportRows()).toHaveLength(3);
    // Append-only for every role, including the table owner.
    await expect(db.query("UPDATE data_exports SET requester_role='admin' WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/DATA_EXPORT_AUDIT_IMMUTABLE/);
    await expect(db.query("DELETE FROM data_exports WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/DATA_EXPORT_AUDIT_IMMUTABLE/);
    await expect(db.query("TRUNCATE data_exports")).rejects.toThrow(/DATA_EXPORT_AUDIT_IMMUTABLE/);
    // A staff row must name an owner/admin role; a learner row must not carry one.
    const insert = (kind: string, role: string | null) =>
      db.query("INSERT INTO data_exports(id,enrollment_id,workspace_id,requested_by,actor_kind,requester_role,digest) VALUES($1,$2,$3,$4,$5,$6,repeat('a',64))", [
        randomUUID(), enrollment, workspace, owner.userId, kind, role,
      ]);
    for (const [kind, role] of [["staff", null], ["staff", "instructor"], ["learner", "owner"]] as const)
      await expect(insert(kind, role), `${kind} ${role}`).rejects.toMatchObject({ code: "23514" });
    expect(await exportRows()).toHaveLength(3);
  });

  it("applies the shared privacy rule to every staff export, per role, and keeps the learner's own export complete", async () => {
    const view = (await call(owner, "GET", viewUrl())).json();
    const markers = ["Private question " + canary, "Model goal " + canary, "I know " + canary, "Thoughts " + canary];
    for (const who of [owner, admin]) {
      const file = await staffExport(who);
      expect(file.statusCode, file.body).toBe(200);
      const body = file.json();
      expect(body).toMatchObject({ audience: "staff", companion: null, learnerModel: null });
      // The same rule, and the same list, as the read-only view.
      expect(body.withheld).toEqual(view.withheld);
      expect(body.limitations.join(" ")).toMatch(/made by course staff/);
      for (const marker of markers) expect(file.body, marker).not.toContain(marker);
      expect(file.body).not.toContain(canary);
      // What staff may see is still there: the learner's evidence and progress.
      expect(body.attempts.items.length).toBeGreaterThan(0);
      expect(body.evidence.items.length).toBeGreaterThan(0);
    }
    const own = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ audience: "learner", withheld: [] });
    for (const marker of markers) expect(own.body, marker).toContain(marker);
    expect(own.json().learnerModel.profile.profile.thoughts).toBe("Thoughts " + canary);
    expect(own.json().companion.items.map((m: { content: string }) => m.content)).toContain("Private question " + canary);
    // The learner sees both staff downloads.
    const listed = (await call(learner, "GET", `/api/enrollments/${enrollment}/staff-views`)).json();
    expect(listed.exports.map((x: { exporterRole: string }) => x.exporterRole)).toEqual(["owner", "admin"]);
  });

  it("lists staff exports for the learner next to staff views, includes them in the learner's export and keeps them through erasure", async () => {
    const viewed = (await call(admin, "GET", viewUrl())).json();
    expect((await staffExport(owner)).statusCode).toBe(200);
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}/export`)).statusCode).toBe(200);
    const [ownerExport] = await exportRows();
    const listed = (await call(learner, "GET", `/api/enrollments/${enrollment}/staff-views`)).json();
    expect(listed.views).toEqual([{ id: viewed.view.id, viewedAt: viewed.view.viewedAt, viewerName: "admin person", viewerRole: "admin" }]);
    // The learner's own download is not staff access and is not listed.
    expect(listed.exports).toEqual([{ id: ownerExport.id, exportedAt: expect.any(String), exporterName: "owner person", exporterRole: "owner" }]);
    expect(JSON.stringify(listed)).not.toContain(owner.userId);
    // The learner's export carries every earlier staff export, with the digest of what was sent.
    const mine = (await call(learner, "GET", `/api/enrollments/${enrollment}/export`)).json();
    expect(mine.staffExports).toEqual([
      { id: ownerExport.id, exportedAt: listed.exports[0].exportedAt, exporterId: owner.userId, exporterName: "owner person", exporterRole: "owner", digest: ownerExport.digest },
    ]);
    expect(mine.staffViews).toHaveLength(1);
    // A later staff export contains the earlier one; the one being built is recorded once it is complete.
    const again = (await staffExport(admin)).json();
    expect(again.staffExports.map((x: { exporterRole: string }) => x.exporterRole)).toEqual(["owner"]);
    const relisted = (await call(learner, "GET", `/api/enrollments/${enrollment}/staff-views`)).json();
    expect(relisted.exports.map((x: { exporterRole: string }) => x.exporterRole)).toEqual(["owner", "admin"]);
    // Another learner cannot read this list.
    expect((await call(await session("learner"), "GET", `/api/enrollments/${enrollment}/staff-views`)).statusCode).toBe(404);
    // Erasure keeps the export records (they hold no learner content) and they stay in the learner's export.
    const before = await exportRows();
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Learner asked for their data to be removed." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(await exportRows()).toEqual(before);
    const after = (await call(learner, "GET", `/api/enrollments/${enrollment}/export`)).json();
    expect(after.staffExports.map((x: { exporterRole: string }) => x.exporterRole)).toEqual(["owner", "admin"]);
    expect(after.staffViews).toHaveLength(1);
    expect(JSON.stringify(after)).not.toContain(canary);
  });
});
