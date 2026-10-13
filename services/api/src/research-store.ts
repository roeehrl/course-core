import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  resolvePublicResearchRequest,
  type PublicResearchRequest,
} from "@course-core/sdk";
import type { RunRef } from "@course-core/supervisor";
import { digestJson } from "./repository.js";
import { appendEvent } from "./events.js";
import { requireCondition } from "./errors.js";
import {
  researchSelectionSchema,
  type ResearchSelection,
} from "./research-contracts.js";

/** Topic resolution always uses the immutable enrolled course. No interpolation,
 * model URL, private profile/history or user-selected query is accepted. */
export async function publicTopicWithin(
  client: PoolClient,
  enrollmentId: string,
  workspaceId: string,
  topicId: string,
  episodeId: string,
) {
  const row = (
    await client.query(
      "SELECT r.id,r.digest,r.server_bundle FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id AND r.workspace_id=e.workspace_id WHERE e.id=$1 AND e.workspace_id=$2 AND e.status='active' AND r.status='published' FOR SHARE OF e,r",
      [enrollmentId, workspaceId],
    )
  ).rows[0];
  requireCondition(row, "RESEARCH_SCOPE_UNAVAILABLE", 409);
  const episode = row.server_bundle.chapters
      .flatMap((c: { episodes: unknown[] }) => c.episodes)
      .find((e: { id: string }) => e.id === episodeId),
    topic = row.server_bundle.research?.publicTopics.find(
      (t: { id: string }) => t.id === topicId,
    );
  requireCondition(
    episode &&
      topic &&
      topic.objectiveIds.every((id: string) =>
        episode.objectiveIds.includes(id),
      ),
    "RESEARCH_TOPIC_OUT_OF_SCOPE",
    409,
  );
  const resolved = resolvePublicResearchRequest(row.server_bundle, { topicId });
  requireCondition(resolved.valid, "RESEARCH_TOPIC_NOT_APPROVED", 409);
  return {
    releaseId: row.id,
    courseDigest: row.digest,
    request: resolved.request,
    topic,
    queryDigest: digestJson({
      episodeId,
      topicId,
      courseDigest: row.digest,
      request: resolved.request,
    }),
  };
}
export async function stageResearchWithin(
  client: PoolClient,
  ref: RunRef,
  topicId: string,
  episodeId: string,
): Promise<ResearchSelection> {
  const permission = (
    await client.query(
      "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2 FOR SHARE",
      [ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0];
  requireCondition(
    permission?.adaptive_teaching,
    "SUPERVISION_CONSENT_REQUIRED",
    409,
  );
  requireCondition(
    !(
      await client.query(
        "SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1",
        [ref.enrollmentId],
      )
    ).rowCount,
    "INDEPENDENT_ASSESSMENT_ACTIVE",
    409,
  );
  const topic = await publicTopicWithin(
    client,
    ref.enrollmentId,
    ref.workspaceId,
    topicId,
    episodeId,
  );
  const old = (
    await client.query(
      "SELECT * FROM research_requests WHERE parent_job_id=$1 AND topic_id=$2",
      [ref.jobId, topicId],
    )
  ).rows[0];
  if (old) {
    requireCondition(
      old.query_digest === topic.queryDigest &&
        old.permission_revision === permission.revision,
      "RESEARCH_SELECTION_CHANGED",
      409,
    );
    return {
      requestId: old.id,
      topicId,
      episodeId,
      permissionRevision: permission.revision,
      queryDigest: topic.queryDigest,
      courseDigest: topic.courseDigest,
    };
  }
  requireCondition(
    Number(
      (
        await client.query(
          "SELECT count(*) FROM research_requests WHERE parent_job_id=$1",
          [ref.jobId],
        )
      ).rows[0].count,
    ) < 2,
    "RESEARCH_REQUEST_LIMIT",
    409,
  );
  const requestId = randomUUID();
  await client.query(
    "INSERT INTO research_requests(id,workspace_id,enrollment_id,course_release_id,parent_job_id,topic_id,episode_id,permission_revision,query_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      requestId,
      ref.workspaceId,
      ref.enrollmentId,
      topic.releaseId,
      ref.jobId,
      topicId,
      episodeId,
      permission.revision,
      topic.queryDigest,
    ],
  );
  return {
    requestId,
    topicId,
    episodeId,
    permissionRevision: permission.revision,
    queryDigest: topic.queryDigest,
    courseDigest: topic.courseDigest,
  };
}
export async function checkResearchSelectionWithin(
  client: PoolClient,
  ref: RunRef,
  raw: ResearchSelection,
) {
  const selection = researchSelectionSchema.parse(raw),
    row = (
      await client.query(
        "SELECT * FROM research_requests WHERE id=$1 AND parent_job_id=$2 AND enrollment_id=$3 AND workspace_id=$4 FOR UPDATE",
        [selection.requestId, ref.jobId, ref.enrollmentId, ref.workspaceId],
      )
    ).rows[0];
  requireCondition(
    row &&
      row.state === "staged" &&
      row.topic_id === selection.topicId &&
      row.episode_id === selection.episodeId &&
      row.query_digest === selection.queryDigest &&
      row.permission_revision === selection.permissionRevision,
    "RESEARCH_SELECTION_CHANGED",
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
      permission.revision === selection.permissionRevision,
    "SUPERVISION_CONSENT_CHANGED",
    409,
  );
  const topic = await publicTopicWithin(
    client,
    ref.enrollmentId,
    ref.workspaceId,
    selection.topicId,
    selection.episodeId,
  );
  requireCondition(
    topic.queryDigest === selection.queryDigest &&
      topic.courseDigest === selection.courseDigest,
    "RESEARCH_SELECTION_CHANGED",
    409,
  );
  return selection;
}
export async function activateResearchWithin(
  client: PoolClient,
  ref: RunRef,
  selections: ResearchSelection[],
) {
  requireCondition(
    selections.length <= 2 &&
      new Set(selections.map((s) => s.requestId)).size === selections.length,
    "RESEARCH_REQUEST_LIMIT",
    409,
  );
  for (const raw of selections) {
    const s = await checkResearchSelectionWithin(client, ref, raw);
    const event = await appendEvent(client, {
      workspaceId: ref.workspaceId,
      enrollmentId: ref.enrollmentId,
      actorKind: "system",
      type: "research.requested",
      payload: { requestId: s.requestId },
      idempotencyKey: "research-activate:" + s.requestId,
      supervise: true,
    });
    await client.query(
      "UPDATE research_requests SET state='dispatched',activation_event_id=$2 WHERE id=$1 AND state='staged'",
      [s.requestId, event.id],
    );
  }
}
export async function resolveResearchInputWithin(
  client: PoolClient,
  enrollmentId: string,
  workspaceId: string,
  requestId: string,
  eventId: string,
  jobId?: string,
) {
  const row = (
    await client.query(
      "SELECT * FROM research_requests WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND activation_event_id=$4 AND state='dispatched' FOR UPDATE",
      [requestId, enrollmentId, workspaceId, eventId],
    )
  ).rows[0];
  requireCondition(
    row && (!jobId || row.research_job_id === jobId),
    "RESEARCH_REQUEST_NOT_ACTIVATED",
    409,
  );
  const permission = (
    await client.query(
      "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2 FOR SHARE",
      [enrollmentId, workspaceId],
    )
  ).rows[0];
  requireCondition(
    permission?.adaptive_teaching &&
      permission.revision === row.permission_revision,
    "SUPERVISION_CONSENT_CHANGED",
    409,
  );
  const topic = await publicTopicWithin(
    client,
    enrollmentId,
    workspaceId,
    row.topic_id,
    row.episode_id,
  );
  requireCondition(
    topic.queryDigest === row.query_digest,
    "RESEARCH_SELECTION_CHANGED",
    409,
  );
  return {
    requestId,
    topicId: row.topic_id,
    episodeId: row.episode_id,
    queryDigest: row.query_digest,
    publicRequest: topic.request as PublicResearchRequest,
  };
}
