import type { FastifyInstance } from "fastify";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { loadEnrollment } from "./repository.js";
import type { authService } from "./auth.js";
import { releaseRole } from "./course-access.js";
import { requireCondition } from "./errors.js";

export function registerResearchRoutes(
  app: FastifyInstance,
  db: Database,
  auth: ReturnType<typeof authService>,
) {
  const uuid = { type: "string", format: "uuid" };
  app.get(
    "/api/enrollments/:enrollmentId/research",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["enrollmentId"],
          properties: { enrollmentId: uuid },
        },
      },
    },
    async (request) => {
      const actor = await auth.authenticate(request),
        { enrollmentId } = request.params as { enrollmentId: string };
      const loaded = await transaction(db, (client) =>
        loadEnrollment(client, actor, enrollmentId, true),
      );
      const rows = (
        await db.query(
          `SELECT r.id,r.topic_id AS "topicId",r.episode_id AS "episodeId",r.state,c.review_state AS "reviewState",c.id AS "candidateId",c.digest
      FROM research_requests r LEFT JOIN research_candidates c ON c.request_id=r.id AND c.enrollment_id=r.enrollment_id AND c.workspace_id=r.workspace_id WHERE r.enrollment_id=$1 AND r.workspace_id=$2 ORDER BY r.created_at DESC LIMIT 50`,
          [enrollmentId, loaded.enrollment.workspace_id],
        )
      ).rows;
      return {
        requests: rows,
        sourceApproval: "not_granted",
        grantsMastery: false,
      };
    },
  );
  app.get(
    "/api/admin/releases/:releaseId/research",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["releaseId"],
          properties: { releaseId: uuid },
        },
      },
    },
    async (request) => {
      const actor = await auth.authenticate(request),
        { releaseId } = request.params as { releaseId: string };
      const release = (
        await db.query("SELECT workspace_id FROM course_releases WHERE id=$1", [
          releaseId,
        ])
      ).rows[0];
      requireCondition(release, "RELEASE_NOT_FOUND", 404);
      // Staff read roles on this release's course (a course grant counts on its own course only).
      requireCondition(["owner", "admin", "instructor"].includes((await releaseRole(db, actor, { id: releaseId, workspace_id: release.workspace_id })) ?? ""), "FORBIDDEN", 403);
      const rows = (
        await db.query(
          `SELECT r.id,r.parent_job_id AS "parentJobId",r.research_job_id AS "researchJobId",r.topic_id AS "topicId",r.episode_id AS "episodeId",r.state,c.id AS "candidateId",c.review_state AS "reviewState",c.digest,a.content
      FROM research_requests r LEFT JOIN research_candidates c ON c.request_id=r.id AND c.enrollment_id=r.enrollment_id AND c.workspace_id=r.workspace_id
      LEFT JOIN supervisor_artifacts a ON a.id=c.artifact_id AND a.job_id=c.job_id AND a.enrollment_id=c.enrollment_id AND a.workspace_id=c.workspace_id WHERE r.course_release_id=$1 AND r.workspace_id=$2 ORDER BY r.created_at DESC LIMIT 50`,
          [releaseId, release.workspace_id],
        )
      ).rows;
      return {
        requests: rows,
        trust: "untrusted_external_content",
        sourceApproval: "not_granted",
        contentUseApproval: false,
      };
    },
  );
}
