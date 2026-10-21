import { classifyHttpError, ProviderError, type ProviderAdapter, type UsageReceipt, type VideoJob, type VideoRequest } from "@course-core/providers";
import { createHash, randomUUID } from "node:crypto";
import { providerConfigurationSchema, type AdapterFactory } from "../src/provider-composition.js";
import type { Database } from "../src/database.js";
import { roleRevisions } from "../src/agent-evals/revision.js";
import { publicSuite } from "../src/agent-evals/public-suite.js";

/** Public synthetic bytes with an MP4 `ftyp` header. Not playable media; never a real clip. */
export const SYNTHETIC_MP4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ...Array.from({ length: 40 }, (_, i) => i)]);
export const SYNTHETIC_CAPTIONS = "WEBVTT\n\n00:00.000 --> 00:04.000\nThe running minimum keeps the smaller value after each comparison.\n";
export type SubmitOutcome = "accept" | "accept_completed" | "unknown_with_operation" | "unknown_without_operation" | "rejected" | "throttled"
  /** Answered with this HTTP status, classified and recorded as the real transport does. */
  | { status: number; retryAfterMs?: number }
  /** A 429 refusal followed by a 503 on the transport's automatic retry: not certified. */
  | "throttled_then_unavailable"
  /** A `rejected` error that carries no attempt record: it cannot be certified. */
  | "rejected_unrecorded"
  /** Refused before any request left the host (no attempt recorded). */
  | "not_sent";
/** `invalid`: an unreadable poll response (the render may still be running);
 * `completed_without_video`: the provider reports the render complete but returns no clip. */
export type PollOutcome = "pending" | "completed" | "failed" | "network" | "invalid" | "completed_without_video";

/** A scripted, credential-free video adapter. It records every call so tests can
 * prove a submission happened exactly once; it never contacts a network. */
export class ScriptedVideo {
  submits: VideoRequest[] = [];
  polls: string[] = [];
  downloads: string[] = [];
  submitOutcomes: SubmitOutcome[] = [];
  pollOutcomes: PollOutcome[] = [];
  asset: Uint8Array = SYNTHETIC_MP4;
  /** When set, a submission waits for it after being recorded (to act while a call is in flight). */
  submitGate: Promise<void> | null = null;
  #sequence = 0;
  constructor(readonly providerId = "scripted") {}
  #usage(request: { modelId: string; accounting: { accountingKey: string } }, operation: "video_submit" | "video_poll"): UsageReceipt {
    return { accounting: request.accounting, providerId: this.providerId, modelId: request.modelId, operation, attempts: [], inputCharacters: 0,
      requestedMaxOutputTokens: null, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
  }
  /** The error the real HTTP transport throws for these answers, with its attempt records. */
  #refusal(request: VideoRequest, statuses: number[], retryAfterMs?: number) {
    const usage = this.#usage(request, "video_submit");
    let error: ProviderError | undefined;
    statuses.forEach((status, i) => {
      error = classifyHttpError(status, i === statuses.length - 1 ? retryAfterMs : undefined);
      usage.attempts.push({ attempt: i + 1, status, outcome: error.submission === "rejected" ? "rejected" : "unknown",
        tokens: { input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null } });
    });
    error!.usage = usage;
    return error!;
  }
  #job(request: VideoRequest, name: string): VideoJob {
    return { kind: "video", providerId: this.providerId, modelId: request.modelId, registryRevision: "media-synthetic",
      providerState: { operationName: name }, accounting: request.accounting, requestedDurationSeconds: request.durationSeconds };
  }
  factory(): AdapterFactory {
    return ({ providerId }) => {
      const self = this;
      return {
        providerId,
        validateModel() {},
        ports: {
          video: {
            async startVideo(request) {
              self.submits.push(structuredClone(request));
              if (self.submitGate) await self.submitGate;
              const outcome = self.submitOutcomes.shift() ?? "accept", name = `scripted/operations/op-${++self.#sequence}`;
              if (outcome === "rejected") throw self.#refusal(request, [400]);
              if (outcome === "throttled") throw self.#refusal(request, [429]);
              if (typeof outcome === "object") throw self.#refusal(request, [outcome.status], outcome.retryAfterMs);
              if (outcome === "throttled_then_unavailable") throw self.#refusal(request, [429, 503]);
              if (outcome === "rejected_unrecorded") throw new ProviderError("UPSTREAM_REJECTED", { status: 400, submission: "rejected" });
              if (outcome === "not_sent") throw new ProviderError("MISSING_CREDENTIAL");
              if (outcome === "unknown_without_operation") throw new ProviderError("UPSTREAM_UNAVAILABLE", { status: 503, submission: "unknown" });
              if (outcome === "unknown_with_operation") {
                const error = new ProviderError("TIMEOUT", { submission: "unknown" });
                error.job = self.#job(request, name);
                throw error;
              }
              const job = self.#job(request, name);
              return { usage: self.#usage(request, "video_submit"),
                output: outcome === "accept_completed" ? { state: "completed", job, videos: [{ uri: "https://media.example.invalid/" + name, mimeType: "video/mp4" }] } : { state: "pending", job } };
            },
            async pollVideo(job) {
              const name = (job.providerState as { operationName: string }).operationName;
              self.polls.push(name);
              const outcome = self.pollOutcomes.shift() ?? "completed";
              if (outcome === "failed") { const e = new ProviderError("OPERATION_FAILED", { submission: "unknown" }); e.job = job; throw e; }
              if (outcome === "network") throw new ProviderError("NETWORK_ERROR", { submission: "unknown" });
              if (outcome === "invalid") throw new ProviderError("INVALID_RESPONSE", { submission: "unknown" });
              if (outcome === "completed_without_video") return { usage: self.#usage(job, "video_poll"), output: { state: "completed", job, videos: [] } };
              return { usage: self.#usage(job, "video_poll"),
                output: outcome === "pending" ? { state: "pending", job } : { state: "completed", job, videos: [{ uri: "https://media.example.invalid/" + name, mimeType: "video/mp4" }] } };
            },
            async downloadVideo(_job, uri, options) {
              self.downloads.push(uri);
              if (self.asset.byteLength > options.maxBytes) throw new ProviderError("OUTPUT_TOO_LARGE");
              return { bytes: self.asset.slice(), mimeType: "video/mp4", byteLength: self.asset.byteLength };
            },
          },
        },
      } satisfies ProviderAdapter;
    };
  }
}
export const MEDIA_CREDENTIAL = "COURSE_PROVIDER_SCRIPTED_API_KEY";
export function mediaConfiguration(pricing: { microUsdPerOutputSecond: number } | null = { microUsdPerOutputSecond: 50_000 }) {
  return {
    registry: { revision: "media-synthetic", models: [{ id: "clip", providerId: "scripted", remoteModel: "scripted/clip", providerConfig: {},
      enabled: true, capabilities: ["video"], tools: [], limits: { maxInputCharacters: 20_000 } }] },
    adapters: [{ id: "scripted", kind: "scripted-video", credentialEnv: MEDIA_CREDENTIAL }],
    roles: { media: { modelId: "clip", maxInputCharacters: 8000, maxOutputTokens: 0, mediaKind: "video",
      video: { durationSeconds: 4, aspectRatio: "16:9", resolution: "720p" },
      ...(pricing ? { pricing: { ...pricing, source: "Synthetic test rate card", reviewedAt: "2026-10-01" } } : {}) } },
  };
}
export const mediaJobPolicy = (microUsd: number) => ({ allowance: { microUsd, tokens: 100_000 }, durationMs: 300_000, timeoutMs: 60_000, maxAttempts: 3 });
/**
 * Every agent role is gated on an evaluated revision (N07); the scripted video adapter is not in
 * the public suite's scripted configuration, so these fixtures record an owner's override for the
 * exact revisions they activate, as an owner would through the provider-evals route.
 */
export async function approveRevisionsForTest(db: Database, workspaceId: string, configuration: unknown) {
  const revisions = await roleRevisions(providerConfigurationSchema.parse(configuration));
  const suite = publicSuite();
  const owner = (await db.query<{ user_id: string }>("SELECT user_id FROM memberships WHERE workspace_id=$1 AND role='owner' ORDER BY user_id LIMIT 1", [workspaceId])).rows[0]!.user_id;
  for (const revision of Object.values(revisions))
    await db.query(`INSERT INTO provider_eval_overrides(id,workspace_id,role,revision_digest,suite_id,suite_digest,reason,actor_id,idempotency_key,request_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), workspaceId, revision!.role, revision!.digest, suite.id, suite.digest,
      "Synthetic test fixture: an owner approves the scripted media revision.", owner, "fixture-" + randomUUID(), createHash("sha256").update(randomUUID()).digest("hex")]);
}
