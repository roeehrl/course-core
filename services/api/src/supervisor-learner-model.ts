import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { RunRef } from "@course-core/supervisor";
import {
  modelSuggestionSelectionSchema,
  type ModelSuggestionSelection,
} from "./supervisor-tool-loop.js";
import { learnerModelSourceEvents, SUGGESTION_OFFER_DAYS, suggestionUncertainty } from "./learner-model.js";
import { loadEnrollment, digestJson } from "./repository.js";
import { appendEvent } from "./events.js";
import { requireCondition } from "./errors.js";

/** Internal application hook, inside the already-verified bridge transaction.
 * No browser route or model principal; writes a pending suggestion, never facts. */
export async function applySupervisorModelSuggestion(
  client: PoolClient,
  ref: RunRef,
  raw: ModelSuggestionSelection,
) {
  const input = modelSuggestionSelectionSchema.parse(raw);
  const job = (
    await client.query(
      "SELECT role,runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR UPDATE",
      [ref.jobId, ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0];
  requireCondition(
    job?.role === "supervisor" &&
      job.runtime_snapshot.state === "ready" &&
      job.runtime_snapshot.generation === ref.generation,
    "SUPERVISOR_MODEL_APPLICATION_SCOPE",
    409,
  );
  const verification = (
    await client.query(
      `SELECT v.id FROM supervisor_verifications v JOIN supervisor_verifier_authorities a ON a.id=v.verifier_id AND a.workspace_id=v.workspace_id
  WHERE v.job_id=$1 AND v.enrollment_id=$2 AND v.workspace_id=$3 AND v.id=$4 AND v.verdict='verified' AND v.revoked_at IS NULL AND a.enabled AND a.can_review_adaptation FOR SHARE OF v,a`,
      [
        ref.jobId,
        ref.enrollmentId,
        ref.workspaceId,
        job.runtime_snapshot.verification?.receiptId,
      ],
    )
  ).rows[0];
  requireCondition(verification, "SUPERVISOR_VERIFICATION_REQUIRED", 409);
  const calls = (
    await client.query(
      "SELECT outcome FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND tool='suggest_model'",
      [ref.jobId, ref.enrollmentId, ref.workspaceId],
    )
  ).rows;
  requireCondition(
    calls.some(
      (c) =>
        c.outcome.modelSuggestion &&
        digestJson(c.outcome.modelSuggestion) === digestJson(input),
    ),
    "SUPERVISOR_MODEL_SELECTION_MISMATCH",
    409,
  );
  const permission = (
    await client.query(
      "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2 FOR SHARE",
      [ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0];
  requireCondition(
    permission?.adaptive_teaching &&
      permission.revision === input.permissionRevision,
    "SUPERVISION_CONSENT_CHANGED",
    409,
  );
  const head = (
    await client.query(
      "SELECT user_id FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0];
  requireCondition(head, "ENROLLMENT_NOT_FOUND", 404);
  const actor = { id: head.user_id, displayName: "Delegated learner" },
    loaded = await loadEnrollment(client, actor, ref.enrollmentId, true);
  requireCondition(
    loaded.enrollment.status === "active",
    "ENROLLMENT_NOT_ACTIVE",
    409,
  );
  const active = (
    await client.query(
      "SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1",
      [ref.enrollmentId],
    )
  ).rowCount;
  requireCondition(!active, "INDEPENDENT_ASSESSMENT_ACTIVE", 409);
  if (input.suggestion.kind === "review_objective") {
    const objectiveId = input.suggestion.objectiveId;
    requireCondition(
      loaded.release.server_bundle.objectives.some((o) => o.id === objectiveId),
      "OBJECTIVE_OUT_OF_SCOPE",
      404,
    );
  }
  const sources = await learnerModelSourceEvents(
    client,
    ref.enrollmentId,
    ref.workspaceId,
    input.sourceEventIds,
  );
  requireCondition(
    sources.length === input.sourceEventDigests.length &&
      sources.every(
        (s) =>
          input.sourceEventDigests.filter(
            (d) => d.eventId === s.eventId && d.digest === s.digest,
          ).length === 1,
      ),
    "MODEL_SOURCE_CHANGED",
    409,
  );
  const human = (
    await client.query(
      "SELECT id FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[]) AND actor_kind='learner'",
      [ref.enrollmentId, ref.workspaceId, input.sourceEventIds],
    )
  ).rowCount;
  requireCondition(human === sources.length, "SOURCE_EVENT_OUT_OF_SCOPE", 404);
  const pending = (
    await client.query(
      // Suggestions from the learner's connected agents have their own share (learner-model.ts).
      `SELECT 1 FROM learner_model_proposals p WHERE enrollment_id=$1 AND workspace_id=$2 AND p.service_id NOT LIKE 'agent-grant:%' AND NOT EXISTS
  (SELECT 1 FROM learner_model_changes c WHERE c.proposal_id=p.id AND c.action<>'proposal.created') LIMIT 20`,
      [ref.enrollmentId, ref.workspaceId],
    )
  ).rows;
  requireCondition(pending.length < 20, "LEARNER_MODEL_PROPOSAL_LIMIT", 409);
  const proposalId = randomUUID(),
    changeId = randomUUID(),
    event = await appendEvent(client, {
      workspaceId: ref.workspaceId,
      enrollmentId: ref.enrollmentId,
      actorId: actor.id,
      actorKind: "agent",
      type: "learner_model.proposal.created",
      payload: { proposalId, jobId: ref.jobId, grantsMastery: false },
      idempotencyKey: "supervisor-model:" + ref.jobId,
      supervise: false,
    });
  await client.query(
    "INSERT INTO learner_model_proposals(id,enrollment_id,workspace_id,actor_id,service_id,course_digest,suggestion,event_id,uncertainty,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+make_interval(hours=>$10*24))",
    [
      proposalId,
      ref.enrollmentId,
      ref.workspaceId,
      actor.id,
      "supervisor-profile:" + ref.jobId,
      loaded.release.digest,
      input.suggestion,
      event.id,
      suggestionUncertainty(sources.length),
      SUGGESTION_OFFER_DAYS,
    ],
  );
  for (const source of sources)
    await client.query(
      "INSERT INTO learner_model_sources(proposal_id,enrollment_id,workspace_id,event_id,event_sequence,event_type,event_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        proposalId,
        ref.enrollmentId,
        ref.workspaceId,
        source.eventId,
        source.cursor,
        source.eventType,
        source.digest,
      ],
    );
  await client.query(
    "INSERT INTO learner_model_profiles(enrollment_id,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [ref.enrollmentId, ref.workspaceId],
  );
  const model = (
    await client.query(
      "UPDATE learner_model_profiles SET revision=revision+1 WHERE enrollment_id=$1 AND workspace_id=$2 RETURNING revision",
      [ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0]!;
  await client.query(
    "UPDATE enrollments SET revision=revision+1,profile_revision=profile_revision+1 WHERE id=$1 AND workspace_id=$2",
    [ref.enrollmentId, ref.workspaceId],
  );
  await client.query(
    `INSERT INTO learner_model_changes(id,enrollment_id,workspace_id,model_revision,enrollment_revision,actor_id,actor_kind,action,proposal_id,event_id,data)
  VALUES($1,$2,$3,$4,$5,$6,'agent','proposal.created',$7,$8,$9)`,
    [
      changeId,
      ref.enrollmentId,
      ref.workspaceId,
      model.revision,
      loaded.enrollment.revision + 1,
      actor.id,
      proposalId,
      event.id,
      {
        suggestion: input.suggestion,
        sourceEventRefs: sources,
        supervisorJobId: ref.jobId,
      },
    ],
  );
  await client.query(
    "INSERT INTO supervisor_model_effects(job_id,enrollment_id,workspace_id,proposal_id,permission_revision,selection_digest) VALUES($1,$2,$3,$4,$5,$6)",
    [
      ref.jobId,
      ref.enrollmentId,
      ref.workspaceId,
      proposalId,
      input.permissionRevision,
      digestJson(input),
    ],
  );
  return {
    proposalId,
    changeId,
    modelRevision: model.revision,
    grantsMastery: false,
  };
}
