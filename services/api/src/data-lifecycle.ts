import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { Actor, authService } from "./auth.js";
import { enrollmentRole, isMember } from "./course-access.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson } from "./repository.js";
import { staffExportsOf, staffViewsOf } from "./learner-view.js";
import { enrollmentProfileFor, mayRead, WITHHELD_FROM_STAFF, type LearnerDataAudience } from "./learner-privacy.js";
import { finalizeErasedPaidWork, lockKeys, openSupervisorOperationKeys } from "./erasure-spend.js";
import { recordSpendEvents } from "./provider-costs.js";
import { afterCommitTransaction, onCommit } from "./after-commit.js";
import { ERASED_REVOKE_REASON, eraseEnrollmentMedia } from "./media-erasure.js";
import { eraseTeachingHypotheses, exportTeachingHypotheses } from "./teaching-hypotheses.js";
import { eraseEnrollmentDigests } from "./erased-digests.js";
import { eraseCrossCourseWithin, exportCrossCourse } from "./cross-course.js";
import { requestSupervisorCancellation } from "./supervisor-cancellation.js";
import { withArtifactContent } from './artifact-store.js';
import { EVENT_EXPORT_FORMAT, eventExportQuery, exportLearningEvents } from './event-export.js';

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
  const member = await isMember(client, actor, enrollment.workspace_id);
  const self = enrollment.user_id === actor.id && member;
  // Staff exports and erasure are workspace-wide (owner/admin); the shared rule resolves the role.
  const role = self || !member ? undefined : await enrollmentRole(client, actor, enrollment);
  const staff = role === "owner" || role === "admin";
  requireCondition(self || staff, "ENROLLMENT_NOT_FOUND", 404);
  return { enrollment, actorKind: self ? ("learner" as const) : ("staff" as const), staffRole: self ? null : (role as "owner" | "admin") };
}
const rows = async (client: PoolClient, sql: string, args: unknown[]) => {
  const result = await client.query(sql + ` LIMIT ${LIMIT + 1}`, args);
  return { items: result.rows.slice(0, LIMIT), truncated: result.rows.length > LIMIT };
};

/** Whether each written answer's conversation has been judged met or not met.
 * Until then, content that grades it (clarification findings, AI drafts) is
 * withheld from the learner's export while they can still reply. */
async function writtenAnswerConclusions(client: PoolClient, enrollmentId: string) {
  const reviews = (await client.query(
    "SELECT attempt_id,decision,criteria->'findings' AS findings,learner_note,probe_only,confirmation,created_at FROM rubric_reviews WHERE enrollment_id=$1 ORDER BY created_at", [enrollmentId])).rows;
  const replies = new Map((await client.query("SELECT continues_attempt_id,id FROM attempts WHERE enrollment_id=$1 AND continues_attempt_id IS NOT NULL", [enrollmentId])).rows
    .map((r) => [r.continues_attempt_id as string, r.id as string]));
  const decisions = new Map(reviews.map((r) => [r.attempt_id as string, r.decision as string]));
  const concluded = (attemptId: string) => {
    for (let at: string | undefined = attemptId, depth = 0; at && depth < 50; at = replies.get(at), depth++)
      if (decisions.get(at) === "met" || decisions.get(at) === "not_met") return true;
    return false;
  };
  return { reviews, concluded };
}
/** Reviewer findings on a clarification request stay withheld while that
 * conversation can still continue: they would coach a reply that may count as
 * independent. The learner always receives the reviewer's note. */
async function writtenAnswerReviews(client: PoolClient, enrollmentId: string, active: boolean) {
  const { reviews, concluded } = await writtenAnswerConclusions(client, enrollmentId);
  return reviews.map((r) => (r.decision === "needs_clarification" && active && !concluded(r.attempt_id) ? { ...r, findings: null, findingsWithheld: true } : r));
}
/** AI drafts reviewers saw about the learner's answers: the drafted summary and
 * per-criterion findings, never a grade. Withheld like clarification findings
 * while the answer awaits a judgement the learner could still influence. */
async function writtenAnswerDrafts(client: PoolClient, enrollmentId: string, active: boolean) {
  const { concluded } = await writtenAnswerConclusions(client, enrollmentId);
  const rows = (await client.query(
    `SELECT r.attempt_id,s.request_id,s.created_at,f.content,f.content_object_id FROM rubric_suggestions s JOIN rubric_assist_requests r ON r.id=s.request_id AND r.enrollment_id=s.enrollment_id
     JOIN supervisor_artifacts f ON f.id=s.artifact_id AND f.enrollment_id=s.enrollment_id WHERE s.enrollment_id=$1 ORDER BY s.created_at`, [enrollmentId])).rows;
  // A draft kept in the object store is read back; an export never silently drops one.
  return (await withArtifactContent(client, rows)).map((r) => {
    const base = { attempt_id: r.attempt_id, request_id: r.request_id, created_at: r.created_at, notAGrade: true };
    if (active && !concluded(r.attempt_id)) return { ...base, summary: null, criteria: null, withheld: true };
    const erased = r.content?.erased === true;
    return { ...base, summary: erased ? null : r.content?.summary ?? null, criteria: erased ? null : r.content?.criteria ?? null };
  });
}

/** The enrollment's data for `audience`. The learner gets everything. A staff
 * export (an owner or admin, on the learner's request) follows the shared
 * privacy rule: the companion conversation and the learner model (the
 * learner's own notes, proposals and change log) are not read at all and are
 * listed under `withheld`; the learner's own download stays complete. The
 * enrollment profile (name, learning goal, pace) follows the same rule's
 * enrollmentProfileFor(): staff who may read the enrollment see it. */
export async function exportEnrollment(client: PoolClient, enrollmentId: string, audience: LearnerDataAudience, staffRole: string | null = null) {
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
    // Who this copy was made for, and what the shared privacy rule left out of it.
    audience,
    withheld: audience === "staff" ? WITHHELD_FROM_STAFF : [],
    learner: { id: user.id, displayName: user.display_name, accountCreatedAt: user.created_at },
    enrollment: {
      id: e.id,
      workspaceId: e.workspace_id,
      status: e.status,
      startedAt: e.started_at,
      closedAt: e.closed_at,
      currentEpisodeId: e.current_episode_id,
      profile: enrollmentProfileFor(audience, staffRole, e.profile),
      policy: e.policy,
    },
    course: release,
    progress: (await client.query("SELECT episode_id,state,completed_block_ids,evidence_refs,started_at,completed_at FROM episode_progress WHERE enrollment_id=$1 ORDER BY started_at", id)).rows,
    attempts: await rows(client, "SELECT id,assessment_id,family_id,mode,assistance,response,result,confidence,submitted_at,course_digest,continues_attempt_id FROM attempts WHERE enrollment_id=$1 ORDER BY submitted_at", id),
    evidence: await rows(client, "SELECT id,attempt_id,objective_id,evaluator_ref,result,independent,invalidated_at,invalidation_reason,created_at FROM evidence WHERE enrollment_id=$1 ORDER BY created_at", id),
    evidenceReviews: (await client.query("SELECT evidence_id,decision,note,created_at FROM admin_evidence_reviews WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
    // Interactive activities: their saved state, what they reported and what a registered evaluator
    // concluded. A staff copy keeps the outcome, never the learner's work (learner-privacy.ts, activity-work).
    activities: {
      instances: await rows(client, `SELECT id,course_digest,episode_id,block_id,activity_id,activity_version,target,execution,state_version,${mayRead(audience, "activity-work") ? "state" : "NULL AS state"},state_revision,satisfied_at,created_at,updated_at FROM activity_instances WHERE enrollment_id=$1 ORDER BY created_at,id`, id),
      observations: await rows(client, `SELECT id,instance_id,${mayRead(audience, "activity-work") ? "observation" : "NULL AS observation"},evaluation,created_at FROM activity_observations WHERE enrollment_id=$1 ORDER BY created_at,id`, id),
      evidence: await rows(client, "SELECT id,instance_id,observation_id,objective_id,evaluator_ref,result,invalidated_at,created_at FROM activity_evidence WHERE enrollment_id=$1 ORDER BY created_at,id", id),
    },
    gateDecisions: (await client.query("SELECT id,gate_id,gate_version,course_digest,policy_revision,status,criterion_results,evaluator,learner_visible_reason,next_actions,decided_at,superseded_at FROM gate_decisions WHERE enrollment_id=$1 ORDER BY decided_at,id", id)).rows,
    // The learner's own words asking for a gate review are for the reviewer deciding it (the review
    // queue), not for staff copies of the record: see learner-privacy.ts.
    gateReviewRequests: (await client.query(`SELECT id,gate_id,decision_id,${mayRead(audience, "gate-review-reason") ? "reason" : "NULL AS reason"},state,reviewer_note,exception_course_digest,exception_gate_version,created_at,decided_at FROM gate_review_requests WHERE enrollment_id=$1 ORDER BY created_at,id`, id)).rows,
    companion: mayRead(audience, "companion")
      ? await rows(client, "SELECT id,role,content,created_at FROM companion_messages WHERE enrollment_id=$1 ORDER BY created_at", id)
      : null,
    // What each companion answer was given (retrieval references, selection, media position,
    // constraint snapshot) and the earlier messages the learner asked it not to use: part of the conversation.
    companionContext: mayRead(audience, "companion")
      ? {
          capsules: await rows(client, "SELECT job_id,learner_message_id,capsule,digest,created_at,updated_at FROM companion_context_capsules WHERE enrollment_id=$1 ORDER BY created_at", id),
          exclusions: (await client.query("SELECT message_id,created_at,ended_at FROM companion_context_exclusions WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
        }
      : null,
    learnerModel: mayRead(audience, "learner-model")
      ? {
          profile: (await client.query("SELECT revision,profile,manually_edited FROM learner_model_profiles WHERE enrollment_id=$1", id)).rows[0] ?? null,
          changes: await rows(client, "SELECT model_revision,actor_kind,action,proposal_id,data,created_at FROM learner_model_changes WHERE enrollment_id=$1 ORDER BY sequence", id),
          proposals: await rows(client, "SELECT id,service_id,suggestion,created_at FROM learner_model_proposals WHERE enrollment_id=$1 ORDER BY created_at", id),
          // Teaching hypotheses about the learner, their reviews, probe runs and the
          // signals that produced them. None of these are assessment evidence.
          teaching: await exportTeachingHypotheses(client, enrollmentId),
          // Agents the learner connected: label, scopes, lifetime and each call's tool and outcome. Never a token.
          agentGrants: await rows(client, "SELECT id,label,scopes,created_at,expires_at,revoked_at,revoked_reason,last_used_at FROM agent_tool_grants WHERE enrollment_id=$1 ORDER BY created_at", id),
          agentToolCalls: await rows(client, "SELECT grant_id,tool,outcome,created_at FROM agent_tool_calls WHERE enrollment_id=$1 ORDER BY created_at", id),
        }
      : null,
    // Staff copies leave the learner model out; teaching hypotheses are given as an
    // explicit staff projection (flags only, no learner-written text) instead.
    ...(audience === "staff" ? { teachingHypotheses: await exportTeachingHypotheses(client, enrollmentId, "staff") } : {}),
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
      research: (await client.query("SELECT topic_id,episode_id,objective_id,request,state,deadline_at,cancel_reason,refusal_code,created_at FROM research_requests WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
      suggestedResources: (await client.query("SELECT objective_id,episode_id,attachment_id,created_at,ended_at,end_reason FROM research_resource_choices WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
    },
    // Generated media staff requested for this learner: what they wrote for it, its review and
    // whether it was shown. Staff-authored, so the shared privacy rule withholds none of it from a
    // staff copy (no learner-privacy.ts category covers it). The clip itself is identified by its
    // digest; it stays playable from the lesson while attached. After erasure only placeholders remain.
    media: await rows(client, `SELECT j.id,j.episode_id,j.kind,j.state,j.failure_code,j.title,j.objective,j.script,j.created_at,j.updated_at,
        a.sha256 AS asset_sha256,a.mime_type AS asset_mime_type,a.byte_length AS asset_byte_length,
        r.decision AS review_decision,r.findings AS review_findings,r.rationale AS review_rationale,r.transcript AS review_transcript,
        r.visual_description AS review_visual_description,r.captions_vtt AS review_captions_vtt,r.created_at AS reviewed_at,
        t.id AS attachment_id,t.expires_at AS attachment_expires_at,t.revoked_at AS attachment_revoked_at,t.revoke_reason AS attachment_revoke_reason
      FROM media_jobs j LEFT JOIN media_assets a ON a.job_id=j.id LEFT JOIN media_reviews r ON r.job_id=j.id LEFT JOIN media_attachments t ON t.job_id=j.id
      WHERE j.enrollment_id=$1 ORDER BY j.created_at,j.id`, id),
    writtenAnswerReviews: await writtenAnswerReviews(client, enrollmentId, e.status === "active"),
    writtenAnswerAssistance: {
      consent: (await client.query("SELECT granted,revision,changed_at FROM rubric_assist_consents WHERE enrollment_id=$1", id)).rows[0] ?? null,
      requests: (await client.query("SELECT attempt_id,state,origin,rejection_reason,created_at FROM rubric_assist_requests WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
      drafts: await writtenAnswerDrafts(client, enrollmentId, e.status === "active"),
    },
    // Which of their own enrollments the learner links for sharing, and the suggestions shown here
    // (learner-privacy.ts, 'cross-course'). Never in a staff copy.
    crossCourse: mayRead(audience, "cross-course") ? await exportCrossCourse(client, enrollmentId) : null,
    // The learner's reason for a second opinion is for the reviewer deciding it (the appeal queue),
    // not for staff copies of the record: see learner-privacy.ts.
    writtenAnswerAppeals: (await client.query(`SELECT attempt_id,${mayRead(audience, "written-answer-appeal-reason") ? "reason" : "NULL AS reason"},state,decision,findings->'findings' AS findings,reviewer_note,created_at,decided_at FROM rubric_appeals WHERE enrollment_id=$1 ORDER BY created_at`, id)).rows,
    // The learner's disputes and exclusions of their own evidence. A staff copy keeps that a result
    // was disputed, never the learner's explanation, and leaves out exclusions (learner-privacy.ts).
    evidenceControls: (await client.query(`SELECT evidence_id,kind,${mayRead(audience, "evidence-dispute-reason") ? "reason" : "NULL AS reason"},created_at,ended_at
      FROM learner_evidence_controls WHERE enrollment_id=$1 ${mayRead(audience, "learner-model") ? "" : "AND kind='dispute'"} ORDER BY created_at,id`, id)).rows,
    // The latest run (the shape before retests existed), every run, and staff overrides of exemptions.
    placement: (await client.query("SELECT state,started_at,finished_at,accepted_at,stop_reason,proposal,start_episode_id FROM placement_runs WHERE enrollment_id=$1 ORDER BY run_number DESC LIMIT 1", id)).rows[0] ?? null,
    placementRuns: (await client.query("SELECT run_number,state,started_at,finished_at,accepted_at,stop_reason,proposal,start_episode_id FROM placement_runs WHERE enrollment_id=$1 ORDER BY run_number", id)).rows,
    placementOverrides: (await client.query("SELECT episode_id,evidence_refs,reason,created_at FROM placement_exemption_overrides WHERE enrollment_id=$1 ORDER BY created_at", id)).rows,
    retention: (await client.query("SELECT objective_id,demonstrated_at,step,due_at,retained_at,needs_review FROM retention_schedules WHERE enrollment_id=$1 ORDER BY objective_id", id)).rows,
    // Research studies of this course the learner joined: the arm, consent and its history (study.ts).
    studies: (await client.query(`SELECT p.study_id,s.title,p.arm_id,p.consent,p.consented_at,p.withdrawn_at,
        (SELECT jsonb_agg(jsonb_build_object('action',c.action,'at',c.created_at) ORDER BY c.consent_revision) FROM study_consent_changes c WHERE c.study_id=p.study_id AND c.enrollment_id=p.enrollment_id) AS history
      FROM study_participants p JOIN studies s ON s.id=p.study_id WHERE p.enrollment_id=$1 ORDER BY p.assigned_at`, id)).rows,
    hiddenPersonalChanges: (await client.query("SELECT episode_id,block_id,hidden,changed_at FROM personal_change_visibility WHERE enrollment_id=$1 ORDER BY episode_id,block_id", id)).rows,
    events: await rows(client, "SELECT sequence,event_type,actor_kind,payload,created_at,schema_version,platform,app_version,client_sequence,occurred_at,COALESCE(received_at,created_at) AS received_at,course_digest,activity_instance_id,attempt_id,payload_ref,causation_id FROM learning_events WHERE enrollment_id=$1 ORDER BY sequence", id),
    // Every time an owner or admin opened the read-only "view as learner" for this enrollment.
    staffViews: await staffViewsOf(client, enrollmentId),
    // Every earlier download of this data by an owner or admin. The download being
    // built right now is recorded once it is complete, so it appears in the next one.
    staffExports: await staffExportsOf(client, enrollmentId),
    limitations: [
      "Course content, grading keys and other learners' records are not included.",
      "Generated media files are listed by digest, type and size; the files themselves are not embedded.",
      "Durable workflow histories are retained by the workflow service for its configured retention period and are not part of this file.",
      ...(audience === "staff" ? ["This copy was made by course staff. It leaves out the parts listed under withheld; the learner's own download includes them."] : []),
    ],
  };
  // Plain JSON only (timestamps as ISO strings) so the file and its digest match.
  return JSON.parse(JSON.stringify(document)) as typeof document;
}

/** Redacts personal content in place. Keeps identifiers, timestamps, event
 * types and spend/extension accounting so audit totals stay coherent. */
export async function eraseWithin(client: PoolClient, enrollment: { id: string; workspace_id: string }) {
  const enrollmentId = enrollment.id;
  // Paid work first, while the job snapshots it settles against still exist: no reservation of this
  // enrollment stays open once the bridge can no longer settle it.
  const paid = await finalizeErasedPaidWork(client, enrollment);
  await client.query("SELECT set_config('course_core.erasure_enrollment',$1,true)", [enrollmentId]);
  const counts: Record<string, number> = { ...paid.counts };
  const run = async (label: string, sql: string) => {
    counts[label] = (await client.query(sql, [enrollmentId])).rowCount ?? 0;
  };
  // Cross-course links of this enrollment, in either direction, go entirely (cross-course.ts).
  Object.assign(counts, await eraseCrossCourseWithin(client, enrollmentId));
  await run("companionMessages", "UPDATE companion_messages SET content='[erased]',context='{}'::jsonb WHERE enrollment_id=$1");
  await run("companionContextCapsules", "UPDATE companion_context_capsules SET capsule='{}'::jsonb,digest='erased' WHERE enrollment_id=$1");
  await run("attempts", `UPDATE attempts SET response='${ERASED}'::jsonb,result='${ERASED}'::jsonb WHERE enrollment_id=$1`);
  await run("evidence", `UPDATE evidence SET result='${ERASED}'::jsonb,invalidation_reason=CASE WHEN invalidation_reason IS NULL THEN NULL ELSE '[erased]' END WHERE enrollment_id=$1`);
  await run("activityStates", "UPDATE activity_instances SET state='{}'::jsonb WHERE enrollment_id=$1");
  await run("activityObservations", `UPDATE activity_observations SET observation='${ERASED}'::jsonb,evaluation=jsonb_build_object('status',evaluation->'status') WHERE enrollment_id=$1`);
  await run("activityEvidence", `UPDATE activity_evidence SET result='${ERASED}'::jsonb WHERE enrollment_id=$1`);
  await run("evidenceReviewNotes", "UPDATE admin_evidence_reviews SET note='[erased]' WHERE enrollment_id=$1");
  // Reviewer findings quote the learner's own words; keep only the decision (the replay digest is
  // tombstoned with the others below).
  await run("writtenAnswerReviews", "UPDATE rubric_reviews SET criteria=jsonb_build_object('findings','[]'::jsonb,'requestDigest',criteria->'requestDigest'),learner_note=NULL WHERE enrollment_id=$1");
  await run("reviewAssistConsent", "UPDATE rubric_assist_consents SET granted=false,revision=revision+1,changed_at=clock_timestamp() WHERE enrollment_id=$1 AND granted");
  await run("gateReviewRequests", "UPDATE gate_review_requests SET reason='[erased]',reviewer_note=CASE WHEN reviewer_note IS NULL THEN NULL ELSE '[erased]' END WHERE enrollment_id=$1");
  await run("writtenAnswerAppeals", "UPDATE rubric_appeals SET reason='[erased]',findings=CASE WHEN findings IS NULL THEN NULL ELSE jsonb_build_object('findings','[]'::jsonb,'requestDigest',findings->'requestDigest') END,reviewer_note=CASE WHEN reviewer_note IS NULL THEN NULL ELSE '[erased]' END WHERE enrollment_id=$1");
  await run("evidenceDisputeReasons", "UPDATE learner_evidence_controls SET reason='' WHERE enrollment_id=$1 AND reason<>''");
  // Study participation goes entirely: the assignment, its consent history and so every export row.
  // The study keeps its allocation counter, so later assignments are unaffected.
  await run("studyConsentChanges", "DELETE FROM study_consent_changes WHERE enrollment_id=$1");
  await run("studyParticipants", "DELETE FROM study_participants WHERE enrollment_id=$1");
  await run("placementProposals", "UPDATE placement_runs SET proposal=NULL WHERE enrollment_id=$1 AND proposal IS NOT NULL");
  await run("supervisorRetryReasons", "UPDATE supervisor_job_retries SET reason='[erased]' WHERE enrollment_id=$1 AND reason<>'[erased]'");
  // A rubric regrade's findings quote the learner's own words; keep only the outcome.
  await run("attemptRegrades", "UPDATE attempt_regrades SET reason='[erased]',result=jsonb_build_object('passed',passed) WHERE enrollment_id=$1");
  await run("supervisorRequeueReasons", "UPDATE supervisor_event_requeues SET reason='[erased]' WHERE enrollment_id=$1 AND reason<>'[erased]'");
  await run("placementOverrides", "UPDATE placement_exemption_overrides SET reason='[erased]' WHERE enrollment_id=$1 AND reason<>'[erased]'");
  await run("policyPreviews", "UPDATE admin_policy_previews SET preview='{}'::jsonb WHERE enrollment_id=$1");
  await run("learnerModelProfiles", "UPDATE learner_model_profiles SET profile='{}'::jsonb WHERE enrollment_id=$1");
  await run("learnerModelChanges", "UPDATE learner_model_changes SET data='{}'::jsonb WHERE enrollment_id=$1");
  await run("learnerModelProposals", "UPDATE learner_model_proposals SET suggestion='{}'::jsonb WHERE enrollment_id=$1");
  // External agent grants stop working; their labels were written by the learner.
  await run("agentToolGrants", "UPDATE agent_tool_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revoked_reason=COALESCE(revoked_reason,'erased'),label='[erased]' WHERE enrollment_id=$1");
  await eraseTeachingHypotheses(run);
  await run("personalTeaching", "UPDATE adaptation_artifacts SET body='{}'::jsonb WHERE enrollment_id=$1");
  await run("adaptationProposals", "UPDATE adaptation_proposals SET body='{}'::jsonb,assignments='[]'::jsonb,evidence_fence='{}'::jsonb WHERE enrollment_id=$1");
  await run("adaptationProofs", "UPDATE adaptation_proofs SET trusted_record='{}'::jsonb,verification_evidence='[]'::jsonb WHERE enrollment_id=$1");
  await run("adaptationAuthorizations", "UPDATE adaptation_authorizations SET trusted_record='{}'::jsonb WHERE enrollment_id=$1");
  await run("adaptationStates", "UPDATE adaptation_states SET snapshot='{}'::jsonb WHERE enrollment_id=$1");
  await run("supervisorInputs", "UPDATE supervisor_inputs SET context='{}'::jsonb WHERE enrollment_id=$1");
  // An artifact kept in the object store lets go of its object, which is then deleted from the store (migration 062).
  await run("supervisorArtifacts", `UPDATE supervisor_artifacts SET content='${ERASED}'::jsonb,content_object_id=NULL WHERE enrollment_id=$1`);
  await run("supervisorToolCalls", "UPDATE supervisor_tool_calls SET arguments='{}'::jsonb,outcome='{}'::jsonb WHERE enrollment_id=$1");
  await run("supervisorJobs", "UPDATE supervisor_jobs SET specification='{}'::jsonb,result=NULL,runtime_snapshot=NULL WHERE enrollment_id=$1");
  await run("researchRequests", "UPDATE research_requests SET request=NULL,request_digest=NULL,objective_id=NULL WHERE enrollment_id=$1 AND request IS NOT NULL");
  await run("researchResourceChoices", "UPDATE research_resource_choices SET ended_at=clock_timestamp(),end_reason='erased' WHERE enrollment_id=$1 AND ended_at IS NULL");
  await run("supervisorAdaptations", "UPDATE supervisor_adaptations SET summary='[erased]' WHERE enrollment_id=$1");
  // The generated candidate is personal. The outcome holds references and numbers only (status,
  // retryability, artifact ID/digest, usage and its basis), which the spend audit and a replay to
  // the settling worker still need; keep exactly those fields.
  await run("providerDispatches", `UPDATE provider_dispatches SET candidate=NULL,outcome=CASE WHEN outcome IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'status',outcome->'status','retryable',outcome->'retryable','retryAfterMs',outcome->'retryAfterMs',
    'artifact',CASE WHEN jsonb_typeof(outcome->'artifact')='object' THEN jsonb_build_object('artifactId',outcome->'artifact'->'artifactId','digest',outcome->'artifact'->'digest') END,
    'usage',CASE WHEN jsonb_typeof(outcome->'usage')='object' THEN jsonb_build_object('microUsd',outcome->'usage'->'microUsd','tokens',outcome->'usage'->'tokens') END,
    'usageBasis',CASE WHEN jsonb_typeof(outcome->'usageBasis')='object' THEN jsonb_build_object('microUsd',outcome->'usageBasis'->'microUsd','tokens',outcome->'usageBasis'->'tokens') END)) END
    WHERE enrollment_id=$1`);
  // Generated help made for this learner stops: live attachments end, unfinished jobs cancel (local only).
  await run("mediaAttachments", `UPDATE media_attachments SET revoked_at=clock_timestamp(),revoked_by=attached_by,revoke_reason='${ERASED_REVOKE_REASON}' WHERE enrollment_id=$1 AND revoked_at IS NULL`);
  // Cancelling a job whose submission may have left the host does not stop the provider.
  await run("mediaJobs", `UPDATE media_jobs SET state=CASE WHEN state='attached' THEN 'expired' ELSE 'cancelled' END,failure_code='MEDIA_ENROLLMENT_ERASED',
    remote_may_continue=(remote_may_continue OR state IN ('submitted','polling','uncertain')),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE enrollment_id=$1 AND state IN ('requested','admitted','submitted','polling','uncertain','generated','under_review','approved','attached')`);
  // A job whose reservation was released above never ran: it ends charging nothing (allowed only
  // once it is cancelled or failed, migration 035).
  if (paid.releasedMediaJobs.length)
    await client.query("UPDATE media_jobs SET charged_micro_usd=0 WHERE id=ANY($1::uuid[]) AND enrollment_id=$2 AND state IN ('failed','cancelled')", [paid.releasedMediaJobs, enrollmentId]);
  // What staff wrote for this learner's media, and the clip rendered for them (media-erasure.ts).
  Object.assign(counts, await eraseEnrollmentMedia(client, enrollmentId));
  await run("commandReceipts", `UPDATE command_receipts SET response='${ERASED}'::jsonb WHERE enrollment_id=$1`);
  // Identifiers stay as the audit skeleton; the payload and the client's device facts go.
  await run("events", `UPDATE learning_events SET payload='${ERASED}'::jsonb,platform=NULL,app_version=NULL,client_sequence=NULL,occurred_at=NULL WHERE enrollment_id=$1`);
  // Plain digests of what was just redacted could be brute-forced back (erased-digests.ts).
  Object.assign(counts, await eraseEnrollmentDigests(client, enrollmentId));
  await run("pendingDeliveries", "UPDATE outbox SET quarantined_at=clock_timestamp() WHERE delivered_at IS NULL AND quarantined_at IS NULL AND payload->>'enrollmentId'=$1::text");
  await run("enrollment", "UPDATE enrollments SET profile='{}'::jsonb,status='erased',closed_at=coalesce(closed_at,clock_timestamp()) WHERE id=$1");
  await client.query("UPDATE supervisor_permissions SET adaptive_teaching=false,revision=revision+1 WHERE enrollment_id=$1 AND adaptive_teaching", [enrollmentId]);
  await client.query("SELECT set_config('course_core.erasure_enrollment','',true)");
  return { counts, spend: paid.events };
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
      const { enrollment, actorKind, staffRole } = await authorize(client, actor, enrollmentId);
      return { document: await exportEnrollment(client, enrollmentId, actorKind, staffRole), enrollment, actorKind, staffRole };
    });
    const digest = digestJson(document.document), exportId = randomUUID();
    // The file is returned only after this append-only record commits. A staff
    // row is shown to the learner (with the role) and kept through erasure.
    await transaction(db, async (client) => {
      await client.query(
        "INSERT INTO data_exports(id,enrollment_id,workspace_id,requested_by,actor_kind,requester_role,digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [exportId, enrollmentId, document.enrollment.workspace_id, actor.id, document.actorKind, document.staffRole, digest],
      );
      await appendEvent(client, {
        workspaceId: document.enrollment.workspace_id,
        actorId: actor.id,
        actorKind: document.actorKind === "learner" ? "learner" : "staff",
        type: "data.exported",
        payload: { enrollmentId, exportId, digest, ...(document.staffRole ? { requesterRole: document.staffRole } : {}) },
        idempotencyKey: "data-export:" + randomUUID(),
      });
    });
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="enrollment-${enrollmentId}.json"`);
    return document.document;
  };
  /** The enrollment's learning events in the portable SDK event-export format (event-export.ts),
   * one bounded cursor page per request, with the same authorization and receipt as the full export. */
  const eventExportHandler = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const actor = await auth.authenticate(request),
      { enrollmentId } = request.params as { enrollmentId: string },
      query = eventExportQuery.safeParse(request.query ?? {});
    requireCondition(query.success, "INVALID_INPUT", 400);
    const result = await transaction(db, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").catch(() => undefined);
      const who = await authorize(client, actor, enrollmentId);
      return { ...who, ...(await exportLearningEvents(client, enrollmentId, who.actorKind, query.data)) };
    });
    const digest = digestJson(result.document), exportId = randomUUID();
    await transaction(db, async (client) => {
      await client.query(
        "INSERT INTO data_exports(id,enrollment_id,workspace_id,requested_by,actor_kind,requester_role,digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [exportId, enrollmentId, result.enrollment.workspace_id, actor.id, result.actorKind, result.staffRole, digest],
      );
      await appendEvent(client, {
        workspaceId: result.enrollment.workspace_id,
        actorId: actor.id,
        actorKind: result.actorKind === "learner" ? "learner" : "staff",
        type: "data.exported",
        payload: { enrollmentId, exportId, digest, format: "learning-event-export", exportFormat: EVENT_EXPORT_FORMAT, cursor: result.document.cursor,
          eventCount: result.document.events.length, ...(result.staffRole ? { requesterRole: result.staffRole } : {}) },
        idempotencyKey: "data-export:" + exportId,
      });
    });
    reply
      .header("Cache-Control", "no-store")
      .header("Course-Core-Export-Has-More", result.hasMore ? "true" : "false")
      .header("Content-Disposition", `attachment; filename="enrollment-${enrollmentId}-events-${result.document.cursor.after}.json"`);
    return result.document;
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
      // Recorded first (authoritative), then signalled so a call, retry wait or hold under way ends now.
      const cancelled = await requestSupervisorCancellation(
        client,
        { workspaceId: enrollment.workspace_id, enrollmentId },
        "data_erasure",
      );
      return { active: cancelled.live };
    });
    if ("done" in pending && pending.done) return { enrollmentId, status: "erased", counts: pending.done.counts, replayed: true };
    requireCondition(!pending.active, "ERASURE_WAITING_FOR_SUPERVISION", 409);
    return afterCommitTransaction(db, async (client) => {
      // The gateway takes an operation's advisory lock before anything else; so does erasure, for
      // every operation whose reservation it may finish, before it locks the enrollment.
      await authorize(client, actor, enrollmentId);
      await lockKeys(client, await openSupervisorOperationKeys(client, enrollmentId));
      const { enrollment, actorKind } = await authorize(client, actor, enrollmentId, true);
      requireCondition(enrollment.status !== "erased", "ALREADY_ERASED", 409);
      const busy = await client.query(
        `SELECT 1 FROM supervisor_jobs WHERE enrollment_id=$1 AND state NOT IN (${TERMINAL.map((s) => `'${s}'`).join(",")}) LIMIT 1`,
        [enrollmentId],
      );
      requireCondition(!busy.rowCount, "ERASURE_WAITING_FOR_SUPERVISION", 409);
      const { counts, spend } = await eraseWithin(client, enrollment);
      // Finished reservations are counted only once the erasure commits.
      onCommit(client, () => recordSpendEvents(spend));
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
    app.get(`${prefix}/:enrollmentId/event-export`, { schema: { params } }, eventExportHandler);
    app.post(`${prefix}/:enrollmentId/erase`, { schema: { params } }, eraseHandler);
  }
}
