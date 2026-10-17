import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Json, UsageReceipt } from "@course-core/providers";
import { snapshotSchema } from "@course-core/supervisor";
import { transaction, type Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson } from "./repository.js";
import { runSupervisorToolLoop, supervisedPlanSchema } from "./supervisor-tool-loop.js";
import { researchCandidateSchema } from "./research-contracts.js";
import { rubricSuggestionSchema } from "./rubric-assist-contracts.js";
import { RUN_PAYLOAD_RULE } from "./learner-privacy.js";
import type { TeachingContext } from "./agent-strategies.js";

/**
 * Debug inspector views of one supervisor run that the metadata-only run view (admin-routes.ts
 * runView) does not cover: the workflow graph, policies and budgets, client and sync state, an
 * explicit payload reveal with an audit receipt, and a sandboxed replay. Every read here is
 * scoped to one course's runs by the caller; nothing here changes learner progress.
 */
type Sql = Database | PoolClient;
interface Catalog { id: string; workspace_id: string; course_key: string }
export interface RunRow {
  id: string; enrollment_id: string; workspace_id: string; workflow_id: string; role: string; state: string; input_event_id: string | null;
  expected_revision: number; runtime_snapshot: unknown; specification: unknown; provider_revision: number | null; cancellation_requested: boolean;
  created_at: Date; updated_at: Date;
}
const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** One run of this course (by its release's course key), or 404. */
export async function courseRun(client: Sql, catalog: Catalog, runId: string) {
  const job = (await client.query<RunRow>(
    `SELECT j.id,j.enrollment_id,j.workspace_id,j.workflow_id,j.role,j.state,j.input_event_id,j.expected_revision,j.runtime_snapshot,j.specification,
       j.provider_revision,j.cancellation_requested,j.created_at,j.updated_at
     FROM supervisor_jobs j JOIN enrollments e ON e.id=j.enrollment_id AND e.workspace_id=j.workspace_id JOIN course_releases r ON r.id=e.course_release_id
     WHERE j.id=$1 AND j.workspace_id=$2 AND r.course_key=$3`, [runId, catalog.workspace_id, catalog.course_key])).rows[0];
  requireCondition(job, "RUN_NOT_FOUND", 404);
  return job;
}

/**
 * The workflow graph: the learning event that started the run, the run (one durable workflow),
 * each checkpoint and its provider operations, the tool calls of each operation, the artifacts it
 * stored, and the host's verification and application. Identifiers and states only.
 */
export async function runWorkflow(client: Sql, job: RunRow) {
  const parsed = snapshotSchema.safeParse(job.runtime_snapshot), snapshot = parsed.success ? parsed.data : null;
  const scope = [job.id, job.enrollment_id, job.workspace_id];
  const event = job.input_event_id
    ? (await client.query<{ id: string; event_type: string; sequence: string; created_at: Date }>("SELECT id,event_type,sequence::text,created_at FROM learning_events WHERE id=$1", [job.input_event_id])).rows[0]
    : undefined;
  const tools = (await client.query<{ id: string; operation_id: string; step: number; tool: string; created_at: Date }>(
    "SELECT id,operation_id,step,tool,created_at FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY operation_id,step LIMIT 200", scope)).rows;
  const dispatches = (await client.query<{ operation_id: string; state: string; failure_code: string | null }>(
    "SELECT operation_id,state,failure_code FROM provider_dispatches WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY started_at", scope)).rows;
  const artifacts = (await client.query<{ id: string; operation_id: string; kind: string | null }>(
    "SELECT id,operation_id,content->>'kind' AS kind FROM supervisor_artifacts WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY created_at", scope)).rows;
  const verification = (await client.query<{ id: string; verdict: string; revoked_at: Date | null }>(
    "SELECT id,verdict,revoked_at FROM supervisor_verifications WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3", scope)).rows[0];
  const application = (await client.query<{ id: string; application_kind: string }>(
    "SELECT id,application_kind FROM supervisor_applications WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3", scope)).rows[0];
  type Node = { id: string; kind: string; label: string; status: string; parentId: string | null };
  const nodes: Node[] = [];
  if (event) nodes.push({ id: `event:${event.id}`, kind: "input_event", label: `${event.event_type} (#${event.sequence})`, status: "recorded", parentId: null });
  const runNode = `run:${job.id}`;
  nodes.push({ id: runNode, kind: "run", label: `${job.role} run · workflow ${job.workflow_id}`, status: job.state, parentId: event ? `event:${event.id}` : null });
  const checkpoints = snapshot?.specification.checkpoints ?? [];
  for (const checkpoint of checkpoints) {
    const checkpointNode = `checkpoint:${checkpoint.id}`;
    const operations = (snapshot?.operations ?? []).filter((o) => o.checkpointId === checkpoint.id);
    nodes.push({ id: checkpointNode, kind: "checkpoint", label: `Checkpoint ${checkpoint.id}${checkpoint.phase ? ` (${checkpoint.phase})` : ""}`,
      status: operations.at(-1)?.status ?? "not_started", parentId: runNode });
    for (const operation of operations) {
      const operationNode = `operation:${operation.id}:${operation.attempt}`;
      const dispatch = dispatches.find((d) => d.operation_id === operation.id);
      nodes.push({ id: operationNode, kind: "operation", label: `Attempt ${operation.attempt}${dispatch ? ` · provider ${dispatch.state}` : ""}`, status: operation.status, parentId: checkpointNode });
      for (const call of tools.filter((t) => t.operation_id === operation.id))
        nodes.push({ id: `tool:${call.id}`, kind: "tool_call", label: `Step ${call.step}: ${call.tool}`, status: "recorded", parentId: operationNode });
      for (const artifact of artifacts.filter((a) => a.operation_id === operation.id))
        nodes.push({ id: `artifact:${artifact.id}`, kind: "artifact", label: `${artifact.kind ?? "artifact"} ${artifact.id}`, status: "stored", parentId: operationNode });
    }
  }
  // Tool calls or artifacts whose operation the snapshot no longer lists still appear, under the run.
  const listed = new Set(nodes.map((n) => n.id));
  for (const call of tools) if (!listed.has(`tool:${call.id}`)) nodes.push({ id: `tool:${call.id}`, kind: "tool_call", label: `Step ${call.step}: ${call.tool}`, status: "recorded", parentId: runNode });
  for (const artifact of artifacts) if (!listed.has(`artifact:${artifact.id}`))
    nodes.push({ id: `artifact:${artifact.id}`, kind: "artifact", label: `${artifact.kind ?? "artifact"} ${artifact.id}`, status: "stored", parentId: runNode });
  if (verification) nodes.push({ id: `verification:${verification.id}`, kind: "verification", label: "Host verification", status: verification.revoked_at ? "revoked" : verification.verdict, parentId: runNode });
  if (application) nodes.push({ id: `application:${application.id}`, kind: "application", label: `Applied as ${application.application_kind}`, status: "applied",
    parentId: verification ? `verification:${verification.id}` : runNode });
  return { workflowId: job.workflow_id, generation: snapshot?.generation ?? null, nodes, truncated: tools.length >= 200 };
}

/** Policies and budgets in force for the run: its fence, allowances, reservations and charges,
 * and the enrollment and workspace budgets and supervision control as they are now. */
export async function runPolicies(client: Sql, job: RunRow) {
  const parsed = snapshotSchema.safeParse(job.runtime_snapshot), snapshot = parsed.success ? parsed.data : null, spec = snapshot?.specification;
  const spend = (await client.query<{ micro_usd: string; tokens: string }>("SELECT micro_usd::text,tokens::text FROM supervisor_job_spend WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3",
    [job.id, job.enrollment_id, job.workspace_id])).rows[0];
  const enrollment = (await client.query<Record<string, string | null>>(
    `SELECT limit_micro_usd::text,limit_tokens::text,used_micro_usd::text,used_tokens::text,daily_limit_micro_usd::text,daily_limit_tokens::text,
       artifact_limit_micro_usd::text,artifact_limit_tokens::text FROM supervisor_enrollment_budgets WHERE enrollment_id=$1 AND workspace_id=$2`, [job.enrollment_id, job.workspace_id])).rows[0];
  const workspace = (await client.query<Record<string, string>>(
    "SELECT limit_micro_usd::text,limit_tokens::text,used_micro_usd::text,used_tokens::text FROM supervisor_workspace_budgets WHERE workspace_id=$1", [job.workspace_id])).rows[0];
  const control = (await client.query<{ state: string; revision: number }>("SELECT state,revision FROM supervisor_controls WHERE enrollment_id=$1 AND workspace_id=$2",
    [job.enrollment_id, job.workspace_id])).rows[0];
  const current = (await client.query<{ revision: number }>("SELECT revision FROM enrollments WHERE id=$1", [job.enrollment_id])).rows[0];
  const pair = (row: Record<string, string | null> | undefined, prefix: string) => ({ microUsd: num(row?.[`${prefix}micro_usd`]), tokens: num(row?.[`${prefix}tokens`]) });
  return {
    fence: spec ? { ...spec.fence, enrollmentRevisionNow: current?.revision ?? null } : null,
    deadline: spec ? new Date(spec.deadlineAtMs).toISOString() : null,
    jobBudget: spec?.budget ?? null,
    checkpoints: (spec?.checkpoints ?? []).map((c) => ({ id: c.id, allowance: c.allowance, timeoutMs: c.timeoutMs, maxAttempts: c.maxAttempts })),
    operations: (snapshot?.operations ?? []).map((o) => ({ id: o.id, attempt: o.attempt, status: o.status, reservation: o.reservation,
      usage: o.outcome?.status === "succeeded" ? o.outcome.usage : null, usageBasis: o.outcome?.status === "succeeded" ? (o.outcome.usageBasis ?? null) : null })),
    charged: spend ? { microUsd: Number(spend.micro_usd), tokens: Number(spend.tokens) } : null,
    enrollmentBudget: enrollment ? { limit: pair(enrollment, "limit_"), used: pair(enrollment, "used_"), daily: pair(enrollment, "daily_limit_"), perArtifact: pair(enrollment, "artifact_limit_") } : null,
    workspaceBudget: workspace ? { limit: pair(workspace, "limit_"), used: pair(workspace, "used_") } : null,
    providerConfiguration: job.provider_revision === null ? "host fallback" : `workspace provider revision ${job.provider_revision}`,
    supervision: control ? { state: control.state, revision: control.revision } : { state: "active", revision: 0 },
    reason: snapshot?.reason ?? null,
  };
}

/** Client and sync state: what the client reported with the input event, how far the
 * enrollment's event stream and revision moved since, and the delivery of that event. */
export async function runSync(client: Sql, job: RunRow) {
  const event = job.input_event_id
    ? (await client.query<{ sequence: string; created_at: Date; platform: string | null; app_version: string | null; client_sequence: string | null; occurred_at: Date | null;
        received_at: Date | null; course_digest: string | null; actor_kind: string }>(
      "SELECT sequence::text,created_at,platform,app_version,client_sequence::text,occurred_at,received_at,course_digest,actor_kind FROM learning_events WHERE id=$1", [job.input_event_id])).rows[0]
    : undefined;
  const later = event
    ? (await client.query<{ n: number; last: string | null }>("SELECT count(*)::integer AS n,max(sequence)::text AS last FROM learning_events WHERE enrollment_id=$1 AND sequence>$2",
      [job.enrollment_id, event.sequence])).rows[0]!
    : { n: 0, last: null };
  const outbox = job.input_event_id
    ? (await client.query<{ attempts: number; delivered_at: Date | null; quarantined_at: Date | null; last_error_code: string | null }>(
      "SELECT attempts,delivered_at,quarantined_at,last_error_code FROM outbox WHERE event_id=$1", [job.input_event_id])).rows[0]
    : undefined;
  const current = (await client.query<{ revision: number }>("SELECT revision FROM enrollments WHERE id=$1", [job.enrollment_id])).rows[0];
  const parsed = snapshotSchema.safeParse(job.runtime_snapshot);
  return {
    inputEvent: event ? {
      sequence: event.sequence, actorKind: event.actor_kind, recordedAt: iso(event.created_at), platform: event.platform, appVersion: event.app_version,
      clientSequence: event.client_sequence, occurredAt: iso(event.occurred_at), receivedAt: iso(event.received_at), courseDigest: event.course_digest,
      clockSkewMs: event.occurred_at ? event.created_at.getTime() - event.occurred_at.getTime() : null,
    } : null,
    eventsSince: later.n,
    latestSequence: later.last ?? event?.sequence ?? null,
    enrollmentRevisionAtRun: job.expected_revision,
    enrollmentRevisionNow: current?.revision ?? null,
    delivery: outbox ? { attempts: outbox.attempts, deliveredAt: iso(outbox.delivered_at), quarantined: outbox.quarantined_at !== null, lastErrorCode: outbox.last_error_code } : null,
    run: { state: job.state, generation: parsed.success ? parsed.data.generation : null, snapshotVersion: parsed.success ? parsed.data.version : null,
      cancellationRequested: job.cancellation_requested, createdAt: iso(job.created_at), updatedAt: iso(job.updated_at) },
  };
}

// ---------------------------------------------------------------- payload reveal

/** Tools whose arguments and results a payload reveal shows (through the projection below). The
 * others read or write what the shared privacy rule keeps from staff (RUN_PAYLOAD_RULE). */
export const REVEALED_TOOLS: ReadonlySet<string> = new Set(["list_sources", "list_support", "choose_support", "list_generation_profiles", "create_teaching", "check_teaching",
  "list_research_topics", "request_research", "get_assessment_outline", "get_code_results"]);
const WITHHELD_TOOL_CATEGORY: Record<string, string> = {
  get_history: "companion", get_profile: "learner-model", get_model_sources: "learner-model", suggest_model: "learner-model",
  // Its result shows which evidence the learner excluded from AI context, which is learner-model.
  get_evidence: "learner-model",
  list_hypotheses: "hypothesis-tool-text", propose_hypothesis: "hypothesis-tool-text", update_hypothesis: "hypothesis-tool-text",
  schedule_probe: "hypothesis-tool-text", read_probe_results: "hypothesis-tool-text",
};
const INPUT_KEYS = ["kind", "eventId", "eventType", "courseReleaseId", "episodeId", "blockId", "messageId", "researchRequestId", "rubricRequestId"] as const;
/**
 * The only keys a revealed value may carry: identifiers, references, states, counts and
 * structure. Any other key is dropped (and counted), whatever its name, so a new field such as a
 * model's "rationale" or "analysis" is never revealed by default.
 */
const STRUCTURAL_KEYS = new Set([
  "kind", "type", "available", "selected", "verification", "recorded", "status", "state", "passed", "pass", "outcome", "role",
  "profileId", "entryId", "episodeId", "objectiveIds", "objectiveId", "sourceRefs", "sourceId", "sourceIds", "topicId", "requestId", "attemptId", "assessmentId",
  "familyId", "itemIds", "id", "ids", "permissionRevision", "registryRevision", "revision", "configurationDigest", "baseCourseDigest", "courseDigest",
  "queryDigest", "rubricDigest", "responseDigest", "artifactDigest", "digest", "sha256", "criterionId", "met", "grounding", "reviewState",
  "entries", "profiles", "topics", "sources", "items", "results", "criteria", "selection", "researchSelections", "generatedTeaching", "artifact", "blocks",
  "toolCallRefs", "count", "total", "cases", "passedCases", "failedCases", "uri", "partIndex", "startByte", "endByte", "sourceIndices", "citations", "parts",
]);
/** Keys that hold model- or learner-written prose: shown only as length and a fingerprint. */
const TEXT_KEYS = new Set(["summary", "markdown", "text", "title", "note", "quote", "explanation", "body", "content", "prompt", "description", "label"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
/** Free text never leaves the reveal: its length and a fingerprint keyed by a secret that exists
 * only for this one reveal, so equal texts in one reveal match but nobody can test a guess. */
type Fingerprint = (text: string) => string;
const withheldText = (text: string, fingerprint: Fingerprint) => ({ withheld: "model_text" as const, length: text.length, fingerprint: fingerprint(text) });
export const PAYLOAD_REASONS = ["incident_investigation", "quality_review", "learner_request", "bug_report"] as const;

/** Allowlist projection of a revealed value: structural keys only, identifier-like strings only,
 * prose replaced by length and fingerprint, bounded depth and size. */
export function project(value: unknown, fingerprint: Fingerprint, depth = 0, key?: string): Json {
  if (depth > 8) return "[depth limit]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return key && TEXT_KEYS.has(key) ? withheldText(value, fingerprint) : IDENTIFIER.test(value) ? value : withheldText(value, fingerprint);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => project(v, fingerprint, depth + 1, key));
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    let omitted = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TEXT_KEYS.has(k)) out[k] = typeof v === "string" ? withheldText(v, fingerprint) : project(v, fingerprint, depth + 1, k);
      else if (STRUCTURAL_KEYS.has(k)) out[k] = project(v, fingerprint, depth + 1, k);
      else omitted++;
    }
    if (omitted) out.omittedKeys = omitted;
    return out;
  }
  return null;
}

function artifactPayload(kind: string | null, content: unknown, fingerprint: Fingerprint): { revealed: Json } | { withheld: string } {
  if (kind === "supervised_plan") {
    const plan = supervisedPlanSchema.safeParse(content);
    if (!plan.success) return { withheld: "unreadable" };
    const { modelSuggestion, ...rest } = plan.data;
    return { revealed: { ...(project(rest, fingerprint) as Record<string, Json>), ...(modelSuggestion ? { modelSuggestion: "[withheld: learner-model]" } : {}) } };
  }
  if (kind === "research_candidate") { const p = researchCandidateSchema.safeParse(content); return p.success ? { revealed: project(p.data, fingerprint) } : { withheld: "unreadable" }; }
  if (kind === "rubric_suggestion") { const p = rubricSuggestionSchema.safeParse(content); return p.success ? { revealed: project(p.data, fingerprint) } : { withheld: "unreadable" }; }
  if (kind === "proposed_adaptation") {
    const summary = (content as { summary?: unknown } | null)?.summary;
    return typeof summary === "string" ? { revealed: { kind, summary: withheldText(summary, fingerprint) } } : { withheld: "unreadable" };
  }
  // companion_message and any unknown kind: a companion reply is part of the private conversation.
  return { withheld: kind === null ? "unreadable" : "companion" };
}

/**
 * The run's payload for an authorized reveal: the frozen input references, tool arguments and
 * results, and stored artifacts, each through an allowlist (RUN_PAYLOAD_RULE): structure,
 * identifiers and states are shown; model- or learner-written prose is shown only as length and a
 * per-reveal fingerprint; the companion conversation, learner-model reads and suggestions (including
 * evidence reads, which show AI-context exclusions) and hypothesis tool text are withheld.
 */
export async function runPayload(client: Sql, job: RunRow) {
  const key = randomBytes(32), fingerprint: Fingerprint = (text) => createHmac("sha256", key).update(text).digest("hex").slice(0, 16);
  const scope = [job.id, job.enrollment_id, job.workspace_id];
  const inputs = (await client.query<{ id: string; checkpoint_id: string; context: Record<string, unknown> }>(
    "SELECT id,checkpoint_id,context FROM supervisor_inputs WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY checkpoint_id", scope)).rows;
  const tools = (await client.query<{ id: string; operation_id: string; step: number; tool: string; arguments: unknown; outcome: { result?: unknown } }>(
    "SELECT id,operation_id,step,tool,arguments,outcome FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY operation_id,step LIMIT 64", scope)).rows;
  const artifacts = (await client.query<{ id: string; digest: string; content: unknown; kind: string | null }>(
    "SELECT id,digest,content,content->>'kind' AS kind FROM supervisor_artifacts WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY created_at", scope)).rows;
  const withheld: { ref: string; category: string }[] = [];
  const payload = {
    inputs: inputs.map((row) => ({ id: row.id, checkpointId: row.checkpoint_id,
      context: Object.fromEntries(INPUT_KEYS.filter((k) => row.context && Object.hasOwn(row.context, k)).map((k) => [k, project(row.context[k], fingerprint)])) })),
    toolCalls: tools.map((row) => {
      if (!REVEALED_TOOLS.has(row.tool)) {
        withheld.push({ ref: `tool:${row.id}`, category: WITHHELD_TOOL_CATEGORY[row.tool] ?? "unlisted-tool" });
        return { id: row.id, operationId: row.operation_id, step: row.step, tool: row.tool, arguments: null, result: null, withheld: true };
      }
      return { id: row.id, operationId: row.operation_id, step: row.step, tool: row.tool, arguments: project(row.arguments, fingerprint),
        result: project(row.outcome?.result ?? null, fingerprint), withheld: false };
    }),
    artifacts: artifacts.map((row) => {
      const projected = job.role === "companion" ? { withheld: "companion" } : artifactPayload(row.kind, row.content, fingerprint);
      if ("withheld" in projected) withheld.push({ ref: `artifact:${row.id}`, category: projected.withheld });
      // A withheld artifact's digest would let anyone test a guess at its content.
      return { id: row.id, kind: row.kind, sha256: "revealed" in projected ? row.digest : null, content: "revealed" in projected ? projected.revealed : null, withheld: "withheld" in projected };
    }),
  };
  return { payload, withheld, rule: RUN_PAYLOAD_RULE };
}

/** Reveals one run's payload and records the audit receipt in the same transaction, before
 * anything is returned: if the receipt cannot be written, nothing is revealed. The receipt goes on
 * the learner's own record (they see who looked), and a copy without learner content (who, which
 * run, why, the digest) goes to the workspace audit log, so erasing the learner's record does not
 * erase staff accountability. */
export async function revealRunPayload(client: PoolClient, actor: { id: string }, catalog: Catalog, job: RunRow, reason: (typeof PAYLOAD_REASONS)[number]) {
  const { payload, withheld, rule } = await runPayload(client, job);
  const digest = digestJson(payload), receiptId = randomUUID();
  const categories = withheld.map((w) => w.category).filter((c, i, all) => all.indexOf(c) === i);
  const recorded = await appendEvent(client, {
    workspaceId: job.workspace_id, enrollmentId: job.enrollment_id, actorId: actor.id, actorKind: "staff", type: "run.payload_revealed",
    payload: { receiptId, catalogId: catalog.id, runId: job.id, reason, payloadDigest: digest, withheld: categories },
    idempotencyKey: `run-payload:${receiptId}`,
  });
  await appendEvent(client, {
    workspaceId: job.workspace_id, actorId: actor.id, actorKind: "staff", type: "run.payload_reveal_audited",
    payload: { receiptId, catalogId: catalog.id, runId: job.id, enrollmentId: job.enrollment_id, reason, payloadDigest: digest },
    idempotencyKey: `run-payload-audit:${receiptId}`,
  });
  return { receipt: { id: receiptId, eventId: recorded.id, reason, payloadDigest: digest }, payload, withheld, rule };
}

// ---------------------------------------------------------------- sandboxed replay

const SYNTHETIC_USAGE: UsageReceipt = {
  accounting: { accountingKey: "replay" }, providerId: "replay", modelId: "frozen-decisions", operation: "assess", attempts: [],
  inputCharacters: 0, requestedMaxOutputTokens: null, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
};
export class ReplayDivergence extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReplayDivergence"; }
}

/**
 * Runs `work` in a REPEATABLE READ, READ ONLY transaction: whatever it attempts, PostgreSQL
 * refuses any write (SQLSTATE 25006), so a replay cannot change learner records or progress.
 */
export async function sandboxed<T>(db: Database, work: (client: PoolClient) => Promise<T>) {
  return transaction(db, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return work(client);
  });
}

/**
 * Replays a finished supervisor run's tool loop against its frozen inputs. The model is replaced
 * by the run's recorded decisions and every tool by a stub that returns the recorded result, so
 * no provider is called and no tool has an effect. Core's current loop rules (selection, candidate
 * and research limits, finish rules) run again, and the plan they produce is compared with the
 * stored one by digest. The replay gets a new run id and is never stored as a run.
 */
export async function replayRun(client: PoolClient, job: RunRow) {
  const replayRunId = randomUUID();
  const base = { replayRunId, sourceRunId: job.id, sideEffects: "stubbed" as const, progressWrites: "denied" as const, providerCalls: 0 };
  const plans = (await client.query<{ id: string; operation_id: string; digest: string; content: unknown }>(
    "SELECT id,operation_id,digest,content FROM supervisor_artifacts WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND content->>'kind'='supervised_plan' ORDER BY created_at DESC LIMIT 1",
    [job.id, job.enrollment_id, job.workspace_id])).rows;
  const artifact = plans[0];
  if (!artifact) {
    // A run Core refused keeps no plan and not the refusing decision, so there is nothing to compare.
    const refused = (await client.query("SELECT 1 FROM supervisor_artifacts WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND content->>'kind'='output_refusal' LIMIT 1",
      [job.id, job.enrollment_id, job.workspace_id])).rowCount;
    return { ...base, outcome: "not_replayable" as const, reason: refused ? "refused_output" : "no_recorded_plan", steps: [], recordedPlanDigest: null, replayedPlanDigest: null };
  }
  if (digestJson(artifact.content) !== artifact.digest)
    return { ...base, outcome: "not_replayable" as const, reason: "recorded_plan_integrity", steps: [], recordedPlanDigest: artifact.digest, replayedPlanDigest: null };
  const plan = supervisedPlanSchema.safeParse(artifact.content);
  if (!plan.success) return { ...base, outcome: "not_replayable" as const, reason: "recorded_plan_unreadable", steps: [], recordedPlanDigest: artifact.digest, replayedPlanDigest: null };
  const calls = (await client.query<{ id: string; step: number; tool: string; arguments: unknown; outcome: Record<string, unknown> }>(
    "SELECT id,step,tool,arguments,outcome FROM supervisor_tool_calls WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND operation_id=$4 ORDER BY step",
    [job.id, job.enrollment_id, job.workspace_id, artifact.operation_id])).rows;
  const context = (await client.query<{ context: unknown }>("SELECT context FROM supervisor_inputs WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY checkpoint_id LIMIT 1",
    [job.id, job.enrollment_id, job.workspace_id])).rows[0]?.context ?? {};
  const decisions = [
    ...calls.map((c) => ({ decision: "tool", tool: c.tool, argumentsJson: JSON.stringify(c.arguments), summary: "" })),
    { decision: "finish", tool: "none", argumentsJson: "{}", summary: plan.data.summary },
  ];
  const steps: { step: number; tool: string; recordedReceiptId: string; argumentsDigest: string | null; resultDigest: string | null }[] = [];
  const secret = randomBytes(32), keyed = (value: unknown) => createHmac("sha256", secret).update(digestJson(value)).digest("hex");
  let round = 0, invoked = 0, divergence: string | null = null;
  // The loop wraps any port failure in its own error, so the reason is kept here first.
  const diverge = (code: string) => { divergence ??= code; return new ReplayDivergence(code); };
  try {
    const replayed = await runSupervisorToolLoop({
      context: context as TeachingContext, roundLimit: decisions.length, maxInputCharacters: 50_000_000, accountingKey: `replay:${replayRunId}`,
      signal: new AbortController().signal,
      model: async () => {
        const decision = decisions[round++];
        if (!decision) throw diverge("replay_decisions_exhausted");
        return { output: decision as Json, usage: { ...SYNTHETIC_USAGE, accounting: { accountingKey: `replay:${replayRunId}` } } };
      },
      tools: {
        async invoke(name, args, step) {
          const recorded = calls[invoked++];
          if (!recorded || recorded.tool !== name || recorded.step !== step || digestJson(args) !== digestJson(recorded.arguments)) throw diverge("tool_call_diverged");
          const outcome = recorded.outcome;
          // Digests are keyed by a secret of this replay only (never returned), and absent for tools whose
          // content the privacy rule withholds, so a step can never confirm a guess at learner content.
          const revealed = REVEALED_TOOLS.has(name);
          steps.push({ step, tool: name, recordedReceiptId: recorded.id, argumentsDigest: revealed ? keyed(args) : null, resultDigest: revealed ? keyed(outcome.result ?? null) : null });
          return {
            receiptId: recorded.id, result: (outcome.result ?? null) as Json,
            ...(outcome.selection ? { selection: outcome.selection as never } : {}),
            ...(outcome.generatedTeaching ? { generatedTeaching: outcome.generatedTeaching as never } : {}),
            ...(outcome.researchSelection ? { researchSelection: outcome.researchSelection as never } : {}),
            ...(outcome.modelSuggestion ? { modelSuggestion: outcome.modelSuggestion as never } : {}),
            ...(outcome.resourceChoice ? { resourceChoice: outcome.resourceChoice as never } : {}),
          };
        },
      },
    });
    // Today's round checks refuse what the recorded run finished with.
    if (replayed.content.kind === "output_refusal")
      return { ...base, outcome: "diverged" as const, reason: `loop_refused:${replayed.content.reason}`, steps, recordedPlanDigest: artifact.digest, replayedPlanDigest: null };
    const replayedPlanDigest = digestJson(replayed.content);
    return { ...base, outcome: replayedPlanDigest === artifact.digest ? ("matches" as const) : ("diverged" as const),
      reason: replayedPlanDigest === artifact.digest ? null : "plan_differs", steps, recordedPlanDigest: artifact.digest, replayedPlanDigest };
  } catch (error) {
    const reason = divergence ?? `loop_refused:${(error as { code?: string }).code ?? "unknown"}`;
    return { ...base, outcome: "diverged" as const, reason, steps, recordedPlanDigest: artifact.digest, replayedPlanDigest: null };
  }
}

/** Receipt for a replay, in its own transaction after the read-only one: who replayed which run,
 * the new replay id and the verdict. Workspace audit only; it changes no learner record. */
export async function recordReplay(client: PoolClient, actor: { id: string }, catalog: Catalog, job: RunRow, result: Awaited<ReturnType<typeof replayRun>>) {
  await appendEvent(client, {
    workspaceId: job.workspace_id, actorId: actor.id, actorKind: "staff", type: "run.replayed",
    payload: { catalogId: catalog.id, runId: job.id, replayRunId: result.replayRunId, outcome: result.outcome, reason: result.reason,
      recordedPlanDigest: result.recordedPlanDigest, replayedPlanDigest: result.replayedPlanDigest },
    idempotencyKey: `run-replay:${result.replayRunId}`,
  });
}

export const payloadRequestSchema = z.strictObject({ reason: z.enum(PAYLOAD_REASONS) });
