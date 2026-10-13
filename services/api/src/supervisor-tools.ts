import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Json } from "@course-core/providers";
import type { ProviderRequest } from "@course-core/supervisor";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { resolveSupervisorOperationWithin } from "./supervisor-bridge.js";
import { digestJson } from "./repository.js";
import { requireCondition } from "./errors.js";
import type { TeachingContext } from "./provider-runtime.js";
import type {
  SupervisorToolPort,
  SupportSelection,
} from "./supervisor-tool-loop.js";
import type { AdaptationConfiguration } from "./adaptation-store.js";

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),
  empty = z.strictObject({});
const schemas = {
  get_history: z.strictObject({
    beforeMessageId: z.string().uuid().optional(),
  }),
  get_profile: empty,
  get_evidence: empty,
  list_sources: empty,
  list_support: empty,
  choose_support: z.strictObject({ profileId: id, entryId: id }),
};
/** Internal scoped tools only. Provider output cannot choose a tenant, user,
 * authorization, SQL query, grading key, URL to fetch, cost or proof receipt. */
export function supervisorTools(
  db: Database,
  request: ProviderRequest,
  context: TeachingContext,
): SupervisorToolPort {
  return {
    async invoke(name, args, step) {
      requireCondition(
        Object.hasOwn(schemas, name) &&
          Number.isSafeInteger(step) &&
          step >= 0 &&
          step < 8,
        "SUPERVISOR_TOOL_UNAVAILABLE",
        409,
      );
      const parsed = schemas[name as keyof typeof schemas].safeParse(args);
      requireCondition(parsed.success, "SUPERVISOR_TOOL_ARGUMENTS", 400);
      return transaction(db, async (client) => {
        const scoped = await resolveSupervisorOperationWithin(client, request);
        requireCondition(
          scoped.operationStatus === "in_flight",
          "SUPERVISOR_TOOL_STALE",
          409,
        );
        const requestDigest = digestJson({ name, args: parsed.data }),
          old = (
            await client.query(
              "SELECT id,request_digest,outcome FROM supervisor_tool_calls WHERE operation_id=$1 AND step=$2",
              [request.operationId, step],
            )
          ).rows[0];
        if (old) {
          requireCondition(
            old.request_digest === requestDigest,
            "SUPERVISOR_TOOL_CONFLICT",
            409,
          );
          return { receiptId: old.id, ...old.outcome };
        }
        const enrollment = (
          await client.query(
            "SELECT course_release_id,user_id FROM enrollments WHERE id=$1 AND workspace_id=$2",
            [scoped.ref.enrollmentId, scoped.ref.workspaceId],
          )
        ).rows[0]!;
        const release = (
          await client.query(
            "SELECT server_bundle,digest FROM course_releases WHERE id=$1 AND workspace_id=$2",
            [enrollment.course_release_id, scoped.ref.workspaceId],
          )
        ).rows[0]!;
        const permission = (
          await client.query(
            "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2 FOR SHARE",
            [scoped.ref.enrollmentId, scoped.ref.workspaceId],
          )
        ).rows[0];
        let result: Json, selection: SupportSelection | undefined;
        if (name === "get_profile")
          result = {
            profile: context.learner.profile,
            model: context.learner.model ?? {},
            authority: "self_report_and_source_linked_projection",
          } as Json;
        else if (name === "get_evidence")
          result = {
            understanding: context.learner.understanding ?? [],
            recentAttempts: context.learner.recentAttempts ?? [],
            authority: "server_evidence_only",
          } as unknown as Json;
        else if (name === "list_sources")
          result = {
            sources: release.server_bundle.sources.map(
              (s: {
                id: string;
                title: string;
                url: string;
                reviewedAt: string;
              }) => ({
                id: s.id,
                title: s.title,
                url: s.url,
                reviewedAt: s.reviewedAt,
              }),
            ),
            sourceTextIsUntrusted: true,
          } as Json;
        else if (name === "get_history") {
          const before = (parsed.data as { beforeMessageId?: string })
            .beforeMessageId;
          let cursor: { created_at: string; id: string } | undefined;
          // PG retains microseconds; a JS Date truncates them and can skip messages
          // at a page boundary. Keep the DB's exact timestamp as cursor material.
          if (before) {
            cursor = (
              await client.query(
                "SELECT id,created_at::text AS created_at FROM companion_messages WHERE id=$1 AND enrollment_id=$2",
                [before, scoped.ref.enrollmentId],
              )
            ).rows[0];
            requireCondition(cursor, "SUPERVISOR_HISTORY_SCOPE", 404);
          }
          const rows = (
            await client.query(
              `SELECT id,role,content,created_at FROM companion_messages WHERE enrollment_id=$1
          AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 6`,
              [
                scoped.ref.enrollmentId,
                cursor?.created_at ?? null,
                cursor?.id ?? null,
              ],
            )
          ).rows;
          result = {
            messages: rows
              .slice(0, 5)
              .map((r) => ({
                id: r.id,
                role: r.role,
                content: r.content.slice(0, 1000),
                truncated: r.content.length > 1000,
                createdAt: r.created_at.toISOString(),
              })),
            beforeMessageId: rows.length > 5 ? rows[4]!.id : null,
            allHistoryPasted: false,
          } as Json;
        } else {
          const active = (
            await client.query(
              "SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1",
              [scoped.ref.enrollmentId],
            )
          ).rowCount;
          const reg = (
            await client.query(
              `SELECT v.configuration,r.revision FROM adaptation_registries r JOIN adaptation_registry_versions v ON v.course_release_id=r.course_release_id AND v.revision=r.revision WHERE r.course_release_id=$1 AND r.status='active'`,
              [enrollment.course_release_id],
            )
          ).rows[0];
          const profiles =
            (
              reg?.configuration as AdaptationConfiguration | undefined
            )?.profiles.filter(
              (p) =>
                p.adapterId === "authored-teaching-bank-v1" &&
                p.operation === "append_teaching" &&
                p.episodeId === context.episode.id,
            ) ?? [];
          if (!permission?.adaptive_teaching)
            result = { available: false, reason: "learner_opt_in_required" };
          else if (active)
            result = {
              available: false,
              reason: "independent_assessment_active",
            };
          else if (name === "list_support")
            result = {
              available: true,
              permissionRevision: permission.revision,
              profiles: profiles.map((p) => ({
                id: p.id,
                episodeId: p.episodeId,
                classification: p.classification,
                plannedMinutes: p.plannedMinutes,
                additionalEpisodes: p.additionalEpisodes,
                items:
                  p.teachingBank?.map((e) => ({
                    id: e.id,
                    objectiveIds: e.objectiveIds,
                    sourceRefs: e.sourceRefs,
                  })) ?? [],
              })),
            } as Json;
          else {
            const input = parsed.data as { profileId: string; entryId: string },
              profile = profiles.find((p) => p.id === input.profileId),
              entry = profile?.teachingBank?.find(
                (e) => e.id === input.entryId,
              );
            if (!profile || !entry)
              result = {
                available: false,
                reason: "reviewed_support_not_available",
              };
            else {
              selection = {
                profileId: profile.id,
                entryId: entry.id,
                permissionRevision: permission.revision,
              };
              result = {
                selected: true,
                profileId: profile.id,
                entryId: entry.id,
                markdown: entry.markdown,
                sourceRefs: entry.sourceRefs,
                plannedMinutes: profile.plannedMinutes,
                delivery: "pending_host_verification",
                doesNotGrantMastery: true,
              } as Json;
            }
          }
        }
        if (JSON.stringify(result).length > 12000) {
          result = { available: false, reason: "tool_projection_limit" };
          selection = undefined;
        }
        const receiptId = randomUUID(),
          outcome = { result, ...(selection ? { selection } : {}) };
        await client.query(
          "INSERT INTO supervisor_tool_calls(id,job_id,enrollment_id,workspace_id,operation_id,step,tool,request_digest,arguments,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            receiptId,
            scoped.ref.jobId,
            scoped.ref.enrollmentId,
            scoped.ref.workspaceId,
            request.operationId,
            step,
            name,
            requestDigest,
            JSON.stringify(parsed.data),
            JSON.stringify(outcome),
          ],
        );
        return { receiptId, ...outcome };
      });
    },
  };
}
