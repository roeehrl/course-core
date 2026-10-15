import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { definiteRejection, ProviderError, type VideoJob } from "@course-core/providers";
import { MAX_RETRY_AFTER_MS } from "@course-core/supervisor";
import { type Database } from "./database.js";
import { afterCommitTransaction as mediaTransaction, onCommit } from "./after-commit.js";
import { membership, type Actor, type authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { digestJson } from "./repository.js";
import { adminPermissionMatrix, type AdminPermission } from "./admin-routes.js";
import { chargePaidWork, lockPaidWorkBudgets, paidWorkPolicy, releasePaidWork } from "./supervisor-bridge.js";
import { pricingInForce, recordSpendEvents, type SpendEvent } from "./provider-costs.js";
import { jobPolicySchema, type SupervisorJobPolicy, type WorkspaceProviders } from "./provider-setup.js";
import type { MediaPricing } from "./provider-runtime.js";
import { telemetry } from "./telemetry.js";

/** Every durable state of a generated-media job. Only `attached` is learner visible. */
export const MEDIA_STATES = [
  "requested", "admitted", "submitted", "polling", "generated", "under_review",
  "approved", "rejected", "attached", "expired", "failed", "cancelled", "uncertain",
] as const;
export type MediaState = (typeof MEDIA_STATES)[number];
const TRANSITIONS: Record<MediaState, readonly MediaState[]> = {
  requested: ["admitted", "failed", "cancelled"],
  admitted: ["submitted", "failed", "cancelled"],
  // Back to `admitted` only when the provider definitely did not receive the request.
  submitted: ["polling", "uncertain", "admitted", "failed", "cancelled"],
  polling: ["polling", "generated", "failed", "cancelled"],
  // Reconciliation polls the stored operation; it never submits again.
  uncertain: ["polling", "generated", "failed", "cancelled"],
  generated: ["under_review", "failed", "cancelled"],
  under_review: ["approved", "rejected", "cancelled"],
  approved: ["attached", "cancelled"],
  attached: ["expired"],
  rejected: [],
  expired: [],
  failed: [],
  cancelled: [],
};
export function canTransition(from: MediaState, to: MediaState) {
  return TRANSITIONS[from].includes(to);
}
const CANCELLABLE: readonly MediaState[] = ["requested", "admitted", "submitted", "polling", "uncertain", "generated", "under_review", "approved"];
const WORKER_STATES: readonly MediaState[] = ["admitted", "submitted", "polling", "uncertain", "generated"];
const IN_FLIGHT: readonly MediaState[] = ["admitted", "submitted", "polling", "uncertain"];

/** The subset of the provider runtime this service uses. Tests compose the real
 * runtime from a scripted adapter; nothing here imports a vendor protocol. */
export interface MediaRuntime {
  mediaVideo(): { modelId: string; video: { durationSeconds: number; aspectRatio: string; resolution: string }; pricing: MediaPricing | null; availability: string } | undefined;
  submitMediaVideo(prompt: string, accountingKey: string, signal: AbortSignal): Promise<{ state: "pending" | "completed"; job: VideoJob; videos?: { uri: string; mimeType: string }[] }>;
  pollMediaVideo(job: VideoJob, signal: AbortSignal): Promise<{ state: "pending" | "completed"; job: VideoJob; videos?: { uri: string; mimeType: string }[] }>;
  downloadMediaVideo(job: VideoJob, uri: string, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string; byteLength: number }>;
}
export interface MediaBinding { revision: number; jobPolicy: SupervisorJobPolicy; runtime: MediaRuntime }
export type MediaRuntimeResolver = (client: Database | PoolClient, workspaceId: string, revision?: number) => Promise<MediaBinding | null>;
export function workspaceMediaResolver(providers: WorkspaceProviders): MediaRuntimeResolver {
  return async (client, workspaceId, revision) => {
    const version = await providers.version(client, workspaceId, revision);
    if (!version) return null;
    return { revision: version.revision, jobPolicy: jobPolicySchema.parse(version.job_policy), runtime: providers.runtime(workspaceId, version) };
  };
}
export interface MediaJobOptions {
  /** Hard ceiling 32 MiB (the database bound). */
  maxAssetBytes?: number;
  maxActivePerWorkspace?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  jobDurationMs?: number;
  maxSubmitAttempts?: number;
  leaseMs?: number;
  providerCallTimeoutMs?: number;
}
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
/** Slack between the longest provider work one leased step can do and the lease itself:
 * database writes around the calls and clock skew between worker hosts. */
export const LEASE_MARGIN_MS = 30_000;
function settings(options: MediaJobOptions = {}) {
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
    const v = value ?? fallback;
    if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error("Invalid media job option.");
    return v;
  };
  const config = {
    maxAssetBytes: bounded(options.maxAssetBytes, 24 * 1024 * 1024, 1024, MAX_ASSET_BYTES),
    maxActivePerWorkspace: bounded(options.maxActivePerWorkspace, 4, 1, 50),
    pollIntervalMs: bounded(options.pollIntervalMs, 10_000, 1, 300_000),
    maxPolls: bounded(options.maxPolls, 120, 1, 1000),
    jobDurationMs: bounded(options.jobDurationMs, 30 * 60_000, 60_000, 86_400_000),
    maxSubmitAttempts: bounded(options.maxSubmitAttempts, 3, 1, 3),
    leaseMs: bounded(options.leaseMs, 300_000, 1_000, 600_000),
    providerCallTimeoutMs: bounded(options.providerCallTimeoutMs, 120_000, 100, 300_000),
  };
  // A poll step makes two sequential provider calls (status, then download), each bounded by
  // the call timeout. A lease that can lapse mid-call lets another worker take the job and turn
  // a submission that is still running into `uncertain`, so such a configuration is refused.
  const needed = 2 * config.providerCallTimeoutMs + LEASE_MARGIN_MS;
  if (config.leaseMs < needed)
    throw new Error(`Invalid media job options: leaseMs (${config.leaseMs}) must be at least twice providerCallTimeoutMs `
      + `(${config.providerCallTimeoutMs}) plus a ${LEASE_MARGIN_MS} ms margin, i.e. at least ${needed}.`);
  return config;
}
type Settings = ReturnType<typeof settings>;

const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  episodeId = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),
  text = (min: number, max: number) =>
    z.string().min(min).max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) && v.trim().length >= min);
const requestSchema = z.strictObject({
  episodeId,
  title: text(3, 200),
  objective: text(10, 2000),
  script: text(20, 8000),
  idempotencyKey: key,
});
const estimateSchema = z.strictObject({ episodeId });
const findingsSchema = z.strictObject({
  factualAccuracy: z.boolean(),
  labelsAndEquations: z.boolean(),
  captionsMatchNarration: z.boolean(),
  noMisleadingMotion: z.boolean(),
});
const reviewSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  captionsVtt: z.string().min(8).max(100_000).optional(),
  transcript: text(20, 20_000).optional(),
  visualDescription: text(20, 5000).optional(),
  findings: findingsSchema,
  rationale: text(20, 2000),
  idempotencyKey: key,
});
const attachSchema = z.strictObject({ expiresAt: z.iso.datetime({ offset: true }), idempotencyKey: key });
const revokeSchema = z.strictObject({ reason: text(10, 1000), idempotencyKey: key });
const cancelSchema = z.strictObject({ idempotencyKey: key });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  requireCondition(result.success, "INVALID_INPUT", 400);
  return result.data;
}
/** WebVTT is the captions format the web player loads; require a header and at least one cue. */
export function validCaptions(vtt: string) {
  return /^﻿?WEBVTT(?:[ \t][^\r\n]*)?\r?\n/.test(vtt) && /\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/.test(vtt)
    && !/<\s*script/i.test(vtt);
}
/** Container magic: MP4 `ftyp` box or the EBML header used by WebM. */
export function sniffVideo(bytes: Uint8Array): "video/mp4" | "video/webm" | null {
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return null;
}
export function operationIdOf(job: VideoJob): string {
  const state = job.providerState as Record<string, unknown> | null;
  const name = state && typeof state === "object" && typeof state.operationName === "string" ? state.operationName : null;
  return name && name.length <= 512 ? name : "digest:" + digestJson(job.providerState).slice(0, 48);
}

interface JobRow {
  id: string; workspace_id: string; enrollment_id: string; course_release_id: string; episode_id: string; kind: string;
  title: string; objective: string; script: string; provider_revision: number; model_id: string;
  settings: { durationSeconds: number; aspectRatio: string; resolution: string }; pricing: MediaPricing | null;
  estimate_micro_usd: string | null; charged_micro_usd: string; state: MediaState; failure_code: string | null;
  idempotency_key: string; request_digest: string; provider_operation: VideoJob | null; provider_operation_id: string | null;
  submit_attempts: number; poll_attempts: number; submit_started_at: Date | null; next_attempt_at: Date; deadline_at: Date;
  lease_token: string | null; lease_until: Date | null; remote_may_continue: boolean; requested_by: string;
  created_at: Date; updated_at: Date;
}
const spend = (client: PoolClient, events: SpendEvent[]) => onCommit(client, () => recordSpendEvents(events));
/** A ledger row nothing has settled yet (erasure or an earlier transition may already have). */
const OPEN_ROW = "source='media' AND source_ref=$1 AND state IN('reserved','uncertain') AND settled_at IS NULL";
/** The provider may have run this job, so its reservation stays charged. The ledger row leaves
 * `reserved` (in flight):
 * - `open`: `uncertain` and still open, while a result may yet arrive (polling resumes, or a
 *   submission in flight may still come back definitely refused);
 * - `closed`: the job ended without knowing the outcome; `uncertain` and settled at its
 *   reservation, so nothing settles it again (the state erasure uses for the same case);
 * - `completed`: the provider reported the render complete but the clip was unusable;
 *   settled `unpriced` at its reservation, as an unpriced completed call is.
 * Every update touches only an open row, so a row already closed is never re-finalized. */
async function holdCharged(client: PoolClient, jobId: string, mode: "open" | "closed" | "completed") {
  if (mode === "open") await client.query(`UPDATE provider_spend_ledger SET state='uncertain' WHERE ${OPEN_ROW} AND state='reserved'`, [jobId]);
  else await client.query(`UPDATE provider_spend_ledger SET state=$2,settled_at=clock_timestamp() WHERE ${OPEN_ROW}`, [jobId, mode === "closed" ? "uncertain" : "unpriced"]);
}
async function permitted(client: Database | PoolClient, actor: Actor, workspaceId: string, permission: AdminPermission) {
  const role = await membership(client, actor, workspaceId);
  requireCondition(adminPermissionMatrix[role]?.includes(permission), "FORBIDDEN", 403);
  return role;
}
/** Returns the reservation released by this transition (0 when none). */
async function move(client: PoolClient, job: Pick<JobRow, "id" | "state">, to: MediaState, code: string | null, set: Record<string, unknown> = {}, actorId: string | null = null): Promise<number> {
  requireCondition(canTransition(job.state, to), "MEDIA_TRANSITION_REJECTED", 409);
  const fields: Record<string, unknown> = { ...set, ...(["failed", "cancelled", "rejected"].includes(to) ? { failure_code: code } : {}) };
  const columns = Object.keys(fields);
  requireCondition(columns.every((c) => /^[a-z_]+$/.test(c)), "MEDIA_WRITE_CONFLICT", 500);
  const assignments = columns.map((c, i) => `,${c}=$${i + 4}`).join("");
  const updated = await client.query(
    `UPDATE media_jobs SET state=$2,updated_at=clock_timestamp()${assignments} WHERE id=$1 AND state=$3`,
    [job.id, to, job.state, ...Object.values(fields)],
  );
  requireCondition(updated.rowCount === 1, "MEDIA_WRITE_CONFLICT", 409);
  await client.query("INSERT INTO media_job_events(job_id,from_state,to_state,code,actor_id) VALUES($1,$2,$3,$4,$5)", [job.id, job.state, to, code, actorId]);
  // The spend ledger follows whether an admitted job's outcome is known.
  if (to === "uncertain") await holdCharged(client, job.id, "open");
  if (job.state === "uncertain" && to === "polling") await client.query(`UPDATE provider_spend_ledger SET state='reserved' WHERE ${OPEN_ROW} AND state='uncertain'`, [job.id]);
  // `admitted` is only ever (re)entered when no submission could have run: before the first
  // one, or after one the provider definitely refused. Ending there gives the reservation back.
  const released = job.state === "admitted" && (to === "failed" || to === "cancelled") ? await releaseUnstartedMedia(client, job.id) : 0;
  job.state = to;
  // Allowlisted state and server code only, counted once the transition commits.
  onCommit(client, () => telemetry().count("course.media.transitions", 1, { "course.media.state": to, "course.media.code": code }));
  return released;
}
/** The provider certainly never ran this job: the whole reservation goes back to both budgets
 * and the ledger row settles as `not_started` with no actual cost. Only a `reserved` row is
 * released; an `uncertain` one (the provider may have run) is never touched, except by a caller
 * that has since proven the submission definitely did not run (`proven`). Idempotent: a
 * retried or replayed call finds no open row and releases nothing. Lock order: job (held by the
 * caller) -> workspace budget -> enrollment budget, as at admission. */
async function releaseUnstartedMedia(client: PoolClient, jobId: string, proven = false): Promise<number> {
  const states = proven ? ["reserved", "uncertain"] : ["reserved"];
  const open = (await client.query<{ workspace_id: string; enrollment_id: string; model_id: string | null }>(
    `SELECT workspace_id,enrollment_id,model_id FROM provider_spend_ledger WHERE ${OPEN_ROW} AND state=ANY($2::text[])`, [jobId, states])).rows[0];
  if (!open) return 0;
  const scope = { workspaceId: open.workspace_id, enrollmentId: open.enrollment_id };
  await lockPaidWorkBudgets(client, scope);
  const settled = await client.query<{ reserved_micro_usd: string }>(`UPDATE provider_spend_ledger SET state='not_started',charged_micro_usd=0,
      released_micro_usd=reserved_micro_usd,settled_at=clock_timestamp()
    WHERE ${OPEN_ROW} AND state=ANY($2::text[]) RETURNING reserved_micro_usd`, [jobId, states]);
  if (!settled.rowCount) return 0;
  const amount = Number(settled.rows[0]!.reserved_micro_usd);
  // Only a failed or cancelled job may hold a zero charge (migration 035).
  await client.query("UPDATE media_jobs SET charged_micro_usd=0 WHERE id=$1", [jobId]);
  if (amount > 0) {
    await releasePaidWork(client, scope, amount);
    spend(client, [{ kind: "released", role: "media", microUsd: amount, modelId: open.model_id, basis: "reported" }]);
  }
  return amount;
}
/** A failed submission that certainly did not run: nothing was sent, or every attempt was
 * refused with a documented rejection status (the gateway's rule, `definiteRejection`). */
function unstarted(failure: ProviderError) {
  const notSent = failure.submission === "not_sent" && !failure.usage?.attempts.length;
  const refused = notSent ? null : definiteRejection(failure);
  return { definite: notSent || refused !== null, notSent, refused };
}
interface ReleaseEpisodes { server_bundle: { chapters: { episodes: { id: string; title: string }[] }[] } }
const episodesOf = (release: ReleaseEpisodes) => release.server_bundle.chapters.flatMap((c) => c.episodes.map((e) => ({ id: e.id, title: e.title })));
function estimateFor(plan: NonNullable<ReturnType<MediaRuntime["mediaVideo"]>>) {
  return plan.pricing ? plan.video.durationSeconds * plan.pricing.microUsdPerOutputSecond + (plan.pricing.microUsdPerRequest ?? 0) : null;
}
/** An operator price version for the video model takes precedence over the role's rate card;
 * only a versioned price lets a finished clip release the unused part of its reservation. */
async function versionedPricing(client: Database | PoolClient, workspaceId: string, modelId: string): Promise<MediaPricing | null> {
  const version = await pricingInForce(client, workspaceId, modelId);
  if (!version || (version.microUsdPerOutputSecond === null && version.microUsdPerRequest === null)) return null;
  const row = (await client.query<{ version: number; effective_from: Date; source_note: string }>(
    "SELECT version,effective_from,source_note FROM provider_model_prices WHERE id=$1", [version.versionId])).rows[0]!;
  return { microUsdPerOutputSecond: version.microUsdPerOutputSecond ?? 0, microUsdPerRequest: version.microUsdPerRequest ?? 0,
    source: `Price version ${row.version}: ${row.source_note}`.slice(0, 300), reviewedAt: row.effective_from.toISOString().slice(0, 10), pricingVersionId: version.versionId };
}
/** A completed clip costs its requested duration at the admitted price. Releases the rest of the
 * reservation once, in the job -> workspace budget -> enrollment budget lock order. */
async function settleMediaCost(client: PoolClient, job: JobRow) {
  const pricing = job.pricing, charged = Number(job.charged_micro_usd), actual = job.estimate_micro_usd === null ? null : Number(job.estimate_micro_usd);
  if (!pricing?.pricingVersionId || actual === null || actual <= 0) {
    await holdCharged(client, job.id, "completed");
    return;
  }
  const scope = { workspaceId: job.workspace_id, enrollmentId: job.enrollment_id };
  await lockPaidWorkBudgets(client, scope);
  const settled = await client.query(`UPDATE provider_spend_ledger SET state='reconciled',pricing_version_id=$2,actual_micro_usd=$3,charged_micro_usd=$3,
      released_micro_usd=GREATEST(0,reserved_micro_usd-$3),settled_at=clock_timestamp()
    WHERE ${OPEN_ROW} RETURNING reserved_micro_usd`, [job.id, pricing.pricingVersionId, actual]);
  const release = Math.max(0, charged - actual);
  if (!settled.rowCount || release === 0) return;
  const updated = await client.query("UPDATE media_jobs SET charged_micro_usd=$2 WHERE id=$1 AND charged_micro_usd=$3", [job.id, actual, charged]);
  requireCondition(updated.rowCount === 1, "MEDIA_WRITE_CONFLICT", 409);
  await releasePaidWork(client, scope, release);
  spend(client, [{ kind: "actual", role: "media", microUsd: actual, modelId: job.model_id, basis: "reported" },
    { kind: "released", role: "media", microUsd: release, modelId: job.model_id, basis: "reported" }]);
}

/** Media command idempotency: a retried key replays; the same key with different input conflicts. */
async function mediaCommand<T>(db: Database, actor: Actor, workspaceId: string, permission: AdminPermission, operation: string,
  idempotencyKey: string, semantic: unknown, execute: (client: PoolClient) => Promise<T>): Promise<T> {
  return mediaTransaction(db, async (client) => {
    await permitted(client, actor, workspaceId, permission);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-command:" + workspaceId + ":" + idempotencyKey]);
    const digest = digestJson({ actorId: actor.id, operation, semantic });
    const old = (await client.query("SELECT request_digest,response FROM media_command_receipts WHERE workspace_id=$1 AND idempotency_key=$2", [workspaceId, idempotencyKey])).rows[0];
    if (old) {
      requireCondition(old.request_digest === digest, "IDEMPOTENCY_CONFLICT", 409);
      return old.response as T;
    }
    const response = await execute(client);
    await client.query("INSERT INTO media_command_receipts(workspace_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,$5)",
      [workspaceId, idempotencyKey, digest, actor.id, JSON.stringify(response)]);
    return response;
  });
}

export function createMediaJobService(db: Database, resolve: MediaRuntimeResolver | undefined, options: MediaJobOptions = {}) {
  const config = settings(options);
  async function enrollmentScope(client: Database | PoolClient, enrollmentId: string) {
    parse(z.string().uuid(), enrollmentId);
    const row = (await client.query<{ id: string; workspace_id: string; course_release_id: string; status: string; user_id: string }>(
      "SELECT id,workspace_id,course_release_id,status,user_id FROM enrollments WHERE id=$1", [enrollmentId])).rows[0];
    requireCondition(row, "ENROLLMENT_NOT_FOUND", 404);
    return row;
  }
  async function binding(client: Database | PoolClient, workspaceId: string, revision?: number) {
    const bound = resolve ? await resolve(client, workspaceId, revision) : null;
    requireCondition(bound, "MEDIA_PROVIDER_UNCONFIGURED", 409);
    const plan = bound.runtime.mediaVideo();
    requireCondition(plan, "MEDIA_CAPABILITY_MISSING", 409);
    const versioned = await versionedPricing(client, workspaceId, plan.modelId);
    return { ...bound, plan: versioned ? { ...plan, pricing: versioned } : plan };
  }
  async function budgets(client: PoolClient, workspaceId: string, enrollmentId: string) {
    return lockPaidWorkBudgets(client, { workspaceId, enrollmentId });
  }

  /** Read-only preview: what one job would cost and whether it would be admitted now. */
  async function estimate(actor: Actor, enrollmentId: string, raw: unknown) {
    const input = parse(estimateSchema, raw);
    return mediaTransaction(db, async (client) => {
      const enrollment = await enrollmentScope(client, enrollmentId);
      await permitted(client, actor, enrollment.workspace_id, "release.publish");
      const release = (await client.query<ReleaseEpisodes>("SELECT server_bundle FROM course_releases WHERE id=$1", [enrollment.course_release_id])).rows[0]!;
      requireCondition(episodesOf(release).some((e) => e.id === input.episodeId), "MEDIA_EPISODE_OUT_OF_SCOPE", 409);
      const bound = await binding(client, enrollment.workspace_id);
      const estimateMicroUsd = estimateFor(bound.plan), reserve = bound.jobPolicy.allowance.microUsd;
      const policy = await paidWorkPolicy(client, { workspaceId: enrollment.workspace_id, enrollmentId, episodeId: input.episodeId }, "admit_job");
      const available = await budgets(client, enrollment.workspace_id, enrollmentId);
      const reason = bound.plan.availability !== "ready" ? "MEDIA_PROVIDER_UNAVAILABLE"
        : estimateMicroUsd === null ? "MEDIA_PRICING_UNAVAILABLE"
        : !policy.allowed ? "MEDIA_POLICY_DENIED"
        : estimateMicroUsd > reserve ? "MEDIA_PER_JOB_LIMIT"
        : available.microUsd < reserve ? "MEDIA_BUDGET_EXHAUSTED" : null;
      return {
        episodeId: input.episodeId, providerRevision: bound.revision, modelId: bound.plan.modelId, settings: bound.plan.video,
        pricing: bound.plan.pricing, estimateMicroUsd, reserveMicroUsd: reserve, availableMicroUsd: available.microUsd,
        admissible: reason === null, reason, chargedAtAdmission: "full_per_job_allowance" as const, grantsCredit: false,
      };
    });
  }

  async function request(actor: Actor, enrollmentId: string, raw: unknown) {
    const input = parse(requestSchema, raw);
    return mediaTransaction(db, async (client) => {
      const enrollment = await enrollmentScope(client, enrollmentId);
      await permitted(client, actor, enrollment.workspace_id, "release.publish");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-request:" + enrollment.workspace_id + ":" + input.idempotencyKey]);
      const { idempotencyKey: _key, ...semantic } = input;
      const digest = digestJson({ actorId: actor.id, enrollmentId, ...semantic });
      const existing = (await client.query<JobRow>("SELECT * FROM media_jobs WHERE workspace_id=$1 AND idempotency_key=$2", [enrollment.workspace_id, input.idempotencyKey])).rows[0];
      if (existing) {
        requireCondition(existing.request_digest === digest, "IDEMPOTENCY_CONFLICT", 409);
        return view(client, existing);
      }
      const release = (await client.query<ReleaseEpisodes>("SELECT server_bundle FROM course_releases WHERE id=$1", [enrollment.course_release_id])).rows[0]!;
      requireCondition(episodesOf(release).some((e) => e.id === input.episodeId), "MEDIA_EPISODE_OUT_OF_SCOPE", 409);
      const bound = await binding(client, enrollment.workspace_id);
      requireCondition(bound.plan.availability === "ready", "MEDIA_PROVIDER_UNAVAILABLE", 409);
      const estimateMicroUsd = estimateFor(bound.plan);
      requireCondition(estimateMicroUsd !== null, "MEDIA_PRICING_UNAVAILABLE", 409);
      // Lock order: enrollment -> membership -> release -> policy -> job -> workspace budget -> enrollment budget.
      const policy = await paidWorkPolicy(client, { workspaceId: enrollment.workspace_id, enrollmentId, episodeId: input.episodeId }, "admit_job");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-admission:" + enrollment.workspace_id]);
      const job: JobRow = (await client.query<JobRow>(
        `INSERT INTO media_jobs(id,workspace_id,enrollment_id,course_release_id,episode_id,kind,title,objective,script,provider_revision,model_id,settings,pricing,
           estimate_micro_usd,state,idempotency_key,request_digest,deadline_at,requested_by)
         VALUES($1,$2,$3,$4,$5,'generated_short_video',$6,$7,$8,$9,$10,$11,$12,$13,'requested',$14,$15,clock_timestamp()+($16*interval '1 millisecond'),$17) RETURNING *`,
        [randomUUID(), enrollment.workspace_id, enrollmentId, enrollment.course_release_id, input.episodeId, input.title, input.objective, input.script,
          bound.revision, bound.plan.modelId, JSON.stringify(bound.plan.video), JSON.stringify(bound.plan.pricing), estimateMicroUsd,
          input.idempotencyKey, digest, config.jobDurationMs, actor.id])).rows[0]!;
      await client.query("INSERT INTO media_job_events(job_id,from_state,to_state,code,actor_id) VALUES($1,NULL,'requested',NULL,$2)", [job.id, actor.id]);
      const reserve = bound.jobPolicy.allowance.microUsd;
      const active = Number((await client.query("SELECT count(*) FROM media_jobs WHERE workspace_id=$1 AND state=ANY($2::text[])", [enrollment.workspace_id, IN_FLIGHT])).rows[0].count);
      const available = await budgets(client, enrollment.workspace_id, enrollmentId);
      const refusal = !policy.allowed ? "MEDIA_POLICY_DENIED"
        : estimateMicroUsd! > reserve ? "MEDIA_PER_JOB_LIMIT"
        : active >= config.maxActivePerWorkspace ? "MEDIA_CAPACITY"
        : available.microUsd < reserve ? "MEDIA_BUDGET_EXHAUSTED" : null;
      if (refusal) {
        await move(client, job, "failed", refusal, {}, actor.id);
        return view(client, (await client.query<JobRow>("SELECT * FROM media_jobs WHERE id=$1", [job.id])).rows[0]!);
      }
      // Charged at the full per-job allowance at admission, as every paid job is.
      await chargePaidWork(client, { workspaceId: enrollment.workspace_id, enrollmentId }, reserve, 0);
      onCommit(client, () => telemetry().count("course.media.cost.reserved", reserve));
      await client.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,model_id,state,reserved_micro_usd,reserved_tokens,charged_micro_usd)
        VALUES($1,'media',$2,1,$3,$4,'media',$5,'reserved',$6,0,$6)`, [randomUUID(), job.id, enrollment.workspace_id, enrollmentId, bound.plan.modelId, reserve]);
      spend(client, [{ kind: "reserved", role: "media", microUsd: reserve, modelId: bound.plan.modelId, basis: "reserved_ceiling" }]);
      const deadlineMs = Math.min(policy.nowMs + config.jobDurationMs, policy.effectiveDeadlineMs ?? Infinity);
      await move(client, job, "admitted", null, { charged_micro_usd: reserve, deadline_at: new Date(deadlineMs).toISOString(), next_attempt_at: new Date(policy.nowMs).toISOString() }, actor.id);
      return view(client, (await client.query<JobRow>("SELECT * FROM media_jobs WHERE id=$1", [job.id])).rows[0]!);
    });
  }

  async function jobRow(client: Database | PoolClient, jobId: string, lock = false) {
    parse(z.string().uuid(), jobId);
    const row = (await client.query<JobRow>(`SELECT * FROM media_jobs WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [jobId])).rows[0];
    requireCondition(row, "MEDIA_JOB_NOT_FOUND", 404);
    return row;
  }
  async function view(client: Database | PoolClient, job: JobRow, detail = false) {
    const asset = (await client.query("SELECT sha256,mime_type,byte_length,created_at FROM media_assets WHERE job_id=$1", [job.id])).rows[0];
    const review = (await client.query("SELECT * FROM media_reviews WHERE job_id=$1", [job.id])).rows[0];
    const attachment = (await client.query("SELECT * FROM media_attachments WHERE job_id=$1", [job.id])).rows[0];
    const events = detail
      ? (await client.query("SELECT from_state,to_state,code,created_at FROM media_job_events WHERE job_id=$1 ORDER BY id LIMIT 200", [job.id])).rows
      : undefined;
    const learner = (await client.query("SELECT u.display_name FROM enrollments e JOIN app_users u ON u.id=e.user_id WHERE e.id=$1", [job.enrollment_id])).rows[0];
    return {
      id: job.id, state: job.state, failureCode: job.failure_code, kind: job.kind, title: job.title, objective: job.objective,
      ...(detail ? { script: job.script } : {}),
      enrollmentId: job.enrollment_id, learnerName: learner?.display_name ?? null, episodeId: job.episode_id, releaseId: job.course_release_id,
      providerRevision: job.provider_revision, modelId: job.model_id, settings: job.settings, pricing: job.pricing,
      estimateMicroUsd: job.estimate_micro_usd === null ? null : Number(job.estimate_micro_usd), chargedMicroUsd: Number(job.charged_micro_usd),
      providerOperationId: job.provider_operation_id, remoteMayContinue: job.remote_may_continue,
      submitAttempts: job.submit_attempts, pollAttempts: job.poll_attempts,
      deadlineAt: new Date(job.deadline_at).toISOString(), createdAt: new Date(job.created_at).toISOString(), updatedAt: new Date(job.updated_at).toISOString(),
      asset: asset ? { sha256: asset.sha256, mimeType: asset.mime_type, byteLength: asset.byte_length, createdAt: asset.created_at.toISOString() } : null,
      review: review ? { id: review.id, decision: review.decision, assetSha256: review.asset_sha256, findings: review.findings, rationale: review.rationale,
        hasCaptions: review.captions_vtt !== null, transcript: review.transcript, visualDescription: review.visual_description,
        reviewedBy: review.reviewed_by, reviewedAt: review.created_at.toISOString() } : null,
      attachment: attachment ? { id: attachment.id, episodeId: attachment.episode_id, expiresAt: attachment.expires_at.toISOString(),
        state: attachment.revoked_at ? "revoked" : attachment.expires_at.getTime() <= Date.now() ? "expired" : "active",
        revokedAt: attachment.revoked_at?.toISOString() ?? null, revokeReason: attachment.revoke_reason } : null,
      ...(events ? { events: events.map((e) => ({ from: e.from_state, to: e.to_state, code: e.code, at: e.created_at.toISOString() })) } : {}),
      learnerVisible: Boolean(job.state === "attached" && attachment && !attachment.revoked_at && attachment.expires_at.getTime() > Date.now()),
      grantsCredit: false,
    };
  }

  async function list(actor: Actor, releaseId: string) {
    parse(z.string().uuid(), releaseId);
    const release = (await db.query<ReleaseEpisodes & { workspace_id: string; id: string; version: string }>(
      "SELECT id,workspace_id,version,server_bundle FROM course_releases WHERE id=$1", [releaseId])).rows[0];
    requireCondition(release, "RELEASE_NOT_FOUND", 404);
    const role = await permitted(db, actor, release.workspace_id, "run.inspect");
    const jobs = (await db.query<JobRow>("SELECT * FROM media_jobs WHERE course_release_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id LIMIT 100", [releaseId, release.workspace_id])).rows;
    const enrollments = (await db.query(
      `SELECT e.id,u.display_name AS name,e.status FROM enrollments e JOIN app_users u ON u.id=e.user_id
       WHERE e.course_release_id=$1 AND e.workspace_id=$2 AND e.status<>'erased' ORDER BY e.started_at DESC,e.id LIMIT 100`, [releaseId, release.workspace_id])).rows;
    const bound = resolve ? await resolve(db, release.workspace_id) : null;
    const plan = bound?.runtime.mediaVideo();
    return {
      release: { id: release.id, version: release.version },
      episodes: episodesOf(release),
      enrollments: enrollments.map((e) => ({ id: e.id, name: e.name, status: e.status })),
      provider: plan && bound ? { revision: bound.revision, modelId: plan.modelId, settings: plan.video, pricing: plan.pricing,
        availability: plan.availability, estimateMicroUsd: estimateFor(plan), perJobAllowanceMicroUsd: bound.jobPolicy.allowance.microUsd } : null,
      permissions: { request: adminPermissionMatrix[role]!.includes("release.publish"), review: adminPermissionMatrix[role]!.includes("release.review"),
        attach: adminPermissionMatrix[role]!.includes("release.publish") },
      jobs: await Promise.all(jobs.map((job) => view(db, job))),
      liveGenerationVerified: false,
    };
  }
  async function detail(actor: Actor, jobId: string) {
    const job = await jobRow(db, jobId);
    await permitted(db, actor, job.workspace_id, "run.inspect");
    return view(db, job, true);
  }
  async function review(actor: Actor, jobId: string, raw: unknown) {
    const input = parse(reviewSchema, raw), job0 = await jobRow(db, jobId);
    return mediaCommand(db, actor, job0.workspace_id, "release.review", "media.reviewed", input.idempotencyKey, { jobId, ...input }, async (client) => {
      const job = await jobRow(client, jobId, true);
      requireCondition(job.state === "under_review", "MEDIA_NOT_UNDER_REVIEW", 409);
      const asset = (await client.query("SELECT sha256 FROM media_assets WHERE job_id=$1", [jobId])).rows[0];
      requireCondition(asset && asset.sha256 === input.assetSha256, "MEDIA_ASSET_CHANGED", 409);
      if (input.decision === "approved") {
        // Nothing is approved without a text alternative and caption track.
        requireCondition(input.captionsVtt && validCaptions(input.captionsVtt), "MEDIA_CAPTIONS_REQUIRED", 400);
        requireCondition(input.transcript && input.visualDescription, "MEDIA_TEXT_ALTERNATIVE_REQUIRED", 400);
        requireCondition(Object.values(input.findings).every(Boolean), "MEDIA_REVIEW_FINDINGS_INCOMPLETE", 400);
      }
      const reviewId = randomUUID();
      await client.query(
        `INSERT INTO media_reviews(id,job_id,workspace_id,decision,asset_sha256,captions_vtt,transcript,visual_description,findings,rationale,reviewed_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [reviewId, jobId, job.workspace_id, input.decision, input.assetSha256, input.captionsVtt ?? null, input.transcript ?? null,
          input.visualDescription ?? null, JSON.stringify(input.findings), input.rationale, actor.id]);
      await move(client, job, input.decision, input.decision === "rejected" ? "MEDIA_REVIEW_REJECTED" : null, {}, actor.id);
      return { jobId, reviewId, state: job.state, learnerVisible: false };
    });
  }
  async function attach(actor: Actor, jobId: string, raw: unknown) {
    const input = parse(attachSchema, raw), job0 = await jobRow(db, jobId);
    return mediaCommand(db, actor, job0.workspace_id, "release.publish", "media.attached", input.idempotencyKey, { jobId, ...input }, async (client) => {
      // Publication re-checks the current enrollment policy, deadline and membership (F13).
      const policy = await paidWorkPolicy(client, { workspaceId: job0.workspace_id, enrollmentId: job0.enrollment_id, episodeId: job0.episode_id }, "publish");
      const job = await jobRow(client, jobId, true);
      requireCondition(job.state === "approved", "MEDIA_NOT_APPROVED", 409);
      requireCondition(policy.allowed, "MEDIA_PUBLICATION_DENIED", 409);
      const review = (await client.query("SELECT id,decision,asset_sha256 FROM media_reviews WHERE job_id=$1", [jobId])).rows[0];
      const asset = (await client.query("SELECT sha256 FROM media_assets WHERE job_id=$1", [jobId])).rows[0];
      requireCondition(review?.decision === "approved" && asset?.sha256 === review.asset_sha256, "MEDIA_NOT_APPROVED", 409);
      const expires = Date.parse(input.expiresAt);
      requireCondition(expires > policy.nowMs && expires <= policy.nowMs + 180 * 86_400_000, "MEDIA_EXPIRY_INVALID", 400);
      const attachmentId = randomUUID();
      await client.query(
        "INSERT INTO media_attachments(id,job_id,review_id,workspace_id,enrollment_id,episode_id,expires_at,attached_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [attachmentId, jobId, review.id, job.workspace_id, job.enrollment_id, job.episode_id, input.expiresAt, actor.id]);
      await move(client, job, "attached", null, {}, actor.id);
      return { jobId, attachmentId, episodeId: job.episode_id, state: "attached", optional: true, grantsCredit: false };
    });
  }
  async function revoke(actor: Actor, attachmentId: string, raw: unknown) {
    const input = parse(revokeSchema, raw);
    parse(z.string().uuid(), attachmentId);
    const attachment = (await db.query("SELECT * FROM media_attachments WHERE id=$1", [attachmentId])).rows[0];
    requireCondition(attachment, "MEDIA_ATTACHMENT_NOT_FOUND", 404);
    return mediaCommand(db, actor, attachment.workspace_id, "release.review", "media.revoked", input.idempotencyKey, { attachmentId, ...input }, async (client) => {
      const job = await jobRow(client, attachment.job_id, true);
      const updated = await client.query("UPDATE media_attachments SET revoked_at=clock_timestamp(),revoked_by=$2,revoke_reason=$3 WHERE id=$1 AND revoked_at IS NULL",
        [attachmentId, actor.id, input.reason]);
      requireCondition(updated.rowCount === 1, "MEDIA_ATTACHMENT_ALREADY_REVOKED", 409);
      if (job.state === "attached") await move(client, job, "expired", "MEDIA_REVOKED", {}, actor.id);
      return { attachmentId, jobId: job.id, state: "revoked" };
    });
  }
  async function cancel(actor: Actor, jobId: string, raw: unknown) {
    const input = parse(cancelSchema, raw), job0 = await jobRow(db, jobId);
    return mediaCommand(db, actor, job0.workspace_id, "release.publish", "media.cancelled", input.idempotencyKey, { jobId, ...input }, async (client) => {
      const job = await jobRow(client, jobId, true);
      requireCondition(CANCELLABLE.includes(job.state), "MEDIA_NOT_CANCELLABLE", 409);
      // Local cancellation only: a submitted operation may still run and bill remotely.
      const remote = job.state === "submitted" || ((job.state === "polling" || job.state === "uncertain") && job.provider_operation !== null);
      // An admitted job never reached the provider, so its reservation is released; any later
      // state keeps it (the provider may still run and bill, or already settled it).
      const from = job.state;
      const released = await move(client, job, "cancelled", "MEDIA_CANCELLED", { remote_may_continue: remote, lease_token: null, lease_until: null }, actor.id);
      // Cancelled after the provider may have received it: the hold is final, except that a
      // submission still in flight stays open until it returns (`submit`), since a definite
      // refusal then releases it (`cancelledUnstarted`).
      if (from === "submitted") await holdCharged(client, jobId, "open");
      else if (from === "polling" || from === "uncertain") await holdCharged(client, jobId, "closed");
      return { jobId, state: "cancelled", remoteMayContinue: remote, chargeReleased: released > 0 };
    });
  }

  // ---- Worker: bounded, leased, idempotent. Never resubmits an uncertain operation. ----
  async function leased(client: PoolClient, jobId: string, token: string) {
    return (await client.query<JobRow>("SELECT * FROM media_jobs WHERE id=$1 AND lease_token=$2 FOR UPDATE", [jobId, token])).rows[0];
  }
  async function release(client: PoolClient, jobId: string, nextAt: Date | null) {
    await client.query(`UPDATE media_jobs SET lease_token=NULL,lease_until=NULL${nextAt ? ",next_attempt_at=$2" : ""} WHERE id=$1`, nextAt ? [jobId, nextAt] : [jobId]);
  }
  const backoff = (attempt: number, now: Date) => new Date(now.getTime() + Math.min(config.pollIntervalMs * 2 ** Math.min(attempt, 3), 300_000));
  async function step(jobId: string, token: string, now: Date, clock: () => Date) {
    const initial = await mediaTransaction(db, async (client) => {
      const job = await leased(client, jobId, token);
      if (!job) return null;
      if (IN_FLIGHT.includes(job.state) && now.getTime() >= job.deadline_at.getTime()) {
        const remote = job.state === "submitted" || job.provider_operation !== null, from = job.state;
        await move(client, job, "failed", job.state === "uncertain" ? "MEDIA_OUTCOME_UNKNOWN" : "MEDIA_DEADLINE_REACHED", { remote_may_continue: remote, lease_token: null, lease_until: null });
        if (from !== "admitted") await holdCharged(client, jobId, "closed");
        return null;
      }
      if (job.state === "submitted") {
        // A worker died between recording intent and recording the result: the POST may have been received.
        await move(client, job, "uncertain", "MEDIA_SUBMISSION_INTERRUPTED", { lease_token: null, lease_until: null, next_attempt_at: now });
        return null;
      }
      if (job.state === "uncertain" && !job.provider_operation) {
        // Nothing to poll and no safe way to resubmit. Wait for staff or the deadline.
        await release(client, jobId, job.deadline_at);
        return null;
      }
      if (job.state === "generated") {
        await move(client, job, "under_review", null, { lease_token: null, lease_until: null });
        return null;
      }
      // Jobs of one pass run one after another, so a lease taken at claim time may be mostly
      // spent by now. Each provider step starts with a full lease from the current time.
      const leaseUntil = new Date(clock().getTime() + config.leaseMs);
      await client.query("UPDATE media_jobs SET lease_until=$3 WHERE id=$1 AND lease_token=$2", [jobId, token, leaseUntil]);
      return { ...job, lease_until: leaseUntil };
    });
    if (!initial) return;
    let bound: Awaited<ReturnType<typeof binding>> | null = null;
    try { bound = await binding(db, initial.workspace_id, initial.provider_revision); } catch { bound = null; }
    if (initial.state === "admitted") return submit(initial, token, now, clock, bound);
    return poll(initial, token, now, bound);
  }
  async function submit(job0: JobRow, token: string, now: Date, clock: () => Date, bound: Awaited<ReturnType<typeof binding>> | null) {
    const ready = bound && bound.plan.availability === "ready" && bound.plan.modelId === job0.model_id
      && digestJson(bound.plan.video) === digestJson(job0.settings);
    const go = await mediaTransaction(db, async (client) => {
      // Caps are enforced before dispatch as well as at admission and publication.
      const policy = await paidWorkPolicy(client, { workspaceId: job0.workspace_id, enrollmentId: job0.enrollment_id, episodeId: job0.episode_id }, "admit_job");
      const job = await leased(client, job0.id, token);
      if (!job || job.state !== "admitted") return false;
      if (!policy.allowed) { await move(client, job, "failed", "MEDIA_POLICY_DENIED", { lease_token: null, lease_until: null }); return false; }
      if (!ready) { await move(client, job, "failed", "MEDIA_PROVIDER_UNAVAILABLE", { lease_token: null, lease_until: null }); return false; }
      await move(client, job, "submitted", null, { submit_attempts: job.submit_attempts + 1, submit_started_at: now,
        lease_until: new Date(clock().getTime() + config.leaseMs) });
      return true;
    });
    if (!go) return;
    let outcome: Awaited<ReturnType<MediaRuntime["submitMediaVideo"]>> | undefined, failure: ProviderError | undefined;
    try {
      outcome = await bound!.runtime.submitMediaVideo(job0.script, "media:" + job0.id, AbortSignal.timeout(config.providerCallTimeoutMs));
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError("NETWORK_ERROR", { submission: "unknown" });
    }
    await mediaTransaction(db, async (client) => {
      const job = await leased(client, job0.id, token);
      const operation = outcome?.job ?? failure?.job;
      if (!job || job.state !== "submitted") {
        // Cancelled while the call ran: keep the handle so remote work can be reconciled or audited.
        if (operation) await client.query("UPDATE media_jobs SET provider_operation=COALESCE(provider_operation,$2),provider_operation_id=COALESCE(provider_operation_id,$3),remote_may_continue=true WHERE id=$1",
          [job0.id, JSON.stringify(operation), operationIdOf(operation)]);
        if (!operation && failure && unstarted(failure).definite) await cancelledUnstarted(client, job0.id);
        else if ((await client.query("SELECT 1 FROM media_jobs WHERE id=$1 AND state='cancelled' FOR UPDATE", [job0.id])).rowCount)
          await holdCharged(client, job0.id, "closed");
        return;
      }
      const clear = { lease_token: null, lease_until: null };
      if (outcome) {
        await move(client, job, "polling", null, { ...clear, provider_operation: JSON.stringify(outcome.job), provider_operation_id: operationIdOf(outcome.job),
          next_attempt_at: outcome.state === "completed" ? now : new Date(now.getTime() + config.pollIntervalMs) });
        return;
      }
      const f = failure!, { definite, notSent, refused } = unstarted(f);
      if (f.code === "OPERATION_FAILED" && f.job) {
        await move(client, job, "failed", "MEDIA_PROVIDER_FAILED", { ...clear, provider_operation: JSON.stringify(f.job), provider_operation_id: operationIdOf(f.job) });
        await holdCharged(client, job.id, "closed");
      } else if (!definite) {
        // The provider may have received and run it (unknown outcome, timeout, 5xx, an undocumented
        // or unrecorded refusal): the reservation stays held and the job is never resubmitted.
        await move(client, job, "uncertain", "MEDIA_SUBMISSION_UNCERTAIN", { ...clear, next_attempt_at: now,
          ...(f.job ? { provider_operation: JSON.stringify(f.job), provider_operation_id: operationIdOf(f.job) } : {}) });
      } else if (job.submit_attempts < config.maxSubmitAttempts && (refused ? refused.retryable
        : notSent && ["THROTTLED", "UPSTREAM_UNAVAILABLE", "TIMEOUT", "NETWORK_ERROR"].includes(f.code))) {
        // The provider definitely did not accept it; a bounded retry cannot duplicate work.
        const hinted = refused?.retryAfterMs != null ? now.getTime() + Math.min(refused.retryAfterMs, MAX_RETRY_AFTER_MS) : 0;
        const next = new Date(Math.max(backoff(job.submit_attempts, now).getTime(), hinted));
        await move(client, job, "admitted", "MEDIA_SUBMIT_RETRY", { ...clear, next_attempt_at: next });
      } else {
        // Definitely refused or never sent, with no retry left: nothing ran, so nothing is charged.
        await move(client, job, "failed", "MEDIA_PROVIDER_REJECTED", clear);
        await releaseUnstartedMedia(client, job.id);
      }
    });
  }
  /** A job cancelled while its submission was in flight, which the provider then definitely
   * refused: nothing can run remotely, so the held reservation is released. Only a cancellation
   * made from `submitted` qualifies; one made after the job became uncertain keeps its hold
   * (its ledger row is `uncertain`, which is never released). */
  async function cancelledUnstarted(client: PoolClient, jobId: string) {
    const job = (await client.query<JobRow>("SELECT * FROM media_jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0];
    if (job?.state !== "cancelled" || job.provider_operation !== null) return;
    const last = (await client.query<{ from_state: string }>("SELECT from_state FROM media_job_events WHERE job_id=$1 ORDER BY id DESC LIMIT 1", [jobId])).rows[0];
    if (last?.from_state !== "submitted") return;
    // The cancellation held the row as open `uncertain`; this refusal proves nothing ran. A row
    // already closed (by erasure) is not released again.
    if (await releaseUnstartedMedia(client, jobId, true)) await client.query("UPDATE media_jobs SET remote_may_continue=false WHERE id=$1", [jobId]);
  }
  async function poll(job0: JobRow, token: string, now: Date, bound: Awaited<ReturnType<typeof binding>> | null) {
    const operation = job0.provider_operation!;
    let result: Awaited<ReturnType<MediaRuntime["pollMediaVideo"]>> | undefined, failure: ProviderError | undefined;
    let asset: { bytes: Uint8Array; mimeType: string; byteLength: number } | undefined;
    try {
      if (!bound || bound.plan.availability !== "ready") throw new ProviderError("MISSING_CREDENTIAL");
      result = await bound.runtime.pollMediaVideo(operation, AbortSignal.timeout(config.providerCallTimeoutMs));
      if (result.state === "completed") {
        const uri = result.videos?.[0]?.uri;
        if (!uri) throw new ProviderError("INVALID_RESPONSE");
        asset = await bound.runtime.downloadMediaVideo(result.job, uri, config.maxAssetBytes, AbortSignal.timeout(config.providerCallTimeoutMs));
      }
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError("NETWORK_ERROR", { submission: "unknown" });
    }
    await mediaTransaction(db, async (client) => {
      const job = await leased(client, job0.id, token);
      if (!job || (job.state !== "polling" && job.state !== "uncertain")) return;
      const clear = { lease_token: null, lease_until: null };
      const polls = job.poll_attempts + 1;
      if (failure) {
        const terminal = failure.code === "OPERATION_FAILED" ? "MEDIA_PROVIDER_FAILED"
          : failure.code === "OUTPUT_TOO_LARGE" ? "MEDIA_ASSET_TOO_LARGE"
          : failure.code === "INVALID_RESPONSE" ? "MEDIA_PROVIDER_INVALID_RESPONSE"
          : polls >= config.maxPolls ? "MEDIA_POLL_LIMIT" : null;
        if (terminal) {
          await move(client, job, "failed", terminal, { ...clear, poll_attempts: polls, remote_may_continue: terminal === "MEDIA_POLL_LIMIT" });
          // An oversized download means the provider finished the render; the rest may have run.
          await holdCharged(client, job.id, terminal === "MEDIA_ASSET_TOO_LARGE" ? "completed" : "closed");
        } else await client.query("UPDATE media_jobs SET poll_attempts=$2,next_attempt_at=$3,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [job.id, polls, backoff(polls, now)]);
        return;
      }
      const reconciled = job.state === "uncertain" ? "MEDIA_RECONCILED" : null;
      if (result!.state === "pending") {
        if (polls >= config.maxPolls) {
          await move(client, job, "failed", "MEDIA_POLL_LIMIT", { ...clear, poll_attempts: polls, remote_may_continue: true });
          await holdCharged(client, job.id, "closed");
          return;
        }
        if (job.state === "uncertain") await move(client, job, "polling", reconciled, { ...clear, poll_attempts: polls, next_attempt_at: new Date(now.getTime() + config.pollIntervalMs) });
        else await client.query("UPDATE media_jobs SET poll_attempts=$2,next_attempt_at=$3,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [job.id, polls, new Date(now.getTime() + config.pollIntervalMs)]);
        return;
      }
      const sniffed = sniffVideo(asset!.bytes);
      if (!sniffed || sniffed !== asset!.mimeType || asset!.byteLength !== asset!.bytes.length || asset!.byteLength > config.maxAssetBytes) {
        await move(client, job, "failed", "MEDIA_ASSET_INVALID", { ...clear, poll_attempts: polls });
        await holdCharged(client, job.id, "completed");
        return;
      }
      if (job.state === "uncertain") await move(client, job, "polling", reconciled, { poll_attempts: polls });
      const sha256 = createHash("sha256").update(asset!.bytes).digest("hex");
      await client.query("INSERT INTO media_assets(job_id,workspace_id,sha256,mime_type,byte_length,content) VALUES($1,$2,$3,$4,$5,$6)",
        [job.id, job.workspace_id, sha256, sniffed, asset!.byteLength, Buffer.from(asset!.bytes.buffer, asset!.bytes.byteOffset, asset!.byteLength)]);
      await move(client, job, "generated", null, { poll_attempts: polls, provider_operation: JSON.stringify(result!.job) });
      await settleMediaCost(client, job);
      // A finished render is not a teaching artifact: it waits for staff review.
      await move(client, job, "under_review", null, clear);
    });
  }
  async function expireAttachments(now: Date) {
    await mediaTransaction(db, async (client) => {
      const due = (await client.query<JobRow>(
        `SELECT j.* FROM media_jobs j JOIN media_attachments a ON a.job_id=j.id
         WHERE j.state='attached' AND (a.expires_at<=$1 OR a.revoked_at IS NOT NULL) ORDER BY a.expires_at LIMIT 50 FOR UPDATE OF j SKIP LOCKED`, [now])).rows;
      for (const job of due) await move(client, job, "expired", "MEDIA_ATTACHMENT_EXPIRED");
    });
  }
  /** One bounded pass. Safe to run concurrently from several processes. */
  async function run(input: { now?: Date; limit?: number } = {}) {
    const now = input.now ?? new Date(), limit = Math.max(1, Math.min(input.limit ?? 5, 50)), token = randomUUID();
    // The pass's time (`now`, injectable) advanced by the real time spent since it started.
    const origin = performance.now(), clock = () => new Date(now.getTime() + Math.max(0, performance.now() - origin));
    await expireAttachments(now);
    const claimed = await mediaTransaction(db, async (client) => (await client.query<{ id: string }>(
      `UPDATE media_jobs SET lease_token=$1,lease_until=$2 WHERE id IN (
         SELECT id FROM media_jobs WHERE state=ANY($3::text[]) AND next_attempt_at<=$4 AND (lease_until IS NULL OR lease_until<=$4)
         ORDER BY next_attempt_at,id LIMIT $5 FOR UPDATE SKIP LOCKED) RETURNING id`,
      [token, new Date(now.getTime() + config.leaseMs), WORKER_STATES, now, limit])).rows);
    const runtime = telemetry();
    for (const { id } of claimed) {
      const started = performance.now();
      const state = (await db.query<{ state: string }>("SELECT state FROM media_jobs WHERE id=$1", [id])).rows[0]?.state;
      const stepName = state === "admitted" ? "submit" : "poll";
      try {
        await runtime.span("media.job.step", { "course.media.step": stepName, "course.media.state": state }, () => step(id, token, now, clock));
      } catch { /* The lease expires and a later pass retries; no provider data is logged. */ }
      runtime.record("course.media.step.duration", (performance.now() - started) / 1000, { "course.media.step": stepName, "course.media.state": state });
    }
    return { claimed: claimed.length };
  }

  // ---- Learner and asset access ----
  async function learnerMedia(actor: Actor, enrollmentId: string, episode: string) {
    const enrollment = await enrollmentScope(db, enrollmentId);
    requireCondition(enrollment.user_id === actor.id && enrollment.status !== "erased", "ENROLLMENT_NOT_FOUND", 404);
    await membership(db, actor, enrollment.workspace_id);
    const rows = (await db.query(
      `SELECT a.id,a.expires_at,j.title,j.objective,r.transcript,r.visual_description,r.created_at AS reviewed_at,m.mime_type,m.byte_length
       FROM media_attachments a JOIN media_jobs j ON j.id=a.job_id AND j.state='attached'
       JOIN media_reviews r ON r.id=a.review_id AND r.decision='approved' JOIN media_assets m ON m.job_id=j.id AND m.sha256=r.asset_sha256
       WHERE a.enrollment_id=$1 AND a.workspace_id=$2 AND a.episode_id=$3 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
       ORDER BY a.created_at,a.id LIMIT 5`, [enrollmentId, enrollment.workspace_id, episode])).rows;
    const base = `/api/enrollments/${enrollmentId}/media`;
    return {
      episodeId: episode,
      media: rows.map((r) => ({
        id: r.id, title: r.title, objective: r.objective, generated: true, transcript: r.transcript, visualDescription: r.visual_description,
        mimeType: r.mime_type, byteLength: r.byte_length, assetUrl: `${base}/${r.id}/asset`, captionsUrl: `${base}/${r.id}/captions.vtt`,
        reviewedAt: r.reviewed_at.toISOString(), expiresAt: r.expires_at.toISOString(),
      })),
      optional: true, grantsCredit: false,
    };
  }
  async function learnerAttachment(actor: Actor, enrollmentId: string, attachmentId: string) {
    parse(z.string().uuid(), attachmentId);
    const enrollment = await enrollmentScope(db, enrollmentId);
    requireCondition(enrollment.user_id === actor.id && enrollment.status !== "erased", "ENROLLMENT_NOT_FOUND", 404);
    await membership(db, actor, enrollment.workspace_id);
    const row = (await db.query(
      `SELECT a.job_id,r.captions_vtt FROM media_attachments a JOIN media_jobs j ON j.id=a.job_id AND j.state='attached'
       JOIN media_reviews r ON r.id=a.review_id AND r.decision='approved' JOIN media_assets m ON m.job_id=j.id AND m.sha256=r.asset_sha256
       WHERE a.id=$1 AND a.enrollment_id=$2 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()`, [attachmentId, enrollmentId])).rows[0];
    requireCondition(row, "MEDIA_NOT_FOUND", 404);
    return row as { job_id: string; captions_vtt: string };
  }
  async function staffAsset(actor: Actor, jobId: string) {
    const job = await jobRow(db, jobId);
    await permitted(db, actor, job.workspace_id, "run.inspect");
    return job.id;
  }
  return { estimate, request, list, detail, review, attach, revoke, cancel, run, learnerMedia, learnerAttachment, staffAsset, config };
}
export type MediaJobService = ReturnType<typeof createMediaJobService>;

/** Serves one asset with single-range support so every browser can seek and play it. */
async function sendAsset(db: Database, jobId: string, range: string | undefined, reply: FastifyReply) {
  const meta = (await db.query<{ mime_type: string; byte_length: number; sha256: string }>("SELECT mime_type,byte_length,sha256 FROM media_assets WHERE job_id=$1", [jobId])).rows[0];
  requireCondition(meta, "MEDIA_NOT_FOUND", 404);
  const size = meta.byte_length;
  let start = 0, end = size - 1, partial = false;
  if (range) {
    const match = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
    else { start = Math.max(0, size - Number(match[2])); }
    if (start > end || start >= size) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
    partial = true;
  }
  const length = end - start + 1;
  const chunk = (await db.query<{ part: Buffer }>("SELECT substring(content FROM $2 FOR $3) AS part FROM media_assets WHERE job_id=$1", [jobId, start + 1, length])).rows[0]!.part;
  reply.header("Content-Type", meta.mime_type).header("Accept-Ranges", "bytes").header("Content-Length", String(length))
    .header("ETag", `"${meta.sha256}"`).header("Content-Disposition", "inline");
  if (partial) reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
  return reply.send(chunk);
}

export function registerMediaJobRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, service: MediaJobService) {
  const uuid = { type: "string", format: "uuid" };
  const params = (...names: string[]) => ({ type: "object", additionalProperties: false, required: names, properties: Object.fromEntries(names.map((n) => [n, uuid])) });
  app.get("/api/admin/releases/:releaseId/media-jobs", { schema: { params: params("releaseId") } }, async (request) =>
    service.list(await auth.authenticate(request), (request.params as { releaseId: string }).releaseId));
  app.post("/api/admin/enrollments/:enrollmentId/media-jobs/estimate", { schema: { params: params("enrollmentId") }, bodyLimit: 4096 }, async (request) =>
    service.estimate(await auth.authenticate(request), (request.params as { enrollmentId: string }).enrollmentId, request.body));
  app.post("/api/admin/enrollments/:enrollmentId/media-jobs", { schema: { params: params("enrollmentId") }, bodyLimit: 32768 }, async (request) =>
    service.request(await auth.authenticate(request), (request.params as { enrollmentId: string }).enrollmentId, request.body));
  app.get("/api/admin/media-jobs/:jobId", { schema: { params: params("jobId") } }, async (request) =>
    service.detail(await auth.authenticate(request), (request.params as { jobId: string }).jobId));
  app.get("/api/admin/media-jobs/:jobId/asset", { schema: { params: params("jobId") } }, async (request, reply) => {
    const jobId = await service.staffAsset(await auth.authenticate(request), (request.params as { jobId: string }).jobId);
    return sendAsset(db, jobId, request.headers.range, reply);
  });
  for (const [path, command] of [["review", service.review], ["attach", service.attach], ["cancel", service.cancel]] as const)
    app.post(`/api/admin/media-jobs/:jobId/${path}`, { schema: { params: params("jobId") }, bodyLimit: 262144 }, async (request) =>
      command(await auth.authenticate(request), (request.params as { jobId: string }).jobId, request.body));
  app.post("/api/admin/media-attachments/:attachmentId/revoke", { schema: { params: params("attachmentId") }, bodyLimit: 8192 }, async (request) =>
    service.revoke(await auth.authenticate(request), (request.params as { attachmentId: string }).attachmentId, request.body));
  app.get("/api/enrollments/:enrollmentId/media", {
    schema: { params: params("enrollmentId"), querystring: { type: "object", additionalProperties: false, required: ["episodeId"],
      properties: { episodeId: { type: "string", pattern: "^[a-z][a-z0-9._:-]{0,127}$" } } } },
  }, async (request) => service.learnerMedia(await auth.authenticate(request), (request.params as { enrollmentId: string }).enrollmentId,
    (request.query as { episodeId: string }).episodeId));
  app.get("/api/enrollments/:enrollmentId/media/:attachmentId/asset", { schema: { params: params("enrollmentId", "attachmentId") } }, async (request, reply) => {
    const p = request.params as { enrollmentId: string; attachmentId: string };
    const row = await service.learnerAttachment(await auth.authenticate(request), p.enrollmentId, p.attachmentId);
    return sendAsset(db, row.job_id, request.headers.range, reply);
  });
  app.get("/api/enrollments/:enrollmentId/media/:attachmentId/captions.vtt", { schema: { params: params("enrollmentId", "attachmentId") } }, async (request, reply) => {
    const p = request.params as { enrollmentId: string; attachmentId: string };
    const row = await service.learnerAttachment(await auth.authenticate(request), p.enrollmentId, p.attachmentId);
    return reply.header("Content-Type", "text/vtt; charset=utf-8").send(row.captions_vtt);
  });
}
