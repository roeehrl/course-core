import { randomUUID } from "node:crypto";
import type { RunRef, Snapshot } from "@course-core/supervisor";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { digestJson } from "./repository.js";
import { recordSupervisorVerification } from "./supervisor-bridge.js";
import { supervisedPlanSchema } from "./supervisor-tool-loop.js";
import { learnerModelSourceEvents } from "./learner-model.js";

/** The verifier authorizes exact reviewed support selection and scope, never an
 * arbitrary model assertion of truth, mastery, paid permission or a policy change. */
export async function verifySupervisorPlan(db: Database, ref: RunRef) {
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
  const outputs = job.runtime_snapshot.operations.flatMap((o) =>
    o.outcome?.status === "succeeded" ? [o.outcome.artifact] : [],
  );
  if (outputs.length !== 1) return;
  const row = (
    await db.query(
      "SELECT content,digest FROM supervisor_artifacts WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4",
      [outputs[0]!.artifactId, ref.jobId, ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0];
  if (!row || row.content.kind !== "supervised_plan") return;
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
    const label = "Scoped teaching and learner-model selection v2",
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
