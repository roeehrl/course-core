import { checkResearchSelectionWithin } from "./research-store.js";
import { checkResourceChoiceWithin } from "./research-media.js";
import { randomUUID } from "node:crypto";
import type { RunRef, Snapshot } from "@course-core/supervisor";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { digestJson } from "./repository.js";
import { recordSupervisorVerification } from "./supervisor-bridge.js";
import { supervisedPlanSchema } from "./supervisor-tool-loop.js";
import {
  verifyGeneratedSupervisorTeaching,
  type AdaptationRuntime,
} from "./adaptation-store.js";
import { learnerModelSourceEvents } from "./learner-model.js";
import { withArtifactContent } from './artifact-store.js';
import { supervisionSettingsWithin } from './supervision-settings.js';
import { authorityGate } from './supervisor-authority.js';

/** The verifier authorizes exact reviewed support selection and scope, never an
 * arbitrary model assertion of truth, mastery, paid permission or a policy change.
 * Novel teaching additionally requires actual installed reference/content checks. */
export async function verifySupervisorPlan(
  db: Database,
  ref: RunRef,
  runtime?: AdaptationRuntime,
) {
  const job = (
    await db.query<{ role: string; runtime_snapshot: Snapshot }>(
      "SELECT role,runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3",
      [ref.jobId, ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0];
  if (
    !job ||
    job.role !== "supervisor" ||
    job.runtime_snapshot.generation !== ref.generation
  )
    return;
  // One writer commits (design §4): only the last checkpoint's plan can be applied; a planner's or
  // builder's plan is input to the next step. Every checkpoint must have finished.
  const checkpoints = job.runtime_snapshot.specification.checkpoints;
  const finished = checkpoints.map((cp) => job.runtime_snapshot.operations.find((o) => o.checkpointId === cp.id)?.outcome);
  if (finished.some((o) => o?.status !== "succeeded")) return;
  const outputs = finished.slice(-1).flatMap((o) => (o?.status === "succeeded" ? [o.artifact] : []));
  if (outputs.length !== 1) return;
  const [row] = await withArtifactContent(db, (
    await db.query(
      "SELECT content,content_object_id,digest FROM supervisor_artifacts WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4",
      [outputs[0]!.artifactId, ref.jobId, ref.enrollmentId, ref.workspaceId],
    )
  ).rows);
  // A plan, or output the plan strategy refused after the model answered (which is rejected below).
  if (!row || (row.content.kind !== "supervised_plan" && row.content.kind !== "output_refusal")) return;
  const parsed = supervisedPlanSchema.safeParse(row.content);
  let valid =
    parsed.success &&
    row.digest === outputs[0]!.digest &&
    row.digest === digestJson(row.content);
  if (valid && parsed.success) {
    const plan = parsed.data,
      calls = (
        await db.query(
          "SELECT id,tool,outcome FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3",
          [ref.jobId, ref.enrollmentId, ref.workspaceId],
        )
      ).rows;
    valid =
      new Set(plan.toolCallRefs).size === plan.toolCallRefs.length &&
      plan.toolCallRefs.every((id) => calls.some((c) => c.id === id));
    const effects = (p: Record<string, unknown>) => digestJson({ selection: p.selection ?? null, generatedTeaching: p.generatedTeaching ?? null,
      resourceChoices: p.resourceChoices ?? null, suggestions: p.suggestions ?? null });
    const changesTeaching = Boolean(plan.selection || plan.generatedTeaching || plan.resourceChoices?.length || plan.suggestions?.length);
    if (checkpoints.length > 1) {
      // The evaluator's plan carries exactly one builder's draft, or no teaching change at all.
      const chosen = plan.chosenAlternative;
      if (chosen) {
        const op = job.runtime_snapshot.operations.find((o) => o.checkpointId === chosen && o.outcome?.status === "succeeded");
        const draft = op?.outcome?.status === "succeeded" ? (await db.query("SELECT content FROM supervisor_artifacts WHERE id=$1 AND job_id=$2", [op.outcome.artifact.artifactId, ref.jobId])).rows[0]?.content : undefined;
        valid = valid && draft?.kind === "supervised_plan" && effects(draft) === effects(plan);
      } else valid = valid && !changesTeaching;
    } else valid = valid && !plan.chosenAlternative;
    // The workspace autonomy level (Q08) is a ceiling: below apply_verified_personal, a plan that
    // would change the learner's teaching is refused; proposals the learner reviews still go on.
    if (changesTeaching && (await supervisionSettingsWithin(db, ref.workspaceId)).autonomyLevel !== "apply_verified_personal") valid = false;
    for (const suggestion of plan.suggestions ?? [])
      valid = valid && calls.some((c) => plan.toolCallRefs.includes(c.id) && (c.tool === "propose_practice_check" || c.tool === "choose_visual")
        && c.outcome.suggestion && digestJson(c.outcome.suggestion) === digestJson(suggestion));
    if (plan.suggestions?.length) {
      const permission = (await db.query("SELECT adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2", [ref.enrollmentId, ref.workspaceId])).rows[0];
      valid = valid && permission?.adaptive_teaching === true;
    }
    if (valid && plan.authorityRequest) {
      const request = plan.authorityRequest;
      valid = calls.some((c) => plan.toolCallRefs.includes(c.id) && c.tool === "request_authority" && c.outcome.authorityRequest
        && digestJson(c.outcome.authorityRequest) === digestJson(request));
      if (valid) {
        // A change only a separate authority may make: the job waits (needs_input) for that decision.
        const decision = await authorityGate(db, ref, request);
        if (decision === "pending") return;
        valid = decision === "approved";
      }
    }
    if (plan.selection) {
      const permission = (
        await db.query(
          "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2",
          [ref.enrollmentId, ref.workspaceId],
        )
      ).rows[0];
      valid =
        valid &&
        permission?.adaptive_teaching === true &&
        permission.revision === plan.selection.permissionRevision &&
        calls.some(
          (c) =>
            plan.toolCallRefs.includes(c.id) &&
            c.tool === "choose_support" &&
            c.outcome.selection &&
            digestJson(c.outcome.selection) === digestJson(plan.selection),
        );
    }
    if (plan.generatedTeaching) {
      const generated = plan.generatedTeaching;
      valid =
        valid &&
        !!runtime &&
        calls.some(
          (c) =>
            plan.toolCallRefs.includes(c.id) &&
            c.tool === "create_teaching" &&
            c.outcome.generatedTeaching &&
            digestJson(c.outcome.generatedTeaching) === digestJson(generated),
        );
      if (valid && runtime) {
        try {
          valid = await verifyGeneratedSupervisorTeaching(
            db,
            ref,
            generated,
            runtime,
          );
        } catch {
          valid = false;
        }
      }
    }
    if (plan.researchSelections) {
      valid =
        valid &&
        new Set(plan.researchSelections.map((s) => s.requestId)).size ===
          plan.researchSelections.length;
      for (const selection of plan.researchSelections) {
        valid =
          valid &&
          calls.some(
            (c) =>
              plan.toolCallRefs.includes(c.id) &&
              c.tool === "request_research" &&
              c.outcome.researchSelection &&
              digestJson(c.outcome.researchSelection) === digestJson(selection),
          );
        if (valid)
          try {
            await transaction(db, (client) =>
              checkResearchSelectionWithin(client, ref, selection),
            );
          } catch {
            valid = false;
          }
      }
    }
    if (plan.resourceChoices) {
      // Each choice must be an actual receipt of this job and still hold now: the latest
      // approved review, a live attachment, consent and the learner's current lesson.
      for (const choice of plan.resourceChoices) {
        valid =
          valid &&
          calls.some(
            (c) =>
              plan.toolCallRefs.includes(c.id) &&
              c.tool === "choose_resource" &&
              c.outcome.resourceChoice &&
              digestJson(c.outcome.resourceChoice) === digestJson(choice),
          );
        if (valid)
          try {
            await transaction(db, (client) => checkResourceChoiceWithin(client, ref, choice));
          } catch {
            valid = false;
          }
      }
    }
    if (plan.modelSuggestion) {
      const suggestion = plan.modelSuggestion,
        permission = (
          await db.query(
            "SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2",
            [ref.enrollmentId, ref.workspaceId],
          )
        ).rows[0];
      valid =
        valid &&
        permission?.adaptive_teaching === true &&
        permission.revision === suggestion.permissionRevision &&
        calls.some(
          (c) =>
            plan.toolCallRefs.includes(c.id) &&
            c.tool === "suggest_model" &&
            c.outcome.modelSuggestion &&
            digestJson(c.outcome.modelSuggestion) === digestJson(suggestion),
        );
      try {
        const sources = await transaction(db, (client) =>
          learnerModelSourceEvents(
            client,
            ref.enrollmentId,
            ref.workspaceId,
            suggestion.sourceEventIds,
          ),
        );
        valid =
          valid &&
          sources.length === suggestion.sourceEventDigests.length &&
          sources.every(
            (s) =>
              suggestion.sourceEventDigests.filter(
                (d) => d.eventId === s.eventId && d.digest === s.digest,
              ).length === 1,
          );
      } catch {
        valid = false;
      }
    }
  }
  const verifier = await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `supervisor-plan-verifier:${ref.workspaceId}`,
    ]);
    const label = "Scoped teaching generation and learner-model selection v3",
      old = (
        await client.query(
          "SELECT id,enabled FROM supervisor_verifier_authorities WHERE workspace_id=$1 AND label=$2",
          [ref.workspaceId, label],
        )
      ).rows[0];
    if (old) return old;
    const id = randomUUID();
    await client.query(
      "INSERT INTO supervisor_verifier_authorities(id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES($1,$2,$3,false,true)",
      [id, ref.workspaceId, label],
    );
    return { id, enabled: true };
  });
  if (verifier.enabled)
    await recordSupervisorVerification(
      db,
      ref,
      verifier.id,
      valid ? "verified" : "rejected",
    );
}
