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
  ModelSuggestionSelection,
} from "./supervisor-tool-loop.js";
import { digestTeachingArtifact } from "@course-core/sdk";
import {
  generatedTeachingInputSchema,
  type GeneratedTeachingSelection,
} from "./generated-teaching.js";
import type {
  AdaptationRuntime,
  AdaptationConfiguration,
} from "./adaptation-store.js";
import {
  learnerModelSuggestionSchema,
  learnerModelSourceTypes,
  learnerModelSourceEvents,
} from "./learner-model.js";

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
  get_model_sources: empty,
  list_generation_profiles: empty,
  create_teaching: generatedTeachingInputSchema,
  suggest_model: z.strictObject({
    suggestion: learnerModelSuggestionSchema,
    sourceEventIds: z
      .array(z.string().uuid())
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
};
/** Internal scoped tools only. Provider output cannot choose a tenant, user,
 * authorization, SQL query, grading key, URL to fetch, cost or proof receipt. */
export function supervisorTools(
  db: Database,
  request: ProviderRequest,
  context: TeachingContext,
  runtime?: AdaptationRuntime,
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
        let result: Json,
          selection: SupportSelection | undefined,
          modelSuggestion: ModelSuggestionSelection | undefined,
          generatedTeaching: GeneratedTeachingSelection | undefined;
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
        else if (name === "get_model_sources") {
          const sources = (
            await client.query(
              `SELECT id AS "eventId",event_type AS "eventType",payload->>'messageId' AS "messageId",payload->>'episodeId' AS "episodeId"
            FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 AND actor_kind='learner' AND event_type=ANY($3::text[])
            ORDER BY sequence DESC LIMIT 8`,
              [
                scoped.ref.enrollmentId,
                scoped.ref.workspaceId,
                learnerModelSourceTypes,
              ],
            )
          ).rows;
          const anchored = sources.length
            ? await learnerModelSourceEvents(
                client,
                scoped.ref.enrollmentId,
                scoped.ref.workspaceId,
                sources.map((s) => s.eventId),
              )
            : [];
          result = {
            sources: sources.map((s) => ({
              ...s,
              digest: anchored.find((a) => a.eventId === s.eventId)!.digest,
            })),
            containsEventPayloads: false,
            grantsMastery: false,
          } as Json;
        } else if (name === "suggest_model") {
          const input = parsed.data as {
            suggestion: ModelSuggestionSelection["suggestion"];
            sourceEventIds: string[];
          };
          requireCondition(
            permission?.adaptive_teaching,
            "SUPERVISION_CONSENT_REQUIRED",
            409,
          );
          const active = (
            await client.query(
              "SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1",
              [scoped.ref.enrollmentId],
            )
          ).rowCount;
          requireCondition(!active, "INDEPENDENT_ASSESSMENT_ACTIVE", 409);
          const allowed = new Set(
            release.server_bundle.chapters
              .flatMap(
                (c: { episodes: { id: string; objectiveIds: string[] }[] }) =>
                  c.episodes,
              )
              .find((e: { id: string }) => e.id === context.episode.id)
              ?.objectiveIds ?? [],
          );
          requireCondition(
            input.suggestion.kind !== "review_objective" ||
              allowed.has(input.suggestion.objectiveId),
            "OBJECTIVE_OUT_OF_SCOPE",
            404,
          );
          const currentSources = await learnerModelSourceEvents(
            client,
            scoped.ref.enrollmentId,
            scoped.ref.workspaceId,
            input.sourceEventIds,
          );
          const human = (
            await client.query(
              "SELECT id FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[]) AND actor_kind='learner'",
              [
                scoped.ref.enrollmentId,
                scoped.ref.workspaceId,
                input.sourceEventIds,
              ],
            )
          ).rowCount;
          requireCondition(
            human === input.sourceEventIds.length,
            "SOURCE_EVENT_OUT_OF_SCOPE",
            404,
          );
          const shown = (
            await client.query(
              "SELECT outcome FROM supervisor_tool_calls WHERE operation_id=$1 AND step<$2 AND tool='get_model_sources'",
              [request.operationId, step],
            )
          ).rows.flatMap((row) => row.outcome.result.sources ?? []);
          requireCondition(
            currentSources.every((source) =>
              shown.some(
                (s: { eventId: string; digest: string }) =>
                  s.eventId === source.eventId && s.digest === source.digest,
              ),
            ),
            "MODEL_SOURCE_NOT_RETRIEVED",
            409,
          );
          modelSuggestion = {
            ...input,
            sourceEventDigests: currentSources.map(({ eventId, digest }) => ({
              eventId,
              digest,
            })),
            permissionRevision: permission.revision,
          };
          result = {
            staged: true,
            delivery: "pending_host_verification_and_learner_review",
            grantsMastery: false,
          };
        } else if (name === "get_history") {
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
            messages: rows.slice(0, 5).map((r) => ({
              id: r.id,
              role: r.role,
              content: r.content.slice(0, 1000),
              truncated: r.content.length > 1000,
              createdAt: r.created_at.toISOString(),
            })),
            beforeMessageId: rows.length > 5 ? rows[4]!.id : null,
            allHistoryPasted: false,
          } as Json;
        } else if (
          name === "list_generation_profiles" ||
          name === "create_teaching"
        ) {
          const active = (
            await client.query(
              "SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1",
              [scoped.ref.enrollmentId],
            )
          ).rowCount;
          const reg = (
            await client.query(
              `SELECT v.configuration,v.configuration_digest,r.revision FROM adaptation_registries r JOIN adaptation_registry_versions v ON v.course_release_id=r.course_release_id AND v.revision=r.revision WHERE r.course_release_id=$1 AND r.status='active'`,
              [enrollment.course_release_id],
            )
          ).rows[0];
          const config = reg?.configuration as
            AdaptationConfiguration | undefined;
          const profiles =
            config?.profiles.filter(
              (p) =>
                p.operation === "append_teaching" &&
                p.episodeId === context.episode.id &&
                runtime?.adapters.some(
                  (a) =>
                    a.kind === "generated-teaching" &&
                    a.id === p.adapterId &&
                    a.implementationDigest === p.adapterDigest,
                ),
            ) ?? [];
          if (!permission?.adaptive_teaching)
            result = { available: false, reason: "learner_opt_in_required" };
          else if (active)
            result = {
              available: false,
              reason: "independent_assessment_active",
            };
          else if (name === "list_generation_profiles")
            result = {
              available: true,
              profiles: profiles.map((p) => ({
                id: p.id,
                episodeId: p.episodeId,
                classification: p.classification,
                plannedMinutes: p.plannedMinutes,
                additionalEpisodes: p.additionalEpisodes,
                objectiveIds: release.server_bundle.adaptation.targets.find(
                  (t: { episodeId: string }) => t.episodeId === p.episodeId,
                ).objectiveIds,
                sourceRefs: release.server_bundle.adaptation.sourceRefs,
                requiredChecks: release.server_bundle.adaptation.verifiers.find(
                  (v: { id: string }) => v.id === p.verifierId,
                ).requiredCheckIds,
                delivery: "requires_independent_verification",
              })),
            } as Json;
          else {
            const input = generatedTeachingInputSchema.parse(parsed.data),
              profile = profiles.find((p) => p.id === input.profileId);
            requireCondition(profile, "GENERATED_TEACHING_UNAVAILABLE", 409);
            const observed = (
              await client.query(
                "SELECT outcome FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND tool='list_generation_profiles'",
                [
                  scoped.ref.jobId,
                  scoped.ref.enrollmentId,
                  scoped.ref.workspaceId,
                ],
              )
            ).rows;
            requireCondition(
              observed.some((c) =>
                c.outcome.result?.profiles?.some(
                  (p: { id: string }) => p.id === profile.id,
                ),
              ),
              "GENERATION_PROFILE_NOT_OBSERVED",
              409,
            );
            const author = release.server_bundle.adaptation,
              target = author.targets.find(
                (t: { episodeId: string }) => t.episodeId === profile.episodeId,
              ),
              generator = author.generators.find(
                (g: { id: string }) => g.id === profile.generatorId,
              ),
              verifier = author.verifiers.find(
                (v: { id: string }) => v.id === profile.verifierId,
              );
            requireCondition(
              input.objectiveIds.every((o) =>
                target.objectiveIds.includes(o),
              ) &&
                input.sourceRefs.every(
                  (s) =>
                    author.sourceRefs.includes(s) &&
                    generator.sourceRefs.includes(s),
                ) &&
                generator.artifactKinds.includes(input.kind) &&
                verifier.artifactKinds.includes(input.kind),
              "GENERATED_TEACHING_SCOPE",
              409,
            );
            const draft = {
              id: "artifact-" + randomUUID(),
              kind: input.kind,
              markdown: input.markdown,
              objectiveIds: input.objectiveIds,
              sourceRefs: input.sourceRefs,
              generator: { id: generator.id, version: generator.version },
            };
            generatedTeaching = {
              profileId: profile.id,
              episodeId: profile.episodeId,
              permissionRevision: permission.revision,
              registryRevision: reg.revision,
              configurationDigest: reg.configuration_digest,
              baseCourseDigest: release.digest,
              artifact: {
                ...draft,
                digest: await digestTeachingArtifact(draft),
              },
            };
            result = {
              selected: true,
              profileId: profile.id,
              artifactDigest: generatedTeaching.artifact.digest,
              delivery: "pending_independent_verification",
              doesNotGrantMastery: true,
            };
          }
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
          modelSuggestion = undefined;
          generatedTeaching = undefined;
        }
        const receiptId = randomUUID(),
          outcome = {
            result,
            ...(selection ? { selection } : {}),
            ...(generatedTeaching
              ? {
                  generatedTeaching,
                  generatedTeachingDigest: digestJson(generatedTeaching),
                }
              : {}),
            ...(modelSuggestion
              ? {
                  modelSuggestion,
                  modelSuggestionDigest: digestJson(modelSuggestion),
                }
              : {}),
          };
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
