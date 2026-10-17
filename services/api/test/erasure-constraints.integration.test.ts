import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { ACCOUNT_ERASURE_CONFIRMATION } from "../src/account-erasure.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";

// Erasure redacts in place with UPDATEs. A placeholder that breaks a column's CHECK, NOT NULL or
// foreign key makes the whole erasure fail and roll back, so the learner's data stays. Unit tests
// of single features only reach the tables they write. Here one enrollment holds a row in every
// table that names an enrollment, each with learner content wherever erasure redacts it, and both
// enrollment erasure and account erasure must succeed and leave none of that content anywhere.

const origin = "http://localhost:4387",
  schema = "erasure_constraints_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, release: string, owner: Session;
interface Session { userId: string; cookie: string; csrf: string }

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "constraints:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
/** Tables (as `table:rows`) whose rows contain `needle` anywhere, in any column. */
async function tablesContaining(needle: string) {
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).rows.map((r) => r.table_name as string);
  const hits: string[] = [];
  for (const table of tables) {
    const n = (await db.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text LIKE $1`, ["%" + needle + "%"])).rows[0].n;
    if (n) hits.push(`${table}:${n}`);
  }
  return hits;
}

const hex = (c: string) => c.repeat(64);
const later = () => new Date(Date.now() + 86_400_000).toISOString();
/** Columns whose CHECK requires a JSON array. */
const ARRAYS = new Set(["assignments", "verification_evidence", "evidence_refs", "objective_ids", "hypothesis_ids", "effects", "recommendations",
  "restraints", "rule_ids", "skipped", "missing_objective_ids", "unresolved_misconception_ids", "next_actions", "jobs", "artifacts", "criterion_results"]);
/** Columns naming a person. */
const PEOPLE = new Set(["actor_id", "reviewer_id", "requested_by", "created_by", "changed_by", "attached_by", "revoked_by", "reviewed_by",
  "viewer_id", "owner_id", "reverted_by", "learner_id", "user_id", "verifier_id"]);

/** Tables with an enrollment_id that this test does not fill, and why. */
const NOT_FILLED: Record<string, string> = {
  data_erasures: "written by the erasure itself; an earlier row would make the request a replay",
};

/**
 * One row per enrollment table. Required columns get a type-appropriate synthetic value; the
 * overrides satisfy each table's checks and put `secret` into every column erasure redacts.
 */
function rows(ids: { enrollment: string; learner: string; job: string; mediaJob: string; attempt: string; evidence: string; proposal: string; hypothesis: string; review: string; appeal: string },
  secret: string): Record<string, Record<string, unknown>> {
  const said = { text: secret }, quoted = [{ quote: secret }];
  const staff = owner.userId, instance = randomUUID(), observation = randomUUID();
  return {
    activity_evidence: { instance_id: instance, observation_id: observation, objective_id: "objective.one", result: said },
    activity_instances: { id: instance, target: "web_desktop", execution: "declarative", state: said },
    activity_observations: { id: observation, instance_id: instance, idempotency_key: "constraints-observation", observation: said, evaluation: { status: "passed", explanation: secret } },
    adaptation_applications: { plan_digest: hex("1"), commit_before: later() },
    adaptation_artifacts: { body: said },
    adaptation_authorizations: { trusted_record: said },
    adaptation_proofs: { trusted_record: said, verification_evidence: quoted },
    adaptation_proposals: { id: ids.proposal, status: "verified", body: said, assignments: quoted, evidence_fence: said },
    adaptation_reverts: { plan_revision: 2, plan_digest: hex("1"), rollback_target_digest: hex("2") },
    adaptation_states: { snapshot: said },
    // A resolved check amended by an appeal (migration 070): identifiers, states and times only, kept as the record.
    adaptation_transfer_checks: { status: "failed", objective_id: "objective.one", attempt_id: ids.attempt, resolved_at: new Date().toISOString(),
      amended_status: "passed", amended_at: new Date().toISOString(), amended_by_appeal_id: ids.appeal },
    // An object-store record holds identifiers and a digest only; erasure releases the object (migration 062).
    artifact_objects: { purpose: "supervisor_artifact", sha256: hex("3"), byte_length: 1, media_type: "application/json", backend: "s3",
      bucket: "course-erasure-test", object_key: `test/artifacts/${ids.enrollment}`, state: "stored", stored_at: new Date() },
    // The response is a course-level reply; its learner content is handled with those receipts.
    admin_command_receipts: { catalog_id: randomUUID(), idempotency_key: "constraints-" + ids.job, actor_id: staff, response: {} },
    admin_evidence_reviews: { evidence_id: ids.evidence, decision: "reject", note: "Staff note: " + secret },
    admin_policy_previews: { preview: said },
    agent_tool_calls: { tool: "get_context", outcome: "OK" },
    agent_tool_grants: { label: "Label " + secret, scopes: ["context"], token_hash: (ids.job + ids.attempt).replaceAll("-", "") },
    assessment_challenges: { mode: "independent" },
    attempts: { id: ids.attempt, mode: "independent", assistance: "none", response: said, result: said },
    command_receipts: { idempotency_key: "constraints-key", response: said },
    companion_context_capsules: { job_id: ids.job, capsule: said },
    companion_context_exclusions: {},
    companion_messages: { role: "learner", content: "Question: " + secret, context: said, job_id: ids.job },
    data_exports: { actor_kind: "learner" },
    diagnostic_probe_runs: { requested_by: "learner", state: "answered", hypothesis_ids: [ids.hypothesis], answered_at: new Date().toISOString(), response: said, outcome: said },
    diagnostic_requests: { state: "awaiting_supervisor", hypothesis_id: ids.hypothesis, note: "Note: " + secret },
    episode_progress: { state: "started", episode_id: "min" },
    evidence: { id: ids.evidence, attempt_id: ids.attempt, result: said, invalidation_reason: "Invalid: " + secret },
    extension_grants: {},
    gate_decisions: { status: "needs_evidence", gate_version: "1" },
    gate_review_requests: { reason: "Please review: " + secret, state: "upheld", reviewer_id: staff, decided_at: new Date().toISOString(), reviewer_note: "Reviewer: " + secret },
    learner_evidence_controls: { evidence_id: ids.evidence, kind: "dispute", reason: "Disputed: " + secret },
    learner_model_changes: { actor_kind: "learner", action: "profile.edited", data: said, model_revision: 1, enrollment_revision: 1 },
    learner_model_profiles: { profile: said },
    learner_model_proposals: { id: ids.proposal, suggestion: said },
    learner_model_sources: { proposal_id: ids.proposal, event_type: "assessment.submitted" },
    learning_events: { actor_kind: "learner", event_type: "assessment.submitted", payload: said, platform: "web", app_version: "1.0.0", client_sequence: 1, occurred_at: new Date().toISOString() },
    media_attachments: { job_id: ids.mediaJob, review_id: ids.review, episode_id: "min", attached_by: staff },
    media_jobs: { id: ids.mediaJob, episode_id: "min", kind: "generated_short_video", title: "Title " + secret, objective: "Objective " + secret, script: "Script for the learner: " + secret,
      model_id: "synthetic-model", state: "attached", charged_micro_usd: 10, provider_operation: { provider: "synthetic", providerState: said }, idempotency_key: "constraints-" + ids.mediaJob },
    personal_change_visibility: {},
    placement_exemption_overrides: { episode_id: "min", reason: "Exempted because " + secret },
    placement_runs: { state: "finished", proposal: said },
    policy_states: {},
    provider_dispatches: { job_id: ids.job, state: "completed", candidate: said, outcome: { status: "succeeded", note: secret } },
    provider_spend_ledger: { source: "supervisor", source_ref: "constraints-" + ids.job, role: "supervisor", state: "not_started", settled_at: new Date().toISOString() },
    research_candidates: { job_id: ids.job },
    research_resource_choices: { job_id: ids.job, objective_id: "objective.one", episode_id: "min" },
    research_requests: { parent_job_id: ids.job, topic_id: "topic.one", episode_id: "min", state: "collected" },
    retention_schedules: {},
    rubric_appeals: { id: ids.appeal, attempt_id: ids.attempt, reason: "My appeal says " + secret, state: "upheld", reviewer_id: staff, decision: "met", decided_at: new Date().toISOString(),
      findings: { findings: quoted, requestDigest: hex("3") }, reviewer_note: "Second reviewer: " + secret },
    rubric_assist_consents: { granted: true },
    rubric_assist_requests: { attempt_id: ids.attempt, state: "suggested", origin: "staff", requested_by: owner.userId },
    rubric_reviews: { attempt_id: ids.attempt, reviewer_id: staff, confirmation: "human", decision: "met", criteria: { findings: quoted, requestDigest: hex("4") }, learner_note: "To the learner: " + secret },
    rubric_suggestions: { job_id: ids.job },
    scope_anchors: {},
    staff_learner_views: { viewer_role: "owner" },
    supervisor_adaptations: { job_id: ids.job, summary: "Summary: " + secret },
    supervisor_applications: { job_id: ids.job, application_kind: "companion_message" },
    supervisor_artifacts: { job_id: ids.job, content: said },
    supervisor_control_changes: { action: "pause", from_state: "active", to_state: "paused", idempotency_key: "constraints-" + ids.job },
    supervisor_controls: {},
    supervisor_enrollment_budgets: {},
    supervisor_event_requeues: { reason: "Requeued: " + secret, previous_code: "provider_outage", idempotency_key: "constraints-" + ids.job },
    supervisor_inputs: { job_id: ids.job, context: said },
    supervisor_job_cancellations: { reason: "data_erasure", jobs: [ids.job] },
    supervisor_job_spend: { job_id: ids.job },
    supervisor_jobs: { id: ids.job, state: "applied", role: "supervisor", specification: said, result: said },
    supervisor_model_effects: { job_id: ids.job, proposal_id: ids.proposal },
    supervisor_permissions: {},
    supervisor_plan_effects: { job_id: ids.job, proposal_id: ids.proposal },
    supervisor_preparations: { disposition: "prepared", jobs: [ids.job] },
    supervisor_reconciliations: { job_id: ids.job, outcome_status: "succeeded", resumed_generation: 2 },
    supervisor_tool_calls: { job_id: ids.job, step: 0, tool: "suggest_model", arguments: said, outcome: said },
    supervisor_verifications: { job_id: ids.job, verdict: "verified", application_kind: "companion_message" },
    teaching_hypotheses: { id: ids.hypothesis, kind: "misconception", statement: "Believes " + secret, objective_ids: ["objective.one"], uncertainty: "medium",
      status: "confirmed", source: "learner", learner_correction: "Actually " + secret, evidence_refs: quoted },
    teaching_hypothesis_changes: { hypothesis_id: ids.hypothesis, actor_kind: "system", action: "proposed", data: said },
    teaching_signals: { signal_kind: "answer.incorrect", source_ref: said },
    wakeup_failures: { stage: "retention", code: "SYNTHETIC_FAILURE" },
    wakeup_signals: { kind: "retention_due" },
  };
}

/** Fills every enrollment table for `enrollment` (foreign keys and triggers off for the inserts only).
 * A table enrolling already filled (policy state, supervisor settings) keeps its own row. */
async function populate(client: PoolClient, enrollment: string, learner: string, secret: string) {
  const ids = { enrollment, learner, job: randomUUID(), mediaJob: randomUUID(), attempt: randomUUID(), evidence: randomUUID(), proposal: randomUUID(), hypothesis: randomUUID(), review: randomUUID(), appeal: randomUUID() };
  const overrides = rows(ids, secret);
  const columns = (await client.query<{ table_name: string; column_name: string; udt_name: string; required: boolean }>(
    `SELECT table_name,column_name,udt_name,(is_nullable='NO' AND column_default IS NULL AND is_identity='NO' AND is_generated='NEVER') AS required FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='enrollment_id')
      ORDER BY table_name,ordinal_position`)).rows;
  const tables = [...new Set(columns.map((c) => c.table_name))];
  const shared: Record<string, string> = { workspace_id: workspace, enrollment_id: enrollment, course_release_id: release, job_id: ids.job, attempt_id: ids.attempt,
    evidence_id: ids.evidence, proposal_id: ids.proposal, hypothesis_id: ids.hypothesis };
  const value = (column: string, type: string): unknown => {
    if (column in shared) return shared[column];
    if (PEOPLE.has(column)) return column === "learner_id" || column === "user_id" ? learner : owner.userId;
    if (type === "uuid") return randomUUID();
    if (type === "text") return /digest|sha256/.test(column) ? hex("a") : "synthetic." + randomUUID().slice(0, 8);
    if (type === "int4" || type === "int8") return 1;
    if (type === "bool") return false;
    if (type === "timestamptz") return later();
    if (type === "jsonb") return ARRAYS.has(column) ? ["synthetic.value"] : {};
    throw new Error("No synthetic value for " + type);
  };
  // Erasure updates some rows twice in one transaction, and a row updated earlier in the same
  // transaction has its foreign keys checked again, so those keys must be real.
  await client.query("INSERT INTO workspace_provider_versions(workspace_id,revision,configuration,job_policy,sealed_credentials,changed_by) VALUES($1,1,'{}','{}','{}',$2) ON CONFLICT DO NOTHING",
    [workspace, owner.userId]);
  await client.query("SET LOCAL session_replication_role = replica");
  for (const table of tables) {
    if (table in NOT_FILLED) continue;
    const own = overrides[table];
    if (!own) throw new Error(`${table} names an enrollment but this test does not fill it: add it to rows() or NOT_FILLED`);
    const row: Record<string, unknown> = {};
    for (const c of columns.filter((c) => c.table_name === table)) {
      if (c.column_name === "enrollment_id") row[c.column_name] = enrollment;
      else if (c.column_name in own) row[c.column_name] = c.udt_name === "jsonb" ? JSON.stringify(own[c.column_name]) : own[c.column_name];
      else if (c.required) { const v = value(c.column_name, c.udt_name); row[c.column_name] = c.udt_name === "jsonb" ? JSON.stringify(v) : v; }
    }
    for (const name of Object.keys(own)) if (!(name in row)) throw new Error(`${table}.${name} does not exist`);
    const names = Object.keys(row);
    await client.query(`INSERT INTO "${table}"(${names.map((n) => `"${n}"`).join(",")}) VALUES(${names.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT DO NOTHING`, Object.values(row))
      .catch((error: Error) => { throw new Error(`${table}: ${error.message}`); });
  }
  // Rows erasure reaches through the media job rather than an enrollment column.
  await client.query(`INSERT INTO media_reviews(id,job_id,workspace_id,decision,asset_sha256,captions_vtt,transcript,visual_description,findings,rationale,reviewed_by)
    VALUES($1,$2,$3,'approved',$4,$5,$6,$7,'{}',$8,$9)`, [ids.review, ids.mediaJob, workspace, hex("b"), "WEBVTT\n\n00:00.000 --> 00:01.000\n" + secret,
    "Transcript of the clip: " + secret, "The clip shows " + secret, "Approved because " + secret, owner.userId]);
  await client.query("INSERT INTO media_assets(job_id,workspace_id,sha256,mime_type,byte_length,content) VALUES($1,$2,$3,'video/mp4',$4,$5)",
    [ids.mediaJob, workspace, hex("b"), Buffer.byteLength(secret), Buffer.from(secret)]);
  await client.query("INSERT INTO outbox(event_id,kind,payload) VALUES($1,'learning_event',$2)", [randomUUID(), JSON.stringify({ enrollmentId: enrollment })]);
  await client.query("UPDATE enrollments SET profile=$2 WHERE id=$1", [enrollment, JSON.stringify({ displayName: "Name " + secret, goal: "Goal " + secret })]);
  await client.query("SET LOCAL session_replication_role = origin");
  return tables;
}

async function enrolled() {
  const learner = await session("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id as string;
  const secret = "LEARNER_CONTENT_" + randomUUID().replaceAll("-", "");
  const client = await db.connect();
  let tables: string[];
  try {
    await client.query("BEGIN");
    tables = await populate(client, enrollment, learner.userId, secret);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  // Every enrollment table holds a row for this learner before erasure.
  for (const table of tables) if (!(table in NOT_FILLED))
    expect((await db.query(`SELECT count(*)::int AS n FROM "${table}" WHERE enrollment_id=$1`, [enrollment])).rows[0].n, table).toBeGreaterThan(0);
  expect((await tablesContaining(secret)).length).toBeGreaterThan(30);
  return { learner, enrollment, secret };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30_000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "constraints-" + workspace, "Constraints"]);
  owner = await session("owner");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  await call(owner, "POST", `/api/releases/${release}/publish`);
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("erasure succeeds whatever learner data the enrollment holds", () => {
  it("enrollment erasure: every placeholder satisfies its column's constraints and no learner content is left", async () => {
    const { learner, enrollment, secret } = await enrolled();
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, {
      confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Learner asked for their course data to be removed.",
    });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json()).toMatchObject({ status: "erased", replayed: false });
    expect(erased.json().counts).toMatchObject({ writtenAnswerAppeals: 1, adaptationProofs: 1, gateReviewRequests: 1, teachingHypotheses: 1, mediaJobText: 1 });
    expect(await tablesContaining(secret)).toEqual([]);
    // The appeal row stays as the audit skeleton with the placeholder reason.
    expect((await db.query("SELECT reason,state,decision,reviewer_note FROM rubric_appeals WHERE enrollment_id=$1", [enrollment])).rows)
      .toEqual([{ reason: "[erased]", state: "upheld", decision: "met", reviewer_note: "[erased]" }]);
    expect((await db.query("SELECT verification_evidence FROM adaptation_proofs WHERE enrollment_id=$1", [enrollment])).rows).toEqual([{ verification_evidence: [] }]);
  });

  it("account erasure: the same enrollment data, erased with the account", async () => {
    const { learner, enrollment, secret } = await enrolled();
    const erased = await call(learner, "POST", "/api/account/erase", { confirmation: ACCOUNT_ERASURE_CONFIRMATION, reason: "I want my account and data removed." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json()).toMatchObject({ status: "erased", enrollmentIds: [enrollment] });
    expect(await tablesContaining(secret)).toEqual([]);
    expect((await db.query("SELECT status FROM enrollments WHERE id=$1", [enrollment])).rows[0].status).toBe("erased");
  });

  it("an appeal reason still needs 10 to 2000 characters unless it is exactly the erasure placeholder", async () => {
    const { enrollment } = await enrolled();
    const client = await db.connect();
    try {
      const attempt = async (reason: string) => {
        await client.query("SAVEPOINT appeal");
        try {
          await client.query("INSERT INTO rubric_appeals(id,attempt_id,enrollment_id,reason) VALUES($1,$2,$3,$4)", [randomUUID(), randomUUID(), enrollment, reason]);
          return "accepted";
        } catch (error) {
          return (error as { constraint?: string }).constraint ?? String(error);
        } finally { await client.query("ROLLBACK TO SAVEPOINT appeal"); }
      };
      await client.query("BEGIN");
      // Foreign keys off so each row needs no attempt of its own; the CHECK still applies.
      await client.query("SET LOCAL session_replication_role = replica");
      for (const reason of ["too short", "[erased] ", "[ERASED]", "x".repeat(2001)]) expect(await attempt(reason), reason).toBe("rubric_appeals_reason_check");
      for (const reason of ["[erased]", "Ten chars.", "x".repeat(2000)]) expect(await attempt(reason), reason).toBe("accepted");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
