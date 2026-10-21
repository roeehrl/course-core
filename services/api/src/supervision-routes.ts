import type { FastifyInstance } from "fastify";
import type { Database } from "./database.js";
import type { authService } from "./auth.js";
import { transaction } from "./database.js";
import {
  enrollmentCommand,
  loadEnrollment,
  type CommandInput,
} from "./repository.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { armOffersRole, studyArmWithin } from "./study.js";

export function registerSupervisionRoutes(
  app: FastifyInstance,
  db: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = "/api/enrollments/:enrollmentId/supervision",
    params = {
      type: "object",
      additionalProperties: false,
      required: ["enrollmentId"],
      properties: { enrollmentId: { type: "string", format: "uuid" } },
    };
  app.get(base, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request),
      { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => {
      const { enrollment } = await loadEnrollment(
        client,
        actor,
        enrollmentId,
        true,
      );
      const row = (
        await client.query(
          "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2",
          [enrollment.id, enrollment.workspace_id],
        )
      ).rows[0];
      const arm = await studyArmWithin(client, enrollment.id);
      return {
        revision: enrollment.revision,
        // A study arm without personal supervision keeps this off until the learner leaves the study.
        lockedByStudy: arm !== null && !armOffersRole(arm.behaviour, "supervisor"),
        permissionRevision: row?.revision ?? 0,
        adaptiveTeaching: row?.adaptive_teaching ?? false,
        authority: "learner_opt_in",
        doesNotGrantMastery: true,
      };
    });
  });
  app.post(
    base,
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision", "idempotencyKey", "adaptiveTeaching"],
          properties: {
            expectedRevision: { type: "integer", minimum: 1 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
            adaptiveTeaching: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const actor = await auth.authenticate(request),
        { enrollmentId } = request.params as { enrollmentId: string },
        input = request.body as CommandInput & { adaptiveTeaching: boolean };
      return enrollmentCommand(
        db,
        actor,
        enrollmentId,
        "supervision.permission",
        input,
        async (client, loaded) => {
          requireCondition(
            loaded.enrollment.user_id === actor.id,
            "LEARNER_CONSENT_REQUIRED",
            403,
          );
          if (input.adaptiveTeaching) {
            const arm = await studyArmWithin(client, enrollmentId);
            requireCondition(!arm || armOffersRole(arm.behaviour, "supervisor"), "STUDY_ARM_NO_SUPERVISION", 409);
          }
          const row = (
            await client.query(
              `INSERT INTO supervisor_permissions(enrollment_id,workspace_id,adaptive_teaching,changed_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(enrollment_id) DO UPDATE SET revision=supervisor_permissions.revision+1,adaptive_teaching=EXCLUDED.adaptive_teaching,changed_by=EXCLUDED.changed_by,updated_at=clock_timestamp() RETURNING revision`,
              [
                enrollmentId,
                loaded.enrollment.workspace_id,
                input.adaptiveTeaching,
                actor.id,
              ],
            )
          ).rows[0]!;
          await client.query(
            "UPDATE enrollments SET revision=revision+1 WHERE id=$1",
            [enrollmentId],
          );
          await appendEvent(client, {
            workspaceId: loaded.enrollment.workspace_id,
            enrollmentId,
            actorId: actor.id,
            actorKind: "learner",
            type: "supervision.permission_changed",
            payload: {
              adaptiveTeaching: input.adaptiveTeaching,
              permissionRevision: row.revision,
            },
            idempotencyKey: `supervision-permission:${enrollmentId}:${input.idempotencyKey}`,
            supervise: false,
          });
          return {
            revision: loaded.enrollment.revision + 1,
            permissionRevision: row.revision,
            adaptiveTeaching: input.adaptiveTeaching,
            authority: "learner_opt_in",
          };
        },
      );
    },
  );
  app.get(base + "/tools", { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request),
      { enrollmentId } = request.params as { enrollmentId: string };
    await transaction(db, (client) =>
      loadEnrollment(client, actor, enrollmentId, true),
    );
    const rows = (
      await db.query(
        `SELECT t.id,t.job_id AS "jobId",t.step,t.tool,t.outcome,t.created_at AS "createdAt",
      j.state AS "jobState",e.plan_revision AS "appliedPlanRevision",m.proposal_id AS "modelProposalId",d.action AS "modelDecision",r.state AS "researchState",
      w.status AS "pendingStatus"
      FROM supervisor_tool_calls t JOIN supervisor_jobs j ON j.id=t.job_id AND j.enrollment_id=t.enrollment_id AND j.workspace_id=t.workspace_id
      LEFT JOIN supervisor_plan_effects e ON e.job_id=t.job_id AND e.enrollment_id=t.enrollment_id AND e.workspace_id=t.workspace_id AND EXISTS(SELECT 1 FROM supervisor_artifacts a WHERE a.job_id=t.job_id AND a.enrollment_id=t.enrollment_id AND a.workspace_id=t.workspace_id AND a.content->>'kind'='supervised_plan' AND ((t.tool='choose_support' AND a.content->'selection'=t.outcome->'selection') OR (t.tool='create_teaching' AND a.content->'generatedTeaching'=t.outcome->'generatedTeaching')))
      LEFT JOIN adaptation_pending_changes w ON w.job_id=t.job_id AND w.enrollment_id=t.enrollment_id AND t.tool='create_teaching' AND w.selection=t.outcome->'generatedTeaching'
      LEFT JOIN research_requests r ON r.id::text=t.outcome #>> '{researchSelection,requestId}' AND r.parent_job_id=t.job_id AND r.enrollment_id=t.enrollment_id AND r.workspace_id=t.workspace_id
      LEFT JOIN supervisor_model_effects m ON m.job_id=t.job_id AND m.enrollment_id=t.enrollment_id AND m.workspace_id=t.workspace_id AND t.tool='suggest_model' AND m.selection_digest=t.outcome->>'modelSuggestionDigest'
      LEFT JOIN LATERAL (SELECT c.action FROM learner_model_changes c WHERE c.proposal_id=m.proposal_id AND c.enrollment_id=t.enrollment_id AND c.workspace_id=t.workspace_id AND c.action<>'proposal.created' ORDER BY c.sequence DESC LIMIT 1) d ON true
      WHERE t.enrollment_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 50`,
        [enrollmentId],
      )
    ).rows;
    // The ordinary timeline shows decisions and references, not pre-delivery text
    // that could become an assessment-help side channel after the job is fenced.
    return {
      calls: rows.map((r) => ({
        ...r,
        outcome: {
          available: r.outcome.result?.available ?? null,
          reason: r.outcome.result?.reason ?? null,
          selected: r.outcome.result?.selected ?? false,
          profileId: r.outcome.selection?.profileId ?? r.outcome.generatedTeaching?.profileId ?? null,
          entryId: r.outcome.selection?.entryId ?? null,
          researchState:r.researchState??null,
          verification:r.tool==='check_teaching'?r.outcome.result?.verification??null:null,
          failedCheckIds:r.tool==='check_teaching'?r.outcome.result?.failedCheckIds??[]:[],
          modelSuggestion: r.tool==='suggest_model'&&r.outcome.modelSuggestion!==undefined,
          delivery:
            // A generated change that waited for a safe point (E03): waiting, turned down or lapsed until added.
            r.pendingStatus && r.appliedPlanRevision === null ? ({ waiting: 'waiting_for_safe_point', declined: 'learner_declined', lapsed: 'lapsed' } as Record<string, string>)[r.pendingStatus] ?? null
            : r.modelProposalId!==null ? (r.modelDecision==='proposal.accepted'?'learner_accepted':r.modelDecision==='proposal.corrected'?'learner_corrected':r.modelDecision==='proposal.disputed'?'learner_disputed':'pending_learner_review') : r.appliedPlanRevision !== null
              ? "applied"
              : (r.outcome.result?.selected===true&&r.jobState==='applied'?'not_selected':r.outcome.result?.delivery ?? null),
        },
        contextRefs: {
          messageIds:
            r.tool === "get_history"
              ? (r.outcome.result?.messages?.map((m: { id: string }) => m.id) ??
                [])
              : r.tool === "search_history"
                ? (r.outcome.result?.matches?.map((m: { messageId: string }) => m.messageId) ?? [])
                : [],
          sourceIds:
            r.tool === "list_sources"
              ? (r.outcome.result?.sources?.map((s: { id: string }) => s.id) ??
                [])
              : r.tool === "search_sources"
                ? [...new Set<string>(r.outcome.result?.passages?.flatMap((p: { sourceRefs: string[] }) => p.sourceRefs) ?? [])]
                : [],
          modelSourceEventIds:r.tool==='get_model_sources'?r.outcome.result?.sources?.map((s:{eventId:string})=>s.eventId)??[]:[],
        },
      })),
    };
  });
}
