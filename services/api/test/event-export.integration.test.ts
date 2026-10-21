import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { MAX_PAGE, type LearningEventExport } from "../src/event-export.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: the portable learning-event export (K14) in the SDK 0.6.0
// learningEventExport format, validated against the vendored SDK schema.
const schemaJson = JSON.parse(readFileSync(new URL("../src/vendor/sdk-event-export/learning-event-export.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validateShape = ajv.compile(schemaJson);
/** Shape (vendored schema) plus the SDK's semantic rules for the record (records.ts learningEventExport). */
function sdkIssues(value: LearningEventExport): string[] {
  const issues = validateShape(value) ? [] : (validateShape.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
  const after = BigInt(value.cursor.after), through = BigInt(value.cursor.through);
  if (after > through) issues.push("cursor reversed");
  let previous = after;
  const ids = new Set<string>();
  for (const event of value.events) {
    const sequence = BigInt(event.sequence);
    if (sequence <= previous || sequence > through) issues.push(`sequence ${event.sequence} outside cursor`);
    previous = sequence > previous ? sequence : previous;
    if (ids.has(event.eventId)) issues.push(`duplicate ${event.eventId}`);
    ids.add(event.eventId);
  }
  return issues;
}

const origin = "http://localhost:4391",
  schema = "event_export_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, release: string, enrollment: string;
interface Session { userId: string; cookie: string; csrf: string }
const sessions: Record<string, Session> = {};
const MARKER = "event-export-private-" + randomUUID().slice(0, 8);

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "event-export:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function command(action: string, body: Record<string, unknown>) {
  const snapshot = (await call(sessions.learner!, "GET", "/api/enrollments/" + enrollment)).json();
  const r = await call(sessions.learner!, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), ...body });
  expect(r.statusCode, action + " " + r.body).toBe(200);
  return r.json();
}
const exportOf = (who: Session, query = "", prefix = "/api/enrollments") => call(who, "GET", `${prefix}/${enrollment}/event-export${query}`);

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "events-" + workspace, "Event export"]);
  for (const role of ["owner", "admin", "instructor", "reviewer", "learner"]) sessions[role] = await session(role);
  sessions.otherLearner = await session("learner");
  release = (await call(sessions.owner!, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(sessions.owner!, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(sessions.learner!, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await command("read", { episodeId: "min", blockId: "min-text" });
  const challenge = await command("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
  await command("answers", { challengeId: challenge.challengeId, answer: 4 });
  await command("companion", { episodeId: "min", content: "Private question " + MARKER });
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("portable learning event export", () => {
  it("gives the learner every event of their own enrollment in the SDK learningEventExport format", async () => {
    const r = await exportOf(sessions.learner!);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["course-core-export-has-more"]).toBe("false");
    const doc = r.json() as LearningEventExport;
    expect(sdkIssues(doc)).toEqual([]);
    const course = (await db.query("SELECT course_key,version,digest FROM course_releases WHERE id=$1", [release])).rows[0];
    expect(doc).toMatchObject({ exportFormat: 1, enrollmentRef: enrollment, course: { id: course.course_key, version: course.version, digest: course.digest }, cursor: { after: "0" } });
    const stored = (await db.query("SELECT id,sequence::text AS sequence,event_type FROM learning_events WHERE enrollment_id=$1 ORDER BY sequence", [enrollment])).rows;
    expect(stored.length).toBeGreaterThan(3);
    // Stable identity: the event's own ID and durable sequence, in order, nothing dropped.
    expect(doc.events.map((e) => [e.eventId, e.sequence, e.type])).toEqual(stored.map((row) => [row.id, row.sequence, row.event_type]));
    expect(doc.cursor.through).toBe(stored.at(-1)!.sequence);
    // The learner's own copy carries every payload of their record.
    expect(doc.events.find((e) => e.type === "block.read")?.payload).toMatchObject({ blockId: "min-text", episodeId: "min" });
    expect(doc.events.find((e) => e.type === "assessment.submitted")?.payload).toMatchObject({ assessmentId: "min-b", passed: true });
    // The download is recorded like the full export.
    const receipts = await db.query("SELECT actor_kind FROM data_exports WHERE enrollment_id=$1", [enrollment]);
    expect(receipts.rows.map((row) => row.actor_kind)).toContain("learner");
  });

  it("pages by cursor without gaps or overlap, and an empty page keeps the cursor", async () => {
    const all = (await exportOf(sessions.learner!)).json() as LearningEventExport;
    const seen: string[] = [];
    let after = "0", pages = 0;
    for (;;) {
      const r = await exportOf(sessions.learner!, `?after=${after}&limit=2`);
      expect(r.statusCode, r.body).toBe(200);
      const page = r.json() as LearningEventExport;
      expect(sdkIssues(page)).toEqual([]);
      expect(page.events.length).toBeLessThanOrEqual(2);
      expect(page.cursor.after).toBe(after);
      seen.push(...page.events.map((e) => e.eventId));
      pages++;
      if (r.headers["course-core-export-has-more"] !== "true") break;
      after = page.cursor.through;
      expect(pages).toBeLessThan(100);
    }
    // The export receipts themselves are workspace events, not enrollment events, so nothing moved.
    expect(seen).toEqual(all.events.map((e) => e.eventId));
    const beyond = (await exportOf(sessions.learner!, `?after=${all.cursor.through}`)).json() as LearningEventExport;
    expect(beyond.events).toEqual([]);
    expect(beyond.cursor).toEqual({ after: all.cursor.through, through: all.cursor.through });
    expect(sdkIssues(beyond)).toEqual([]);
  });

  it("refuses malformed cursors and page sizes outside the bound", async () => {
    for (const query of ["?after=-1", "?after=abc", "?after=01", "?after=99999999999999999999", "?limit=0", `?limit=${MAX_PAGE + 1}`, "?limit=2.5", "?unknown=1"])
      expect((await exportOf(sessions.learner!, query)).statusCode, query).toBe(400);
  });

  it("an owner or admin copy follows the staff privacy rule; other staff and other learners are denied", async () => {
    for (const role of ["owner", "admin"]) {
      const r = await exportOf(sessions[role]!, "", "/api/admin/enrollments");
      expect(r.statusCode, r.body).toBe(200);
      const doc = r.json() as LearningEventExport;
      expect(sdkIssues(doc)).toEqual([]);
      expect(JSON.stringify(doc)).not.toContain(MARKER);
      expect(doc.events.map((e) => e.eventId)).toEqual(((await exportOf(sessions.learner!)).json() as LearningEventExport).events.map((e) => e.eventId));
      // Learner events keep their identity; their payloads are withheld.
      const learnerEvents = doc.events.filter((e) => e.actorKind === "learner");
      expect(learnerEvents.length).toBeGreaterThan(0);
      for (const event of learnerEvents) expect(event.payload).toEqual({ withheld: "event-payloads" });
    }
    for (const role of ["instructor", "reviewer", "otherLearner"]) {
      expect((await exportOf(sessions[role]!)).statusCode, role).toBe(404);
      expect((await exportOf(sessions[role]!, "", "/api/admin/enrollments")).statusCode, role).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/api/enrollments/${enrollment}/event-export` })).statusCode).toBe(401);
    expect((await call(sessions.owner!, "GET", `/api/enrollments/${randomUUID()}/event-export`)).statusCode).toBe(404);
    // Staff downloads are recorded with the requester's role and appear in the workspace audit.
    const staff = await db.query("SELECT requester_role FROM data_exports WHERE enrollment_id=$1 AND actor_kind='staff' ORDER BY created_at", [enrollment]);
    expect(staff.rows.map((row) => row.requester_role)).toEqual(expect.arrayContaining(["owner", "admin"]));
    const audit = await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='data.exported' AND actor_kind='staff'", [workspace]);
    expect(audit.rows.some((row) => row.payload.format === "learning-event-export" && row.payload.requesterRole === "owner")).toBe(true);
  });

  it("the vendored schema rejects records outside the SDK format", () => {
    const base: LearningEventExport = { exportFormat: 1, course: { id: "c", version: "1.0.0", digest: "a".repeat(64) }, enrollmentRef: "e1", exportedAt: new Date().toISOString(),
      cursor: { after: "0", through: "1" }, events: [{ eventId: "x", sequence: "1", type: "a.b", actorKind: "learner", occurredAt: new Date().toISOString(), payload: {}, traceId: null }] };
    expect(sdkIssues(base)).toEqual([]);
    expect(sdkIssues({ ...base, exportFormat: 2 } as unknown as LearningEventExport)).not.toEqual([]);
    expect(sdkIssues({ ...base, cursor: { after: "2", through: "1" } })).not.toEqual([]);
    expect(sdkIssues({ ...base, events: [{ ...base.events[0]!, type: "Bad Type" }] })).not.toEqual([]);
    expect(sdkIssues({ ...base, extra: true } as unknown as LearningEventExport)).not.toEqual([]);
  });
});
