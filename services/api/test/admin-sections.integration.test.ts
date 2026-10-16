import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { adminSectionSettingsFor } from "../src/admin-sections.js";

// Real HTTP and PostgreSQL 17: a course pack unrelated to Core (the public plant-journal example)
// declares admin sections with the SDK; Core lists, renders and enforces them server-side.
const origin = "http://localhost:4396",
  schema = "admin_sections_" + randomUUID().replaceAll("-", "");
const pack = JSON.parse(readFileSync(new URL("../../../examples/courses/packs/plant-journal.json", import.meta.url), "utf8")) as CourseManifest;
const chapterId = pack.chapters[0]!.id;
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, author: Session, instructor: Session, reviewer: Session, observer: Session, learner: Session, catalog: string, release: string, enrollment: string;

function withSections(version: string, overrides: Partial<{ maxReminder: number }> = {}): CourseManifest {
  return {
    ...structuredClone(pack),
    version,
    adminSections: [
      {
        id: "journal-reminders", version: "1.0.0", title: "Journal reminders", description: "How the notebook nudges learners to record observations.",
        requiredPermissions: ["course.read", "course.settings.write"], learnerDataAccess: "none", audit: "all_mutations",
        settings: [
          { id: "reminder-hours", label: "Hours between reminders", scope: "course", mutationPermission: "course.settings.write", type: "integer", default: 24, minimum: 1, maximum: overrides.maxReminder ?? 72 },
          { id: "units", label: "Measurement units", scope: "course", mutationPermission: "course.settings.write", type: "enum", default: "metric", options: ["metric", "imperial"] },
          { id: "show-supplied-records", label: "Show supplied records first", scope: "chapter", mutationPermission: "course.settings.write", type: "boolean", default: true },
          { id: "notebook-label", label: "Notebook label", scope: "enrollment", mutationPermission: "course.settings.write", type: "string", default: "", maxLength: 40 },
        ],
      },
      {
        id: "nudge-tuning", version: "1.0.0", title: "Nudge tuning", requiredPermissions: ["policy.read", "supervision.control"], learnerDataAccess: "aggregate", audit: "all_mutations",
        settings: [{ id: "nudge-level", label: "Nudge level", scope: "course", mutationPermission: "supervision.control", type: "enum", default: "gentle", options: ["gentle", "firm"] }],
      },
      {
        id: "trace-tools", version: "1.0.0", title: "Trace tools", requiredPermissions: ["debug.read", "debug.payload", "learners.read_evidence", "course.settings.write"], learnerDataAccess: "scoped_with_consent", audit: "all_mutations",
        settings: [{ id: "trace-depth", label: "Trace depth", scope: "course", mutationPermission: "course.settings.write", type: "number", default: 1.5, minimum: 0.5, maximum: 4 }],
      },
    ],
  } as CourseManifest;
}

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "as:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const sections = (who: Session) => call(who, "GET", `/api/admin/courses/${catalog}/admin-sections`);
const section = (who: Session, id: string, query = "") => call(who, "GET", `/api/admin/courses/${catalog}/admin-sections/${id}${query}`);
const put = (who: Session, id: string, body: Record<string, unknown>) =>
  call(who, "PUT", `/api/admin/courses/${catalog}/admin-sections/${id}/values`, { scope: "course", scopeRef: "", expectedRevision: 0, ...body });
const settingOf = (body: { section: { settings: { id: string }[] } }, id: string) => body.section.settings.find((s) => s.id === id) as Record<string, unknown>;
async function publish(manifest: CourseManifest) {
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest);
  expect(created.statusCode, created.body).toBe(200);
  expect((await call(owner, "POST", `/api/releases/${created.json().id}/publish`)).statusCode).toBe(200);
  return created.json().id as string;
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "as-" + workspace, "Admin sections"]);
  owner = await person("owner");
  author = await person("author");
  instructor = await person("instructor");
  reviewer = await person("reviewer");
  observer = await person("observer");
  learner = await person("learner");
  release = await publish(withSections("1.0.0"));
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("admin sections declared by an unrelated course pack", () => {
  it("lists only the sections each role may open, and hides any needing a permission Core does not grant", async () => {
    const titles = async (who: Session) => (await sections(who)).json().sections.map((s: { id: string }) => s.id);
    expect(await titles(owner)).toEqual(["journal-reminders", "nudge-tuning"]);
    expect(await titles(author)).toEqual(["journal-reminders"]);
    expect(await titles(instructor)).toEqual(["journal-reminders", "nudge-tuning"]);
    expect(await titles(reviewer)).toEqual(["journal-reminders", "nudge-tuning"]);
    expect(await titles(observer)).toEqual(["journal-reminders"]);
    expect((await sections(owner)).json()).toMatchObject({ chapters: [{ id: chapterId }] });
    // debug.payload has no Core permission: even an owner cannot open that section by URL.
    expect((await section(owner, "trace-tools")).json().error).toBe("FORBIDDEN");
    expect((await section(author, "nudge-tuning")).statusCode).toBe(403);
    expect((await section(owner, "missing-section")).statusCode).toBe(404);
    expect((await sections(learner)).statusCode).toBe(403);
    expect((await section(learner, "journal-reminders")).statusCode).toBe(403);
  });

  it("renders defaults from the schema with per-setting edit rights, without loading course code or learner data", async () => {
    const owned = (await section(owner, "journal-reminders")).json();
    expect(owned.section).toMatchObject({ title: "Journal reminders", version: "1.0.0", revision: 0, scopes: ["course", "chapter", "enrollment"], scope: "course",
      learnerDataShared: false, renderer: { kind: "core_schema_form", declaredRendererLoaded: false } });
    expect(owned.section.settings.map((s: { id: string }) => s.id)).toEqual(["reminder-hours", "units"]);
    expect(settingOf(owned, "reminder-hours")).toMatchObject({ type: "integer", value: 24, source: "default", minimum: 1, maximum: 72, canEdit: true });
    // Read-only for roles without the mutation permission.
    expect(settingOf((await section(observer, "journal-reminders")).json(), "units")).toMatchObject({ value: "metric", canEdit: false });
    expect(settingOf((await section(reviewer, "nudge-tuning")).json(), "nudge-level")).toMatchObject({ canEdit: false });
    expect(settingOf((await section(instructor, "nudge-tuning")).json(), "nudge-level")).toMatchObject({ canEdit: true });
    expect(settingOf((await section(instructor, "journal-reminders")).json(), "units")).toMatchObject({ canEdit: false });
  });

  it("saves valid values with a revision and an audit entry, and refuses everything else on the server", async () => {
    const saved = await put(author, "journal-reminders", { values: { "reminder-hours": 12, units: "imperial" } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().section).toMatchObject({ revision: 1, savedForVersion: "1.0.0" });
    expect(settingOf(saved.json(), "reminder-hours")).toMatchObject({ value: 12, source: "saved" });

    // Stale revision, out of bounds, wrong type, unknown setting, wrong scope, no rights.
    expect((await put(owner, "journal-reminders", { values: { units: "metric" } })).json().error).toBe("STALE_REVISION");
    const at = { expectedRevision: 1 };
    expect((await put(owner, "journal-reminders", { ...at, values: { "reminder-hours": 73 } })).json().error).toBe("ADMIN_SETTING_INVALID");
    expect((await put(owner, "journal-reminders", { ...at, values: { "reminder-hours": 2.5 } })).json().error).toBe("ADMIN_SETTING_INVALID");
    expect((await put(owner, "journal-reminders", { ...at, values: { units: "furlongs" } })).json().error).toBe("ADMIN_SETTING_INVALID");
    expect((await put(owner, "journal-reminders", { ...at, values: { units: true } })).json().error).toBe("ADMIN_SETTING_INVALID");
    expect((await put(owner, "journal-reminders", { ...at, values: { "grade-override": 1 } })).json().error).toBe("ADMIN_SETTING_UNKNOWN");
    expect((await put(owner, "journal-reminders", { ...at, values: { "show-supplied-records": false } })).json().error).toBe("ADMIN_SETTING_SCOPE_MISMATCH");
    expect((await put(owner, "journal-reminders", { ...at, values: {} })).json().error).toBe("INVALID_REQUEST");
    expect((await put(instructor, "journal-reminders", { ...at, values: { units: "metric" } })).statusCode).toBe(403);
    expect((await put(observer, "journal-reminders", { ...at, values: { units: "metric" } })).statusCode).toBe(403);
    expect((await put(learner, "journal-reminders", { ...at, values: { units: "metric" } })).statusCode).toBe(403);
    expect((await put(author, "nudge-tuning", { values: { "nudge-level": "firm" } })).statusCode).toBe(403);
    expect((await put(reviewer, "nudge-tuning", { values: { "nudge-level": "firm" } })).statusCode).toBe(403);
    expect((await put(owner, "trace-tools", { values: { "trace-depth": 2 } })).statusCode).toBe(403);
    expect((await put(instructor, "nudge-tuning", { values: { "nudge-level": "firm" } })).statusCode).toBe(200);
    expect(settingOf((await section(owner, "journal-reminders")).json(), "reminder-hours")).toMatchObject({ value: 12 });

    // Only the two accepted writes were stored and audited, with who, what and from/to values.
    const audit = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=admin_section.settings_changed`)).json().events;
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ actorKind: "staff", actor: "author person", payloadWithheld: false, payload: { catalogId: catalog, releaseId: release, sectionId: "journal-reminders", sectionVersion: "1.0.0",
      scope: "course", scopeRef: "", revision: 1, changes: [{ settingId: "reminder-hours", from: 24, to: 12 }, { settingId: "units", from: "metric", to: "imperial" }] } });
  });

  it("keeps chapter and enrollment values to targets in this course, and a trusted extension reads the effective values", async () => {
    const chapterQuery = `?scope=chapter&scopeRef=${chapterId}`;
    expect((await section(owner, "journal-reminders", chapterQuery)).json().section.settings.map((s: { id: string }) => s.id)).toEqual(["show-supplied-records"]);
    expect((await put(owner, "journal-reminders", { scope: "chapter", scopeRef: chapterId, values: { "show-supplied-records": false } })).statusCode).toBe(200);
    expect((await put(owner, "journal-reminders", { scope: "chapter", scopeRef: "no-such-chapter", values: { "show-supplied-records": false } })).json().error).toBe("ADMIN_SECTION_SCOPE_INVALID");
    expect((await put(owner, "journal-reminders", { scope: "course", scopeRef: chapterId, values: { units: "metric" } })).json().error).toBe("ADMIN_SECTION_SCOPE_INVALID");
    expect((await put(owner, "journal-reminders", { scope: "enrollment", scopeRef: enrollment, values: { "notebook-label": "Kitchen window basil" } })).statusCode).toBe(200);
    expect((await put(owner, "journal-reminders", { scope: "enrollment", scopeRef: enrollment, expectedRevision: 1, values: { "notebook-label": "x".repeat(41) } })).json().error).toBe("ADMIN_SETTING_INVALID");
    expect((await put(owner, "journal-reminders", { scope: "enrollment", scopeRef: enrollment, expectedRevision: 1, values: { "notebook-label": "bell\u0007" } })).json().error).toBe("ADMIN_SETTING_INVALID");
    // An author has no enrollment.read: enrollment targets are closed to them.
    expect((await section(author, "journal-reminders", `?scope=enrollment&scopeRef=${enrollment}`)).statusCode).toBe(403);
    // An enrollment of another workspace's course is not a target here.
    const otherWorkspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [otherWorkspace, "as-" + otherWorkspace, "Other"]);
    const savedWorkspace = workspace; workspace = otherWorkspace;
    const otherOwner = await person("owner"), otherLearner = await person("learner");
    const otherRelease = (await call(otherOwner, "POST", `/api/workspaces/${otherWorkspace}/releases`, withSections("1.0.0"))).json().id;
    await call(otherOwner, "POST", `/api/releases/${otherRelease}/publish`);
    const foreign = (await call(otherLearner, "POST", "/api/enrollments", { releaseId: otherRelease })).json().id;
    workspace = savedWorkspace;
    expect((await put(owner, "journal-reminders", { scope: "enrollment", scopeRef: foreign, values: { "notebook-label": "x" } })).json().error).toBe("ADMIN_SECTION_SCOPE_INVALID");
    // The enrollment-scoped change is on that enrollment's own record, so its learner sees it was made.
    const row = (await db.query("SELECT enrollment_id,actor_kind FROM learning_events WHERE event_type='admin_section.settings_changed' AND enrollment_id=$1", [enrollment])).rows;
    expect(row).toEqual([{ enrollment_id: enrollment, actor_kind: "staff" }]);

    const e = (await db.query("SELECT * FROM enrollments WHERE id=$1", [enrollment])).rows[0];
    expect(await adminSectionSettingsFor(db, e, "journal-reminders")).toEqual({ "reminder-hours": 24, units: "metric", "show-supplied-records": false, "notebook-label": "Kitchen window basil" });
    expect(await adminSectionSettingsFor(db, e, "absent")).toBeNull();
  });

  it("falls back to the default when a later release narrows a setting, and never trusts the old value", async () => {
    expect((await put(owner, "journal-reminders", { values: { "reminder-hours": 60 } })).statusCode).toBe(200);
    await publish(withSections("1.1.0", { maxReminder: 48 }));
    const narrowed = (await section(owner, "journal-reminders")).json();
    expect(narrowed.release.version).toBe("1.1.0");
    expect(settingOf(narrowed, "reminder-hours")).toMatchObject({ value: 24, source: "default", discardedSavedValue: true, maximum: 48 });
    // Saving another setting drops the invalid value rather than carrying it forward.
    expect((await put(owner, "journal-reminders", { expectedRevision: 1, values: { units: "imperial" } })).statusCode).toBe(200);
    const stored = (await db.query("SELECT setting_values FROM admin_section_values WHERE section_id='journal-reminders' AND scope='course' AND workspace_id=$1", [workspace])).rows[0];
    expect(stored.setting_values).toEqual({ units: "imperial" });
  });

  it("honours course-scoped grants and their revocation on every section route", async () => {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "as:" + id, "scoped author"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'course_scoped')", [workspace, id]);
    const grant = randomUUID();
    await db.query(`INSERT INTO course_access_grants(id,workspace_id,catalog_id,user_id,role,reason_code,granted_by,expires_at)
      VALUES($1,$2,$3,$4,'author','contract_author',$5,clock_timestamp()+interval '1 day')`, [grant, workspace, catalog, id, owner.userId]);
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    const scoped = { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
    expect((await put(scoped, "journal-reminders", { values: { units: "imperial" } })).statusCode).toBe(200);
    await db.query("UPDATE course_access_grants SET revoked_at=clock_timestamp(),revoked_by=$2,revoke_reason_code='ended' WHERE id=$1", [grant, owner.userId]);
    expect((await sections(scoped)).statusCode).toBe(403);
    expect((await put(scoped, "journal-reminders", { expectedRevision: 1, values: { units: "metric" } })).statusCode).toBe(403);
  });
});
