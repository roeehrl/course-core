import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { definiteRejection, ProviderError, type CostEstimate, type Json, type MediaCapabilities, type MediaPrice, type OutputSchema, type UsageReceipt, type VideoJob } from "@course-core/providers";
import { MAX_RETRY_AFTER_MS } from "@course-core/supervisor";
import { type Database } from "./database.js";
import { afterCommitTransaction, onCommit } from "./after-commit.js";
import type { Actor, authService } from "./auth.js";
import { ApiError, requireCondition } from "./errors.js";
import { requireSameRequest } from "./erased-digests.js";
import { digestJson } from "./repository.js";
import { adminPermissionMatrix, memberRole, permitRelease, type AdminPermission } from "./course-access.js";
import { chargePaidWork, lockPaidWorkBudgets, paidWorkPolicy, releasePaidWork } from "./supervisor-bridge.js";
import { pricingInForce, recordSpendEvents, type SpendEvent } from "./provider-costs.js";
import { jobPolicySchema, type SupervisorJobPolicy, type WorkspaceProviders } from "./provider-setup.js";
import type { MediaPricing } from "./provider-runtime.js";
import { telemetry } from "./telemetry.js";
import { ERASED_MEDIA_TEXT, redactedOperationSql } from "./media-erasure.js";
import { artifactStore, claimObject, readObjectRange, releaseObject, stageObject, type ObjectMediaType, type StagedObject } from "./artifact-store.js";
import { ClipError, clipFrameTimes, composeClips, exportSceneClip, type ClipToolchain } from "./clip-export.js";
import { fromVisualExperience } from "@course-core/visuals/headless";
import type { CourseManifest } from "@course-core/sdk";
import { referenceStatements, rulesCheck, type CheckFinding, type MediaCandidate, type MediaSources } from "./media-verifier.js";

/** Every durable state of a generated-media job. Only `attached` is learner visible. */
export const MEDIA_STATES = [
  "requested", "admitted", "submitted", "polling", "generated", "under_review",
  "approved", "rejected", "attached", "expired", "failed", "cancelled", "uncertain",
] as const;
export type MediaState = (typeof MEDIA_STATES)[number];
const TRANSITIONS: Record<MediaState, readonly MediaState[]> = {
  requested: ["admitted", "generated", "failed", "cancelled"],
  admitted: ["submitted", "failed", "cancelled"],
  // Back to `admitted` only when the provider definitely did not receive the request.
  // `requested -> generated`: an exact clip or a composition is rendered here, by no provider.
  // `submitted -> generated`: an image comes back in the submission's own response.
  submitted: ["polling", "generated", "uncertain", "admitted", "failed", "cancelled"],
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
/** Paid kinds call a provider under a reservation; renders and compositions call none and cost nothing. */
export const MEDIA_KINDS = ["generated_short_video", "generated_image", "scene_clip", "composed_video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
const RENDERED: readonly string[] = ["scene_clip", "composed_video"];
const VIDEO_KINDS: readonly string[] = ["generated_short_video", "scene_clip", "composed_video"];
/** Wakes every media scheduler (media-scheduler.ts) once the transaction commits. No payload. */
export const MEDIA_CHANNEL = "course_media_jobs";
const notify = (client: PoolClient) => client.query("SELECT pg_notify($1,'')", [MEDIA_CHANNEL]);

/** The subset of the provider runtime this service uses. Tests compose the real
 * runtime from a scripted adapter; nothing here imports a vendor protocol. */
export interface MediaRuntime {
  mediaVideo(): { modelId: string; video: { durationSeconds: number; aspectRatio: string; resolution: string }; pricing: MediaPricing | null; availability: string } | undefined;
  submitMediaVideo(prompt: string, accountingKey: string, signal: AbortSignal): Promise<{ state: "pending" | "completed"; job: VideoJob; videos?: { uri: string; mimeType: string }[] }>;
  pollMediaVideo(job: VideoJob, signal: AbortSignal): Promise<{ state: "pending" | "completed"; job: VideoJob; videos?: { uri: string; mimeType: string }[] }>;
  downloadMediaVideo(job: VideoJob, uri: string, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string; byteLength: number }>;
  /** The adapter's declared capabilities and cost estimate for the bound media model (O08). */
  mediaCapabilities(kind?: "image" | "video"): MediaCapabilities | null;
  estimateMediaCost(price: MediaPrice | null, kind?: "image" | "video"): CostEstimate | null;
  mediaImage(): { modelId: string; image: { aspectRatio?: string; imageSize?: string }; availability: string } | undefined;
  generateMediaImage(prompt: string, accountingKey: string, signal: AbortSignal): Promise<{ images: { mimeType: string; base64: string; byteLength: number }[] }>;
  /** The text model that drafts storyboards or checks media, and one bounded structured call to it. */
  mediaAssistant(purpose: "storyboard" | "check"): { role: "supervisor" | "reviewer"; modelId: string; availability: string } | undefined;
  assistMedia(purpose: "storyboard" | "check", instruction: string, prompt: string, outputSchema: OutputSchema, accountingKey: string, signal: AbortSignal): Promise<{ output: Json; usage: UsageReceipt }>;
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
  /** External tools for exact clips and compositions; absent refuses them with a clear code. */
  clipToolchain?: ClipToolchain | null;
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
    clipToolchain: options.clipToolchain ?? null,
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
const visualId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), shotId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** Optional links every request may carry: the storyboard shot it realizes and a verified scene
 * of the release that the automated check compares it with (F12). */
const links = { storyboardId: z.string().uuid().optional(), shotId: shotId.optional(), referenceVisualId: visualId.optional() };
const requestSchema = z.strictObject({
  episodeId,
  title: text(3, 200),
  objective: text(10, 2000),
  script: text(20, 8000),
  ...links,
  idempotencyKey: key,
});
const imageRequestSchema = z.strictObject({
  episodeId, title: text(3, 200), objective: text(10, 2000),
  /** What the image must show; sent to the provider as the prompt. */
  prompt: text(20, 4000),
  ...links, idempotencyKey: key,
});
const clipRequestSchema = z.strictObject({
  episodeId, title: text(3, 200), objective: text(10, 2000),
  /** What the clip shows, in staff words; the text the automated check compares with. */
  script: text(20, 8000),
  visualId, fromMs: z.number().int().min(0), toMs: z.number().int().min(1), fps: z.number().int().min(1).max(30).default(24),
  width: z.number().int().min(64).max(1280).default(960), format: z.enum(["mp4", "webm"]).default("mp4"), reducedMotion: z.boolean().default(false),
  storyboardId: links.storyboardId, shotId: links.shotId, idempotencyKey: key,
});
const composeSchema = z.strictObject({
  format: z.enum(["mp4", "webm"]).default("mp4"), width: z.number().int().min(64).max(1280).default(1280),
  height: z.number().int().min(64).max(1280).default(720), fps: z.number().int().min(1).max(30).default(24), idempotencyKey: key,
});
/** `kind` picks the image model when one is bound beside a video model; by default the media role's own. */
const estimateSchema = z.strictObject({ episodeId, kind: z.enum(["video", "image"]).optional() });
const findingsSchema = z.strictObject({
  factualAccuracy: z.boolean(),
  labelsAndEquations: z.boolean(),
  captionsMatchNarration: z.boolean(),
  noMisleadingMotion: z.boolean(),
});
const reviewSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  /** For an image, the visual description is its alt text; captions and a transcript do not apply. */
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  captionsVtt: z.string().min(8).max(100_000).optional(),
  /** The caption track's language, a BCP 47 tag such as "en" or "he". */
  captionsLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/).optional(),
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
/** Image signatures for the types an asset may have. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP") return "image/webp";
  return null;
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

export interface JobRow {
  id: string; workspace_id: string; enrollment_id: string; course_release_id: string; episode_id: string; kind: string;
  title: string; objective: string; script: string; provider_revision: number | null; model_id: string;
  settings: Record<string, unknown>; pricing: MediaPricing | null;
  storyboard_id: string | null; shot_id: string | null; reference_visual_id: string | null; source: Record<string, unknown> | null;
  estimate_micro_usd: string | null; charged_micro_usd: string; state: MediaState; failure_code: string | null;
  idempotency_key: string; request_digest: string; provider_operation: VideoJob | null; provider_operation_id: string | null;
  submit_attempts: number; poll_attempts: number; submit_started_at: Date | null; next_attempt_at: Date; deadline_at: Date;
  lease_token: string | null; lease_until: Date | null; remote_may_continue: boolean; requested_by: string;
  created_at: Date; updated_at: Date;
}
/** The non-provider "models" of renders and compositions, recorded as the job's model. */
const SCENE_RENDERER = "core:scene-renderer", CLIP_COMPOSER = "core:clip-composer";
/** One shot of a storyboard (media-pipeline.ts validates the full shape). */
export interface StoryboardShot { id: string; kind: "generated" | "scene"; description: string; narration: string; durationSeconds?: number; visualId?: string; fromMs?: number; toMs?: number }
export const spend = (client: PoolClient, events: SpendEvent[]) => onCommit(client, () => recordSpendEvents(events));
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
/** The shared course-scoped rule on the course of `releaseId` (course-access.ts). */
export const permitted = (client: Database | PoolClient, actor: Actor, workspaceId: string, permission: AdminPermission, releaseId: string) =>
  permitRelease(client, actor, { id: releaseId, workspace_id: workspaceId }, permission);
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
  // Schedulers wake for work they can now do (a submission, a poll, a review step) or an expiry to watch.
  if (WORKER_STATES.includes(to) || to === "attached") await notify(client);
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
export function unstarted(failure: ProviderError) {
  const notSent = failure.submission === "not_sent" && !failure.usage?.attempts.length;
  const refused = notSent ? null : definiteRejection(failure);
  return { definite: notSent || refused !== null, notSent, refused };
}
export interface ReleaseEpisodes { server_bundle: { chapters: { episodes: { id: string; title: string }[] }[]; visuals?: CourseManifest["visuals"] } }
export const episodesOf = (release: ReleaseEpisodes) => release.server_bundle.chapters.flatMap((c) => c.episodes.map((e) => ({ id: e.id, title: e.title })));
/** The release's visuals, which passed the renderer's check when the release was published. */
export function visualsOf(release: ReleaseEpisodes) {
  return (release.server_bundle.visuals ?? []).flatMap((visual) => {
    try { const scene = fromVisualExperience(visual); return [{ id: visual.id, title: scene.title, durationMs: scene.timeline.durationMs, visual }]; }
    catch { return []; }
  }).slice(0, 200);
}
/** The bound media model as one plan: its fixed settings, price, adapter-declared capabilities
 * and the adapter's estimate for one job (O08). Core never computes a price itself. */
export interface MediaPlan {
  kind: "video" | "image"; modelId: string; settings: Record<string, unknown>; pricing: MediaPricing | null; availability: string;
  capabilities: MediaCapabilities | null; estimate: CostEstimate | null;
}
const priceOf = (kind: "video" | "image", pricing: MediaPricing | null): MediaPrice | null => !pricing ? null
  : kind === "video" ? { microUsdPerOutputSecond: pricing.microUsdPerOutputSecond, microUsdPerRequest: pricing.microUsdPerRequest ?? null, pricingVersionId: pricing.pricingVersionId ?? null }
  : { microUsdPerRequest: pricing.microUsdPerRequest ?? null, pricingVersionId: pricing.pricingVersionId ?? null };
function planOf(runtime: MediaRuntime, kind: "video" | "image"): MediaPlan | null {
  const video = kind === "video" ? runtime.mediaVideo() : undefined, image = kind === "image" ? runtime.mediaImage() : undefined;
  const base = video ? { modelId: video.modelId, settings: video.video as Record<string, unknown>, pricing: video.pricing, availability: video.availability }
    : image ? { modelId: image.modelId, settings: image.image as Record<string, unknown>, pricing: null, availability: image.availability } : null;
  if (!base) return null;
  return { kind, ...base, capabilities: runtime.mediaCapabilities(kind), estimate: runtime.estimateMediaCost(priceOf(kind, base.pricing), kind) };
}
function withPricing(runtime: MediaRuntime, plan: MediaPlan, pricing: MediaPricing): MediaPlan {
  return { ...plan, pricing, estimate: runtime.estimateMediaCost(priceOf(plan.kind, pricing), plan.kind) };
}
const estimateFor = (plan: MediaPlan) => plan.estimate?.microUsd ?? null;
/** A provider that deletes its output (Veo: after 2 days) bounds how long a job may wait to fetch it. */
const retentionBoundMs = (plan: MediaPlan) => plan.capabilities?.retention.outputHours ? plan.capabilities.retention.outputHours * 3_600_000 - 3_600_000 : Infinity;
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

/** What a job's media must agree with: its script, its storyboard shot (every shot for a
 * composition) and, when linked, the statements of a verified reference scene of the release. */
export async function mediaSources(client: Database | PoolClient, job: Pick<JobRow, "script" | "storyboard_id" | "shot_id" | "reference_visual_id" | "course_release_id" | "kind">): Promise<MediaSources> {
  let shot: string | null = null, reference: string[] | null = null;
  if (job.storyboard_id) {
    const shots = (await client.query<{ shots: StoryboardShot[] }>("SELECT shots FROM media_storyboards WHERE id=$1", [job.storyboard_id])).rows[0]?.shots ?? [];
    const relevant = job.kind === "composed_video" ? shots : shots.filter((s) => s.id === job.shot_id);
    shot = relevant.map((s) => [s.description, s.narration].filter(Boolean).join("\n")).join("\n") || null;
  }
  if (job.reference_visual_id) {
    const release = (await client.query<ReleaseEpisodes>("SELECT server_bundle FROM course_releases WHERE id=$1", [job.course_release_id])).rows[0];
    const visual = release ? visualsOf(release).find((v) => v.id === job.reference_visual_id) : undefined;
    reference = visual ? referenceStatements(visual.visual) : null;
  }
  return { script: job.script, shot, reference };
}
/** The exact text alternative a check or a review is about. */
export const candidateDigest = (candidate: MediaCandidate) =>
  digestJson({ transcript: candidate.transcript ?? null, visualDescription: candidate.visualDescription ?? null, captionsVtt: candidate.captionsVtt ?? null });
const CONTRADICTIONS: readonly string[] = ["QUANTITY_CONTRADICTED", "CLAIM_CONTRADICTED"];
/** Runs the rules check and reads earlier checks of the same asset and text. */
async function automaticCheck(client: PoolClient, job: JobRow, sha256: string, candidate: MediaCandidate) {
  const rules = rulesCheck(await mediaSources(client, job), candidate);
  const prior = (await client.query<{ findings: CheckFinding[] }>(
    "SELECT findings FROM media_checks WHERE job_id=$1 AND asset_sha256=$2 AND input_digest=$3 AND verdict='contradicted' ORDER BY created_at DESC LIMIT 5",
    [job.id, sha256, candidateDigest(candidate)])).rows;
  const findings = [...rules.findings, ...prior.flatMap((row) => row.findings)].filter((f) => CONTRADICTIONS.includes(f.code)).slice(0, 20);
  return { contradicted: rules.verdict === "contradicted" || prior.length > 0, findings };
}

/** Media command idempotency: a retried key replays; the same key with different input conflicts. */
async function mediaCommand<T>(db: Database, actor: Actor, workspaceId: string, releaseId: string, permission: AdminPermission, operation: string,
  idempotencyKey: string, semantic: unknown, execute: (client: PoolClient) => Promise<T>): Promise<T> {
  return afterCommitTransaction(db, async (client) => {
    await permitted(client, actor, workspaceId, permission, releaseId);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-command:" + workspaceId + ":" + idempotencyKey]);
    const digest = digestJson({ actorId: actor.id, operation, semantic });
    const old = (await client.query("SELECT request_digest,response FROM media_command_receipts WHERE workspace_id=$1 AND idempotency_key=$2", [workspaceId, idempotencyKey])).rows[0];
    if (old) {
      requireSameRequest(old.request_digest, digest, "IDEMPOTENCY_CONFLICT");
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
  async function enrollmentScope(client: Database | PoolClient, enrollmentId: string, share = false) {
    parse(z.string().uuid(), enrollmentId);
    const row = (await client.query<{ id: string; workspace_id: string; course_release_id: string; status: string; user_id: string }>(
      `SELECT id,workspace_id,course_release_id,status,user_id FROM enrollments WHERE id=$1${share ? " FOR SHARE" : ""}`, [enrollmentId])).rows[0];
    requireCondition(row, "ENROLLMENT_NOT_FOUND", 404);
    return row;
  }
  /** The bound media plan of `kind`, or of the media role's own model (the video model when an
   * image model is bound beside it). */
  async function binding(client: Database | PoolClient, workspaceId: string, revision?: number, kind?: "video" | "image") {
    const bound = resolve ? await resolve(client, workspaceId, revision) : null;
    requireCondition(bound, "MEDIA_PROVIDER_UNCONFIGURED", 409);
    const plan = planOf(bound.runtime, kind ?? (bound.runtime.mediaVideo() ? "video" : "image"));
    requireCondition(plan, "MEDIA_CAPABILITY_MISSING", 409);
    const versioned = await versionedPricing(client, workspaceId, plan.modelId);
    return { ...bound, plan: versioned ? withPricing(bound.runtime, plan, versioned) : plan };
  }
  /** What is left under every ceiling, including the learner's per-day and per-lesson limits
   * (media for this lesson counts toward them like supervisor work, requirement B09). */
  async function budgets(client: PoolClient, workspaceId: string, enrollmentId: string, episodeId: string) {
    return lockPaidWorkBudgets(client, { workspaceId, enrollmentId, episodeId });
  }

  /** Read-only preview: what one job would cost and whether it would be admitted now. */
  async function estimate(actor: Actor, enrollmentId: string, raw: unknown) {
    const input = parse(estimateSchema, raw);
    return afterCommitTransaction(db, async (client) => {
      const enrollment = await enrollmentScope(client, enrollmentId);
      await permitted(client, actor, enrollment.workspace_id, "release.publish", enrollment.course_release_id);
      const release = (await client.query<ReleaseEpisodes>("SELECT server_bundle FROM course_releases WHERE id=$1", [enrollment.course_release_id])).rows[0]!;
      requireCondition(episodesOf(release).some((e) => e.id === input.episodeId), "MEDIA_EPISODE_OUT_OF_SCOPE", 409);
      const bound = await binding(client, enrollment.workspace_id, undefined, input.kind);
      const estimateMicroUsd = estimateFor(bound.plan), reserve = bound.jobPolicy.allowance.microUsd;
      const policy = await paidWorkPolicy(client, { workspaceId: enrollment.workspace_id, enrollmentId, episodeId: input.episodeId }, "admit_job");
      const available = await budgets(client, enrollment.workspace_id, enrollmentId, input.episodeId);
      const reason = bound.plan.availability !== "ready" ? "MEDIA_PROVIDER_UNAVAILABLE"
        : estimateMicroUsd === null ? "MEDIA_PRICING_UNAVAILABLE"
        : !policy.allowed ? "MEDIA_POLICY_DENIED"
        : estimateMicroUsd > reserve ? "MEDIA_PER_JOB_LIMIT"
        : available.microUsd < reserve ? "MEDIA_BUDGET_EXHAUSTED" : null;
      return {
        episodeId: input.episodeId, providerRevision: bound.revision, modelId: bound.plan.modelId, settings: bound.plan.settings, kind: bound.plan.kind,
        capabilities: bound.plan.capabilities, units: bound.plan.estimate?.units ?? null,
        pricing: bound.plan.pricing, estimateMicroUsd, reserveMicroUsd: reserve, availableMicroUsd: available.microUsd,
        admissible: reason === null, reason, chargedAtAdmission: "full_per_job_allowance" as const, grantsCredit: false,
      };
    });
  }

  /** A storyboard shot must belong to an approved storyboard of this enrollment's episode and be of
   * the requested kind; a reference must be a visual of the release. Returns the reference to check against. */
  async function checkLinks(client: PoolClient, enrollmentId: string, episode: string, release: ReleaseEpisodes,
    input: { storyboardId?: string | undefined; shotId?: string | undefined; referenceVisualId?: string | undefined }, shotKind: "generated" | "scene") {
    if (input.referenceVisualId) requireCondition(visualsOf(release).some((v) => v.id === input.referenceVisualId), "MEDIA_REFERENCE_NOT_FOUND", 409);
    if (!input.storyboardId) { requireCondition(!input.shotId, "INVALID_INPUT", 400); return { reference: input.referenceVisualId ?? null, shot: null }; }
    const board = (await client.query<{ state: string; episode_id: string; shots: StoryboardShot[]; reference_visual_id: string | null }>(
      "SELECT state,episode_id,shots,reference_visual_id FROM media_storyboards WHERE id=$1 AND enrollment_id=$2 FOR SHARE", [input.storyboardId, enrollmentId])).rows[0];
    requireCondition(board, "MEDIA_STORYBOARD_NOT_FOUND", 404);
    requireCondition(board.state === "approved", "MEDIA_STORYBOARD_NOT_APPROVED", 409);
    requireCondition(board.episode_id === episode, "MEDIA_EPISODE_OUT_OF_SCOPE", 409);
    const shot = input.shotId ? board.shots.find((s) => s.id === input.shotId) ?? null : null;
    requireCondition(!input.shotId || shot?.kind === shotKind, "MEDIA_STORYBOARD_SHOT_MISMATCH", 409);
    return { reference: input.referenceVisualId ?? board.reference_visual_id, shot };
  }
  /** A generated clip (the staff script is the prompt) or a generated image (the staff prompt). */
  async function admit(actor: Actor, enrollmentId: string, kind: "generated_short_video" | "generated_image",
    input: z.infer<typeof requestSchema>) {
    const media = kind === "generated_image" ? "image" : "video";
    return afterCommitTransaction(db, async (client) => {
      // Shared with other requests, exclusive with erasure (which locks the enrollment first): a
      // job is either in place for erasure to redact, or never written for an erased learner.
      const enrollment = await enrollmentScope(client, enrollmentId, true);
      await permitted(client, actor, enrollment.workspace_id, "release.publish", enrollment.course_release_id);
      requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-request:" + enrollment.workspace_id + ":" + input.idempotencyKey]);
      const { idempotencyKey: _key, ...semantic } = input;
      const digest = digestJson({ actorId: actor.id, enrollmentId, ...(kind === "generated_image" ? { kind } : {}), ...semantic });
      const existing = (await client.query<JobRow>("SELECT * FROM media_jobs WHERE workspace_id=$1 AND idempotency_key=$2", [enrollment.workspace_id, input.idempotencyKey])).rows[0];
      if (existing) {
        requireSameRequest(existing.request_digest, digest, "IDEMPOTENCY_CONFLICT");
        return view(client, existing);
      }
      const release = (await client.query<ReleaseEpisodes>("SELECT server_bundle FROM course_releases WHERE id=$1", [enrollment.course_release_id])).rows[0]!;
      requireCondition(episodesOf(release).some((e) => e.id === input.episodeId), "MEDIA_EPISODE_OUT_OF_SCOPE", 409);
      const linked = await checkLinks(client, enrollmentId, input.episodeId, release, input, "generated");
      const bound = await binding(client, enrollment.workspace_id, undefined, media);
      requireCondition(bound.plan.availability === "ready", "MEDIA_PROVIDER_UNAVAILABLE", 409);
      requireCondition(input.script.length <= (bound.plan.capabilities?.maxPromptCharacters ?? Infinity), "MEDIA_PROMPT_TOO_LONG", 400);
      const estimateMicroUsd = estimateFor(bound.plan);
      requireCondition(estimateMicroUsd !== null, "MEDIA_PRICING_UNAVAILABLE", 409);
      // Lock order: enrollment -> membership -> release -> policy -> job -> workspace budget -> enrollment budget.
      const policy = await paidWorkPolicy(client, { workspaceId: enrollment.workspace_id, enrollmentId, episodeId: input.episodeId }, "admit_job");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-admission:" + enrollment.workspace_id]);
      const job: JobRow = (await client.query<JobRow>(
        `INSERT INTO media_jobs(id,workspace_id,enrollment_id,course_release_id,episode_id,kind,title,objective,script,provider_revision,model_id,settings,pricing,
           estimate_micro_usd,state,idempotency_key,request_digest,deadline_at,requested_by,storyboard_id,shot_id,reference_visual_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'requested',$15,$16,clock_timestamp()+($17*interval '1 millisecond'),$18,$19,$20,$21) RETURNING *`,
        [randomUUID(), enrollment.workspace_id, enrollmentId, enrollment.course_release_id, input.episodeId, kind, input.title, input.objective, input.script,
          bound.revision, bound.plan.modelId, JSON.stringify(bound.plan.settings), JSON.stringify(bound.plan.pricing), estimateMicroUsd,
          input.idempotencyKey, digest, config.jobDurationMs, actor.id, input.storyboardId ?? null, input.shotId ?? null, linked.reference])).rows[0]!;
      await client.query("INSERT INTO media_job_events(job_id,from_state,to_state,code,actor_id) VALUES($1,NULL,'requested',NULL,$2)", [job.id, actor.id]);
      const reserve = bound.jobPolicy.allowance.microUsd;
      const active = Number((await client.query("SELECT count(*) FROM media_jobs WHERE workspace_id=$1 AND state=ANY($2::text[])", [enrollment.workspace_id, IN_FLIGHT])).rows[0].count);
      const available = await budgets(client, enrollment.workspace_id, enrollmentId, input.episodeId);
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
      await client.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,model_id,state,reserved_micro_usd,reserved_tokens,charged_micro_usd,episode_id)
        VALUES($1,'media',$2,1,$3,$4,'media',$5,'reserved',$6,0,$6,$7)`, [randomUUID(), job.id, enrollment.workspace_id, enrollmentId, bound.plan.modelId, reserve, input.episodeId]);
      spend(client, [{ kind: "reserved", role: "media", microUsd: reserve, modelId: bound.plan.modelId, basis: "reserved_ceiling" }]);
      // A provider that deletes its output after a while (O08 retention) also bounds the deadline.
      const deadlineMs = Math.min(policy.nowMs + config.jobDurationMs, policy.nowMs + retentionBoundMs(bound.plan), policy.effectiveDeadlineMs ?? Infinity);
      await move(client, job, "admitted", null, { charged_micro_usd: reserve, deadline_at: new Date(deadlineMs).toISOString(), next_attempt_at: new Date(policy.nowMs).toISOString() }, actor.id);
      return view(client, (await client.query<JobRow>("SELECT * FROM media_jobs WHERE id=$1", [job.id])).rows[0]!);
    });
  }
  const request = (actor: Actor, enrollmentId: string, raw: unknown) => admit(actor, enrollmentId, "generated_short_video", parse(requestSchema, raw));
  function requestImage(actor: Actor, enrollmentId: string, raw: unknown) {
    const { prompt, ...input } = parse(imageRequestSchema, raw);
    return admit(actor, enrollmentId, "generated_image", { ...input, script: prompt });
  }
  /** An exact clip of a verified scene of the release. No provider, no charge; a worker renders it. */
  async function requestClip(actor: Actor, enrollmentId: string, raw: unknown) {
    const input = parse(clipRequestSchema, raw);
    return afterCommitTransaction(db, async (client) => {
      const enrollment = await enrollmentScope(client, enrollmentId, true);
      await permitted(client, actor, enrollment.workspace_id, "release.publish", enrollment.course_release_id);
      requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-request:" + enrollment.workspace_id + ":" + input.idempotencyKey]);
      const { idempotencyKey: _key, ...semantic } = input;
      const digest = digestJson({ actorId: actor.id, enrollmentId, kind: "scene_clip", ...semantic });
      const existing = (await client.query<JobRow>("SELECT * FROM media_jobs WHERE workspace_id=$1 AND idempotency_key=$2", [enrollment.workspace_id, input.idempotencyKey])).rows[0];
      if (existing) {
        requireSameRequest(existing.request_digest, digest, "IDEMPOTENCY_CONFLICT");
        return view(client, existing);
      }
      requireCondition(config.clipToolchain, "MEDIA_CLIP_TOOLCHAIN_MISSING", 409);
      const release = (await client.query<ReleaseEpisodes>("SELECT server_bundle FROM course_releases WHERE id=$1", [enrollment.course_release_id])).rows[0]!;
      requireCondition(episodesOf(release).some((e) => e.id === input.episodeId), "MEDIA_EPISODE_OUT_OF_SCOPE", 409);
      const visual = visualsOf(release).find((v) => v.id === input.visualId);
      requireCondition(visual, "MEDIA_REFERENCE_NOT_FOUND", 409);
      try { clipFrameTimes(visual.durationMs, input); } catch { requireCondition(false, "MEDIA_CLIP_RANGE_INVALID", 400); }
      const linked = await checkLinks(client, enrollmentId, input.episodeId, release, input, "scene");
      requireCondition(!linked.shot || linked.shot.visualId === input.visualId, "MEDIA_STORYBOARD_SHOT_MISMATCH", 409);
      const source = { visualId: input.visualId, fromMs: input.fromMs, toMs: input.toMs, fps: input.fps, width: input.width, format: input.format, reducedMotion: input.reducedMotion };
      const job = (await client.query<JobRow>(
        `INSERT INTO media_jobs(id,workspace_id,enrollment_id,course_release_id,episode_id,kind,title,objective,script,provider_revision,model_id,settings,pricing,
           estimate_micro_usd,state,idempotency_key,request_digest,deadline_at,requested_by,storyboard_id,shot_id,reference_visual_id,source)
         VALUES($1,$2,$3,$4,$5,'scene_clip',$6,$7,$8,NULL,$9,$10,NULL,0,'requested',$11,$12,clock_timestamp()+($13*interval '1 millisecond'),$14,$15,$16,$17,$18) RETURNING *`,
        [randomUUID(), enrollment.workspace_id, enrollmentId, enrollment.course_release_id, input.episodeId, input.title, input.objective, input.script,
          SCENE_RENDERER, JSON.stringify(source), input.idempotencyKey, digest, config.jobDurationMs, actor.id, input.storyboardId ?? null, input.shotId ?? null,
          input.visualId, JSON.stringify(source)])).rows[0]!;
      await client.query("INSERT INTO media_job_events(job_id,from_state,to_state,code,actor_id) VALUES($1,NULL,'requested',NULL,$2)", [job.id, actor.id]);
      await notify(client);
      return view(client, job);
    });
  }
  /** One clip joining the approved clips of every shot of an approved storyboard, in shot order. */
  async function compose(actor: Actor, storyboardId: string, raw: unknown) {
    const input = parse(composeSchema, raw);
    parse(z.string().uuid(), storyboardId);
    const board0 = (await db.query<{ workspace_id: string; course_release_id: string }>("SELECT workspace_id,course_release_id FROM media_storyboards WHERE id=$1", [storyboardId])).rows[0];
    requireCondition(board0, "MEDIA_STORYBOARD_NOT_FOUND", 404);
    return afterCommitTransaction(db, async (client) => {
      await permitted(client, actor, board0.workspace_id, "release.publish", board0.course_release_id);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["media-request:" + board0.workspace_id + ":" + input.idempotencyKey]);
      const digest = digestJson({ actorId: actor.id, storyboardId, kind: "composed_video", format: input.format, width: input.width, height: input.height, fps: input.fps });
      const existing = (await client.query<JobRow>("SELECT * FROM media_jobs WHERE workspace_id=$1 AND idempotency_key=$2", [board0.workspace_id, input.idempotencyKey])).rows[0];
      if (existing) {
        requireSameRequest(existing.request_digest, digest, "IDEMPOTENCY_CONFLICT");
        return view(client, existing);
      }
      requireCondition(config.clipToolchain, "MEDIA_CLIP_TOOLCHAIN_MISSING", 409);
      const board = (await client.query<{ id: string; enrollment_id: string; episode_id: string; title: string; objective: string; script: string; state: string;
        shots: StoryboardShot[]; reference_visual_id: string | null }>("SELECT * FROM media_storyboards WHERE id=$1 FOR SHARE", [storyboardId])).rows[0]!;
      requireCondition(board.state === "approved", "MEDIA_STORYBOARD_NOT_APPROVED", 409);
      const enrollment = await enrollmentScope(client, board.enrollment_id, true);
      requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      // Each shot needs an approved clip (generated or exact) whose asset is the one approved.
      const approved = (await client.query<{ id: string; shot_id: string; sha256: string }>(
        `SELECT DISTINCT ON (j.shot_id) j.id,j.shot_id,a.sha256 FROM media_jobs j JOIN media_assets a ON a.job_id=j.id
           JOIN media_reviews r ON r.job_id=j.id AND r.decision='approved' AND r.asset_sha256=a.sha256
         WHERE j.storyboard_id=$1 AND j.kind IN ('generated_short_video','scene_clip') AND j.state IN ('approved','attached')
         ORDER BY j.shot_id, r.created_at DESC`, [storyboardId])).rows;
      const parts = board.shots.map((shot) => approved.find((row) => row.shot_id === shot.id));
      requireCondition(parts.every(Boolean), "MEDIA_COMPOSITION_INCOMPLETE", 409, );
      const source = { storyboardId, parts: parts.map((p) => ({ jobId: p!.id, sha256: p!.sha256 })), format: input.format, width: input.width, height: input.height, fps: input.fps };
      const job = (await client.query<JobRow>(
        `INSERT INTO media_jobs(id,workspace_id,enrollment_id,course_release_id,episode_id,kind,title,objective,script,provider_revision,model_id,settings,pricing,
           estimate_micro_usd,state,idempotency_key,request_digest,deadline_at,requested_by,storyboard_id,reference_visual_id,source)
         VALUES($1,$2,$3,$4,$5,'composed_video',$6,$7,$8,NULL,$9,$10,NULL,0,'requested',$11,$12,clock_timestamp()+($13*interval '1 millisecond'),$14,$15,$16,$17) RETURNING *`,
        [randomUUID(), board0.workspace_id, board.enrollment_id, board0.course_release_id, board.episode_id, board.title, board.objective, board.script,
          CLIP_COMPOSER, JSON.stringify({ format: input.format, width: input.width, height: input.height, fps: input.fps }), input.idempotencyKey, digest,
          config.jobDurationMs, actor.id, storyboardId, board.reference_visual_id, JSON.stringify(source)])).rows[0]!;
      await client.query("INSERT INTO media_job_events(job_id,from_state,to_state,code,actor_id) VALUES($1,NULL,'requested',NULL,$2)", [job.id, actor.id]);
      await notify(client);
      return view(client, job);
    });
  }

  async function jobRow(client: Database | PoolClient, jobId: string, lock = false) {
    parse(z.string().uuid(), jobId);
    const row = (await client.query<JobRow>(`SELECT * FROM media_jobs WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [jobId])).rows[0];
    requireCondition(row, "MEDIA_JOB_NOT_FOUND", 404);
    return row;
  }
  async function view(client: Database | PoolClient, job: JobRow, detail = false) {
    const asset = (await client.query("SELECT sha256,mime_type,byte_length,created_at,provenance FROM media_assets WHERE job_id=$1", [job.id])).rows[0];
    const checks = detail ? (await client.query("SELECT id,asset_sha256,input_digest,verifier,verdict,findings,reference_visual_id,model_id,created_at FROM media_checks WHERE job_id=$1 ORDER BY created_at DESC,id LIMIT 20", [job.id])).rows : undefined;
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
      storyboardId: job.storyboard_id, shotId: job.shot_id, referenceVisualId: job.reference_visual_id, source: job.source,
      paid: !RENDERED.includes(job.kind),
      estimateMicroUsd: job.estimate_micro_usd === null ? null : Number(job.estimate_micro_usd), chargedMicroUsd: Number(job.charged_micro_usd),
      providerOperationId: job.provider_operation_id, remoteMayContinue: job.remote_may_continue,
      submitAttempts: job.submit_attempts, pollAttempts: job.poll_attempts,
      deadlineAt: new Date(job.deadline_at).toISOString(), createdAt: new Date(job.created_at).toISOString(), updatedAt: new Date(job.updated_at).toISOString(),
      asset: asset ? { sha256: asset.sha256, mimeType: asset.mime_type, byteLength: asset.byte_length, createdAt: asset.created_at.toISOString(), provenance: asset.provenance ?? null } : null,
      ...(checks ? { checks: checks.map((c) => ({ id: c.id, assetSha256: c.asset_sha256, inputDigest: c.input_digest, verifier: c.verifier, verdict: c.verdict,
        findings: c.findings, referenceVisualId: c.reference_visual_id, modelId: c.model_id, at: c.created_at.toISOString() })) } : {}),
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
    const role = await permitted(db, actor, release.workspace_id, "run.inspect", release.id);
    const jobs = (await db.query<JobRow>("SELECT * FROM media_jobs WHERE course_release_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id LIMIT 100", [releaseId, release.workspace_id])).rows;
    const enrollments = (await db.query(
      `SELECT e.id,u.display_name AS name,e.status FROM enrollments e JOIN app_users u ON u.id=e.user_id
       WHERE e.course_release_id=$1 AND e.workspace_id=$2 AND e.status<>'erased' ORDER BY e.started_at DESC,e.id LIMIT 100`, [releaseId, release.workspace_id])).rows;
    const bound = resolve ? await resolve(db, release.workspace_id) : null;
    const priced = async (found: MediaPlan | null) => {
      const versioned = found ? await versionedPricing(db, release.workspace_id, found.modelId) : null;
      return found && versioned ? withPricing(bound!.runtime, found, versioned) : found;
    };
    const video = bound ? await priced(planOf(bound.runtime, "video")) : null, image = bound ? await priced(planOf(bound.runtime, "image")) : null;
    // The media role's own model first; an image model bound beside a video model second.
    const plan = video ?? image, imagePlan = video ? image : null;
    const providerView = (p: MediaPlan) => ({ revision: bound!.revision, kind: p.kind, modelId: p.modelId, settings: p.settings, pricing: p.pricing,
      availability: p.availability, estimateMicroUsd: estimateFor(p), units: p.estimate?.units ?? null, capabilities: p.capabilities,
      perJobAllowanceMicroUsd: bound!.jobPolicy.allowance.microUsd });
    return {
      release: { id: release.id, version: release.version },
      episodes: episodesOf(release),
      // Verified scenes of this release that exact clips can be rendered from, and that checks can use as a reference.
      visuals: visualsOf(release).map((v) => ({ id: v.id, title: v.title, durationMs: v.durationMs })),
      clipRendering: config.clipToolchain ? "ready" : "toolchain_missing",
      enrollments: enrollments.map((e) => ({ id: e.id, name: e.name, status: e.status })),
      provider: plan && bound ? providerView(plan) : null,
      imageProvider: imagePlan && bound ? providerView(imagePlan) : null,
      permissions: { request: adminPermissionMatrix[role]!.includes("release.publish"), review: adminPermissionMatrix[role]!.includes("release.review"),
        attach: adminPermissionMatrix[role]!.includes("release.publish") },
      jobs: await Promise.all(jobs.map((job) => view(db, job))),
      liveGenerationVerified: false,
    };
  }
  async function detail(actor: Actor, jobId: string) {
    const job = await jobRow(db, jobId);
    await permitted(db, actor, job.workspace_id, "run.inspect", job.course_release_id);
    return view(db, job, true);
  }
  async function review(actor: Actor, jobId: string, raw: unknown) {
    const input = parse(reviewSchema, raw), job0 = await jobRow(db, jobId);
    return mediaCommand(db, actor, job0.workspace_id, job0.course_release_id, "release.review", "media.reviewed", input.idempotencyKey, { jobId, ...input }, async (client) => {
      const job = await jobRow(client, jobId, true);
      requireCondition(job.state === "under_review", "MEDIA_NOT_UNDER_REVIEW", 409);
      const asset = (await client.query("SELECT sha256 FROM media_assets WHERE job_id=$1", [jobId])).rows[0];
      requireCondition(asset && asset.sha256 === input.assetSha256, "MEDIA_ASSET_CHANGED", 409);
      if (input.decision === "approved") {
        if (VIDEO_KINDS.includes(job.kind)) {
          // Nothing is approved without a text alternative and caption track.
          requireCondition(input.captionsVtt && validCaptions(input.captionsVtt), "MEDIA_CAPTIONS_REQUIRED", 400);
          requireCondition(input.transcript && input.visualDescription, "MEDIA_TEXT_ALTERNATIVE_REQUIRED", 400);
        } else {
          // An image's visual description is its alt text; a caption track or transcript does not apply.
          requireCondition(input.visualDescription, "MEDIA_TEXT_ALTERNATIVE_REQUIRED", 400);
          requireCondition(!input.captionsVtt && !input.transcript, "INVALID_INPUT", 400);
        }
        requireCondition(Object.values(input.findings).every(Boolean), "MEDIA_REVIEW_FINDINGS_INCOMPLETE", 400);
        // The automated check (O09, F12): what the reviewer says the media shows and says must not
        // contradict its script, storyboard shot or reference scene, and no earlier check of this
        // exact asset and text may have found a contradiction.
        const checked = await automaticCheck(client, job, asset.sha256, input);
        if (checked.contradicted) throw new ApiError(409, "MEDIA_FACTUAL_CHECK_FAILED", "MEDIA_FACTUAL_CHECK_FAILED", { findings: checked.findings });
      }
      const reviewId = randomUUID();
      await client.query(
        `INSERT INTO media_reviews(id,job_id,workspace_id,decision,asset_sha256,captions_vtt,transcript,visual_description,findings,rationale,reviewed_by,captions_language)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [reviewId, jobId, job.workspace_id, input.decision, input.assetSha256, input.captionsVtt ?? null, input.transcript ?? null,
          input.visualDescription ?? null, JSON.stringify(input.findings), input.rationale, actor.id, input.captionsVtt ? input.captionsLanguage ?? null : null]);
      await move(client, job, input.decision, input.decision === "rejected" ? "MEDIA_REVIEW_REJECTED" : null, {}, actor.id);
      return { jobId, reviewId, state: job.state, learnerVisible: false };
    });
  }
  async function attach(actor: Actor, jobId: string, raw: unknown) {
    const input = parse(attachSchema, raw), job0 = await jobRow(db, jobId);
    return mediaCommand(db, actor, job0.workspace_id, job0.course_release_id, "release.publish", "media.attached", input.idempotencyKey, { jobId, ...input }, async (client) => {
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
    const attachment = (await db.query("SELECT a.*,j.course_release_id FROM media_attachments a JOIN media_jobs j ON j.id=a.job_id WHERE a.id=$1", [attachmentId])).rows[0];
    requireCondition(attachment, "MEDIA_ATTACHMENT_NOT_FOUND", 404);
    return mediaCommand(db, actor, attachment.workspace_id, attachment.course_release_id, "release.review", "media.revoked", input.idempotencyKey, { attachmentId, ...input }, async (client) => {
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
    return mediaCommand(db, actor, job0.workspace_id, job0.course_release_id, "release.publish", "media.cancelled", input.idempotencyKey, { jobId, ...input }, async (client) => {
      const job = await jobRow(client, jobId, true);
      requireCondition(CANCELLABLE.includes(job.state), "MEDIA_NOT_CANCELLABLE", 409);
      // Local cancellation only: once a submission may have left the host, the provider may still
      // run and bill it, with or without a stored operation handle (an uncertain submission).
      const remote = job.state === "submitted" || job.state === "polling" || job.state === "uncertain";
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
    const initial = await afterCommitTransaction(db, async (client) => {
      const job = await leased(client, jobId, token);
      if (!job) return null;
      if (job.state === "requested" && RENDERED.includes(job.kind) && now.getTime() >= job.deadline_at.getTime()) {
        await move(client, job, "failed", "MEDIA_DEADLINE_REACHED", { lease_token: null, lease_until: null });
        return null;
      }
      if (IN_FLIGHT.includes(job.state) && now.getTime() >= job.deadline_at.getTime()) {
        // Only an admitted job certainly never reached the provider; an uncertain submission without
        // an operation handle may still be running remotely.
        const remote = job.state !== "admitted", from = job.state;
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
    if (initial.state === "requested") return render(initial, token, now);
    let bound: Awaited<ReturnType<typeof binding>> | null = null;
    try { bound = await binding(db, initial.workspace_id, initial.provider_revision ?? undefined, initial.kind === "generated_image" ? "image" : "video"); } catch { bound = null; }
    if (initial.state === "admitted" && initial.kind === "generated_image") return submitImage(initial, token, now, clock, bound);
    if (initial.state === "admitted") return submit(initial, token, now, clock, bound);
    return poll(initial, token, now, bound);
  }
  /** Records the intent to submit (caps re-checked first). False when the job must not be sent. */
  async function beginSubmit(job0: JobRow, token: string, now: Date, clock: () => Date, ready: boolean) {
    return afterCommitTransaction(db, async (client) => {
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
  }
  /** A submission that failed. Only a definite non-acceptance may retry or release; anything the
   * provider may have run stays held and is never resubmitted. */
  async function submitFailed(client: PoolClient, job: JobRow, f: ProviderError, now: Date) {
    const clear = { lease_token: null, lease_until: null };
    const { definite, notSent, refused } = unstarted(f);
    // A provider-reported failure ends the remote work: a video's operation failed, or an image
    // call returned its failed result. Without either it proves nothing.
    if (f.code === "OPERATION_FAILED" && (f.job || job.kind === "generated_image")) {
      await move(client, job, "failed", "MEDIA_PROVIDER_FAILED", { ...clear, ...(f.job ? { provider_operation: JSON.stringify(f.job), provider_operation_id: operationIdOf(f.job) } : {}) });
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
  }
  /** The submission returned after the job left `submitted` (cancelled or erased meanwhile). */
  async function lateSubmission(client: PoolClient, jobId: string, failure: ProviderError | undefined, hasOperation: boolean) {
    if (!hasOperation && failure && unstarted(failure).definite) await cancelledUnstarted(client, jobId);
    else if ((await client.query("SELECT 1 FROM media_jobs WHERE id=$1 AND state='cancelled' FOR UPDATE", [jobId])).rowCount)
      await holdCharged(client, jobId, "closed");
  }
  async function submit(job0: JobRow, token: string, now: Date, clock: () => Date, bound: Awaited<ReturnType<typeof binding>> | null) {
    const ready = Boolean(bound && bound.plan.availability === "ready" && bound.plan.modelId === job0.model_id
      && digestJson(bound.plan.settings) === digestJson(job0.settings));
    if (!await beginSubmit(job0, token, now, clock, ready)) return;
    let outcome: Awaited<ReturnType<MediaRuntime["submitMediaVideo"]>> | undefined, failure: ProviderError | undefined;
    try {
      outcome = await bound!.runtime.submitMediaVideo(job0.script, "media:" + job0.id, AbortSignal.timeout(config.providerCallTimeoutMs));
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError("NETWORK_ERROR", { submission: "unknown" });
    }
    await afterCommitTransaction(db, async (client) => {
      const job = await leased(client, job0.id, token);
      const operation = outcome?.job ?? failure?.job;
      if (!job || job.state !== "submitted") {
        // Cancelled while the call ran: keep the handle so remote work can be reconciled or audited.
        // Erasure may have ended it: its redacted text marks the row, so the late handle is stored without its adapter state.
        if (operation) await client.query(`UPDATE media_jobs SET provider_operation=COALESCE(provider_operation,CASE WHEN script=$4 THEN ${redactedOperationSql("$2::jsonb")} ELSE $2::jsonb END),
          provider_operation_id=COALESCE(provider_operation_id,$3),remote_may_continue=true WHERE id=$1`,
          [job0.id, JSON.stringify(operation), operationIdOf(operation), ERASED_MEDIA_TEXT]);
        await lateSubmission(client, job0.id, failure, Boolean(operation));
        return;
      }
      const clear = { lease_token: null, lease_until: null };
      if (outcome) {
        await move(client, job, "polling", null, { ...clear, provider_operation: JSON.stringify(outcome.job), provider_operation_id: operationIdOf(outcome.job),
          next_attempt_at: outcome.state === "completed" ? now : new Date(now.getTime() + config.pollIntervalMs) });
        return;
      }
      await submitFailed(client, job, failure!, now);
    });
  }
  /** An image comes back in the submission's response: there is no operation to poll. A response
   * that may have been produced but never arrived is uncertain and waits for its deadline. */
  async function submitImage(job0: JobRow, token: string, now: Date, clock: () => Date, bound: Awaited<ReturnType<typeof binding>> | null) {
    const ready = Boolean(bound && bound.plan.kind === "image" && bound.plan.availability === "ready" && bound.plan.modelId === job0.model_id
      && digestJson(bound.plan.settings) === digestJson(job0.settings));
    if (!await beginSubmit(job0, token, now, clock, ready)) return;
    let failure: ProviderError | undefined, asset: { bytes: Uint8Array; mimeType: string } | null = null, produced = false;
    try {
      const output = await bound!.runtime.generateMediaImage(job0.script, "media:" + job0.id, AbortSignal.timeout(config.providerCallTimeoutMs));
      produced = true;
      const first = output.images[0];
      if (first && output.images.length === 1 && first.byteLength <= config.maxAssetBytes) {
        const bytes = new Uint8Array(Buffer.from(first.base64, "base64"));
        if (bytes.byteLength === first.byteLength && sniffImage(bytes) === first.mimeType) asset = { bytes, mimeType: first.mimeType };
      }
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError("NETWORK_ERROR", { submission: "unknown" });
    }
    await storeAndRecord(job0, asset, async (client, stored) => {
      const job = await leased(client, job0.id, token);
      if (!job || job.state !== "submitted") { await lateSubmission(client, job0.id, failure, produced); return false; }
      const clear = { lease_token: null, lease_until: null };
      if (failure) { await submitFailed(client, job, failure, now); return false; }
      if (!asset || !stored) {
        // The provider produced and billed a response, but not one usable image.
        await move(client, job, "failed", "MEDIA_ASSET_INVALID", clear);
        await holdCharged(client, job.id, "completed");
        return false;
      }
      await stored(client, job);
      await move(client, job, "generated", null, clear);
      await settleMediaCost(client, job);
      await move(client, job, "under_review", null);
      return true;
    });
  }
  /** Stores an asset content-addressed (in the object store when one is configured, staged before
   * the transaction that claims it) and runs `record` with a writer for it. An unclaimed upload is let go. */
  async function storeAndRecord(job0: Pick<JobRow, "workspace_id" | "enrollment_id">, asset: { bytes: Uint8Array; mimeType: string } | null,
    record: (client: PoolClient, stored: ((client: PoolClient, job: Pick<JobRow, "id" | "workspace_id" | "enrollment_id">, provenance?: unknown) => Promise<void>) | null) => Promise<boolean>) {
    const store = artifactStore();
    let staged: StagedObject | null = null, claimed = false;
    if (asset && store) {
      // Store unavailable: nothing is recorded, the lease lapses and a later pass tries again.
      try { staged = await stageObject(db, store, { workspaceId: job0.workspace_id, enrollmentId: job0.enrollment_id, purpose: "media_asset",
        mediaType: asset.mimeType as ObjectMediaType, bytes: asset.bytes }); }
      catch { return; }
    }
    const sha256 = asset ? createHash("sha256").update(asset.bytes).digest("hex") : null;
    const writer = asset ? async (client: PoolClient, job: Pick<JobRow, "id" | "workspace_id" | "enrollment_id">, provenance?: unknown) => {
      if (staged) {
        requireCondition(staged.sha256 === sha256 && staged.byteLength === asset.bytes.byteLength, "MEDIA_ASSET_CHANGED", 409);
        await claimObject(client, staged, { workspaceId: job.workspace_id, enrollmentId: job.enrollment_id, purpose: "media_asset" });
        await client.query("INSERT INTO media_assets(job_id,workspace_id,sha256,mime_type,byte_length,content,object_id,provenance) VALUES($1,$2,$3,$4,$5,NULL,$6,$7)",
          [job.id, job.workspace_id, sha256, asset.mimeType, asset.bytes.byteLength, staged.id, provenance ? JSON.stringify(provenance) : null]);
        onCommit(client, () => { claimed = true; });
      } else await client.query("INSERT INTO media_assets(job_id,workspace_id,sha256,mime_type,byte_length,content,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [job.id, job.workspace_id, sha256, asset.mimeType, asset.bytes.byteLength, Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength),
          provenance ? JSON.stringify(provenance) : null]);
    } : null;
    try { await afterCommitTransaction(db, (client) => record(client, writer)); }
    finally { if (staged && !claimed) await releaseObject(db, staged.id).catch(() => undefined); }
  }
  /** Renders an exact clip or a composition. A missing toolchain or a busy renderer retries later
   * (bounded by the poll limit and the deadline); an invalid scene or range fails at once. */
  async function render(job0: JobRow, token: string, now: Date) {
    let asset: { bytes: Uint8Array; mimeType: string } | null = null, provenance: unknown = null, code: string | null = null, retry = false;
    try {
      requireCondition(config.clipToolchain, "MEDIA_CLIP_TOOLCHAIN_MISSING", 409);
      const source = job0.source as Record<string, unknown>;
      const signal = AbortSignal.timeout(config.providerCallTimeoutMs);
      if (job0.kind === "scene_clip") {
        const release = (await db.query<ReleaseEpisodes>("SELECT server_bundle FROM course_releases WHERE id=$1", [job0.course_release_id])).rows[0]!;
        const visual = visualsOf(release).find((v) => v.id === source.visualId);
        if (!visual) throw new ClipError("CLIP_SCENE_INVALID");
        const clip = await exportSceneClip(visual.visual, source as never, config.clipToolchain, { signal });
        asset = clip;
        provenance = { kind: "scene_clip", visualId: visual.id, frameDigest: clip.frameDigest, frames: clip.frames, width: clip.width, height: clip.height,
          fromMs: source.fromMs, toMs: source.toMs, fps: source.fps };
      } else {
        const parts = (source.parts as { jobId: string; sha256: string }[]);
        const clips: { bytes: Uint8Array; mimeType: string }[] = [];
        for (const part of parts) {
          const meta = (await db.query<{ sha256: string; mime_type: string; byte_length: number; object_id: string | null }>(
            "SELECT sha256,mime_type,byte_length,object_id FROM media_assets WHERE job_id=$1", [part.jobId])).rows[0];
          // A part erased or replaced since the composition was requested cannot be used.
          if (!meta || meta.sha256 !== part.sha256) throw new ClipError("CLIP_SCENE_INVALID");
          const bytes = meta.object_id ? await readObjectRange(db, meta.object_id, 0, meta.byte_length - 1)
            : (await db.query<{ content: Buffer }>("SELECT content FROM media_assets WHERE job_id=$1", [part.jobId])).rows[0]!.content;
          clips.push({ bytes: new Uint8Array(bytes), mimeType: meta.mime_type });
        }
        asset = await composeClips(clips, { format: source.format as "mp4" | "webm", width: source.width as number, height: source.height as number, fps: source.fps as number },
          config.clipToolchain, { signal });
        provenance = { kind: "composed_video", parts: parts.map((p) => p.sha256) };
      }
      if (asset.bytes.byteLength > config.maxAssetBytes) throw new ClipError("CLIP_TOO_LARGE");
    } catch (error) {
      asset = null;
      code = error instanceof ClipError ? "MEDIA_" + error.code : error instanceof ApiError ? error.code : "MEDIA_CLIP_ENCODER_FAILED";
      // Busy, slow, missing or failing tools may recover; a scene, range or size problem will not.
      retry = ["MEDIA_CLIP_BUSY", "MEDIA_CLIP_TIMEOUT", "MEDIA_CLIP_TOOLCHAIN_MISSING", "MEDIA_CLIP_TOOLCHAIN_UNAVAILABLE", "MEDIA_CLIP_ENCODER_FAILED"].includes(code);
    }
    await storeAndRecord(job0, asset, async (client, stored) => {
      const job = await leased(client, job0.id, token);
      if (!job || job.state !== "requested") return false;
      const clear = { lease_token: null, lease_until: null }, attempts = job.poll_attempts + 1;
      if (!asset || !stored) {
        if (retry && attempts < config.maxPolls) {
          await client.query("UPDATE media_jobs SET poll_attempts=$2,next_attempt_at=$3,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",
            [job.id, attempts, backoff(attempts, now)]);
          return false;
        }
        await move(client, job, "failed", code ?? "MEDIA_CLIP_ENCODER_FAILED", { ...clear, poll_attempts: attempts });
        return false;
      }
      await stored(client, job, provenance);
      await move(client, job, "generated", null, { ...clear, poll_attempts: attempts });
      await move(client, job, "under_review", null);
      return true;
    });
  }
  /** A job cancelled while its submission was in flight, which the provider then definitely
   * refused: nothing can run remotely, so the held reservation is released. Only a cancellation
   * made from `submitted` qualifies; one made after the job became uncertain keeps its hold
   * (its ledger row is `uncertain`, which is never released). */
  async function cancelledUnstarted(client: PoolClient, jobId: string) {
    const job = (await client.query<JobRow>("SELECT * FROM media_jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0];
    if (job?.state !== "cancelled" || job.provider_operation !== null) return;
    // A cancelled job is never resubmitted, so this refusal proves nothing runs remotely, however it
    // was cancelled (staff or erasure) and whether or not its reservation can still be released.
    await client.query("UPDATE media_jobs SET remote_may_continue=false WHERE id=$1", [jobId]);
    const last = (await client.query<{ from_state: string }>("SELECT from_state FROM media_job_events WHERE job_id=$1 ORDER BY id DESC LIMIT 1", [jobId])).rows[0];
    if (last?.from_state !== "submitted") return;
    // The cancellation held the row as open `uncertain`; this refusal proves nothing ran. A row
    // already closed (by erasure) is not released again.
    await releaseUnstartedMedia(client, jobId, true);
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
    // With an object store configured, a valid clip is uploaded before the transaction that
    // records it. That transaction claims it; an upload it does not claim is let go (and swept).
    const store = artifactStore();
    let staged: StagedObject | null = null, claimed = false;
    if (!failure && asset && store && sniffVideo(asset.bytes) === asset.mimeType && asset.byteLength === asset.bytes.length && asset.byteLength <= config.maxAssetBytes) {
      // Store unavailable: nothing is recorded, the lease lapses and a later poll downloads again.
      try { staged = await stageObject(db, store, { workspaceId: job0.workspace_id, enrollmentId: job0.enrollment_id, purpose: "media_asset",
        mediaType: asset.mimeType as "video/mp4" | "video/webm", bytes: asset.bytes }); }
      catch { return; }
    }
    try { await record(); }
    finally { if (staged && !claimed) await releaseObject(db, staged.id).catch(() => undefined); }
    async function record() {
    await afterCommitTransaction(db, async (client) => {
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
          // Only a poll that reported the render complete, or a provider-reported failure, proves the
          // remote job ended. A malformed or unreadable poll response proves nothing: the provider
          // may still be rendering (and billing) it.
          const completed = result?.state === "completed", ended = completed || failure.code === "OPERATION_FAILED";
          await move(client, job, "failed", terminal, { ...clear, poll_attempts: polls, remote_may_continue: !ended });
          // A completed render whose clip is missing, oversized or never downloaded settles like any
          // unusable completed clip; otherwise the outcome is unknown and the charge is closed as held.
          await holdCharged(client, job.id, completed ? "completed" : "closed");
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
      if (staged) {
        requireCondition(staged.sha256 === sha256 && staged.byteLength === asset!.byteLength, "MEDIA_ASSET_CHANGED", 409);
        await claimObject(client, staged, { workspaceId: job.workspace_id, enrollmentId: job.enrollment_id, purpose: "media_asset" });
        await client.query("INSERT INTO media_assets(job_id,workspace_id,sha256,mime_type,byte_length,content,object_id) VALUES($1,$2,$3,$4,$5,NULL,$6)",
          [job.id, job.workspace_id, sha256, sniffed, asset!.byteLength, staged.id]);
        onCommit(client, () => { claimed = true; });
      } else await client.query("INSERT INTO media_assets(job_id,workspace_id,sha256,mime_type,byte_length,content) VALUES($1,$2,$3,$4,$5,$6)",
        [job.id, job.workspace_id, sha256, sniffed, asset!.byteLength, Buffer.from(asset!.bytes.buffer, asset!.bytes.byteOffset, asset!.byteLength)]);
      await move(client, job, "generated", null, { poll_attempts: polls, provider_operation: JSON.stringify(result!.job) });
      await settleMediaCost(client, job);
      // A finished render is not a teaching artifact: it waits for staff review.
      await move(client, job, "under_review", null, clear);
    });
    }
  }
  async function expireAttachments(now: Date) {
    await afterCommitTransaction(db, async (client) => {
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
    const claimed = await afterCommitTransaction(db, async (client) => (await client.query<{ id: string }>(
      `UPDATE media_jobs SET lease_token=$1,lease_until=$2 WHERE id IN (
         SELECT id FROM media_jobs WHERE (state=ANY($3::text[]) OR (state='requested' AND kind IN ('scene_clip','composed_video')))
           AND next_attempt_at<=$4 AND (lease_until IS NULL OR lease_until<=$4)
         ORDER BY next_attempt_at,id LIMIT $5 FOR UPDATE SKIP LOCKED) RETURNING id`,
      [token, new Date(now.getTime() + config.leaseMs), WORKER_STATES, now, limit])).rows);
    const runtime = telemetry();
    for (const { id } of claimed) {
      const started = performance.now();
      const state = (await db.query<{ state: string }>("SELECT state FROM media_jobs WHERE id=$1", [id])).rows[0]?.state;
      const stepName = state === "admitted" ? "submit" : state === "requested" ? "render" : "poll";
      try {
        await runtime.span("media.job.step", { "course.media.step": stepName, "course.media.state": state }, () => step(id, token, now, clock));
      } catch { /* The lease expires and a later pass retries; no provider data is logged. */ }
      runtime.record("course.media.step.duration", (performance.now() - started) / 1000, { "course.media.step": stepName, "course.media.state": state });
    }
    return { claimed: claimed.length };
  }

  /** When the next pass has work: the earliest due job, a lapsed lease, or an attachment expiry.
   * Read from the database, so a restarted process resumes exactly where the last one stopped. */
  async function nextDueAt(): Promise<Date | null> {
    const row = (await db.query<{ due: Date | null }>(
      `SELECT least(
         (SELECT min(greatest(next_attempt_at,coalesce(lease_until,next_attempt_at))) FROM media_jobs
           WHERE state=ANY($1::text[]) OR (state='requested' AND kind IN ('scene_clip','composed_video'))),
         (SELECT min(a.expires_at) FROM media_attachments a JOIN media_jobs j ON j.id=a.job_id WHERE j.state='attached')) AS due`, [WORKER_STATES])).rows[0];
    return row?.due ?? null;
  }

  // ---- Learner and asset access ----
  async function learnerMedia(actor: Actor, enrollmentId: string, episode: string) {
    const enrollment = await enrollmentScope(db, enrollmentId);
    requireCondition(enrollment.user_id === actor.id && enrollment.status !== "erased", "ENROLLMENT_NOT_FOUND", 404);
    await memberRole(db, actor, enrollment.workspace_id);
    const rows = await attachedMedia(db, enrollmentId, enrollment.workspace_id, episode);
    const base = `/api/enrollments/${enrollmentId}/media`;
    return {
      episodeId: episode,
      media: rows.map((r) => ({
        id: r.id, title: r.title, objective: r.objective, generated: true, transcript: r.transcript, visualDescription: r.visualDescription,
        mimeType: r.mimeType, byteLength: r.byteLength, assetUrl: `${base}/${r.id}/asset`, captionsUrl: r.captions ? `${base}/${r.id}/captions.vtt` : null, captionsLanguage: r.captionsLanguage,
        reviewedAt: r.reviewedAt, expiresAt: r.expiresAt,
      })),
      optional: true, grantsCredit: false,
    };
  }
  async function learnerAttachment(actor: Actor, enrollmentId: string, attachmentId: string) {
    parse(z.string().uuid(), attachmentId);
    const enrollment = await enrollmentScope(db, enrollmentId);
    requireCondition(enrollment.user_id === actor.id && enrollment.status !== "erased", "ENROLLMENT_NOT_FOUND", 404);
    await memberRole(db, actor, enrollment.workspace_id);
    return activeAttachment(db, enrollmentId, attachmentId);
  }
  async function staffAsset(actor: Actor, jobId: string) {
    const job = await jobRow(db, jobId);
    await permitted(db, actor, job.workspace_id, "run.inspect", job.course_release_id);
    return job.id;
  }
  return { estimate, request, requestImage, requestClip, compose, list, detail, review, attach, revoke, cancel, run, nextDueAt, learnerMedia, learnerAttachment, staffAsset, config };
}
export type MediaJobService = ReturnType<typeof createMediaJobService>;

/** What the learner is shown of course-made media: attached, approved, not revoked and not
 * expired, in attachment order, at most five per episode. One query for the learner's own
 * episode route and for the read-only learner view (all episodes). */
export async function attachedMedia(client: Database | PoolClient, enrollmentId: string, workspaceId: string, episodeId?: string) {
  const rows = (await client.query<{ id: string; episode_id: string; expires_at: Date; title: string; objective: string; transcript: string | null;
    visual_description: string | null; captions: boolean; captions_language: string | null; reviewed_at: Date; mime_type: string; byte_length: number }>(
    `SELECT a.id,a.episode_id,a.expires_at,j.title,j.objective,r.transcript,r.visual_description,r.captions_vtt IS NOT NULL AS captions,r.captions_language,
       r.created_at AS reviewed_at,m.mime_type,m.byte_length
     FROM media_attachments a JOIN media_jobs j ON j.id=a.job_id AND j.state='attached'
     JOIN media_reviews r ON r.id=a.review_id AND r.decision='approved' JOIN media_assets m ON m.job_id=j.id AND m.sha256=r.asset_sha256
     WHERE a.enrollment_id=$1 AND a.workspace_id=$2 AND ($3::text IS NULL OR a.episode_id=$3) AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
     ORDER BY a.created_at,a.id LIMIT 1000`, [enrollmentId, workspaceId, episodeId ?? null])).rows;
  const perEpisode = new Map<string, number>();
  return rows.filter((r) => {
    const count = (perEpisode.get(r.episode_id) ?? 0) + 1;
    perEpisode.set(r.episode_id, count);
    return count <= 5;
  }).map((r) => ({
    id: r.id, episodeId: r.episode_id, title: r.title, objective: r.objective, transcript: r.transcript, visualDescription: r.visual_description,
    captions: r.captions, captionsLanguage: r.captions_language, mimeType: r.mime_type, byteLength: r.byte_length, reviewedAt: r.reviewed_at.toISOString(), expiresAt: r.expires_at.toISOString(),
  }));
}

/** One attachment the learner can currently play, or MEDIA_NOT_FOUND. */
export async function activeAttachment(client: Database | PoolClient, enrollmentId: string, attachmentId: string) {
  const row = (await client.query<{ job_id: string; captions_vtt: string }>(
    `SELECT a.job_id,r.captions_vtt FROM media_attachments a JOIN media_jobs j ON j.id=a.job_id AND j.state='attached'
     JOIN media_reviews r ON r.id=a.review_id AND r.decision='approved' JOIN media_assets m ON m.job_id=j.id AND m.sha256=r.asset_sha256
     WHERE a.id=$1 AND a.enrollment_id=$2 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()`, [attachmentId, enrollmentId])).rows[0];
  requireCondition(row, "MEDIA_NOT_FOUND", 404);
  return row;
}

/** Serves one asset with single-range support so every browser can seek and play it. */
export async function sendAsset(db: Database, jobId: string, range: string | undefined, reply: FastifyReply) {
  const meta = (await db.query<{ mime_type: string; byte_length: number; sha256: string; object_id: string | null }>("SELECT mime_type,byte_length,sha256,object_id FROM media_assets WHERE job_id=$1", [jobId])).rows[0];
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
  // A clip in the object store is read through the API after the same authorization, never by a bucket URL.
  const chunk = meta.object_id ? Buffer.from(await readObjectRange(db, meta.object_id, start, end))
    : (await db.query<{ part: Buffer }>("SELECT substring(content FROM $2 FOR $3) AS part FROM media_assets WHERE job_id=$1", [jobId, start + 1, length])).rows[0]!.part;
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
  app.post("/api/admin/enrollments/:enrollmentId/media-images", { schema: { params: params("enrollmentId") }, bodyLimit: 32768 }, async (request) =>
    service.requestImage(await auth.authenticate(request), (request.params as { enrollmentId: string }).enrollmentId, request.body));
  app.post("/api/admin/enrollments/:enrollmentId/media-clips", { schema: { params: params("enrollmentId") }, bodyLimit: 32768 }, async (request) =>
    service.requestClip(await auth.authenticate(request), (request.params as { enrollmentId: string }).enrollmentId, request.body));
  app.post("/api/admin/media-storyboards/:storyboardId/compose", { schema: { params: params("storyboardId") }, bodyLimit: 4096 }, async (request) =>
    service.compose(await auth.authenticate(request), (request.params as { storyboardId: string }).storyboardId, request.body));
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
