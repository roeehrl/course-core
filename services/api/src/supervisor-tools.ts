import { stageResearchWithin } from "./research-store.js";
import {
  buildResearchRequest,
  listReviewedResourcesWithin,
  researchRequestToolSchema,
  type ResourceChoice,
  type ResearchRequestToolInput,
} from "./research-media.js";
import type { ResearchSelection } from "./research-contracts.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Json } from "@course-core/providers";
import type { ProviderRequest } from "@course-core/supervisor";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { resolveSupervisorOperationWithin } from "./supervisor-bridge.js";
import { digestJson, type Enrollment, type Release } from "./repository.js";
import type { CourseManifest } from "@course-core/sdk";
import { SEARCH_LIMITS, searchCoursePassages, searchLearnerQuestions } from "./retrieval.js";
import { transferChecks } from "./adaptation-transfer.js";
import { ApiError } from "./errors.js";
import { checkGeneratedSupervisorTeachingWithin, resolveEnrollmentCourse } from "./adaptation-store.js";
import { CREATES_INPUT, generatedDraft, profileCreates, sceneModels, sdkKind } from "./generated-content.js";
import { requireCondition } from "./errors.js";
import { requireSameRequest } from "./erased-digests.js";
import type { TeachingContext } from "./provider-runtime.js";
import {
  ToolCallRefused,
  type SupervisorToolPort,
  type SupportSelection,
  type ModelSuggestionSelection,
} from "./supervisor-tool-loop.js";
import type { ToolLoopRefusalReason } from "./output-refusal.js";
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
  excludedAttemptIds,
} from "./learner-model.js";
import { USABLE_MESSAGE, inLesson } from "./context-capsule.js";
import {
  HYPOTHESIS_TOOL_NAMES,
  hypothesisToolSchemas,
  invokeHypothesisTool,
  type HypothesisToolName,
} from "./teaching-hypotheses.js";

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),
  empty = z.strictObject({});
const schemas = {
  get_history: z.strictObject({
    beforeMessageId: z.string().uuid().optional(),
  }),
  get_profile: empty,
  get_evidence: empty,
  list_sources: empty,
  search_sources: z.strictObject({ query: z.string().trim().min(1).max(SEARCH_LIMITS.queryCharacters) }),
  search_history: z.strictObject({ query: z.string().trim().min(1).max(SEARCH_LIMITS.queryCharacters) }),
  list_research_topics: empty,
  request_research: researchRequestToolSchema,
  list_reviewed_resources: empty,
  choose_resource: z.strictObject({ attachmentId: z.string().uuid(), objectiveId: id }),
  list_support: empty,
  choose_support: z.strictObject({ profileId: id, entryId: id }),
  get_model_sources: empty,
  list_generation_profiles: empty,
  create_teaching: generatedTeachingInputSchema,
  check_teaching: z.strictObject({
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
  }),
  suggest_model: z.strictObject({
    suggestion: learnerModelSuggestionSchema,
    sourceEventIds: z
      .array(z.string().uuid())
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  ...hypothesisToolSchemas,
  get_assessment_outline: empty,
  get_code_results: empty,
};
/** Items that test an objective of the current episode. Prompt and structure only: never grading. */
function episodeAssessments(bundle: { assessments?: { id: string; type: string; objectiveIds: string[]; familyId: string; role?: string;
  misconceptionIds?: string[]; language?: string }[] }, context: TeachingContext) {
  const objectives = new Set(context.episode.objectives.map((o) => o.id));
  return (bundle.assessments ?? []).filter((a) => a.objectiveIds.some((id) => objectives.has(id)));
}
/** Names the host implements; each must have a catalog contract and vice versa. */
export const IMPLEMENTED_SUPERVISOR_TOOLS = Object.keys(schemas);
/**
 * Tool refusals decided only by what the model asked for, checked against data that is fixed for
 * the run: the call's arguments, this job's own earlier tool receipts, the frozen teaching context
 * and the immutable course release. Each is checked before anything is recorded (the tool's
 * transaction rolls back), and asking again can only be refused again, so the loop ends the run
 * with a definite refusal.
 *
 * Every other tool refusal stays an error, and an uncertain one, because it reflects host state
 * that can change during the run, not the model's request:
 * - SUPERVISION_CONSENT_REQUIRED, INDEPENDENT_ASSESSMENT_ACTIVE: the learner turned support off or
 *   started an independent check. Both change the enrollment revision, which fences the job: the
 *   next transition cancels it (stale_revision), and the tool's own fence check usually refuses first.
 * - SUPERVISOR_TOOL_STALE / SUPERVISOR_INPUT_STALE, SUPERVISOR_TOOL_CONFLICT: the operation was
 *   fenced, cancelled or settled, or the same step was recorded with other arguments by a concurrent
 *   retry; host concurrency, which the job's own state machine resolves.
 * - RESEARCH_SCOPE_UNAVAILABLE, RESEARCH_SELECTION_CHANGED: the enrollment or release is no longer
 *   active, or consent changed since the same request was staged; the enrollment's status or
 *   revision fences the job (inactive_enrollment or stale_revision).
 *
 * GENERATED_TEACHING_UNAVAILABLE (an observed profile is no longer in the active registry or the
 * installed adapters: staff changed the registry, or the runtime is not configured) does not fence
 * the job, and it is not the model's doing either. It ends the run as tool_loop_runtime_unavailable,
 * a host-side failure, so the job never waits for a change that may not come.
 *
 * Hypothesis tools never throw for a refused write; they return it to the model as a result.
 */
const REFUSED_TOOL_CALLS: Record<string, ToolLoopRefusalReason> = {
  SUPERVISOR_TOOL_ARGUMENTS: "tool_loop_invalid_decision",
  SUPERVISOR_TOOL_UNAVAILABLE: "tool_loop_invalid_decision",
  // Cites something this run never retrieved, or that is outside this enrollment or lesson.
  SUPERVISOR_HISTORY_SCOPE: "tool_loop_invalid_decision",
  RESEARCH_TOPIC_NOT_OBSERVED: "tool_loop_invalid_decision",
  RESEARCH_TOPIC_OUT_OF_SCOPE: "tool_loop_invalid_decision",
  RESEARCH_TOPIC_NOT_APPROVED: "tool_loop_invalid_decision",
  RESEARCH_SCOPE_MISMATCH: "tool_loop_invalid_decision",
  RESOURCE_NOT_OBSERVED: "tool_loop_invalid_decision",
  GENERATION_PROFILE_NOT_OBSERVED: "tool_loop_invalid_decision",
  GENERATED_TEACHING_SCOPE: "tool_loop_invalid_decision",
  GENERATED_TEACHING_CANDIDATE_NOT_FOUND: "tool_loop_invalid_decision",
  OBJECTIVE_OUT_OF_SCOPE: "tool_loop_invalid_decision",
  SOURCE_EVENT_OUT_OF_SCOPE: "tool_loop_invalid_decision",
  MODEL_SOURCE_NOT_RETRIEVED: "tool_loop_invalid_decision",
  GENERATION_CANDIDATE_LIMIT: "tool_loop_candidate_limit",
  RESEARCH_REQUEST_LIMIT: "tool_loop_candidate_limit",
  GENERATED_TEACHING_UNAVAILABLE: "tool_loop_runtime_unavailable",
};
/** Internal scoped tools only. Provider output cannot choose a tenant, user,
 * authorization, SQL query, grading key, URL to fetch, cost or proof receipt. */
export function supervisorTools(
  db: Database,
  request: ProviderRequest,
  context: TeachingContext,
  runtime?: AdaptationRuntime,
): SupervisorToolPort {
  const port = scopedTools(db, request, context, runtime);
  return {
    async invoke(name, args, step, signal) {
      try {
        return await port.invoke(name, args, step, signal);
      } catch (error) {
        const reason = error instanceof ApiError ? REFUSED_TOOL_CALLS[error.code] : undefined;
        if (reason) throw new ToolCallRefused(reason, (error as ApiError).code);
        throw error;
      }
    },
  };
}
function scopedTools(
  db: Database,
  request: ProviderRequest,
  context: TeachingContext,
  runtime?: AdaptationRuntime,
): SupervisorToolPort {
  return {
    async invoke(name, args, step, signal) {
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
          requireSameRequest(old.request_digest, requestDigest, "SUPERVISOR_TOOL_CONFLICT");
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
        // The learner's delivered course (base plus applied personal changes), read only when needed.
        let effectiveCourse: CourseManifest | undefined;
        const delivered = async () => effectiveCourse ??= (await resolveEnrollmentCourse(client,
          (await client.query<Enrollment>("SELECT * FROM enrollments WHERE id=$1 AND workspace_id=$2", [scoped.ref.enrollmentId, scoped.ref.workspaceId])).rows[0]!,
          (await client.query<Release>("SELECT * FROM course_releases WHERE id=$1 AND workspace_id=$2", [enrollment.course_release_id, scoped.ref.workspaceId])).rows[0]!)).server_bundle;
        const permission = (
          await client.query(
            "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2 FOR SHARE",
            [scoped.ref.enrollmentId, scoped.ref.workspaceId],
          )
        ).rows[0];
        let result: Json,
          selection: SupportSelection | undefined,
          modelSuggestion: ModelSuggestionSelection | undefined,
          generatedTeaching: GeneratedTeachingSelection | undefined,
          researchSelection: ResearchSelection | undefined,
          resourceChoice: ResourceChoice | undefined;
        if ((HYPOTHESIS_TOOL_NAMES as string[]).includes(name)) {
          // A refused write (consent, pin, rejection, caps, stale revision) is
          // feedback the model can act on; nothing partial is kept.
          await client.query("SAVEPOINT hypothesis_tool");
          try {
            result = await invokeHypothesisTool(
              client,
              name as HypothesisToolName,
              parsed.data,
              {
                jobId: scoped.ref.jobId,
                enrollmentId: scoped.ref.enrollmentId,
                workspaceId: scoped.ref.workspaceId,
                bundle: release.server_bundle,
                digest: release.digest,
                episodeObjectiveIds: context.episode.objectives.map((o) => o.id),
                consent: Boolean(permission?.adaptive_teaching),
              },
            );
            await client.query("RELEASE SAVEPOINT hypothesis_tool");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT hypothesis_tool");
            if (!(error instanceof ApiError) || error.statusCode >= 500)
              throw error;
            result = {
              recorded: false,
              reason: error.code,
              grantsMastery: false,
            };
          }
        } else if (name === "get_profile")
          result = {
            profile: context.learner.profile,
            model: context.learner.model ?? {},
            authority: "self_report_and_source_linked_projection",
          } as Json;
        else if (name === "get_assessment_outline")
          result = {
            items: episodeAssessments(release.server_bundle, context).slice(0, 20).map((a) => ({
              id: a.id, type: a.type, objectiveIds: a.objectiveIds, familyId: a.familyId, role: a.role ?? null,
              misconceptionIds: a.misconceptionIds ?? [], ...(a.type === "code" ? { language: a.language ?? null } : {}),
            })),
            answersIncluded: false,
          } as unknown as Json;
        else if (name === "get_code_results") {
          const ids = episodeAssessments(release.server_bundle, context).filter((a) => a.type === "code").map((a) => a.id);
          const rows = ids.length ? (await client.query<{ id: string; assessment_id: string; mode: string; assistance: string; submitted_at: Date;
            passed: boolean | null; abstained: boolean | null; status: string | null; passed_cases: number | null; total_cases: number | null }>(
            `SELECT id,assessment_id,mode,assistance,submitted_at,(result->>'passed')::boolean AS passed,(result->>'abstained')::boolean AS abstained,result#>>'{execution,status}' AS status,
              (result#>>'{execution,passedCases}')::integer AS passed_cases,(result#>>'{execution,totalCases}')::integer AS total_cases
             FROM attempts WHERE enrollment_id=$1 AND assessment_id=ANY($2::text[]) AND course_digest=$3 ORDER BY submitted_at DESC,id DESC LIMIT 10`,
            [scoped.ref.enrollmentId, ids, release.digest])).rows : [];
          // Answers whose evidence the learner excluded from AI context are left out, as in the provider context.
          const excluded = await excludedAttemptIds(client, scoped.ref.enrollmentId, rows.map((r) => r.id));
          result = {
            runs: rows.filter((r) => !excluded.has(r.id)).map((r) => ({ assessmentId: r.assessment_id, mode: r.mode, assistance: r.assistance, submittedAt: r.submitted_at.toISOString(),
              passed: r.passed === true, ...(r.abstained === true ? { abstained: true } : {}), status: r.status, passedCases: r.passed_cases, totalCases: r.total_cases })),
            sourceIncluded: false, hiddenCasesIncluded: false, authority: "server_evidence_only",
          } as unknown as Json;
        } else if (name === "get_evidence") {
          const checks = await transferChecks(client, scoped.ref.enrollmentId, release.server_bundle, true);
          // A check settled by an answer the learner excluded from AI context would reveal that answer's result.
          const excluded = await excludedAttemptIds(client, scoped.ref.enrollmentId, checks.flatMap((c) => (c.attemptId ? [c.attemptId] : [])));
          result = {
            understanding: context.learner.understanding ?? [],
            recentAttempts: context.learner.recentAttempts ?? [],
            // Whether earlier delivered teaching was followed by a passed independent check.
            transferChecks: checks.filter((c) => !c.attemptId || !excluded.has(c.attemptId)).slice(-20)
              .map((c) => ({ objectiveId: c.objectiveId, status: c.status, ...(c.amendedFrom ? { amendedFrom: c.amendedFrom } : {}), deliveredAt: c.deliveredAt })),
            authority: "server_evidence_only",
          } as unknown as Json;
        } else if (name === "list_sources")
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
        else if (name === "search_sources")
          result = {
            passages: (await searchCoursePassages(client, { releaseId: enrollment.course_release_id, workspaceId: scoped.ref.workspaceId },
              (parsed.data as { query: string }).query)) as unknown as Json,
            sourceTextIsUntrusted: true,
            maxResults: SEARCH_LIMITS.results,
          } as Json;
        else if (name === "search_history")
          result = {
            matches: (await searchLearnerQuestions(client, { enrollmentId: scoped.ref.enrollmentId, workspaceId: scoped.ref.workspaceId, courseDigest: release.digest },
              (parsed.data as { query: string }).query)) as unknown as Json,
            learnerTextIsUntrusted: true,
            maxResults: SEARCH_LIMITS.results,
          } as Json;
        else if (name === "list_research_topics")
          result = {
            topics: (release.server_bundle.research?.publicTopics ?? [])
              .filter((t: { objectiveIds: string[] }) =>
                t.objectiveIds.every((id) =>
                  context.episode.objectives.some((o) => o.id === id),
                ),
              )
              .map(
                (t: {
                  id: string;
                  queryText: string;
                  objectiveIds: string[];
                  allowedDomains?: string[];
                }) => ({
                  id: t.id,
                  queryText: t.queryText,
                  objectiveIds: t.objectiveIds,
                  allowedDomains: t.allowedDomains ?? [],
                  queryAuthority: "immutable_author_public_text",
                }),
              ),
            privateContextExcluded: true,
          } as Json;
        else if (name === "list_reviewed_resources" || name === "choose_resource") {
          const active = (
            await client.query(
              "SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND independent_eligible AND expires_at>clock_timestamp() LIMIT 1",
              [scoped.ref.enrollmentId],
            )
          ).rowCount;
          if (!permission?.adaptive_teaching)
            result = { available: false, reason: "learner_opt_in_required" };
          else if (active)
            result = { available: false, reason: "independent_assessment_active" };
          else if (name === "list_reviewed_resources") {
            const listed = await listReviewedResourcesWithin(client, {
              releaseId: enrollment.course_release_id,
              workspaceId: scoped.ref.workspaceId,
              episodeId: context.episode.id,
              objectiveIds: context.episode.objectives.map((o) => o.id),
              bundle: release.server_bundle,
            });
            result = {
              available: true,
              episodeId: context.episode.id,
              resources: listed,
              sourceTextIsUntrusted: true,
              choice: "one_reviewed_resource_per_objective",
              grantsMastery: false,
            } as unknown as Json;
          } else {
            const input = parsed.data as { attachmentId: string; objectiveId: string };
            const observed = (
              await client.query(
                "SELECT outcome FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND tool='list_reviewed_resources'",
                [scoped.ref.jobId, scoped.ref.enrollmentId, scoped.ref.workspaceId],
              )
            ).rows.flatMap((r) => r.outcome.result?.resources ?? []) as { attachmentId: string; objectiveId: string; candidateDigest: string }[];
            requireCondition(
              observed.some((r) => r.attachmentId === input.attachmentId && r.objectiveId === input.objectiveId),
              "RESOURCE_NOT_OBSERVED",
              409,
            );
            const [current] = await listReviewedResourcesWithin(client, {
              releaseId: enrollment.course_release_id,
              workspaceId: scoped.ref.workspaceId,
              episodeId: context.episode.id,
              objectiveIds: [input.objectiveId],
              bundle: release.server_bundle,
              attachmentId: input.attachmentId,
            });
            if (!current || !observed.some((r) => r.attachmentId === input.attachmentId && r.objectiveId === input.objectiveId && r.candidateDigest === current.candidateDigest))
              result = { selected: false, reason: "resource_changed_or_unavailable" };
            else if (!current.choosable)
              result = { selected: false, reason: current.reason ?? "not_reviewed" };
            else {
              const reviewId = (
                await client.query("SELECT review_id FROM research_attachments WHERE id=$1", [input.attachmentId])
              ).rows[0]!.review_id as string;
              resourceChoice = {
                attachmentId: input.attachmentId,
                objectiveId: input.objectiveId,
                episodeId: context.episode.id,
                reviewId,
                candidateDigest: current.candidateDigest,
                permissionRevision: permission.revision,
              };
              result = {
                selected: true,
                attachmentId: input.attachmentId,
                objectiveId: input.objectiveId,
                delivery: "pending_host_verification",
                doesNotGrantMastery: true,
              };
            }
          }
        } else if (name === "request_research") {
          const input = parsed.data as ResearchRequestToolInput;
          const { topicId } = input;
          const observed = (
            await client.query(
              "SELECT outcome FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND tool='list_research_topics'",
              [
                scoped.ref.jobId,
                scoped.ref.enrollmentId,
                scoped.ref.workspaceId,
              ],
            )
          ).rows;
          requireCondition(
            observed.some((r) =>
              r.outcome.result?.topics?.some(
                (t: { id: string }) => t.id === topicId,
              ),
            ),
            "RESEARCH_TOPIC_NOT_OBSERVED",
            409,
          );
          let structured;
          if (input.taskId !== undefined && input.objectiveId !== undefined) {
            requireCondition(
              context.episode.objectives.some((o) => o.id === input.objectiveId),
              "RESEARCH_SCOPE_MISMATCH",
              409,
            );
            const revision = (
              await client.query("SELECT revision FROM enrollments WHERE id=$1 AND workspace_id=$2", [scoped.ref.enrollmentId, scoped.ref.workspaceId])
            ).rows[0]!.revision as number;
            try {
              structured = buildResearchRequest(
                release.server_bundle,
                release.digest,
                input as ResearchRequestToolInput & { taskId: string; objectiveId: string },
                context.episode.id,
                revision,
              );
            } catch (error) {
              // The request is built only from the model's declared IDs and the immutable release,
              // so any refusal here (an unapproved task, a request the SDK rejects) is the model's.
              if (error instanceof ApiError) throw new ToolCallRefused("tool_loop_invalid_decision", error.code);
              throw error;
            }
          }
          researchSelection = await stageResearchWithin(
            client,
            scoped.ref,
            topicId,
            context.episode.id,
            structured,
          );
          result = {
            staged: true,
            requestId: researchSelection.requestId,
            topicId,
            ...(structured
              ? { objectiveId: structured.objective, deadlineSeconds: structured.sourcePolicy.deadlineSeconds, sentToSearch: "approved_public_query_only" }
              : {}),
            delivery: "pending_host_verification",
            doesNotGrantMastery: true,
          } as Json;
        } else if (name === "get_model_sources") {
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
          // The same conversation the provider context retrieves: this lesson in this course
          // version only, never a message the learner excluded, deleted or erased.
          const rows = (
            await client.query(
              `SELECT m.id,m.role,m.content,m.created_at FROM companion_messages m WHERE m.enrollment_id=$1 AND ${inLesson("$4", "$5")} AND ${USABLE_MESSAGE}
          AND ($2::timestamptz IS NULL OR (m.created_at,m.id)<($2::timestamptz,$3::uuid)) ORDER BY m.created_at DESC,m.id DESC LIMIT 6`,
              [
                scoped.ref.enrollmentId,
                cursor?.created_at ?? null,
                cursor?.id ?? null,
                context.episode.id,
                release.digest,
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
        } else if (name === "check_teaching") {
          const { artifactDigest } = parsed.data as { artifactDigest: string };
          const candidate = (
            await client.query(
              "SELECT outcome FROM supervisor_tool_calls WHERE operation_id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4 AND tool='create_teaching' AND outcome #>> '{generatedTeaching,artifact,digest}'=$5",
              [
                request.operationId,
                scoped.ref.jobId,
                scoped.ref.enrollmentId,
                scoped.ref.workspaceId,
                artifactDigest,
              ],
            )
          ).rows[0]?.outcome.generatedTeaching as
            GeneratedTeachingSelection | undefined;
          // No installed runtime is configuration; a digest this run never created is the model's.
          requireCondition(runtime, "GENERATED_TEACHING_UNAVAILABLE", 409);
          requireCondition(
            candidate,
            "GENERATED_TEACHING_CANDIDATE_NOT_FOUND",
            404,
          );
          try {
            const feedback = await checkGeneratedSupervisorTeachingWithin(
              client,
              scoped.ref,
              candidate,
              runtime,
              signal,
            );
            result = {
              checked: true,
              artifactDigest,
              verification: feedback.passed ? "passed" : "rejected",
              failedCheckIds: feedback.failedCheckIds,
              ...(feedback.accessibilityProblems.length ? { accessibilityProblems: feedback.accessibilityProblems } : {}),
              ...(feedback.contentProblems.length ? { contentProblems: feedback.contentProblems } : {}),
              delivery: "feedback_only",
              doesNotGrantMastery: true,
            };
          } catch (error) {
            if (
              error instanceof ApiError &&
              [
                "ADAPTATION_VERIFICATION_TIMEOUT",
                "ADAPTATION_VERIFICATION_FAILED",
                "INVALID_REQUEST",
                "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE",
              ].includes(error.code)
            )
              result = {
                checked: true,
                artifactDigest,
                verification: "unavailable",
                reason: "reference_check_unavailable",
                delivery: "feedback_only",
                doesNotGrantMastery: true,
              };
            else throw error;
          }
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
                ["append_teaching", "insert_episode", "attach_visual", "add_assessment_variant"].includes(p.operation) &&
                p.episodeId === context.episode.id &&
                // An advanced branch is offered only once every objective here is demonstrated.
                (p.branch !== "advanced" || (context.episode.objectives.length > 0 && context.episode.objectives.every((o) =>
                  context.learner.understanding?.some((u) => u.objectiveId === o.id && u.status === "demonstrated")))) &&
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
          else if (name === "list_generation_profiles") {
            // Questions are keyed by scenes of the learner's delivered course (personal simulations included).
            const effective = profiles.some((p) => profileCreates(p, release.server_bundle) === "check_item") ? await delivered() : undefined;
            result = {
              available: true,
              profiles: profiles.map((p) => ({
                id: p.id,
                episodeId: p.episodeId,
                classification: p.classification,
                // Text appended to this lesson, a whole lesson inserted after it, a simulation, a
                // check question keyed by a scene's model, or a code exercise with hidden tests.
                creates: profileCreates(p, release.server_bundle),
                ...(profileCreates(p, release.server_bundle) === "check_item"
                  ? { models: sceneModels(effective!, p.episodeId) as unknown as Json }
                  : {}),
                ...(profileCreates(p, release.server_bundle) === "component"
                  ? { contract: "python: def solve(inputs) -> outputs; inputs maps each control name to a number; outputs maps each output name to a number or short text" }
                  : {}),
                ...(profileCreates(p, release.server_bundle) === "code_exercise"
                  ? { language: release.server_bundle.assessments.find((a: { id: string }) => a.id === p.canonicalAssessmentId)?.language ?? null }
                  : {}),
                ...(p.branch ? { branch: p.branch } : {}),
                plannedMinutes: p.plannedMinutes,
                additionalEpisodes: p.additionalEpisodes,
                objectiveIds: release.server_bundle.adaptation.targets.find(
                  (t: { episodeId: string }) => t.episodeId === p.episodeId,
                ).objectiveIds,
                sourceRefs: release.server_bundle.adaptation.sourceRefs,
                requiredChecks: release.server_bundle.adaptation.verifiers.find(
                  (v: { id: string }) => v.id === p.verifierId,
                ).requiredCheckIds,
                ...(p.generationBrief
                  ? { generationBrief: p.generationBrief }
                  : {}),
                guidanceTrust: "approved_creator_content_not_tool_authority",
                delivery: "requires_independent_verification",
              })),
            } as Json;
          } else {
            const stagedCount = Number(
              (
                await client.query(
                  "SELECT count(*) FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND tool='create_teaching' AND outcome ? 'generatedTeaching'",
                  [
                    scoped.ref.jobId,
                    scoped.ref.enrollmentId,
                    scoped.ref.workspaceId,
                  ],
                )
              ).rows[0].count,
            );
            requireCondition(
              stagedCount < 2,
              "GENERATION_CANDIDATE_LIMIT",
              409,
            );
            const input = generatedTeachingInputSchema.parse(parsed.data);
            // A profile this run never listed is the model's choice; one it listed that is no
            // longer available is a registry change, checked after.
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
                  (p: { id: string }) => p.id === input.profileId,
                ),
              ),
              "GENERATION_PROFILE_NOT_OBSERVED",
              409,
            );
            const profile = profiles.find((p) => p.id === input.profileId);
            requireCondition(profile, "GENERATED_TEACHING_UNAVAILABLE", 409);
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
                generator.artifactKinds.includes(sdkKind(input.kind)) &&
                verifier.artifactKinds.includes(sdkKind(input.kind)) &&
                // Each profile creates one kind: text is appended, a lesson inserted, a simulation
                // attached, a question added. Never another kind than the approved one.
                CREATES_INPUT[profileCreates(profile, release.server_bundle)].includes(input.kind),
              "GENERATED_TEACHING_SCOPE",
              409,
            );
            const artifactId = "artifact-" + randomUUID(),
              common = { id: artifactId, objectiveIds: input.objectiveIds, sourceRefs: input.sourceRefs,
                generator: { id: generator.id, version: generator.version } };
            const built = generatedDraft(input, common, await delivered(),
              release.server_bundle.assessments.find((a: { id: string }) => a.id === profile.canonicalAssessmentId));
            if ("problems" in built) {
              // Structural problems are feedback the supervisor can repair; nothing is staged.
              result = { selected: false, reason: "content_invalid", problems: built.problems, doesNotGrantMastery: true };
            } else {
            const draft = built.draft;
            const staged: GeneratedTeachingSelection = {
              profileId: profile.id,
              episodeId: profile.episodeId,
              permissionRevision: permission.revision,
              registryRevision: reg.revision,
              configurationDigest: reg.configuration_digest,
              baseCourseDigest: release.digest,
              artifact: {
                ...draft,
                digest: await digestTeachingArtifact(draft),
              } as GeneratedTeachingSelection["artifact"],
              // A component is published beside its text block once delivered.
              ...(input.kind === "component" ? { component: input.component } : {}),
            };
            generatedTeaching = staged;
            result = {
              selected: true,
              profileId: profile.id,
              artifactDigest: generatedTeaching.artifact.digest,
              delivery: "pending_independent_verification",
              doesNotGrantMastery: true,
            };
            }
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
                (p.operation === "append_teaching" || p.operation === "insert_episode") &&
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
                operation: p.operation,
                classification: p.classification,
                plannedMinutes: p.plannedMinutes,
                additionalEpisodes: p.additionalEpisodes,
                items:
                  p.teachingBank?.map((e) => ({
                    id: e.id,
                    kind: e.kind,
                    ...(e.kind === "episode" ? { title: e.title } : {}),
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
                ...(entry.kind === "episode"
                  ? { insertsEpisode: { title: entry.title, blocks: entry.blocks.map((b) => b.markdown) } }
                  : { markdown: entry.markdown }),
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
          researchSelection = undefined;
          resourceChoice = undefined;
        }
        const receiptId = randomUUID(),
          outcome = {
            result,
            ...(selection ? { selection } : {}),
            ...(researchSelection ? { researchSelection } : {}),
            ...(resourceChoice ? { resourceChoice } : {}),
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
