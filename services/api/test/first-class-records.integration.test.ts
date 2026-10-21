import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { MAX_PLATFORM_SNAPSHOTS } from "../src/platform-capabilities.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { enablePlacement } from "./placement-admin-fixture.js";
import { fixture } from "./fixture.js";

/** M02: learning step instances, extension manifests, platform capability snapshots, debug
 * traces and decision records (migration 109) are first-class records, written with the
 * authoritative row from any code path. Playback contexts: interactive-flow.integration.test.ts. */
const origin = "http://localhost:4395",
  schema = "firstclass_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
interface Session { id: string; cookie: string; csrf: string }
let versions = 0;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

async function enrolled(change: (course: CourseManifest) => void = () => {}) {
  const workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "records-" + workspace, "Records"]);
  const sign = async (role: string): Promise<Session> => {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "records:" + id, role]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
  };
  const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const owner = await sign("owner");
  const course = fixture();
  course.version = `1.0.${versions++}`;
  change(course);
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
  expect(created.statusCode, created.body).toBe(200);
  const release = created.json().id as string;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  const learner = await sign("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id as string;
  const send = async (who: Session, action: string, body: Record<string, unknown> = {}) => {
    const revision = (await call(who, "GET", "/api/enrollments/" + enrollment)).json().revision;
    return call(who, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
  };
  return { workspace, release, enrollment, owner, learner, sign, call, send };
}
const steps = async (enrollment: string) =>
  (await db.query("SELECT step_id,episode_id,kind,requirement,status,block_ids,completed_block_count,completed_at IS NOT NULL AS done,revision FROM learning_step_instances WHERE enrollment_id=$1 ORDER BY step_id", [enrollment])).rows;

describe("learning step instances (M02)", () => {
  it("a learning step instance follows progress: the episode as one step, or the course's declared steps by their blocks", async () => {
    const plain = await enrolled();
    expect(await steps(plain.enrollment)).toEqual([]);
    const read = await plain.send(plain.learner, "read", { episodeId: "min", blockId: "min-text" });
    expect(read.statusCode, read.body).toBe(200);
    expect(await steps(plain.enrollment)).toEqual([{ step_id: "min", episode_id: "min", kind: "episode", requirement: "required", status: "current",
      block_ids: ["min-text", "min-check"], completed_block_count: 1, done: false, revision: 1 }]);
    // Any code path that completes the episode: the step completes in the same statement.
    await db.query("UPDATE episode_progress SET state='completed',completed_at=now() WHERE enrollment_id=$1 AND episode_id='min'", [plain.enrollment]);
    expect(await steps(plain.enrollment)).toMatchObject([{ step_id: "min", status: "completed", done: true, revision: 2 }]);
    // A write that rolls back leaves no step behind.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO episode_progress(enrollment_id,episode_id,state,completed_block_ids) VALUES($1,'max','started','[]')", [plain.enrollment]);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await steps(plain.enrollment)).map((s) => s.step_id)).toEqual(["min"]);

    const stepped = await enrolled((course) => {
      (course as CourseManifest & { learningSteps: unknown[] }).learningSteps = [
        { id: "min-explain", episodeId: "min", kind: "explain", requirement: "required", blockIds: ["min-text"], primaryAction: { label: "Read", blockId: "min-text" }, nextStepId: "min-solve" },
        { id: "min-solve", episodeId: "min", kind: "solve", requirement: "required", blockIds: ["min-check"], primaryAction: { label: "Answer", blockId: "min-check" }, nextStepId: null },
      ];
    });
    const declared = (await db.query("SELECT server_bundle->'learningSteps' AS steps FROM course_releases WHERE id=$1", [stepped.release])).rows[0].steps;
    expect(declared, "the compiled bundle keeps the declared steps").toHaveLength(2);
    expect((await stepped.send(stepped.learner, "read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
    expect(await steps(stepped.enrollment)).toMatchObject([
      { step_id: "min-explain", kind: "explain", status: "completed", block_ids: ["min-text"], completed_block_count: 1, done: true },
      { step_id: "min-solve", kind: "solve", status: "current", block_ids: ["min-check"], completed_block_count: 0, done: false },
    ]);
  });
});

describe("extension manifests (M02)", () => {
  it("records each runtime extension a stored course version declares, skipping malformed entries", async () => {
    const { workspace, owner } = await enrolled();
    const release = randomUUID(), digest = "d".repeat(64);
    const renderer = { id: "course-core-svg-v1", version: "0.5.1", integrity: "sha256-" + "a".repeat(64), execution: "declarative", entrypoint: "renderers/svg-v1.js",
      platforms: ["web"], capabilities: ["visual.render"] };
    await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
      VALUES($1,$2,'manifests','9.0.0',$3,$4,'{}','draft',$5)`, [release, workspace, digest,
      JSON.stringify({ extensions: [renderer, { id: "", version: "1", integrity: "x" }, "not an object", { id: "no-version", integrity: "x" }] }), owner.id]);
    const rows = (await db.query("SELECT extension_id,version,integrity,execution,platforms,capabilities,course_digest,manifest_digest,manifest FROM extension_manifests WHERE course_release_id=$1", [release])).rows;
    expect(rows).toEqual([{ extension_id: renderer.id, version: "0.5.1", integrity: renderer.integrity, execution: "declarative", platforms: ["web"],
      capabilities: ["visual.render"], course_digest: digest, manifest_digest: expect.stringMatching(/^[a-f0-9]{64}$/), manifest: renderer }]);
  });
});

describe("platform capability snapshots (M02)", () => {
  const report = { target: "web_mobile", appVersion: "0.1.53", sdkVersion: "0.5.0", layoutClass: "compact", inputModes: ["touch", "keyboard"],
    capabilities: ["visual.render", "activity.sandboxed_web"], rendererIds: ["course-core-svg-v1"], nativeModules: [] };
  it("keeps one snapshot per distinct report of the learner's own app, and refuses anything else", async () => {
    const { enrollment, learner, owner, sign, call } = await enrolled();
    const url = `/api/enrollments/${enrollment}/platform-capabilities`;
    const first = await call(learner, "POST", url, report);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ recorded: true, duplicate: false });
    // The same device again, lists in another order: the same snapshot, seen twice.
    const again = await call(learner, "POST", url, { ...report, inputModes: ["keyboard", "touch"], capabilities: [...report.capabilities].reverse() });
    expect(again.json()).toEqual({ recorded: true, duplicate: true, snapshotId: first.json().snapshotId });
    expect((await call(learner, "POST", url, { ...report, target: "web_desktop", layoutClass: "expanded", inputModes: ["pointer", "keyboard"] })).json().duplicate).toBe(false);
    expect((await db.query("SELECT target,layout_class,report_count FROM platform_capability_snapshots WHERE enrollment_id=$1 ORDER BY first_reported_at", [enrollment])).rows)
      .toEqual([{ target: "web_mobile", layout_class: "compact", report_count: 2 }, { target: "web_desktop", layout_class: "expanded", report_count: 1 }]);
    // Invalid reports.
    for (const bad of [{ ...report, target: "smart_fridge" }, { ...report, extra: true }, { ...report, capabilities: Array.from({ length: 33 }, (_, i) => `cap.${i}`) },
      { ...report, inputModes: ["touch", "touch"] }, { ...report, appVersion: "<script>" }, { ...report, nativeModules: undefined }])
      expect((await call(learner, "POST", url, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    // Only the enrollment's own learner.
    const stranger = await sign("learner");
    expect((await call(stranger, "POST", url, report)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(owner, "POST", url, report)).statusCode).toBeGreaterThanOrEqual(403);
    // Bounded: no more than MAX_PLATFORM_SNAPSHOTS distinct reports.
    for (let i = 2; i < MAX_PLATFORM_SNAPSHOTS; i++) expect((await call(learner, "POST", url, { ...report, appVersion: `0.2.${i}` })).statusCode).toBe(200);
    const over = await call(learner, "POST", url, { ...report, appVersion: "9.9.9" });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("PLATFORM_SNAPSHOT_LIMIT");
    expect((await call(learner, "POST", url, report)).json().duplicate).toBe(true);
    // The learner's own data copy includes them, with the other first-class records.
    const copy = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(copy.statusCode).toBe(200);
    expect(copy.json().records.platformCapabilities.items).toHaveLength(MAX_PLATFORM_SNAPSHOTS);
    expect(copy.json().records).toMatchObject({ learningSteps: { items: [] }, playbackContexts: { items: [] }, decisions: { items: [] } });
  });
});

describe("debug traces (M02)", () => {
  it("projects each trace with the records it wrote", async () => {
    const { enrollment } = await enrolled();
    const trace = randomUUID().replaceAll("-", "");
    const events = (await db.query("UPDATE learning_events SET trace_id=$2 WHERE enrollment_id=$1 RETURNING id", [enrollment, trace])).rowCount!;
    expect(events).toBeGreaterThan(0);
    expect((await db.query("SELECT enrollment_id,event_count,job_count,dispatch_count,revision FROM debug_traces WHERE trace_id=$1", [trace])).rows)
      .toEqual([{ enrollment_id: enrollment, event_count: events, job_count: 0, dispatch_count: 0, revision: events }]);
    // Setting the same trace again is not a new record.
    await db.query("UPDATE learning_events SET trace_id=$2 WHERE enrollment_id=$1", [enrollment, trace]);
    expect((await db.query("SELECT event_count FROM debug_traces WHERE trace_id=$1", [trace])).rows[0].event_count).toBe(events);
    expect((await db.query("SELECT count(*)::int AS n FROM debug_traces WHERE trace_id=$1", ["0".repeat(32)])).rows[0].n).toBe(0);
  });
});

describe("decision records (M02)", () => {
  it("records gate, placement, closure, extension and intervention decisions with their versions, as codes only", async () => {
    const f = await enrolled();
    const digest = (await db.query("SELECT digest FROM course_releases WHERE id=$1", [f.release])).rows[0].digest as string;
    // Placement, through the API: the learner declines it.
    await enablePlacement(app, f.owner, origin, f.workspace);
    expect((await f.send(f.learner, "placement/decline")).statusCode).toBe(200);
    // A gate decision, a closure, an extension offer and a teaching action, as their services write them.
    const gate = randomUUID();
    await db.query(`INSERT INTO gate_decisions(id,enrollment_id,workspace_id,gate_id,gate_version,episode_id,course_digest,policy_revision,status,criterion_results,
      missing_objective_ids,unresolved_misconception_ids,evidence_refs,evaluator,learner_visible_reason,next_actions,inputs_digest)
      VALUES($1,$2,$3,'min-gate','3','min',$4,1,'needs_evidence','[]','["minimum"]','[]','["evidence-1"]','{}','Private prose the record must not copy','[]',$5)`,
      [gate, f.enrollment, f.workspace, digest, "b".repeat(64)]);
    await db.query(`INSERT INTO closure_reports(enrollment_id,closed_at,reason,coverage,mastery,uncovered_objective_ids,unproven_concept_ids,policy_revision)
      VALUES($1,now(),'cap','partial','partial','[]','[]',2)`, [f.enrollment]);
    const offer = (state: string) => db.query(`INSERT INTO extension_offers(enrollment_id,offer_id,scope_id,state,terms_digest,change,pool_debits,required_approvals,created_at,expires_at,last_transition_at)
      VALUES($1,'offer-1','episode:min',$2,'t','{}','[]','[]',now(),now()+interval '1 day',now()) ON CONFLICT(enrollment_id,offer_id) DO UPDATE SET state=EXCLUDED.state`, [f.enrollment, state]);
    await offer("proposed");
    await offer("accepted");
    await offer("accepted");
    const action = randomUUID();
    await db.query(`INSERT INTO teaching_actions(id,enrollment_id,workspace_id,action,objective_ids,rule_id,origin,state) VALUES($1,$2,$3,'contrast_case','["minimum"]','T1','trigger','started')`,
      [action, f.enrollment, f.workspace]);
    const rows = (await db.query(`SELECT kind,source_ref,subject_ref,course_digest,policy_revision,gate_version,input_evidence_refs,outcome,reason,decided_by_kind,decided_by
      FROM decision_records WHERE enrollment_id=$1 ORDER BY kind,outcome`, [f.enrollment])).rows;
    expect(rows).toEqual([
      { kind: "closure", source_ref: `closure_report:${f.enrollment}`, subject_ref: "enrollment", course_digest: digest, policy_revision: 2, gate_version: null, input_evidence_refs: [], outcome: "partial", reason: "cap", decided_by_kind: "host_policy", decided_by: "policy" },
      { kind: "extension", source_ref: `extension_offer:${f.enrollment}:offer-1`, subject_ref: "episode:min", course_digest: digest, policy_revision: 1, gate_version: null, input_evidence_refs: [], outcome: "accepted", reason: "accepted", decided_by_kind: "learner", decided_by: "learner" },
      { kind: "extension", source_ref: `extension_offer:${f.enrollment}:offer-1`, subject_ref: "episode:min", course_digest: digest, policy_revision: 1, gate_version: null, input_evidence_refs: [], outcome: "proposed", reason: "proposed", decided_by_kind: "host_policy", decided_by: "policy" },
      { kind: "gate", source_ref: `gate_decision:${gate}`, subject_ref: "min-gate", course_digest: digest, policy_revision: 1, gate_version: "3", input_evidence_refs: ["evidence-1"], outcome: "needs_evidence", reason: "needs_evidence", decided_by_kind: "host_policy", decided_by: "progression-gates" },
      { kind: "intervention", source_ref: `teaching_action:${action}`, subject_ref: "contrast_case", course_digest: digest, policy_revision: 1, gate_version: null, input_evidence_refs: ["minimum"], outcome: "started", reason: "T1", decided_by_kind: "host_policy", decided_by: "teaching-rules" },
      { kind: "placement", source_ref: expect.stringMatching(/^placement_run:/), subject_ref: "placement", course_digest: digest, policy_revision: 1, gate_version: null, input_evidence_refs: [], outcome: "declined", reason: "declined", decided_by_kind: "learner", decided_by: "learner" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("Private prose");
  });
});
