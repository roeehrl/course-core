import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { membership, type Actor, type authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson } from "./repository.js";

const TERMINAL = ["applied", "cancelled", "failed"];
const ERASED = '{"erased":true}';
const LIMIT = 20000;

/** The learner always may; owners and admins may on request. Instructors and
 * other staff never receive a full personal export or erasure authority. */
async function authorize(client: Database | PoolClient, actor: Actor, enrollmentId: string, lock = false) {
  const enrollment = (
    await client.query(
      `SELECT * FROM enrollments WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [enrollmentId],
    )
  ).rows[0];
  requireCondition(enrollment, "ENROLLMENT_NOT_FOUND", 404);
  const role = await membership(client, actor, enrollment.workspace_id).catch(() => undefined);
  const self = enrollment.user_id === actor.id && role !== undefined;
  const staff = role === "owner" || role === "admin";
  requireCondition(self || staff, "ENROLLMENT_NOT_FOUND", 404);
  return { enrollment, actorKind: self ? ("learner" as const) : ("staff" as const) };
}
const rows = async (client: PoolClient, sql: string, args: unknown[]) => {
  const result = await client.query(sql + ` LIMIT ${LIMIT + 1}`, args);
  return { items: result.rows.slice(0, LIMIT), truncated: result.rows.length > LIMIT };
};

export async function exportEnrollment(client: PoolClient, enrollmentId: string) {
  const e = (await client.query("SELECT * FROM enrollments WHERE id=$1", [enrollmentId])).rows[0];
  const release = (
    await client.query(
      "SELECT id,course_key,version,digest,learner_bundle->>'title' AS title FROM course_releases WHERE id=$1",
      [e.course_release_id],
    )
  ).rows[0];
  const user = (await client.query("SELECT id,display_name,created_at FROM app_users WHERE id=$1", [e.user_id])).rows[0];
  const id = [enrollmentId];
  const document = {
    format: "course-core.enrollment-export",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    learner: { id: user.id, displayName: user.display_name, accountCreatedAt: user.created_at },
    enrollment: {
      id: e.id,
      workspaceId: e.workspace_id,
      status: e.status,
      startedAt: e.started_at,
      closedAt: e.closed_at,
      currentEpisodeId: e.current_episode_id,
      profile: e.profile,
      policy: e.policy,
    },
    course: release,
    progress: (await client.query("SELECT episode_id,state,completed_block_ids,evidence_refs,started_at,completed_at FROM episode_progress WHERE enrollment_id=$1 ORDER BY started_at", id)).rows,
    attempts: await rows(client, "SELECT id,assessment_id,family_id,mode,assistance,response,result,submitted_at,course_digest FROM attempts WHERE enrollment_id=$1 ORDER BY submitted_at", id),
    evidence: await rows(client, "SELECT id,attempt_id,objective_id,evaluator_ref,result,independent,invalidated_at,invalidation_reason,created_at FROM evidence WHERE enrollment_id=$1 ORDER BY created_at", id),
    evidenceReviews: (await client.query("SELECT evidence_id,decision,note,created_at FROM admin_evidence_reviews WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
    companion: await rows(client, "SELECT id,role,content,created_at FROM companion_messages WHERE enrollment_id=$1 ORDER BY created_at", id),
    learnerModel: {
      profile: (await client.query("SELECT revision,profile,manually_edited FROM learner_model_profiles WHERE enrollment_id=$1", id)).rows[0] ?? null,
      changes: await rows(client, "SELECT model_revision,actor_kind,action,proposal_id,data,created_at FROM learner_model_changes WHERE enrollment_id=$1 ORDER BY sequence", id),
      proposals: await rows(client, "SELECT id,service_id,suggestion,created_at FROM learner_model_proposals WHERE enrollment_id=$1 ORDER BY created_at", id),
    },
    policy: {
      state: (await client.query("SELECT policy_revision,ledger_revision,snapshot,updated_at FROM policy_states WHERE enrollment_id=$1", id)).rows[0] ?? null,
      anchors: (await client.query("SELECT scope_id,anchor_kind,anchored_at,resolved_deadline FROM scope_anchors WHERE enrollment_id=$1", id)).rows,
      extensionGrants: (await client.query("SELECT id,offer_id,terms_digest,consent_receipt,grant_data,created_at FROM extension_grants WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
    },
    supervision: {
      permission: (await client.query("SELECT revision,adaptive_teaching,updated_at FROM supervisor_permissions WHERE enrollment_id=$1", id)).rows[0] ?? null,
      jobs: await rows(client, "SELECT id,role,state,created_at,updated_at FROM supervisor_jobs WHERE enrollment_id=$1 ORDER BY created_at", id),
      adaptations: (await client.query("SELECT id,summary,state,created_at FROM supervisor_adaptations WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
      personalTeaching: (await client.query("SELECT artifact_id,body FROM adaptation_artifacts WHERE enrollment_id=$1", id)).rows,
      research: (await client.query("SELECT topic_id,episode_id,state,created_at FROM research_requests WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
    },
    writtenAnswerReviews: (await client.query("SELECT attempt_id,decision,criteria->'findings' AS findings,learner_note,created_at FROM rubric_reviews WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
    placement: (await client.query("SELECT state,started_at,finished_at,accepted_at,stop_reason,proposal,start_episode_id FROM placement_runs WHERE enrollment_id=$1", id)).rows[0] ?? null,
    retention: (await client.query("SELECT objective_id,demonstrated_at,step,due_at,retained_at,needs_review FROM retention_schedules WHERE enrollment_id=$1 ORDER BY objective_id", id)).rows,
    hiddenPersonalChanges: (await client.query("SELECT episode_id,block_id,hidden,changed_at FROM personal_change_visibility WHERE enrollment_id=$1 ORDER BY episode_id,block_id", id)).rows,
    events: await rows(client, "SELECT sequence,event_type,actor_kind,payload,created_at FROM learning_events WHERE enrollment_id=$1 ORDER BY sequence", id),
    limitations: [
      "Course content, grading keys and other learners' records are not included.",
      "Durable workflow histories are retained by the workflow service for its configured retention period and are not part of this file.",
    ],
  };
  // Plain JSON only (timestamps as ISO strings) so the file and its digest match.
  return JSON.parse(JSON.stringify(document)) as typeof document;
}

/** Redacts personal content in place. Keeps identifiers, timestamps, event
 * types and spend/extension accounting so audit totals stay coherent. */
async function eraseWithin(client: PoolClient, enrollmentId: string) {
  await client.query("SELECT set_config('course_core.erasure_enrollment',$1,true)", [enrollmentId]);
  const counts: Record<string, number> = {};
  const run = async (label: string, sql: string) => {
    counts[label] = (await client.query(sql, [enrollmentId])).rowCount ?? 0;
  };
  await run("companionMessages", "UPDATE companion_messages SET content='[erased]',context='{}'::jsonb WHERE enrollment_id=$1");
  await run("attempts", `UPDATE attempts SET response='${ERASED}'::jsonb,result='${ERASED}'::jsonb WHERE enrollment_id=$1`);
  await run("evidence", `UPDATE evidence SET result='${ERASED}'::jsonb,invalidation_reason=CASE WHEN invalidation_reason IS NULL THEN NULL ELSE '[erased]' END WHERE enrollment_id=$1`);
  await run("evidenceReviewNotes", "UPDATE admin_evidence_reviews SET note='[erased]' WHERE enrollment_id=$1");
  // Reviewer findings quote the learner's own words; keep only the decision and replay digest.
  await run("writtenAnswerReviews", "UPDATE rubric_reviews SET criteria=jsonb_build_object('findings','[]'::jsonb,'requestDigest',criteria->'requestDigest'),learner_note=NULL WHERE enrollment_id=$1");
  await run("placementProposals", "UPDATE placement_runs SET proposal=NULL WHERE enrollment_id=$1 AND proposal IS NOT NULL");
  await run("policyPreviews", "UPDATE admin_policy_previews SET preview='{}'::jsonb WHERE enrollment_id=$1");
  await run("learnerModelProfiles", "UPDATE learner_model_profiles SET profile='{}'::jsonb WHERE enrollment_id=$1");
  await run("learnerModelChanges", "UPDATE learner_model_changes SET data='{}'::jsonb WHERE enrollment_id=$1");
  await run("learnerModelProposals", "UPDATE learner_model_proposals SET suggestion='{}'::jsonb WHERE enrollment_id=$1");
  await run("personalTeaching", "UPDATE adaptation_artifacts SET body='{}'::jsonb WHERE enrollment_id=$1");
  await run("adaptationProposals", "UPDATE adaptation_proposals SET body='{}'::jsonb,assignments='[]'::jsonb,evidence_fence='{}'::jsonb WHERE enrollment_id=$1");
  await run("adaptationProofs", "UPDATE adaptation_proofs SET trusted_record='{}'::jsonb,verification_evidence='{}'::jsonb WHERE enrollment_id=$1");
  await run("adaptationAuthorizations", "UPDATE adaptation_authorizations SET trusted_record='{}'::jsonb WHERE enrollment_id=$1");
  await run("adaptationStates", "UPDATE adaptation_states SET snapshot='{}'::jsonb WHERE enrollment_id=$1");
  await run("supervisorInputs", "UPDATE supervisor_inputs SET context='{}'::jsonb WHERE enrollment_id=$1");
  await run("supervisorArtifacts", `UPDATE supervisor_artifacts SET content='${ERASED}'::jsonb WHERE enrollment_id=$1`);
  await run("supervisorToolCalls", "UPDATE supervisor_tool_calls SET arguments='{}'::jsonb,outcome='{}'::jsonb WHERE enrollment_id=$1");
  await run("supervisorJobs", "UPDATE supervisor_jobs SET specification='{}'::jsonb,result=NULL,runtime_snapshot=NULL WHERE enrollment_id=$1");
  await run("supervisorAdaptations", "UPDATE supervisor_adaptations SET summary='[erased]' WHERE enrollment_id=$1");
  await run("providerDispatches", "UPDATE provider_dispatches SET candidate=NULL,outcome=NULL WHERE enrollment_id=$1");
  await run("commandReceipts", `UPDATE command_receipts SET response='${ERASED}'::jsonb WHERE enrollment_id=$1`);
  await run("events", `UPDATE learning_events SET payload='${ERASED}'::jsonb WHERE enrollment_id=$1`);
  await run("pendingDeliveries", "UPDATE outbox SET quarantined_at=clock_timestamp() WHERE delivered_at IS NULL AND quarantined_at IS NULL AND payload->>'enrollmentId'=$1::text");
  await run("enrollment", "UPDATE enrollments SET profile='{}'::jsonb,status='erased',closed_at=coalesce(closed_at,clock_timestamp()) WHERE id=$1");
  await client.query("UPDATE supervisor_permissions SET adaptive_teaching=false,revision=revision+1 WHERE enrollment_id=$1 AND adaptive_teaching", [enrollmentId]);
  await client.query("SELECT set_config('course_core.erasure_enrollment','',true)");
  return counts;
}

export function registerDataLifecycleRoutes(
  app: FastifyInstance,
  db: Database,
  auth: ReturnType<typeof authService>,
) {
  const params = {
    type: "object",
    additionalProperties: false,
    required: ["enrollmentId"],
    properties: { enrollmentId: { type: "string", format: "uuid" } },
  };
  const exportHandler = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const actor = await auth.authenticate(request),
      { enrollmentId } = request.params as { enrollmentId: string };
    const document = await transaction(db, async (client) => {

      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").catch(() => undefined);
      const { enrollment, actorKind } = await authorize(client, actor, enrollmentId);
      return { document: await exportEnrollment(client, enrollmentId), enrollment, actorKind };
    });
    const digest = digestJson(document.document);
    await transaction(db, async (client) => {
      await client.query(
        "INSERT INTO data_exports(id,enrollment_id,workspace_id,requested_by,actor_kind,digest) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), enrollmentId, document.enrollment.workspace_id, actor.id, document.actorKind, digest],
      );
      await appendEvent(client, {
        workspaceId: document.enrollment.workspace_id,
        actorId: actor.id,
        actorKind: document.actorKind === "learner" ? "learner" : "staff",
        type: "data.exported",
        payload: { enrollmentId, digest },
        idempotencyKey: "data-export:" + randomUUID(),
      });
    });
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="enrollment-${enrollmentId}.json"`);
    return document.document;
  };
  const eraseHandler = async (request: import("fastify").FastifyRequest) => {
    const actor = await auth.authenticate(request),
      { enrollmentId } = request.params as { enrollmentId: string },
      input = z
        .strictObject({ confirmation: z.string().max(100), reason: z.string().trim().min(10).max(1000) })
        .safeParse(request.body);
    requireCondition(input.success, "INVALID_INPUT", 400);
    requireCondition(
      input.data.confirmation === `ERASE ${enrollmentId.slice(0, 8)}`,
      "ERASURE_CONFIRMATION_REQUIRED",
      400,
    );
    // Stop new supervision first in its own transaction, so a running job is
    // fenced before any content it might still read is redacted.
    const pending = await transaction(db, async (client) => {
      const { enrollment } = await authorize(client, actor, enrollmentId, true);
      const done = (await client.query("SELECT counts FROM data_erasures WHERE enrollment_id=$1", [enrollmentId])).rows[0];
      if (done) return { done };
      requireCondition(enrollment.status !== "erased", "ALREADY_ERASED", 409);
      await client.query(
        "UPDATE supervisor_permissions SET adaptive_teaching=false,revision=revision+1 WHERE enrollment_id=$1 AND adaptive_teaching",
        [enrollmentId],
      );
      const active = await client.query(
        "UPDATE supervisor_jobs SET cancellation_requested=true WHERE enrollment_id=$1 AND state NOT IN ('applied','cancelled','failed') RETURNING id",
        [enrollmentId],
      );
      return { active: active.rowCount ?? 0 };
    });
    if ("done" in pending && pending.done) return { enrollmentId, status: "erased", counts: pending.done.counts, replayed: true };
    requireCondition(!pending.active, "ERASURE_WAITING_FOR_SUPERVISION", 409);
    return transaction(db, async (client) => {
      const { enrollment, actorKind } = await authorize(client, actor, enrollmentId, true);
      requireCondition(enrollment.status !== "erased", "ALREADY_ERASED", 409);
      const busy = await client.query(
        `SELECT 1 FROM supervisor_jobs WHERE enrollment_id=$1 AND state NOT IN (${TERMINAL.map((s) => `'${s}'`).join(",")}) LIMIT 1`,
        [enrollmentId],
      );
      requireCondition(!busy.rowCount, "ERASURE_WAITING_FOR_SUPERVISION", 409);
      const counts = await eraseWithin(client, enrollmentId);
      await client.query(
        "INSERT INTO data_erasures(id,enrollment_id,workspace_id,requested_by,actor_kind,reason,counts) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [randomUUID(), enrollmentId, enrollment.workspace_id, actor.id, actorKind, input.data.reason, JSON.stringify(counts)],
      );
      // Workspace-level audit without personal content or the free-text reason.
      await appendEvent(client, {
        workspaceId: enrollment.workspace_id,
        actorId: actor.id,
        actorKind: actorKind === "learner" ? "learner" : "staff",
        type: "data.erased",
        payload: { enrollmentId, counts },
        idempotencyKey: "data-erasure:" + enrollmentId,
      });
      return { enrollmentId, status: "erased", counts, replayed: false };
    });
  };
  // Learner-facing and administration paths share one authorization model.
  for (const prefix of ["/api/enrollments", "/api/admin/enrollments"]) {
    app.get(`${prefix}/:enrollmentId/export`, { schema: { params } }, exportHandler);
    app.post(`${prefix}/:enrollmentId/erase`, { schema: { params } }, eraseHandler);
  }
}
