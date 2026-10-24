import { randomUUID } from 'node:crypto';
import type { RunRef, Snapshot } from '@course-core/supervisor';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { digestJson } from './repository.js';
import { requireCondition } from './errors.js';
import { recordSupervisorVerification } from './supervisor-bridge.js';
import { withArtifactContent } from './artifact-store.js';
import { storedReplyKeepsChecks, WITHHELD_REASONS } from './companion-check-integrity.js';

/** Authorizes an advisory chat message, not factual correctness or assessment credit: its format,
 * size and, for a reply written in check-coaching mode, that it keeps graded checks' answers. */
export async function verifyCompanionBoundary(db: Database, ref: RunRef) {
  const job = (await db.query<{ role: string; runtime_snapshot: Snapshot }>('SELECT role,runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3', [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  if (!job || job.role !== 'companion') return;
  const snapshot = job.runtime_snapshot;
  if (snapshot.generation !== ref.generation || snapshot.operations.some(operation => operation.outcome?.status !== 'succeeded')) return;
  const outputs = snapshot.operations.flatMap(operation => operation.outcome?.status === 'succeeded' ? [operation.outcome.artifact] : []);
  if (outputs.length !== 1) return;
  const [row] = await withArtifactContent(db, (await db.query<{ content: { kind: string; text: unknown }; content_object_id: string | null; digest: string }>('SELECT content,content_object_id,digest FROM supervisor_artifacts WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4', [outputs[0]!.artifactId, ref.jobId, ref.enrollmentId, ref.workspaceId])).rows);
  requireCondition(row && row.digest === outputs[0]!.digest && row.digest === digestJson(row.content), 'COMPANION_ARTIFACT_MISMATCH', 409);
  const keys = Object.keys(row.content).sort().join(','), marks = row.content as { cutShort?: unknown; withheld?: unknown };
  const formatted = row.content.kind === 'companion_message' && typeof row.content.text === 'string' && row.content.text.trim().length > 0 && row.content.text.length <= 16000
    && (keys === 'kind,text' || keys === 'cutShort,kind,text' && marks.cutShort === true
      || keys === 'kind,text,withheld' && (WITHHELD_REASONS as readonly unknown[]).includes(marks.withheld));
  // A reply written in check-coaching mode must not give away a matched check's answer; the gateway
  // already replaced one that did, so this re-check only fails when that step was bypassed.
  const valid = formatted && (marks.withheld !== undefined || await storedReplyKeepsChecks(db, ref, row.content.text as string));
  const verifier = await transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`companion-verifier:${ref.workspaceId}`]);
    const label = 'Advisory companion format and scope boundary v1';
    const existing = (await client.query<{ id: string; enabled: boolean }>('SELECT id,enabled FROM supervisor_verifier_authorities WHERE workspace_id=$1 AND label=$2', [ref.workspaceId, label])).rows[0];
    if (existing) return existing;
    const id = randomUUID();
    await client.query('INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,$3,true,false)', [id, ref.workspaceId, label]);
    return { id, enabled: true };
  });
  if (verifier.enabled) await recordSupervisorVerification(db, ref, verifier.id, valid ? 'verified' : 'rejected');
}
