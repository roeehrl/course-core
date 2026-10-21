import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { auditCsv } from "../src/workspace-audit.js";
import { policyChanges, RECOVERY_TARGETS } from "../src/platform-operations.js";
import { previewAsLearners } from "../src/release-editing.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: safe draft editing (check before save, preview as representative
// learners, confirmed forward publish), the audit export and policy history, provider-billed
// figures, integrations and the platform-readiness page, with role refusals for each.
const origin = "http://localhost:4391",
  schema = "admin_operations_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, author: Session, instructor: Session, support: Session, learner: Session, catalog: string, v1: string;
let versions = 0;

async function person(role: string, name = role + " person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "ops:" + id, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
const course = (version: string, edit?: (c: CourseManifest) => void) => {
  const c = fixture();
  c.version = version;
  edit?.(c);
  return c;
};
const revision = async () => (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json().revision as string;
const command = async (who: Session, url: string, payload: unknown) =>
  call(who, "POST", `/api/admin/courses/${catalog}${url}`, payload, { "if-match": await revision(), "idempotency-key": "cmd-" + randomUUID() });
/** An approved draft of `manifest`, created through the admin routes. */
async function approvedDraft(manifest: CourseManifest) {
  const created = await command(owner, "/releases", { version: manifest.version, notes: "Draft for the test.", manifest });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().workspace.releases.find((r: { version: string }) => r.version === manifest.version).id as string;
  expect((await command(owner, `/releases/${id}/transitions`, { action: "submit-review" })).statusCode).toBe(200);
  expect((await command(owner, `/releases/${id}/transitions`, { action: "approve" })).statusCode).toBe(200);
  return id;
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ops-" + workspace, "Operations"]);
  owner = await person("owner", "Owner Ada");
  author = await person("author");
  instructor = await person("instructor");
  support = await person("support_observer");
  learner = await person("learner", "Learner Canary Name");
  v1 = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course(`1.${versions++}.0`))).json().id;
  expect((await call(owner, "POST", `/api/releases/${v1}/publish`)).statusCode).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("draft editing (Q03, Q14)", () => {
  it("checks a manifest before saving: problems by code and path, identity, runtime and changes", async () => {
    const draft = (await command(owner, "/releases", { version: "9.0.0", notes: "Edit me." })).json().workspace.releases.find((r: { version: string }) => r.version === "9.0.0").id;
    const check = (who: Session, manifest: unknown) => call(who, "POST", `/api/admin/courses/${catalog}/releases/${draft}/check`, { manifest });
    const good = await check(author, course("9.0.0", (c) => { c.chapters[0]!.episodes[0]!.title = "Smallest value"; }));
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json()).toMatchObject({ valid: true, issues: [], identityMatches: true, runtime: { ready: true, code: null },
      summary: { chapters: 1, episodes: 2, assessments: 4 }, changes: { identical: false, kinds: { episodes: { changed: ["min"] } } } });
    const wrongVersion = await check(author, course("9.0.1"));
    expect(wrongVersion.json()).toMatchObject({ valid: true, identityMatches: false });
    const broken = course("9.0.0");
    (broken.chapters[0]!.episodes[0] as { title?: string }).title = undefined;
    const bad = await check(author, broken);
    expect(bad.statusCode).toBe(200);
    expect(bad.json().valid).toBe(false);
    expect(bad.json().issues.length).toBeGreaterThan(0);
    expect(bad.json().issues[0]).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9_.-]+$/), path: expect.any(String) });
    // Nothing was saved by a check.
    expect((await call(author, "GET", `/api/admin/courses/${catalog}/releases/${draft}/manifest`)).json().manifest.chapters[0].episodes[0].title).toBe("Minimum");
    expect((await check(instructor, course("9.0.0"))).statusCode).toBe(403);
    expect((await call(author, "POST", `/api/admin/courses/${catalog}/releases/${draft}/check`, {})).statusCode).toBe(400);
  });

  it("previews a draft as representative synthetic learners, saved or unsaved", async () => {
    const draft = await approvedDraft(course("9.1.0"));
    const preview = await call(author, "POST", `/api/admin/courses/${catalog}/releases/${draft}/preview`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json();
    expect(body).toMatchObject({ source: "saved", syntheticLearners: true, course: { version: "9.1.0" } });
    expect(body.profiles.map((p: { profile: string }) => p.profile)).toEqual(["new_learner", "placed_out", "first_chapter_done", "nearly_finished"]);
    const fresh = body.profiles[0];
    expect(fresh).toMatchObject({ complete: false, counts: { available: 1, locked: 1 }, next: { episodeId: "min", title: "Minimum" } });
    expect(fresh.next.blocks[0]).toMatchObject({ type: "text", excerpt: "The minimum is no greater than any other member." });
    expect(fresh.next.blocks[1]).toMatchObject({ type: "assessment", assessmentId: "min-a", itemType: "choice" });
    // A learner who finished the first (only) chapter has completed the course.
    expect(body.profiles[2]).toMatchObject({ complete: true, next: null });
    expect(body.profiles[3]).toMatchObject({ counts: { completed: 1, available: 1 }, next: { episodeId: "max" } });
    const unsaved = await call(author, "POST", `/api/admin/courses/${catalog}/releases/${draft}/preview`,
      { manifest: course("9.1.0", (c) => { c.chapters[0]!.episodes[0]!.title = "Unsaved title"; }) });
    expect(unsaved.json()).toMatchObject({ source: "unsaved" });
    expect(unsaved.json().profiles[0].next.title).toBe("Unsaved title");
    expect((await call(author, "POST", `/api/admin/courses/${catalog}/releases/${draft}/preview`, { manifest: course("9.9.9") })).json().error).toBe("COURSE_IDENTITY_MISMATCH");
    // Instructors see published releases only.
    expect((await call(instructor, "POST", `/api/admin/courses/${catalog}/releases/${draft}/preview`, {})).statusCode).toBe(403);
    expect((await call(instructor, "POST", `/api/admin/courses/${catalog}/releases/${v1}/preview`, {})).statusCode).toBe(200);
  });

  it("requires confirming the forward-publish impact while learners are pinned, and refuses a changed one", async () => {
    // No learner on the live release: nothing to confirm.
    const quiet = await approvedDraft(course("9.2.0"));
    const first = await command(owner, `/releases/${quiet}/transitions`, { action: "publish" });
    expect(first.statusCode, first.body).toBe(200);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: quiet })).json().id;
    expect(enrollment).toBeTruthy();
    const draft = await approvedDraft(course("9.3.0", (c) => { c.assessments.find((a) => a.id === "min-b")!.prompt = "Minimum of 6 and 3?"; }));
    const impact = await call(owner, "GET", `/api/admin/courses/${catalog}/releases/${draft}/publish-impact`);
    expect(impact.statusCode, impact.body).toBe(200);
    expect(impact.json()).toMatchObject({ confirmationRequired: true, impact: { learnersPinnedToActive: 1, changedOrRemovedItems: ["min-b"],
      existingLearnersMove: false, newLearnersGet: "9.3.0", defectiveItemsFixed: [], kinds: { assessments: { changed: 1 } } } });
    expect((await call(instructor, "GET", `/api/admin/courses/${catalog}/releases/${draft}/publish-impact`)).statusCode).toBe(403);
    const missing = await command(owner, `/releases/${draft}/transitions`, { action: "publish" });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ error: "IMPACT_CONFIRMATION_REQUIRED", details: { impactDigest: impact.json().impactDigest } });
    // Another learner joins: the confirmed analysis is out of date.
    const other = await person("learner");
    await call(other, "POST", "/api/enrollments", { releaseId: quiet });
    const stale = await command(owner, `/releases/${draft}/transitions`, { action: "publish", impactDigest: impact.json().impactDigest });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "IMPACT_CHANGED", details: { impact: { learnersPinnedToActive: 2 } } });
    const published = await command(owner, `/releases/${draft}/transitions`, { action: "publish", impactDigest: stale.json().details.impactDigest });
    expect(published.statusCode, published.body).toBe(200);
    // Nobody moved.
    expect((await db.query("SELECT course_release_id FROM enrollments WHERE id=$1", [enrollment])).rows[0].course_release_id).toBe(quiet);
    expect((await call(owner, "GET", `/api/admin/courses/${catalog}/releases/${draft}/publish-impact`)).statusCode).toBe(409);
  });

  it("previews synthetic learners with the engine's own rules", () => {
    const c = course("1.0.0");
    c.chapters.push({ id: "extra", title: "Extra", episodes: [{ id: "opt", title: "Optional", objectiveIds: ["minimum"], requirement: "optional", blocks: [] }] });
    const preview = previewAsLearners(c, "d".repeat(64));
    expect(preview.outline.map((ch) => ch.id)).toEqual(["order", "extra"]);
    expect(preview.profiles[2]!.lessons.find((l) => l.episodeId === "opt")).toMatchObject({ requirement: "optional", chapterId: "extra" });
  });
});

describe("audit export and policy history (Q12)", () => {
  it("exports CSV and JSON with the page's privacy projection, records the export and refuses other roles", async () => {
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: v1 })).json().id;
    const rev = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().revision;
    await call(learner, "POST", `/api/enrollments/${enrollment}/profile`, { expectedRevision: rev, idempotencyKey: randomUUID(),
      profile: { displayName: "Learner Canary Name", goal: "SECRET GOAL CANARY", pace: "steady" } });
    const day = new Date().toISOString().slice(0, 10);
    const url = (format: string, extra = "") => `/api/admin/workspaces/${workspace}/audit/export?format=${format}&from=${day}&to=${day}${extra}`;
    const csv = await call(owner, "GET", url("csv"));
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers["content-disposition"]).toBe(`attachment; filename="audit-${day}-to-${day}.csv"`);
    expect(csv.headers["cache-control"]).toBe("no-store");
    expect(csv.body.split("\r\n")[0]).toBe("sequence,id,at,actorKind,actor,type,enrollmentId,payloadWithheld,payload");
    expect(csv.body).not.toContain("SECRET GOAL CANARY");
    expect(csv.body).not.toContain("Learner Canary Name");
    const json = await call(owner, "GET", url("json", "&actorKind=learner"));
    expect(json.json()).toMatchObject({ kind: "course-core-audit-export", truncated: false, actorKind: "learner" });
    expect(json.json().events.length).toBeGreaterThan(0);
    expect(json.json().events.every((e: { actorKind: string; payload: unknown; payloadWithheld: boolean }) => e.actorKind === "learner" && e.payload === null && e.payloadWithheld)).toBe(true);
    // The export itself is in the log, with its digest.
    const logged = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='audit.exported' ORDER BY sequence", [workspace])).rows;
    expect(logged).toHaveLength(2);
    expect(logged[0].payload).toMatchObject({ format: "csv", rows: Number(csv.headers["x-export-rows"]), digest: csv.headers["x-export-digest"] });
    // Support observers read the log on the page but cannot download it; instructors neither.
    expect((await call(support, "GET", `/api/admin/workspaces/${workspace}/audit?limit=5`)).statusCode).toBe(200);
    expect((await call(support, "GET", url("csv"))).statusCode).toBe(403);
    expect((await call(instructor, "GET", url("json"))).statusCode).toBe(403);
    expect((await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit/export?format=xml&from=${day}&to=${day}`)).statusCode).toBe(400);
    expect((await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit/export?format=csv&from=2020-01-01&to=${day}`)).json().error).toBe("AUDIT_EXPORT_RANGE_INVALID");
  });

  it("neutralises spreadsheet formulas in CSV cells", () => {
    const row = { sequence: "1", id: "e", at: "t", actorKind: "staff" as const, actor: "=HYPERLINK(\"x\")", type: "t", enrollmentId: null, payload: { a: "b,c" }, payloadWithheld: false };
    const [, line] = auditCsv([row]).split("\r\n");
    expect(line).toBe(`1,e,t,staff,"'=HYPERLINK(""x"")",t,,false,"{""a"":""b,c""}"`);
  });

  it("lists policy and placement setting changes as field diffs, newest first", async () => {
    const view = (await call(owner, "GET", `/api/admin/courses/${catalog}/policy-settings`)).json();
    const save = (settings: Record<string, unknown>, expectedRevision: number) =>
      call(owner, "PUT", `/api/admin/courses/${catalog}/policy-settings`, { expectedRevision, settings, reason: "Pilot cohort needs more time." });
    const first = await save({ ...view.settings }, view.revision);
    expect(first.statusCode, first.body).toBe(200);
    const changedKey = Object.keys(view.settings).find((k) => typeof view.settings[k] === "number")!;
    expect((await save({ ...view.settings, [changedKey]: view.settings[changedKey] + 1 }, first.json().revision)).statusCode).toBe(200);
    const history = await call(owner, "GET", `/api/admin/courses/${catalog}/policy-history`);
    expect(history.statusCode, history.body).toBe(200);
    const settings = history.json().entries.filter((e: { source: string }) => e.source === "course_settings");
    expect(settings).toHaveLength(2);
    expect(settings[0]).toMatchObject({ actor: "Owner Ada", reason: "Pilot cohort needs more time.",
      changes: [{ path: changedKey, before: String(view.settings[changedKey]), after: String(view.settings[changedKey] + 1) }] });
    expect(history.json().entries.some((e: { source: string; version: string }) => e.source === "release_policy" && e.version)).toBe(true);
    expect((await call(learner, "GET", `/api/admin/courses/${catalog}/policy-history`)).statusCode).toBe(403);
    expect(policyChanges({ a: { b: 1 } }, { a: { b: 2, c: true } })).toEqual([{ path: "a.b", before: "1", after: "2" }, { path: "a.c", before: null, after: "true" }]);
  });
});

describe("billed versus estimated cost (U04)", () => {
  it("records a provider-billed figure next to the estimate for the same days, idempotently", async () => {
    const base = `/api/admin/workspaces/${workspace}/billing-statements`;
    const today = new Date().toISOString().slice(0, 10);
    const input = { idempotencyKey: "bill-" + randomUUID(), providerLabel: "Example AI", periodStart: today, periodEnd: today, billedMicroUsd: 1_250_000, sourceNote: "October invoice, line 3" };
    const saved = await call(owner, "POST", base, input);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ replayed: false, estimatesAreEstimates: true, statements: [{ providerLabel: "Example AI", billedMicroUsd: 1_250_000,
      estimate: { chargedMicroUsd: 0, calls: 0 }, differenceMicroUsd: 1_250_000, recordedBy: "Owner Ada" }] });
    expect((await call(owner, "POST", base, input)).json()).toMatchObject({ replayed: true, id: saved.json().id });
    expect((await call(owner, "POST", base, { ...input, billedMicroUsd: 1 })).statusCode).toBe(409);
    expect((await call(owner, "POST", base, { ...input, idempotencyKey: "bill-" + randomUUID(), periodStart: "2026-01-10", periodEnd: "2026-01-01" })).json().error).toBe("BILLING_PERIOD_INVALID");
    expect((await call(owner, "POST", base, { ...input, idempotencyKey: "bill-" + randomUUID(), providerLabel: "<script>" })).statusCode).toBe(400);
    expect((await call(owner, "POST", base, { ...input, idempotencyKey: "bill-" + randomUUID(), apiKey: "x" })).statusCode).toBe(400);
    expect((await call(instructor, "GET", base)).statusCode).toBe(403);
    expect((await call(support, "POST", base, { ...input, idempotencyKey: "bill-" + randomUUID() })).statusCode).toBe(403);
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE workspace_id=$1 AND event_type='provider.billed_statement_recorded'", [workspace])).rows[0].n).toBe(1);
  });
});

describe("platform readiness and integrations (Q11, Q12, T03)", () => {
  it("reports each part's state and monitors the recovery targets from the backup reports", async () => {
    await db.query("DELETE FROM platform_backup_reports");
    const url = `/api/admin/workspaces/${workspace}/platform-readiness`;
    const empty = await call(owner, "GET", url);
    expect(empty.statusCode, empty.body).toBe(200);
    const byId = (body: { checks: { id: string; status: string; facts: Record<string, unknown> }[] }) => Object.fromEntries(body.checks.map((c) => [c.id, c]));
    const checks = byId(empty.json());
    expect(Object.keys(checks)).toEqual(["database", "temporal", "sandbox", "collector", "version", "backups"]);
    expect(checks.database).toMatchObject({ status: "ok", facts: { postgresMajor: 17, migrationsCurrent: true } });
    expect(checks.temporal!.status).toBe("not_configured");
    expect(checks.sandbox!.status).toBe("not_configured");
    expect(checks.collector!.status).toBe("not_configured");
    expect(empty.json().targets).toMatchObject({ rpo: { targetMinutes: 60, currentMinutes: null, status: "no_data" }, rto: { status: "no_data" } });
    const report = (kind: string, outcome: string, minutesAgo: number, durationSeconds: number, code: string | null = null) =>
      db.query(`INSERT INTO platform_backup_reports(id,kind,outcome,code,started_at,finished_at,encrypted,core_version,tables,rows,bytes)
        VALUES($1,$2,$3,$4,clock_timestamp()-make_interval(mins=>$5)-make_interval(secs=>$6),clock_timestamp()-make_interval(mins=>$5),true,'0.1.50',80,1200,40960)`,
        [randomUUID(), kind, outcome, code, minutesAgo, durationSeconds]);
    await report("snapshot", "succeeded", 200, 4);
    await report("restore_drill", "succeeded", 300, 90);
    let body = (await call(owner, "GET", url)).json();
    expect(body.targets).toMatchObject({ rpo: { currentMinutes: 200, status: "failing" }, rto: { lastDrillMinutes: 2, status: "ok", drillAgeDays: 0 } });
    expect(body.overall).toBe("failing");
    await report("snapshot", "succeeded", 20, 4);
    await report("snapshot", "failed", 5, 1, "pg_dump_failed");
    body = (await call(owner, "GET", url)).json();
    expect(body.targets.rpo).toMatchObject({ currentMinutes: 20, status: "ok" });
    expect(byId(body).backups).toMatchObject({ status: "warning", facts: { lastSnapshot: { encrypted: true, rows: 1200 }, lastFailure: { code: "pg_dump_failed" } } });
    await report("restore_drill", "failed", 1, 30, "restored_row_counts_differ");
    expect((await call(owner, "GET", url)).json().targets.rto.status).toBe("failing");
    expect(RECOVERY_TARGETS).toMatchObject({ rpoMinutes: 60, rtoMinutes: 60 });
    expect(JSON.stringify(body)).not.toMatch(/\/Users\/|postgres:\/\//);
    for (const who of [author, instructor, support, learner]) expect((await call(who, "GET", url)).statusCode).toBe(403);
  });

  it("lists runtime versions, extensions, course compatibility, package receipts and connections without secrets", async () => {
    const r = await call(owner, "GET", `/api/admin/workspaces/${workspace}/integrations`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ runtime: { courseSchemaVersion: 1 }, telemetry: { export: "off" }, packageReceipts: [], providers: [],
      courses: [{ catalogId: catalog, courseKey: "ordering", liveVersion: expect.any(String), extensions: [] }] });
    expect(r.json().runtime.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect((await call(instructor, "GET", `/api/admin/workspaces/${workspace}/integrations`)).statusCode).toBe(403);
    expect((await call(owner, "GET", `/api/admin/workspaces/not-a-uuid/integrations`)).statusCode).toBe(400);
  });
});
