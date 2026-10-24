import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { SDK_VERSION } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";
import type { CourseManifest, LegacyProgressionGate } from "@course-core/sdk";

const pack = (name: "number-line" | "plant-journal") => JSON.parse(readFileSync(new URL(`../../../examples/courses/packs/${name}.json`, import.meta.url), "utf8")) as CourseManifest;
const origin = "http://localhost:4398", schema = "sdk_support_" + randomUUID().replaceAll("-", ""), workspace = randomUUID();
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "support:" + id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "support", "Support"]);
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

/** No SDK 0.4 compatibility (RELEASES.md): Core pins SDK 0.5.0, refuses packages built below it,
 * and applies the full false-mastery rules to every gate, including gates without a version. */
describe("SDK 0.5.0 is the minimum, with the full gate rules for every gate", () => {
  it("pins SDK 0.5.0", () => {
    expect(SDK_VERSION).toBe("0.5.0");
  });
  it("refuses to publish a gate of choice items only, and shows the checkpoint to staff before they try", async () => {
    const owner = await session("owner");
    const course = fixture();
    course.id = "recognition-only";
    course.title = "Recognition only";
    // Both of the first checkpoint's families are choice items.
    course.assessments = course.assessments.map((item) => item.id !== "min-b" ? item : { id: "min-b", type: "choice", objectiveIds: ["minimum"], familyId: "select",
      prompt: "Which is the minimum of 4 and 9?", options: [{ id: "four", text: "4" }, { id: "nine", text: "9" }], grading: { correctOptionId: "four", explanation: "4 is below 9." } });
    const gate = course.gates[0] as LegacyProgressionGate;
    const imported = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
    expect(imported.statusCode, imported.body).toBe(200);
    const publish = await call(owner, "POST", `/api/releases/${imported.json().id}/publish`);
    expect(publish.statusCode).toBe(409);
    expect(publish.json()).toMatchObject({ error: "PUBLISH_RECOGNITION_ONLY_GATE", details: { gateId: gate.id } });
    const courses = (await call(owner, "GET", "/api/admin/session")).json().courses as { id: string; title: string }[];
    const checks = (await call(owner, "GET", `/api/admin/courses/${courses.find((c) => c.title === course.title)!.id}`)).json().releases[0].checks;
    expect(checks).toContainEqual({ code: "GATE_RECOGNITION_ONLY", passed: false, params: { gate: gate.id } });
    expect(checks.map((c: { code: string }) => c.code)).not.toContain("RUNTIME_UNSUPPORTED");
  });
  it("refuses to publish a gate that passes on one of several objectives", async () => {
    const owner = await session("owner");
    const course = fixture();
    course.id = "partial-objectives";
    const gate = course.gates[1] as LegacyProgressionGate;
    gate.objectiveIds = ["minimum", "maximum"];
    gate.requireAllObjectives = false;
    const imported = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
    expect(imported.statusCode, imported.body).toBe(200);
    const publish = await call(owner, "POST", `/api/releases/${imported.json().id}/publish`);
    expect(publish.json()).toMatchObject({ error: "PUBLISH_GATE_PARTIAL_OBJECTIVES", details: { gateId: "max-gate" } });
  });
  it("publishes the example courses, whose every checkpoint asks for a produced answer, and runs one through real HTTP", async () => {
    const owner = await session("owner"), learner = await session("learner");
    const imported = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, pack("number-line"));
    expect(imported.json()).toMatchObject({ status: "draft" });
    expect((await call(owner, "POST", `/api/releases/${imported.json().id}/publish`)).statusCode).toBe(200);
    const journal = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, pack("plant-journal"));
    expect((await call(owner, "POST", `/api/releases/${journal.json().id}/publish`)).statusCode).toBe(200);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: imported.json().id })).json().id;
    const send = async (action: string, body: Record<string, unknown>) => call(learner, "POST", `/api/enrollments/${enrollment}/${action}`,
      { expectedRevision: (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().revision, idempotencyKey: randomUUID(), ...body });
    for (const blockId of ["nl-position-text-1", "nl-position-text-2"]) expect((await send("read", { episodeId: "nl-position", blockId })).statusCode).toBe(200);
    const early = await send("complete", { episodeId: "nl-position" });
    expect(early.json()).toMatchObject({ error: "EVIDENCE_REQUIRED", details: { missing: [{ objectiveId: "nl-position-objective", independentFamilies: 0, requiredFamilies: 2 }], status: "needs_evidence" } });
    for (const [assessmentId, answer] of [["nl-position-scale-1", 0], ["nl-position-order-1", "c"]] as const) {
      const issued = await send("challenges", { episodeId: "nl-position", assessmentId, mode: "independent" });
      expect((await send("answers", { challengeId: issued.json().challengeId, answer })).json().result).toMatchObject({ passed: true, independent: true });
    }
    const lesson = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().lessons[0];
    expect(lesson.gate).toMatchObject({ passed: true, status: "ready", gateVersion: "legacy-0.4" });
    const done = await send("complete", { episodeId: "nl-position" });
    expect(done.statusCode, done.body).toBe(200);
  });
});
