import { randomUUID } from "node:crypto";
import type { RunRef, Snapshot } from "@course-core/supervisor";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { digestJson } from "./repository.js";
import { recordSupervisorVerification } from "./supervisor-bridge.js";
import { researchCandidateSchema } from "./research-contracts.js";
import { resolveResearchInputWithin } from "./research-store.js";
import { withArtifactContent } from './artifact-store.js';

/** Authorizes collection into an UNREVIEWED queue, never a lesson, source-use
 * approval, factual truth, rights, grading or learner-mastery decision. */
export async function verifyResearchCollection(db: Database, ref: RunRef) {
  const job = (
    await db.query<{ role: string; runtime_snapshot: Snapshot }>(
      "SELECT role,runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3",
      [ref.jobId, ref.enrollmentId, ref.workspaceId],
    )
  ).rows[0];
  if (
    job?.role !== "research" ||
    job.runtime_snapshot.generation !== ref.generation
  )
    return;
  const outputs = job.runtime_snapshot.operations.flatMap((o) =>
    o.outcome?.status === "succeeded" ? [o.outcome.artifact] : [],
  );
  if (outputs.length !== 1) return;
  const [row] = await withArtifactContent(db, (
    await db.query(
      "SELECT content,content_object_id,digest FROM supervisor_artifacts WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4",
      [outputs[0]!.artifactId, ref.jobId, ref.enrollmentId, ref.workspaceId],
    )
  ).rows);
  const parsed = researchCandidateSchema.safeParse(row?.content);
  let valid =
    parsed.success &&
    row?.digest === outputs[0]!.digest &&
    digestJson(row?.content) === row?.digest;
  if (valid && parsed.success) {
    const candidate = parsed.data;
    const input = (
      await db.query(
        "SELECT context FROM supervisor_inputs WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3",
        [ref.jobId, ref.enrollmentId, ref.workspaceId],
      )
    ).rows[0]?.context;
    try {
      const source = await transaction(db, (client) =>
        resolveResearchInputWithin(
          client,
          ref.enrollmentId,
          ref.workspaceId,
          input.researchRequestId,
          input.eventId,
          ref.jobId,
        ),
      );
      valid =
        source.requestId === candidate.requestId &&
        source.topicId === candidate.topicId &&
        source.queryDigest === candidate.queryDigest;
    } catch {
      valid = false;
    }
    valid =
      valid &&
      candidate.citations.every((c) => {
        const part = candidate.parts.find((p) => p.partIndex === c.partIndex);
        return (
          part &&
          c.endByte > c.startByte &&
          c.endByte <= Buffer.byteLength(part.text, "utf8") &&
          c.sourceIndices.every((i) => i < candidate.sources.length)
        );
      });
  }
  const verifier = await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "research-collection:" + ref.workspaceId,
    ]);
    const old = (
      await client.query(
        "SELECT id,enabled FROM supervisor_verifier_authorities WHERE workspace_id=$1 AND label=$2",
        [ref.workspaceId, "Public-topic unreviewed research collection v1"],
      )
    ).rows[0];
    if (old) return old;
    const id = randomUUID();
    await client.query(
      "INSERT INTO supervisor_verifier_authorities(id,workspace_id,label,can_verify_companion,can_review_adaptation,can_collect_research) VALUES($1,$2,$3,false,false,true)",
      [id, ref.workspaceId, "Public-topic unreviewed research collection v1"],
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
