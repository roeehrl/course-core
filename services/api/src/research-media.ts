import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  validateRecord,
  validateResearchRequest,
  type MediaCandidate,
  type ResearchRequest,
  type ResearchTask,
} from "@course-core/sdk";
import type { ReviewedSource, SourceInspection } from "@course-core/research";
import {
  createYouTubeSearch,
  ResearchError,
  YouTubeSearchError,
  type YouTubeSearchHit,
  type YouTubeSearchResult,
} from "@course-core/research/node";
import type { RunRef } from "@course-core/supervisor";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { ApiError, requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, loadEnrollment } from "./repository.js";
import { permitRelease } from "./course-access.js";

/** The provider-setup credential binding an admin uses for the YouTube Data API key.
 * Keys are entered only in the admin provider screen and are sealed server-side. */
export const YOUTUBE_SEARCH_CREDENTIAL = "COURSE_PROVIDER_YOUTUBE_DATA_API_KEY";
export interface YouTubeSearchPort {
  /** Undefined when the workspace has no key: search is then unavailable, never keyless. */
  forWorkspace(workspaceId: string): Promise<{ search(query: unknown, signal?: AbortSignal): Promise<YouTubeSearchResult> } | undefined>;
}
export function workspaceYouTubeSearch(
  credential: (workspaceId: string, name: string) => Promise<string | undefined>,
  fetchImpl?: typeof fetch,
): YouTubeSearchPort {
  return {
    async forWorkspace(workspaceId) {
      const key = await credential(workspaceId, YOUTUBE_SEARCH_CREDENTIAL);
      if (!key) return undefined;
      return createYouTubeSearch({ apiKey: () => key, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    },
  };
}

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/);
interface Bundle {
  objectives: { id: string; prerequisites?: string[] }[];
  chapters: { episodes: { id: string; objectiveIds: string[] }[] }[];
  research?: { publicTopics: { id: string; objectiveIds: string[]; queryText: string; allowedDomains?: string[] }[] };
  researchTasks?: ResearchTask[];
}

// ------------------------------------------------------------------ MediaCandidate

export interface ResourceRow {
  attachment_id: string;
  episode_id: string;
  topic_id: string;
  review_id: string;
  review: ReviewedSource;
  segment_start_seconds: number | null;
  segment_end_seconds: number | null;
  inspection_id: string;
  inspection: SourceInspection;
  source_id: string;
  kind: "web" | "youtube";
  candidate_id: string | null;
  duration_seconds: number | null;
  captions_status: "creator_captions" | "unknown" | null;
  embeddable: boolean | null;
}
/** Active, approved, latest-reviewed attachments of an episode. A newer review of
 * the same source (for example a rejection) supersedes an older approval. */
export async function activeResourcesWithin(client: Database | PoolClient, releaseId: string, workspaceId: string, episodeId: string, attachmentId?: string) {
  return (await client.query<ResourceRow>(
    `SELECT a.id AS attachment_id,a.episode_id,a.topic_id,r.id AS review_id,r.document AS review,r.segment_start_seconds,r.segment_end_seconds,
       i.id AS inspection_id,i.document AS inspection,s.id AS source_id,s.kind,s.candidate_id,s.duration_seconds,s.captions_status,s.embeddable
     FROM research_attachments a JOIN research_reviews r ON r.id=a.review_id AND r.decision='approved'
     JOIN research_inspections i ON i.id=r.inspection_id JOIN research_sources s ON s.id=i.source_id
     WHERE a.course_release_id=$1 AND a.workspace_id=$2 AND a.episode_id=$3 AND a.revoked_at IS NULL
       AND a.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND ($4::uuid IS NULL OR a.id=$4)
       AND r.id=(SELECT r2.id FROM research_reviews r2 JOIN research_inspections i2 ON i2.id=r2.inspection_id WHERE i2.source_id=s.id ORDER BY r2.created_at DESC,r2.id DESC LIMIT 1)
     ORDER BY a.created_at,a.id LIMIT 20`,
    [releaseId, workspaceId, episodeId, attachmentId ?? null])).rows;
}
const evidenceKind = (row: ResourceRow): MediaCandidate["inspectedEvidence"]["kind"] => {
  if (row.segment_start_seconds !== null) return "viewed_segment";
  const basis = row.inspection.content.basis;
  return basis === "metadata_only" ? "metadata_only" : basis === "transcript" ? "transcript" : "full_text";
};
/** The SDK MediaCandidate for one reviewed resource and one objective. Claims are
 * only the reviewer's quoted evidence; a segment only a reviewer-watched one. */
export function mediaCandidate(row: ResourceRow, objectiveId: string, bundle: Bundle, requestId?: string): MediaCandidate {
  const review = row.review, kind = evidenceKind(row), metadataOnly = kind === "metadata_only";
  const topic = bundle.research?.publicTopics.find((t) => t.id === row.topic_id);
  const author = review.attributions.find((a) => a.authorName)?.authorName ?? review.attributions[0]?.providerName ?? new URL(review.url).hostname;
  const youtube = row.kind === "youtube";
  const transcript = row.inspection.youtube?.transcript.status === "provided_with_rights";
  const rights: MediaCandidate["rightsAndEmbeddingStatus"] = review.rights.use === "embed"
    ? (row.embeddable === false ? "not_permitted" : "embeddable")
    : review.rights.use === "excerpt" && ["owned", "licensed", "public_domain"].includes(review.rights.basis) ? "licensed_reuse" : "link_only";
  const concerns: string[] = [];
  if (row.inspection.content.truncated) concerns.push("The reviewed text was truncated.");
  if (youtube && !transcript && row.captions_status !== "creator_captions") concerns.push("Captions were not confirmed.");
  if (youtube && row.duration_seconds === null) concerns.push("Duration is unknown.");
  if (metadataOnly) concerns.push("Only provider metadata was inspected; content is unreviewed.");
  const candidate: MediaCandidate = {
    requestId: requestId ?? "library:" + row.source_id,
    sourceUrl: review.url,
    creator: author.slice(0, 300),
    inspectedEvidence: { kind, summary: `Staff ${kind.replaceAll("_", " ")} review of inspection ${row.inspection_id.slice(0, 12)} on ${review.reviewedAt.slice(0, 10)}.` },
    objectiveFit: { objective: objectiveId, fit: topic && topic.objectiveIds.length === 1 ? "direct" : "partial", rationale: review.rationale },
    prerequisites: [...(bundle.objectives.find((o) => o.id === objectiveId)?.prerequisites ?? [])],
    claims: metadataOnly ? [] : review.evidence.map((e) => ({ text: e.quote, supportedBy: `inspection:${row.inspection_id}@${e.start}` })),
    verifiedSegmentIfAny: !metadataOnly && row.segment_start_seconds !== null && row.segment_end_seconds !== null
      ? { startSeconds: row.segment_start_seconds, endSeconds: row.segment_end_seconds } : null,
    duration: row.duration_seconds !== null ? { seconds: row.duration_seconds } : null,
    captionsOrTranscriptStatus: transcript ? "transcript_authorized" : youtube ? (row.captions_status ?? "unknown") : "unknown",
    rightsAndEmbeddingStatus: rights,
    reviewedAt: review.reviewedAt,
    concerns,
    reviewStatus: metadataOnly ? "unreviewed" : "reviewed",
  };
  const checked = validateRecord("researchResult", candidate);
  requireCondition(checked.valid, "RESEARCH_MEDIA_CANDIDATE_INVALID", 409);
  return candidate;
}
/** A metadata-only lead from a stored search hit (F09): never reviewed, no claims or segment. */
export function searchCandidate(hit: YouTubeSearchHit, objectiveId: string, searchId: string): MediaCandidate {
  const candidate: MediaCandidate = {
    requestId: "search:" + searchId,
    sourceUrl: hit.watchUrl,
    creator: hit.channelTitle.slice(0, 300),
    inspectedEvidence: { kind: "metadata_only", summary: "YouTube Data API search metadata only." },
    objectiveFit: { objective: objectiveId, fit: "background", rationale: "Search rank only; not reviewed for fit." },
    prerequisites: [],
    claims: [],
    verifiedSegmentIfAny: null,
    duration: hit.durationSeconds !== null && hit.durationSeconds <= 86400 ? { seconds: hit.durationSeconds } : null,
    captionsOrTranscriptStatus: hit.captions,
    rightsAndEmbeddingStatus: hit.embeddable === false ? "not_permitted" : hit.embeddable ? "embeddable" : "unknown",
    reviewedAt: new Date(0).toISOString(),
    concerns: ["Metadata only: not inspected or reviewed."],
    reviewStatus: "unreviewed",
  };
  const checked = validateRecord("researchResult", candidate);
  requireCondition(checked.valid, "RESEARCH_MEDIA_CANDIDATE_INVALID", 409);
  return candidate;
}

// ------------------------------------------------------------------ supervisor resource choice

export const resourceChoiceSchema = z.strictObject({
  attachmentId: z.string().uuid(),
  objectiveId: id,
  episodeId: id,
  reviewId: z.string().regex(/^[a-f0-9]{64}$/),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  permissionRevision: z.number().int().positive(),
});
export type ResourceChoice = z.infer<typeof resourceChoiceSchema>;
export interface ResourceListing {
  attachmentId: string;
  objectiveId: string;
  candidate: MediaCandidate;
  candidateDigest: string;
  choosable: boolean;
  reason?: "metadata_only_unreviewed" | "embedding_not_permitted";
}
function choosability(candidate: MediaCandidate): Pick<ResourceListing, "choosable" | "reason"> {
  if (candidate.reviewStatus !== "reviewed") return { choosable: false, reason: "metadata_only_unreviewed" };
  if (candidate.rightsAndEmbeddingStatus === "not_permitted") return { choosable: false, reason: "embedding_not_permitted" };
  return { choosable: true };
}
/** One entry per reviewed attachment and episode objective the attachment's topic covers. */
export async function listReviewedResourcesWithin(client: PoolClient, scope: { releaseId: string; workspaceId: string; episodeId: string;
  objectiveIds: string[]; bundle: Bundle; attachmentId?: string }): Promise<ResourceListing[]> {
  const rows = await activeResourcesWithin(client, scope.releaseId, scope.workspaceId, scope.episodeId, scope.attachmentId);
  return rows.flatMap((row) => {
    const topic = scope.bundle.research?.publicTopics.find((t) => t.id === row.topic_id);
    return (topic?.objectiveIds ?? []).filter((o) => scope.objectiveIds.includes(o)).map((objectiveId) => {
      const candidate = mediaCandidate(row, objectiveId, scope.bundle);
      return { attachmentId: row.attachment_id, objectiveId, candidate, candidateDigest: digestJson({ reviewId: row.review_id, candidate }), ...choosability(candidate) };
    });
  }).slice(0, 10);
}
/** Re-derives the choice against current state. Used by the plan verifier and again at
 * application: consent, the learner's current episode (F11), the latest approved review,
 * the attachment's liveness and the exact candidate the tool showed. */
export async function checkResourceChoiceWithin(client: PoolClient, ref: RunRef, raw: ResourceChoice) {
  const choice = resourceChoiceSchema.parse(raw);
  const permission = (await client.query("SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2 FOR SHARE",
    [ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(permission?.adaptive_teaching && permission.revision === choice.permissionRevision, "SUPERVISION_CONSENT_CHANGED", 409);
  const enrollment = (await client.query(
    `SELECT e.status,e.current_episode_id,e.course_release_id,r.server_bundle FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id AND r.workspace_id=e.workspace_id
     WHERE e.id=$1 AND e.workspace_id=$2 FOR SHARE OF e`, [ref.enrollmentId, ref.workspaceId])).rows[0];
  requireCondition(enrollment?.status === "active", "RESEARCH_SCOPE_UNAVAILABLE", 409);
  // F11: once the learner has moved to another lesson, a choice for the old one is stale.
  requireCondition(enrollment.current_episode_id === null || enrollment.current_episode_id === choice.episodeId, "RESOURCE_TOPIC_CHANGED", 409);
  requireCondition(!(await client.query(
    "SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1",
    [ref.enrollmentId])).rowCount, "INDEPENDENT_ASSESSMENT_ACTIVE", 409);
  const bundle = enrollment.server_bundle as Bundle;
  const episode = bundle.chapters.flatMap((c) => c.episodes).find((e) => e.id === choice.episodeId);
  requireCondition(episode?.objectiveIds.includes(choice.objectiveId), "RESOURCE_OUT_OF_SCOPE", 409);
  const [listing] = (await listReviewedResourcesWithin(client, { releaseId: enrollment.course_release_id, workspaceId: ref.workspaceId,
    episodeId: choice.episodeId, objectiveIds: [choice.objectiveId], bundle, attachmentId: choice.attachmentId }));
  requireCondition(listing && listing.choosable && listing.candidateDigest === choice.candidateDigest &&
    listing.candidate.objectiveFit.objective === choice.objectiveId, "RESOURCE_NOT_AVAILABLE", 409);
  return choice;
}
export async function applyResourceChoicesWithin(client: PoolClient, ref: RunRef, choices: ResourceChoice[]) {
  requireCondition(choices.length <= 2 && new Set(choices.map((c) => c.objectiveId)).size === choices.length, "RESOURCE_CHOICE_LIMIT", 409);
  const applied = [];
  for (const raw of choices) {
    const choice = await checkResourceChoiceWithin(client, ref, raw);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["resource-choice:" + ref.enrollmentId + ":" + choice.objectiveId]);
    const replay = (await client.query("SELECT id FROM research_resource_choices WHERE job_id=$1 AND objective_id=$2", [ref.jobId, choice.objectiveId])).rows[0];
    if (replay) { applied.push({ choiceId: replay.id, objectiveId: choice.objectiveId }); continue; }
    await client.query("UPDATE research_resource_choices SET ended_at=clock_timestamp(),end_reason='superseded' WHERE enrollment_id=$1 AND objective_id=$2 AND ended_at IS NULL",
      [ref.enrollmentId, choice.objectiveId]);
    const choiceId = randomUUID();
    await client.query(
      `INSERT INTO research_resource_choices(id,workspace_id,enrollment_id,objective_id,episode_id,attachment_id,review_id,job_id,permission_revision,candidate_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [choiceId, ref.workspaceId, ref.enrollmentId, choice.objectiveId, choice.episodeId, choice.attachmentId, choice.reviewId, ref.jobId,
        choice.permissionRevision, choice.candidateDigest]);
    await appendEvent(client, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, actorKind: "system", type: "research.resource.chosen",
      payload: { choiceId, objectiveId: choice.objectiveId, episodeId: choice.episodeId, attachmentId: choice.attachmentId, grantsMastery: false },
      idempotencyKey: "resource-choice:" + choiceId });
    applied.push({ choiceId, objectiveId: choice.objectiveId });
  }
  return applied;
}

// ------------------------------------------------------------------ structured research requests

export const researchRequestToolSchema = z.strictObject({
  topicId: id,
  taskId: id.optional(),
  objectiveId: id.optional(),
  misconceptionHypothesis: id.nullable().optional(),
  knownPrerequisites: z.array(id).max(20).optional(),
  modality: z.enum(["article", "video", "interactive", "worked_example", "any"]).optional(),
  remainingLearningTime: z.enum(["under_15_min", "15_to_60_min", "over_60_min"]).optional(),
  accessibilityNeeds: z.array(z.enum(["captions", "transcript", "screen_reader", "reduced_motion", "keyboard_only", "audio_description", "plain_language"])).max(7).optional(),
  requiredOrOptional: z.enum(["optional", "required_replacement"]).optional(),
}).refine((v) => (v.taskId === undefined) === (v.objectiveId === undefined), { message: "taskId and objectiveId go together" })
  .refine((v) => v.taskId !== undefined || Object.keys(v).length === 1, { message: "structured fields need a task" });
export type ResearchRequestToolInput = z.infer<typeof researchRequestToolSchema>;
/** Builds the SDK ResearchRequest from declared IDs, enumerated buckets and the task's
 * own limits; the host fills the request ID, episode revision, language and source
 * policy. Nothing here is learner text, and none of it is sent to search. */
export function buildResearchRequest(bundle: Bundle, courseDigest: string, input: ResearchRequestToolInput & { taskId: string; objectiveId: string },
  episodeId: string, planRevision: number): ResearchRequest {
  const task = bundle.researchTasks?.find((t) => t.id === input.taskId);
  requireCondition(task, "UNAPPROVED_RESEARCH_TASK", 409);
  const topic = bundle.research?.publicTopics.find((t) => t.id === input.topicId);
  const allowed = task.sourcePolicy.allowedDomains ?? topic?.allowedDomains;
  const request: ResearchRequest = {
    requestId: "request-" + randomUUID(),
    taskId: task.id,
    objective: input.objectiveId,
    episodeRevision: { episodeId, courseDigest, planRevision },
    misconceptionHypothesis: input.misconceptionHypothesis ?? null,
    knownPrerequisites: [...new Set(input.knownPrerequisites ?? [])],
    language: task.languages[0]!,
    modality: input.modality ?? task.modalities[0]!,
    remainingLearningTime: input.remainingLearningTime ?? "15_to_60_min",
    accessibilityNeeds: [...new Set(input.accessibilityNeeds ?? [])],
    sourcePolicy: { publicTopicId: input.topicId, ...(allowed ? { allowedDomains: [...allowed] } : {}), requireReviewedContent: true,
      maxCandidates: task.sourcePolicy.maxCandidates, maxToolCalls: task.sourcePolicy.maxToolCalls, deadlineSeconds: task.sourcePolicy.deadlineSeconds },
    requiredOrOptional: input.requiredOrOptional ?? "optional",
  };
  const checked = validateResearchRequest(bundle, request);
  if (!checked.valid) throw new ApiError(409, checked.issues[0]?.code ?? "RESEARCH_REQUEST_INVALID");
  return checked.request;
}

// ------------------------------------------------------------------ routes

const uuid = { type: "string", format: "uuid" };
const searchBody = z.strictObject({ maxResults: z.number().int().min(1).max(10).optional() });
const searchView = (row: { id: string; topic_id: string; sent: unknown; hits: YouTubeSearchHit[]; created_at: Date }, objectiveIds: string[]) => ({
  id: row.id,
  topicId: row.topic_id,
  createdAt: row.created_at.toISOString(),
  sent: row.sent,
  hits: row.hits.map((hit) => ({
    videoId: hit.videoId, watchUrl: hit.watchUrl, title: hit.title, channelTitle: hit.channelTitle, publishedAt: hit.publishedAt,
    durationSeconds: hit.durationSeconds, embeddable: hit.embeddable, captions: hit.captions, reviewStatus: hit.reviewStatus,
    candidates: objectiveIds.map((o) => searchCandidate(hit, o, row.id)),
  })),
  reviewStatus: "unreviewed" as const,
});
export async function recentSearches(client: Database | PoolClient, releaseId: string, workspaceId: string, bundle: Pick<Bundle, "research">) {
  const rows = (await client.query("SELECT * FROM research_searches WHERE course_release_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id LIMIT 5",
    [releaseId, workspaceId])).rows;
  return rows.map((row) => searchView(row, bundle.research?.publicTopics.find((t) => t.id === row.topic_id)?.objectiveIds ?? []));
}
function searchFailure(error: unknown): never {
  if (error instanceof YouTubeSearchError)
    throw new ApiError(error.searchCode === "SEARCH_QUOTA" ? 429 : error.searchCode === "SEARCH_UNAUTHORIZED" ? 409 : 502, "YOUTUBE_" + error.searchCode);
  if (error instanceof ResearchError) throw new ApiError(error.code === "INVALID_INPUT" ? 400 : 502, "YOUTUBE_SEARCH_" + error.code);
  throw error;
}

export function registerResearchMediaRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, search?: YouTubeSearchPort) {
  /** Staff search. The topic's approved public query is the only text sent. */
  app.post("/api/admin/releases/:releaseId/research/topics/:topicId/youtube-search", {
    schema: { params: { type: "object", additionalProperties: false, required: ["releaseId", "topicId"],
      properties: { releaseId: uuid, topicId: { type: "string", pattern: "^[a-z][a-z0-9._:-]{0,127}$" } } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { releaseId, topicId } = request.params as { releaseId: string; topicId: string };
    const parsed = searchBody.safeParse(request.body ?? {});
    requireCondition(parsed.success, "INVALID_INPUT", 400);
    const release = (await db.query("SELECT id,workspace_id,server_bundle FROM course_releases WHERE id=$1", [releaseId])).rows[0];
    requireCondition(release, "RELEASE_NOT_FOUND", 404);
    await permitRelease(db, actor, { id: release.id, workspace_id: release.workspace_id }, "course.write");
    const bundle = release.server_bundle as Bundle;
    const topic = bundle.research?.publicTopics.find((t) => t.id === topicId);
    requireCondition(topic, "RESEARCH_TOPIC_NOT_APPROVED", 409);
    const client = await search?.forWorkspace(release.workspace_id);
    requireCondition(client, "YOUTUBE_SEARCH_NOT_CONFIGURED", 409);
    // A declared task language for this topic, if any; never a learner's language.
    const language = bundle.researchTasks?.find((t) => t.publicTopicIds.includes(topicId))?.languages[0];
    let result: YouTubeSearchResult;
    try {
      // Network access happens outside any database transaction.
      result = await client.search({ queryText: topic.queryText, ...(language ? { relevanceLanguage: language } : {}),
        maxResults: parsed.data.maxResults ?? 5 });
    } catch (error) {
      searchFailure(error);
    }
    return transaction(db, async (tx) => {
      await permitRelease(tx, actor, { id: release.id, workspace_id: release.workspace_id }, "course.write");
      const searchId = randomUUID(), queryDigest = digestJson(result.sent);
      await tx.query("INSERT INTO research_searches(id,workspace_id,course_release_id,topic_id,provider,sent,query_digest,hits,searched_by) VALUES($1,$2,$3,$4,'youtube_data_api',$5,$6,$7,$8)",
        [searchId, release.workspace_id, releaseId, topicId, JSON.stringify(result.sent), queryDigest, JSON.stringify(result.hits), actor.id]);
      await appendEvent(tx, { workspaceId: release.workspace_id, actorId: actor.id, actorKind: "staff", type: "research.youtube.searched",
        payload: { searchId, releaseId, topicId, queryDigest, hits: result.hits.length }, idempotencyKey: "research-search:" + searchId });
      const row = (await tx.query("SELECT * FROM research_searches WHERE id=$1", [searchId])).rows[0];
      return { search: searchView(row, topic.objectiveIds), trust: "untrusted_provider_metadata", contentUse: "not_reviewed", grantsCredit: false };
    });
  });
  /** A learner (or staff with access) cancels an outstanding request; its result can then never be collected. */
  app.post("/api/enrollments/:enrollmentId/research/:requestId/cancel", {
    schema: { params: { type: "object", additionalProperties: false, required: ["enrollmentId", "requestId"], properties: { enrollmentId: uuid, requestId: uuid } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId, requestId } = request.params as { enrollmentId: string; requestId: string };
    return transaction(db, async (client) => {
      const loaded = await loadEnrollment(client, actor, enrollmentId, true, true);
      const own = loaded.enrollment.user_id === actor.id;
      const updated = (await client.query(
        `UPDATE research_requests SET state='cancelled',cancelled_at=clock_timestamp(),cancel_reason=$4
         WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND state IN('staged','dispatched') RETURNING research_job_id`,
        [requestId, enrollmentId, loaded.enrollment.workspace_id, own ? "learner" : "staff"])).rows[0];
      if (!updated) {
        const row = (await client.query("SELECT state FROM research_requests WHERE id=$1 AND enrollment_id=$2", [requestId, enrollmentId])).rows[0];
        requireCondition(row, "RESEARCH_REQUEST_NOT_FOUND", 404);
        return { requestId, state: row.state, cancelled: row.state === "cancelled" };
      }
      if (updated.research_job_id)
        await client.query("UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1 AND enrollment_id=$2 AND state NOT IN ('applied','cancelled','failed')",
          [updated.research_job_id, enrollmentId]);
      await appendEvent(client, { workspaceId: loaded.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: own ? "learner" : "staff",
        type: "research.cancelled", payload: { requestId }, idempotencyKey: "research-cancel:" + requestId });
      return { requestId, state: "cancelled", cancelled: true };
    });
  });
}
/** A request whose deadline passed is reported (and treated) as expired. */
export const researchStateSql = "CASE WHEN r.state IN ('staged','dispatched') AND r.deadline_at IS NOT NULL AND r.deadline_at<=clock_timestamp() THEN 'expired' ELSE r.state END";
