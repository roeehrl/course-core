import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  parseYouTubeId,
  publicHttpsUrl,
  type ResearchPolicy,
  type ReviewedSource,
  type SourceInspection,
} from "@course-core/research";
import {
  createSourceInspector,
  createSourceReviewer,
  ResearchError,
  verifyInspection,
} from "@course-core/research/node";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { Actor, authService } from "./auth.js";
import { ApiError, requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, loadEnrollment } from "./repository.js";
import { permitRelease, type AdminPermission } from "./course-access.js";
import { recentSearches } from "./research-media.js";

/** A server-built principal. Browsers and models never supply catalog URLs to
 * the inspector; staff add an explicit, expiring source row first. */
export interface ResearchPrincipalInput {
  actorId: string;
  policy: ResearchPolicy;
}
export interface ResearchInspectorPort {
  inspect(
    principal: ResearchPrincipalInput,
    request: { policyId: string; topicId: string; sourceId: string },
  ): Promise<SourceInspection>;
}
export function productionResearchInspector(): ResearchInspectorPort {
  const engine = createSourceInspector<ResearchPrincipalInput>(
    async (principal) => ({ ...principal, role: "author" as const }),
    { maxConcurrent: 2 },
  );
  return { inspect: (principal, request) => engine.inspect(principal, request) };
}

const MAX_SOURCE_DAYS = 365,
  id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),
  key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  timestamp = z.iso.datetime({ offset: true }),
  text = (min: number, max: number) =>
    z
      .string()
      .min(min)
      .max(max)
      .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v));
const addSourceSchema = z.strictObject({
  topicId: id,
  kind: z.enum(["web", "youtube"]),
  url: z.string().max(2048),
  fallbackText: text(1, 10000).optional(),
  candidateId: z.string().uuid().optional(),
  /** A stored YouTube search whose hits include this video; its metadata is copied server-side. */
  searchId: z.string().uuid().optional(),
  expiresAt: timestamp,
  idempotencyKey: key,
});
const reviewSchema = z.strictObject({
  decision: z.enum(["approved", "rejected", "needs_review"]),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rationale: text(20, 2000),
  evidence: z
    .array(
      z.strictObject({
        quote: text(20, 800),
        start: z.number().int().min(0).optional(),
        relevance: text(20, 1000),
      }),
    )
    .max(5),
  suitability: z.strictObject({
    topicRelevant: z.boolean(),
    accurateEnoughForUse: z.boolean(),
    safeForAudience: z.boolean(),
  }),
  rights: z.strictObject({
    use: z.enum(["link_only", "excerpt", "embed"]),
    basis: z.enum([
      "link_only",
      "owned",
      "licensed",
      "public_domain",
      "provider_embed",
    ]),
    reference: text(1, 1000),
  }),
  acknowledgesTruncation: z.boolean(),
  /** The part of a video the reviewer actually watched; never inferred from metadata. */
  segment: z
    .strictObject({
      startSeconds: z.number().int().min(0).max(86400),
      endSeconds: z.number().int().min(1).max(86400),
    })
    .refine((v) => v.endSeconds > v.startSeconds)
    .optional(),
  idempotencyKey: key,
});
const attachSchema = z.strictObject({
  episodeId: id,
  expiresAt: timestamp,
  idempotencyKey: key,
});
const revokeSchema = z.strictObject({
  reason: text(10, 1000),
  idempotencyKey: key,
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  requireCondition(result.success, "INVALID_INPUT", 400);
  return result.data;
}
/** The shared course-scoped rule on the course of `releaseId` (course-access.ts). */
const permitted = (client: Database | PoolClient, actor: Actor, workspaceId: string, permission: AdminPermission, releaseId: string) =>
  permitRelease(client, actor, { id: releaseId, workspace_id: workspaceId }, permission);
interface ReleaseRow {
  id: string;
  workspace_id: string;
  status: string;
  version: string;
  digest: string;
  server_bundle: {
    chapters: {
      episodes: { id: string; title: string; objectiveIds: string[] }[];
    }[];
    research?: {
      publicTopics: {
        id: string;
        objectiveIds: string[];
        queryText: string;
        allowedDomains?: string[];
      }[];
    };
  };
}
interface SourceRow {
  id: string;
  workspace_id: string;
  course_release_id: string;
  topic_id: string;
  kind: "web" | "youtube";
  url: string;
  host: string;
  fallback_text: string | null;
  candidate_id: string | null;
  search_id: string | null;
  duration_seconds: number | null;
  captions_status: "creator_captions" | "unknown" | null;
  embeddable: boolean | null;
  added_by: string;
  expires_at: Date;
  created_at: Date;
}
async function releaseRow(client: Database | PoolClient, releaseId: string) {
  const row = (
    await client.query<ReleaseRow>(
      "SELECT id,workspace_id,status,version,digest,server_bundle FROM course_releases WHERE id=$1",
      [releaseId],
    )
  ).rows[0];
  requireCondition(row, "RELEASE_NOT_FOUND", 404);
  return row;
}
const episodesOf = (release: ReleaseRow) =>
  release.server_bundle.chapters.flatMap((c) => c.episodes);
function topicOf(release: ReleaseRow, topicId: string) {
  const topic = release.server_bundle.research?.publicTopics.find(
    (t) => t.id === topicId,
  );
  requireCondition(topic, "RESEARCH_TOPIC_NOT_APPROVED", 409);
  return topic;
}
const episodesForTopic = (
  release: ReleaseRow,
  topic: { objectiveIds: string[] },
) =>
  episodesOf(release).filter((e) =>
    topic.objectiveIds.every((o) => e.objectiveIds.includes(o)),
  );
/** One single-source policy per approved row. Its expiry is the row's expiry, so
 * an expired approval cannot be inspected or reviewed again. */
function policyFor(release: ReleaseRow, source: SourceRow): ResearchPolicy {
  const topic = topicOf(release, source.topic_id);
  return {
    id: "release:" + release.id,
    revision: 1,
    approvedBy: source.added_by,
    approvalId: source.id,
    expiresAt: source.expires_at.toISOString(),
    topics: [{ id: topic.id, description: topic.queryText.slice(0, 1000) }],
    allowedHosts:
      source.kind === "youtube"
        ? ["www.youtube.com"]
        : [source.host],
    sources: [
      {
        id: source.id,
        kind: source.kind,
        url: source.url,
        topicIds: [topic.id],
        ...(source.fallback_text
          ? {
              fallback: {
                text: source.fallback_text,
                authorId: source.added_by,
                reference: "Course staff written alternative",
              },
            }
          : {}),
      },
    ],
  };
}
async function sourceRow(
  client: Database | PoolClient,
  sourceId: string,
  lock = false,
) {
  parse(z.string().uuid(), sourceId);
  const row = (
    await client.query<SourceRow>(
      `SELECT * FROM research_sources WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [sourceId],
    )
  ).rows[0];
  requireCondition(row, "RESEARCH_SOURCE_NOT_FOUND", 404);
  return row;
}
/** Workspace-scoped idempotency. A retried key returns the original response;
 * the same key with a different request is a conflict, never a second write. */
async function researchCommand<T>(
  db: Database,
  actor: Actor,
  workspaceId: string,
  releaseId: string,
  permission: AdminPermission,
  operation: string,
  idempotencyKey: string,
  semantic: unknown,
  execute: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return transaction(db, async (client) => {
    await permitted(client, actor, workspaceId, permission, releaseId);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "research-command:" + workspaceId + ":" + idempotencyKey,
    ]);
    const digest = digestJson({ actorId: actor.id, operation, semantic });
    const old = (
      await client.query(
        "SELECT request_digest,response FROM research_command_receipts WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspaceId, idempotencyKey],
      )
    ).rows[0];
    if (old) {
      requireCondition(
        old.request_digest === digest,
        "IDEMPOTENCY_CONFLICT",
        409,
      );
      return old.response as T;
    }
    const response = await execute(client);
    await appendEvent(client, {
      workspaceId,
      actorId: actor.id,
      actorKind: "staff",
      type: operation,
      payload: response,
      idempotencyKey: "research:" + idempotencyKey,
    });
    await client.query(
      "INSERT INTO research_command_receipts(workspace_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,$5)",
      [workspaceId, idempotencyKey, digest, actor.id, JSON.stringify(response)],
    );
    return response;
  });
}
function researchFailure(error: unknown): never {
  if (error instanceof ResearchError) {
    const status = [
      "NOT_AUTHORIZED",
      "TOPIC_NOT_APPROVED",
      "SOURCE_NOT_APPROVED",
    ].includes(error.code)
      ? 403
      : ["INVALID_INPUT", "URL_REJECTED", "DOMAIN_REJECTED"].includes(
            error.code,
          )
        ? 400
        : ["CAPACITY"].includes(error.code)
          ? 429
          : 409;
    throw new ApiError(status, "RESEARCH_" + error.code);
  }
  throw error;
}
function attachmentState(row: {
  revoked_at: Date | null;
  expires_at: Date;
  source_expires_at: Date;
}) {
  if (row.revoked_at) return "revoked";
  const now = Date.now();
  return row.expires_at.getTime() <= now ||
    row.source_expires_at.getTime() <= now
    ? "expired"
    : "active";
}
function inspectionView(row: {
  id: string;
  document: SourceInspection;
  created_at: Date;
  policy_revision: number;
}) {
  const d = row.document;
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    title: d.title,
    kind: d.kind,
    trust: d.trust,
    basis: d.content.basis,
    truncated: d.content.truncated,
    contentDigest: d.content.digest,
    text: d.content.text,
    finalUrl: d.provenance.finalUrl,
    metadataAvailability: d.provenance.metadataAvailability,
    fetchedAt: d.provenance.fetchedAt,
    hops: d.provenance.hops.map((h) => ({ url: h.url, status: h.status })),
    attributions: d.attributions,
    ...(d.youtube ? { youtube: d.youtube } : {}),
  };
}
const reviewView = (row: {
  id: string;
  decision: string;
  document: ReviewedSource;
  created_at: Date;
  segment_start_seconds: number | null;
  segment_end_seconds: number | null;
}) => ({
  segment:
    row.segment_start_seconds === null
      ? null
      : { startSeconds: row.segment_start_seconds, endSeconds: row.segment_end_seconds },
  id: row.id,
  inspectionId: row.document.inspectionId,
  decision: row.decision,
  rationale: row.document.rationale,
  evidence: row.document.evidence,
  suitability: row.document.suitability,
  rights: row.document.rights,
  reviewedBy: row.document.reviewedBy,
  reviewedAt: row.document.reviewedAt,
  qualification: row.document.qualification,
});

export function registerResearchReviewRoutes(
  app: FastifyInstance,
  db: Database,
  auth: ReturnType<typeof authService>,
  inspector: ResearchInspectorPort,
) {
  const uuid = { type: "string", format: "uuid" };
  const params = (name: string, pattern?: string) => ({
    type: "object",
    additionalProperties: false,
    required: [name],
    properties: { [name]: pattern ? { type: "string", pattern } : uuid },
  });
  app.get(
    "/api/admin/releases/:releaseId/research/library",
    { schema: { params: params("releaseId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { releaseId } = request.params as { releaseId: string };
      const release = await releaseRow(db, releaseId);
      await permitted(db, actor, release.workspace_id, "course.read", release.id);
      const sources = (
        await db.query<SourceRow>(
          "SELECT * FROM research_sources WHERE course_release_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id LIMIT 100",
          [releaseId, release.workspace_id],
        )
      ).rows;
      const ids = sources.map((s) => s.id);
      const inspections = (
        await db.query(
          `SELECT * FROM (SELECT i.*,row_number() OVER (PARTITION BY source_id ORDER BY created_at DESC,id) AS n
           FROM research_inspections i WHERE source_id=ANY($1::uuid[])) x WHERE n<=3`,
          [ids],
        )
      ).rows;
      const failures = (
        await db.query(
          `SELECT * FROM (SELECT f.*,row_number() OVER (PARTITION BY source_id ORDER BY created_at DESC,id) AS n
           FROM research_inspection_failures f WHERE source_id=ANY($1::uuid[])) x WHERE n<=3`,
          [ids],
        )
      ).rows;
      const reviews = (
        await db.query(
          "SELECT r.* FROM research_reviews r WHERE r.course_release_id=$1 AND r.workspace_id=$2 ORDER BY created_at DESC,id LIMIT 300",
          [releaseId, release.workspace_id],
        )
      ).rows;
      const attachments = (
        await db.query(
          `SELECT a.*,s.expires_at AS source_expires_at,s.id AS source_id FROM research_attachments a
           JOIN research_reviews r ON r.id=a.review_id JOIN research_inspections i ON i.id=r.inspection_id
           JOIN research_sources s ON s.id=i.source_id WHERE a.course_release_id=$1 AND a.workspace_id=$2
           ORDER BY a.created_at DESC,a.id LIMIT 300`,
          [releaseId, release.workspace_id],
        )
      ).rows;
      const reviewSource = new Map(
        inspections.map((i) => [i.id as string, i.source_id as string]),
      );
      return {
        release: {
          id: release.id,
          version: release.version,
          status: release.status,
        },
        topics: (release.server_bundle.research?.publicTopics ?? []).map(
          (t) => ({
            id: t.id,
            objectiveIds: t.objectiveIds,
            queryText: t.queryText,
            allowedDomains: t.allowedDomains ?? [],
            episodes: episodesForTopic(release, t).map((e) => ({
              id: e.id,
              title: e.title,
            })),
          }),
        ),
        sources: sources.map((s) => ({
          id: s.id,
          topicId: s.topic_id,
          kind: s.kind,
          url: s.url,
          fallbackText: s.fallback_text,
          candidateId: s.candidate_id,
          searchId: s.search_id,
          durationSeconds: s.duration_seconds,
          captions: s.captions_status,
          embeddable: s.embeddable,
          expiresAt: s.expires_at.toISOString(),
          createdAt: s.created_at.toISOString(),
          expired: s.expires_at.getTime() <= Date.now(),
          inspections: inspections
            .filter((i) => i.source_id === s.id)
            .map(inspectionView),
          failures: failures
            .filter((f) => f.source_id === s.id)
            .map((f) => ({
              code: f.code,
              createdAt: f.created_at.toISOString(),
            })),
          reviews: reviews
            .filter((r) => reviewSource.get(r.inspection_id) === s.id)
            .map(reviewView),
        })),
        attachments: attachments.map((a) => ({
          id: a.id,
          reviewId: a.review_id,
          sourceId: a.source_id,
          episodeId: a.episode_id,
          topicId: a.topic_id,
          expiresAt: a.expires_at.toISOString(),
          createdAt: a.created_at.toISOString(),
          state: attachmentState(a),
          revokedAt: a.revoked_at?.toISOString() ?? null,
          revokeReason: a.revoke_reason,
        })),
        searches: await recentSearches(db, releaseId, release.workspace_id, release.server_bundle),
        trust: "untrusted_external_content",
        grantsCredit: false,
      };
    },
  );
  app.post(
    "/api/admin/releases/:releaseId/research/sources",
    { schema: { params: params("releaseId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { releaseId } = request.params as { releaseId: string },
        input = parse(addSourceSchema, request.body);
      const release = await releaseRow(db, releaseId);
      return researchCommand(
        db,
        actor,
        release.workspace_id,
        release.id,
        "course.write",
        "research.source.added",
        input.idempotencyKey,
        { releaseId, ...input },
        async (client) => {
          const topic = topicOf(release, input.topicId);
          let url: URL;
          try {
            url =
              input.kind === "youtube"
                ? new URL(
                    "https://www.youtube.com/watch?v=" +
                      parseYouTubeId(input.url),
                  )
                : publicHttpsUrl(input.url);
          } catch (error) {
            researchFailure(error);
          }
          if (topic.allowedDomains?.length && input.kind === "web")
            requireCondition(
              topic.allowedDomains.includes(url.hostname),
              "RESEARCH_DOMAIN_NOT_ALLOWED",
              409,
            );
          const expires = Date.parse(input.expiresAt);
          requireCondition(
            expires > Date.now() &&
              expires <= Date.now() + MAX_SOURCE_DAYS * 86400_000,
            "RESEARCH_EXPIRY_INVALID",
            400,
          );
          if (input.candidateId)
            requireCondition(
              (
                await client.query(
                  `SELECT 1 FROM research_candidates c JOIN research_requests r ON r.id=c.request_id
                   WHERE c.id=$1 AND c.workspace_id=$2 AND r.course_release_id=$3 AND r.topic_id=$4`,
                  [
                    input.candidateId,
                    release.workspace_id,
                    releaseId,
                    input.topicId,
                  ],
                )
              ).rowCount,
              "RESEARCH_CANDIDATE_MISMATCH",
              409,
            );
          let hit: { durationSeconds: number | null; captions: "creator_captions" | "unknown"; embeddable: boolean | null } | undefined;
          if (input.searchId) {
            requireCondition(input.kind === "youtube", "RESEARCH_SEARCH_MISMATCH", 409);
            const stored = (
              await client.query(
                "SELECT hits FROM research_searches WHERE id=$1 AND workspace_id=$2 AND course_release_id=$3 AND topic_id=$4",
                [input.searchId, release.workspace_id, releaseId, input.topicId],
              )
            ).rows[0];
            const videoId = url.searchParams.get("v");
            hit = (stored?.hits as { videoId: string; durationSeconds: number | null; captions: "creator_captions" | "unknown"; embeddable: boolean | null }[] | undefined)
              ?.find((h) => h.videoId === videoId);
            requireCondition(hit, "RESEARCH_SEARCH_MISMATCH", 409);
          }
          const sourceId = randomUUID();
          const inserted = await client.query(
            `INSERT INTO research_sources(id,workspace_id,course_release_id,topic_id,kind,url,host,fallback_text,candidate_id,added_by,expires_at,
               search_id,duration_seconds,captions_status,embeddable)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (course_release_id,topic_id,kind,url) DO NOTHING`,
            [
              sourceId,
              release.workspace_id,
              releaseId,
              input.topicId,
              input.kind,
              url.href,
              url.hostname,
              input.fallbackText ?? null,
              input.candidateId ?? null,
              actor.id,
              input.expiresAt,
              input.searchId ?? null,
              hit && hit.durationSeconds !== null && hit.durationSeconds <= 86400 ? hit.durationSeconds : null,
              hit?.captions ?? null,
              hit?.embeddable ?? null,
            ],
          );
          requireCondition(
            inserted.rowCount === 1,
            "RESEARCH_SOURCE_EXISTS",
            409,
          );
          return {
            sourceId,
            url: url.href,
            state: "approved_for_inspection",
            contentUse: "not_reviewed",
          };
        },
      );
    },
  );
  app.post(
    "/api/admin/research/sources/:sourceId/inspect",
    { schema: { params: params("sourceId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { sourceId } = request.params as { sourceId: string };
      const source = await sourceRow(db, sourceId);
      await permitted(db, actor, source.workspace_id, "course.write", source.course_release_id);
      const release = await releaseRow(db, source.course_release_id);
      requireCondition(
        source.expires_at.getTime() > Date.now(),
        "RESEARCH_SOURCE_EXPIRED",
        409,
      );
      const policy = policyFor(release, source);
      let inspection: SourceInspection;
      try {
        // Network access happens outside any database transaction.
        inspection = await inspector.inspect(
          { actorId: actor.id, policy },
          { policyId: policy.id, topicId: source.topic_id, sourceId: source.id },
        );
        verifyInspection(inspection);
        requireCondition(
          inspection.sourceId === source.id &&
            inspection.policy.approvalId === source.id &&
            inspection.provenance.requestedUrl === source.url,
          "RESEARCH_INSPECTION_MISMATCH",
          409,
        );
      } catch (error) {
        if (error instanceof ResearchError)
          await db.query(
            "INSERT INTO research_inspection_failures(id,source_id,workspace_id,course_release_id,code,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
            [
              randomUUID(),
              source.id,
              source.workspace_id,
              source.course_release_id,
              error.code,
              actor.id,
            ],
          );
        researchFailure(error);
      }
      return transaction(db, async (client) => {
        await permitted(client, actor, source.workspace_id, "course.write", source.course_release_id);
        await client.query(
          "INSERT INTO research_inspections(id,source_id,workspace_id,course_release_id,policy_revision,document,content_digest,inspected_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
          [
            inspection.inspectionId,
            source.id,
            source.workspace_id,
            source.course_release_id,
            inspection.policy.revision,
            JSON.stringify(inspection),
            inspection.content.digest,
            actor.id,
          ],
        );
        await appendEvent(client, {
          workspaceId: source.workspace_id,
          actorId: actor.id,
          actorKind: "staff",
          type: "research.source.inspected",
          payload: {
            sourceId: source.id,
            inspectionId: inspection.inspectionId,
            contentDigest: inspection.content.digest,
          },
          idempotencyKey: "research-inspection:" + inspection.inspectionId,
        });
        return {
          inspectionId: inspection.inspectionId,
          state: inspection.state,
          trust: inspection.trust,
          basis: inspection.content.basis,
          contentUse: "not_reviewed",
        };
      });
    },
  );
  app.post(
    "/api/admin/research/inspections/:inspectionId/review",
    { schema: { params: params("inspectionId", "^[a-f0-9]{64}$") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { inspectionId } = request.params as { inspectionId: string },
        input = parse(reviewSchema, request.body);
      const stored = (
        await db.query(
          "SELECT * FROM research_inspections WHERE id=$1",
          [inspectionId],
        )
      ).rows[0];
      requireCondition(stored, "RESEARCH_INSPECTION_NOT_FOUND", 404);
      const source = await sourceRow(db, stored.source_id);
      const release = await releaseRow(db, source.course_release_id);
      return researchCommand(
        db,
        actor,
        source.workspace_id,
        source.course_release_id,
        "release.review",
        "research.source.reviewed",
        input.idempotencyKey,
        { inspectionId, ...input },
        async (client) => {
          const document = stored.document as SourceInspection;
          if (input.segment) {
            // Only a video has a segment, and it must lie inside the known duration.
            requireCondition(source.kind === "youtube", "RESEARCH_SEGMENT_NOT_APPLICABLE", 409);
            requireCondition(
              source.duration_seconds === null || input.segment.endSeconds <= source.duration_seconds,
              "RESEARCH_SEGMENT_OUT_OF_RANGE",
              409,
            );
          }
          const evidence = input.evidence.map((e) => {
            const start =
              e.start ?? document.content.text.indexOf(e.quote);
            requireCondition(start >= 0, "RESEARCH_REVIEW_EVIDENCE_REQUIRED", 409);
            return { start, quote: e.quote, relevance: e.relevance };
          });
          const policy = policyFor(release, source);
          const reviewer = createSourceReviewer<ResearchPrincipalInput>(
            async (principal) => ({ ...principal, role: "author" as const }),
            async (id) => (id === inspectionId ? document : undefined),
          );
          let reviewed: ReviewedSource;
          try {
            reviewed = await reviewer.review(
              { actorId: actor.id, policy },
              {
                policyId: policy.id,
                topicId: source.topic_id,
                sourceId: source.id,
                inspectionId,
                decision: input.decision,
                rationale: input.rationale,
                contentDigest: input.contentDigest,
                evidence,
                suitability: input.suitability,
                rights: input.rights,
                acknowledgesTruncation: input.acknowledgesTruncation,
              },
            );
          } catch (error) {
            researchFailure(error);
          }
          await client.query(
            "INSERT INTO research_reviews(id,inspection_id,workspace_id,course_release_id,decision,document,reviewed_by,segment_start_seconds,segment_end_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              reviewed.reviewId,
              inspectionId,
              source.workspace_id,
              source.course_release_id,
              reviewed.status,
              JSON.stringify(reviewed),
              actor.id,
              input.segment?.startSeconds ?? null,
              input.segment?.endSeconds ?? null,
            ],
          );
          return {
            segment: input.segment ?? null,
            reviewId: reviewed.reviewId,
            decision: reviewed.status,
            qualification: reviewed.qualification,
            grantsCredit: false,
          };
        },
      );
    },
  );
  app.post(
    "/api/admin/research/reviews/:reviewId/attachments",
    { schema: { params: params("reviewId", "^[a-f0-9]{64}$") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { reviewId } = request.params as { reviewId: string },
        input = parse(attachSchema, request.body);
      const review = (
        await db.query("SELECT * FROM research_reviews WHERE id=$1", [
          reviewId,
        ])
      ).rows[0];
      requireCondition(review, "RESEARCH_REVIEW_NOT_FOUND", 404);
      return researchCommand(
        db,
        actor,
        review.workspace_id,
        review.course_release_id,
        "release.publish",
        "research.resource.attached",
        input.idempotencyKey,
        { reviewId, ...input },
        async (client) => {
          requireCondition(
            review.decision === "approved",
            "RESEARCH_REVIEW_NOT_APPROVED",
            409,
          );
          const inspection = (
            await client.query(
              "SELECT source_id FROM research_inspections WHERE id=$1",
              [review.inspection_id],
            )
          ).rows[0]!;
          const source = await sourceRow(client, inspection.source_id, true);
          const release = await releaseRow(client, review.course_release_id);
          // Archived releases keep serving the learners pinned to them.
          requireCondition(
            release.status === "published" || release.status === "archived",
            "PUBLISHED_RELEASE_REQUIRED",
            409,
          );
          // A newer review of the same source supersedes earlier decisions.
          const latest = (
            await client.query(
              `SELECT r.id FROM research_reviews r JOIN research_inspections i ON i.id=r.inspection_id
               WHERE i.source_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
              [source.id],
            )
          ).rows[0];
          requireCondition(
            latest?.id === reviewId,
            "RESEARCH_REVIEW_SUPERSEDED",
            409,
          );
          const topic = topicOf(release, source.topic_id);
          requireCondition(
            episodesForTopic(release, topic).some(
              (e) => e.id === input.episodeId,
            ),
            "RESEARCH_EPISODE_OUT_OF_SCOPE",
            409,
          );
          const expires = Date.parse(input.expiresAt);
          requireCondition(
            expires > Date.now() && expires <= source.expires_at.getTime(),
            "RESEARCH_EXPIRY_INVALID",
            400,
          );
          const attachmentId = randomUUID();
          const inserted = await client.query(
            `INSERT INTO research_attachments(id,review_id,workspace_id,course_release_id,episode_id,topic_id,expires_at,attached_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [
              attachmentId,
              reviewId,
              review.workspace_id,
              review.course_release_id,
              input.episodeId,
              source.topic_id,
              input.expiresAt,
              actor.id,
            ],
          );
          requireCondition(
            inserted.rowCount === 1,
            "RESEARCH_ATTACHMENT_EXISTS",
            409,
          );
          return {
            attachmentId,
            episodeId: input.episodeId,
            state: "active",
            optional: true,
            grantsCredit: false,
          };
        },
      );
    },
  );
  app.post(
    "/api/admin/research/attachments/:attachmentId/revoke",
    { schema: { params: params("attachmentId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { attachmentId } = request.params as { attachmentId: string },
        input = parse(revokeSchema, request.body);
      const attachment = (
        await db.query("SELECT * FROM research_attachments WHERE id=$1", [
          attachmentId,
        ])
      ).rows[0];
      requireCondition(attachment, "RESEARCH_ATTACHMENT_NOT_FOUND", 404);
      return researchCommand(
        db,
        actor,
        attachment.workspace_id,
        attachment.course_release_id,
        "release.review",
        "research.resource.revoked",
        input.idempotencyKey,
        { attachmentId, ...input },
        async (client) => {
          const updated = await client.query(
            "UPDATE research_attachments SET revoked_at=clock_timestamp(),revoked_by=$2,revoke_reason=$3 WHERE id=$1 AND revoked_at IS NULL",
            [attachmentId, actor.id, input.reason],
          );
          requireCondition(
            updated.rowCount === 1,
            "RESEARCH_ATTACHMENT_ALREADY_REVOKED",
            409,
          );
          return { attachmentId, state: "revoked" };
        },
      );
    },
  );
  app.get(
    "/api/enrollments/:enrollmentId/resources",
    {
      schema: {
        params: params("enrollmentId"),
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["episodeId"],
          properties: {
            episodeId: { type: "string", pattern: "^[a-z][a-z0-9._:-]{0,127}$" },
          },
        },
      },
    },
    async (request) => {
      const actor = await auth.authenticate(request),
        { enrollmentId } = request.params as { enrollmentId: string },
        { episodeId } = request.query as { episodeId: string };
      const loaded = await loadEnrollment(db, actor, enrollmentId);
      const rows = (
        await db.query(
          `SELECT a.id,a.episode_id,a.expires_at,r.document,r.segment_start_seconds,r.segment_end_seconds,s.duration_seconds,
             (SELECT array_agg(c.objective_id ORDER BY c.objective_id) FROM research_resource_choices c
               WHERE c.enrollment_id=$4 AND c.attachment_id=a.id AND c.episode_id=a.episode_id AND c.ended_at IS NULL) AS chosen_for
           FROM research_attachments a
           JOIN research_reviews r ON r.id=a.review_id AND r.decision='approved'
           JOIN research_inspections i ON i.id=r.inspection_id JOIN research_sources s ON s.id=i.source_id
           WHERE a.course_release_id=$1 AND a.workspace_id=$2 AND a.episode_id=$3 AND a.revoked_at IS NULL
             AND a.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()
           ORDER BY (SELECT count(*) FROM research_resource_choices c WHERE c.enrollment_id=$4 AND c.attachment_id=a.id AND c.ended_at IS NULL) DESC,a.created_at,a.id LIMIT 10`,
          [
            loaded.enrollment.course_release_id,
            loaded.enrollment.workspace_id,
            episodeId,
            enrollmentId,
          ],
        )
      ).rows;
      return {
        episodeId,
        resources: rows.map((row) => {
          const d = row.document as ReviewedSource;
          return {
            id: row.id,
            title: d.display.title,
            url: d.display.url,
            excerpts: d.display.excerpts,
            ...(d.display.youtube
              ? {
                  youtube: {
                    ...d.display.youtube,
                    // The reviewer-watched part, when one was recorded.
                    segment:
                      row.segment_start_seconds === null
                        ? null
                        : { startSeconds: row.segment_start_seconds, endSeconds: row.segment_end_seconds },
                    durationSeconds: row.duration_seconds,
                  },
                }
              : {}),
            // Objectives for which the verified supervisor plan suggested this resource to this learner.
            suggestedFor: row.chosen_for ?? [],
            attributions: d.attributions.map((a) => ({
              providerName: a.providerName,
              ...(a.authorName ? { authorName: a.authorName } : {}),
              ...(a.requiredNotice ? { requiredNotice: a.requiredNotice } : {}),
            })),
            whyUseful: d.rationale,
            reviewedAt: d.reviewedAt,
            expiresAt: row.expires_at.toISOString(),
            rightsUse: d.rights.use,
            qualification: d.qualification,
          };
        }),
        optional: true,
        grantsCredit: false,
      };
    },
  );
}
