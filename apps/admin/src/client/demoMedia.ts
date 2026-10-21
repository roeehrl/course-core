// i18n-ignore-file: fictional demo media jobs, scripts and reviews are course content, like src/data/
import { demoSession, demoWorkspace, type DemoRole } from "../data/fixtures";
import {
  MediaActionError,
  type MediaAdminPort,
  type MediaCheck,
  type MediaJob,
  type MediaKind,
  type MediaLibrary,
  type Storyboard,
} from "../domain/media";

/**
 * The demo's generated-media jobs. Nothing calls a provider: requests stay in memory, video
 * requests wait at the provider step forever, and the only "rendered" assets are tiny
 * placeholder images. Learners see an item only after review and attachment; nothing grants credit.
 */
export interface DemoMediaOptions {
  role?: DemoRole;
  scenario?:
    "standard" | "permission_denied" | "stale_revision" | "load_failure";
  latency?: number;
  /** The clock, so tests can pin it. */
  now?: () => Date;
}

const ESTIMATE = 400_000;
/** A fictional per-image estimate for the demo image model. */
const IMAGE_ESTIMATE = 40_000;
const ALLOWANCE = 1_000_000;
const BUDGET = 3_000_000;
const RATE = 50_000;
const SECONDS = 8;
/** A tiny placeholder picture: the demo never renders real media. */
const PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#eef1f4"/><g fill="#5b6b7b"><rect x="20" y="50" width="16" height="20"/><rect x="44" y="40" width="16" height="30"/><rect x="68" y="30" width="16" height="40"/><rect x="92" y="20" width="16" height="50"/><rect x="116" y="10" width="16" height="60"/></g></svg>',
)}`;
const PLACEHOLDER_BYTES = 412;

/** A stable UUID-shaped id for a demo record (the demo's own ids are readable slugs). */
function demoUuid(seed: string) {
  let a = 0x811c9dc5,
    b = 0x01000193;
  const hex: string[] = [];
  for (let round = 0; round < 4; round++) {
    for (const char of `${round}:${seed}`) {
      a = Math.imul(a ^ char.charCodeAt(0), 16777619) >>> 0;
      b = Math.imul(b ^ char.charCodeAt(0), 2246822519) >>> 0;
    }
    hex.push(((a ^ b) >>> 0).toString(16).padStart(8, "0"));
  }
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const digest = (seed: string) =>
  Array.from({ length: 8 }, (_, i) => demoUuid(`${seed}#${i}`).slice(0, 8))
    .join("")
    .slice(0, 64);

type Release = {
  releaseId: string;
  uuid: string;
  version: string;
  episodes: { id: string; title: string }[];
  enrollments: { id: string; name: string; status: string }[];
};

export function createDemoMedia({
  role = "administrator",
  scenario = "standard",
  latency = 140,
  now = () => new Date(),
}: DemoMediaOptions = {}): MediaAdminPort {
  const permissions = {
    request: role === "administrator",
    review: role !== "observer",
    attach: role === "administrator",
  };
  const releases = new Map<string, Release>();
  for (const course of demoSession(role).courses) {
    const workspace = demoWorkspace(course, role);
    for (const release of workspace.releases) {
      if (release.state !== "published") continue;
      releases.set(release.id, {
        releaseId: release.id,
        uuid: demoUuid(release.id),
        version: release.version,
        episodes: workspace.course.objectives.map((title, i) => ({
          id: `ep-${i + 1}`,
          title,
        })),
        enrollments: workspace.enrollments.map((e) => ({
          id: demoUuid(e.id),
          name: e.profile.displayName,
          status: e.status,
        })),
      });
    }
  }
  const jobs = new Map<string, MediaJob & { releaseId: string }>();
  const boards = new Map<string, Storyboard & { releaseId: string }>();
  const receipts = new Map<string, { fingerprint: string; result: unknown }>();
  let sequence = 0;
  const iso = (offsetMs = 0) =>
    new Date(now().getTime() + offsetMs).toISOString();
  const clone = <T>(value: T): T => structuredClone(value);

  async function delay(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!latency) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, latency);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function guard(permission?: keyof typeof permissions) {
    if (scenario === "load_failure") throw new Error("unavailable");
    if (
      scenario === "permission_denied" ||
      (permission && !permissions[permission])
    )
      throw new MediaActionError("FORBIDDEN");
  }
  function release(releaseId: string) {
    const found = releases.get(releaseId);
    if (!found) throw new MediaActionError("MEDIA_EPISODE_OUT_OF_SCOPE");
    return found;
  }
  function enrollmentRelease(enrollmentId: string) {
    for (const r of releases.values()) {
      const enrollment = r.enrollments.find((e) => e.id === enrollmentId);
      if (enrollment) return { release: r, enrollment };
    }
    throw new MediaActionError("MEDIA_EPISODE_OUT_OF_SCOPE");
  }
  function job(jobId: string) {
    const found = jobs.get(jobId);
    if (!found) throw new MediaActionError("INVALID_INPUT");
    return found;
  }
  function board(storyboardId: string) {
    const found = boards.get(storyboardId);
    if (!found) throw new MediaActionError("MEDIA_STORYBOARD_NOT_FOUND");
    return found;
  }
  /** Replays a finished action for the same key; refuses the key for a different action. */
  async function once<T>(
    key: string,
    payload: unknown,
    action: () => T,
  ): Promise<T> {
    await delay();
    const fingerprint = JSON.stringify(payload);
    const replay = receipts.get(key);
    if (replay) {
      if (replay.fingerprint !== fingerprint)
        throw new MediaActionError("IDEMPOTENCY_CONFLICT");
      return clone(replay.result as T);
    }
    const result = action();
    receipts.set(key, { fingerprint, result: clone(result) });
    return clone(result);
  }
  const move = (
    target: MediaJob,
    to: MediaJob["state"],
    code: string | null = null,
  ) => {
    target.events = [
      ...(target.events ?? []),
      { from: target.state, to, code, at: iso() },
    ];
    target.state = to;
    target.updatedAt = iso();
  };
  const reserved = (releaseId: string) =>
    [...jobs.values()]
      .filter((j) => j.releaseId === releaseId)
      .reduce((sum, j) => sum + j.chargedMicroUsd, 0);

  function newJob(
    r: Release,
    enrollment: Release["enrollments"][number],
    fields: {
      kind: MediaKind;
      episodeId: string;
      title: string;
      objective: string;
      script?: string;
      storyboardId?: string | null;
      shotId?: string | null;
      referenceVisualId?: string | null;
    },
  ): MediaJob & { releaseId: string } {
    if (!r.episodes.some((e) => e.id === fields.episodeId))
      throw new MediaActionError("MEDIA_EPISODE_OUT_OF_SCOPE");
    const paid =
      fields.kind !== "scene_clip" && fields.kind !== "composed_video";
    const id = demoUuid(`job-${++sequence}-${fields.title}`);
    return {
      releaseId: r.releaseId,
      id,
      state: "requested",
      failureCode: null,
      kind: fields.kind,
      paid,
      storyboardId: fields.storyboardId ?? null,
      shotId: fields.shotId ?? null,
      referenceVisualId: fields.referenceVisualId ?? null,
      source: null,
      title: fields.title,
      objective: fields.objective,
      script: fields.script ?? "",
      enrollmentId: enrollment.id,
      learnerName: enrollment.name,
      episodeId: fields.episodeId,
      providerRevision: paid ? 1 : null,
      modelId: paid ? "demo-video-model" : "course-visual-renderer",
      settings:
        fields.kind === "generated_image"
          ? { aspectRatio: "16:9" }
          : {
              durationSeconds: SECONDS,
              aspectRatio: "16:9",
              resolution: "720p",
            },
      pricing: paid
        ? {
            microUsdPerOutputSecond: RATE,
            source: "Demo rate card (fictional)",
            reviewedAt: "2026-10-01",
          }
        : null,
      estimateMicroUsd: paid ? ESTIMATE : 0,
      chargedMicroUsd: 0,
      providerOperationId: null,
      remoteMayContinue: false,
      submitAttempts: 0,
      pollAttempts: 0,
      deadlineAt: iso(2 * 86_400_000),
      createdAt: iso(),
      updatedAt: iso(),
      asset: null,
      checks: [],
      review: null,
      attachment: null,
      events: [{ from: null, to: "requested", code: null, at: iso() }],
      learnerVisible: false,
      grantsCredit: false,
    };
  }
  function withAsset(target: MediaJob, seed: string) {
    target.asset = {
      sha256: digest(seed),
      mimeType: "image/svg+xml",
      byteLength: PLACEHOLDER_BYTES,
      createdAt: iso(),
      provenance: { generator: "demo placeholder", provider: null },
    };
  }

  // Seed each release with jobs in the states a reviewer meets most often.
  for (const r of releases.values()) {
    const learner = r.enrollments[0]!;
    const ep = r.episodes[0]!.id;
    const waiting = newJob(r, learner, {
      kind: "generated_image",
      episodeId: ep,
      title: "Five cards before sorting",
      objective: "See the starting order before any comparison.",
      script: "Five cards in a row, the smallest one last.",
    });
    move(waiting, "admitted");
    move(waiting, "submitted");
    move(waiting, "generated");
    waiting.providerOperationId = `demo-op-${waiting.id.slice(0, 8)}`;
    waiting.submitAttempts = 1;
    waiting.pollAttempts = 2;
    waiting.chargedMicroUsd = 40_000;
    withAsset(waiting, waiting.id);
    move(waiting, "under_review");
    const shown = newJob(r, learner, {
      kind: "generated_image",
      episodeId: ep,
      title: "A sorted hand",
      objective: "Recognize the finished order.",
      script: "Five cards from smallest to largest.",
    });
    for (const s of [
      "admitted",
      "submitted",
      "generated",
      "under_review",
    ] as const)
      move(shown, s);
    shown.providerOperationId = `demo-op-${shown.id.slice(0, 8)}`;
    shown.submitAttempts = 1;
    shown.pollAttempts = 1;
    shown.chargedMicroUsd = 40_000;
    withAsset(shown, shown.id);
    shown.review = {
      id: demoUuid(`review-${shown.id}`),
      decision: "approved",
      assetSha256: shown.asset!.sha256,
      rationale: "Matches the lesson: five cards, smallest first, no labels.",
      hasCaptions: false,
      transcript: null,
      visualDescription: "Five cards in ascending order from left to right.",
      reviewedAt: iso(),
    };
    move(shown, "approved");
    shown.attachment = {
      id: demoUuid(`attachment-${shown.id}`),
      episodeId: ep,
      expiresAt: iso(30 * 86_400_000),
      state: "active",
      revokedAt: null,
      revokeReason: null,
    };
    move(shown, "attached");
    shown.learnerVisible = true;
    const uncertain = newJob(r, learner, {
      kind: "generated_short_video",
      episodeId: ep,
      title: "Insertion sort animation",
      objective: "See how items shift.",
      script: "Five cards. The third card moves left.",
    });
    for (const s of ["admitted", "submitted", "polling"] as const)
      move(uncertain, s);
    uncertain.providerOperationId = `demo-op-${uncertain.id.slice(0, 8)}`;
    uncertain.submitAttempts = 1;
    uncertain.pollAttempts = 3;
    uncertain.chargedMicroUsd = ESTIMATE;
    uncertain.remoteMayContinue = true;
    move(uncertain, "uncertain", "MEDIA_OUTCOME_UNKNOWN");
    uncertain.failureCode = "MEDIA_OUTCOME_UNKNOWN";
    const failed = newJob(r, r.enrollments[1] ?? learner, {
      kind: "generated_short_video",
      episodeId: r.episodes[1]?.id ?? ep,
      title: "Shifting items clip",
      objective: "Follow one item as it moves.",
      script: "One card slides past two larger cards.",
    });
    move(failed, "failed", "MEDIA_BUDGET_EXHAUSTED");
    failed.failureCode = "MEDIA_BUDGET_EXHAUSTED";
    for (const seeded of [shown, waiting, uncertain, failed])
      jobs.set(seeded.id, seeded);
    const sb: Storyboard & { releaseId: string } = {
      releaseId: r.releaseId,
      id: demoUuid(`storyboard-${r.releaseId}`),
      enrollmentId: learner.id,
      episodeId: ep,
      title: "Insertion sort, step by step",
      objective: "Follow one insertion from start to finish.",
      script:
        "Start with five cards. Pick the third. Slide it left until it fits.",
      shots: [
        {
          id: "shot-1",
          kind: "generated",
          description: "Five cards in a row, unsorted.",
          narration: "Here are five cards in no particular order.",
          durationSeconds: SECONDS,
        },
        {
          id: "shot-2",
          kind: "generated",
          description: "The third card slides left past one larger card.",
          narration:
            "The third card moves left until the card before it is smaller.",
          durationSeconds: SECONDS,
        },
      ],
      referenceVisualId: null,
      draftedBy: "staff",
      draftStatus: "ready",
      state: "draft",
      revision: 1,
      reviewNote: null,
      updatedAt: iso(),
    };
    boards.set(sb.id, sb);
  }

  const view = (j: MediaJob & { releaseId: string }): MediaJob => {
    const { releaseId: _releaseId, ...rest } = j;
    return clone(rest);
  };
  const boardView = (b: Storyboard & { releaseId: string }): Storyboard => {
    const { releaseId: _releaseId, ...rest } = b;
    return clone({
      ...rest,
      jobs: [...jobs.values()]
        .filter((j) => j.storyboardId === b.id)
        .map((j) => ({
          id: j.id,
          shotId: j.shotId,
          kind: j.kind,
          state: j.state,
        })),
    });
  };
  /** A paid request in the demo: admitted, then waiting at the provider step (no call is made). */
  function submitPaid(target: MediaJob & { releaseId: string }) {
    if (reserved(target.releaseId) + ALLOWANCE > BUDGET) {
      move(target, "failed", "MEDIA_BUDGET_EXHAUSTED");
      target.failureCode = "MEDIA_BUDGET_EXHAUSTED";
      return;
    }
    move(target, "admitted");
    if (target.kind === "generated_image") {
      move(target, "submitted");
      move(target, "generated");
      target.providerOperationId = `demo-op-${target.id.slice(0, 8)}`;
      target.submitAttempts = 1;
      target.chargedMicroUsd = 40_000;
      withAsset(target, target.id);
      move(target, "under_review");
    } else {
      move(target, "submitted");
      move(target, "polling");
      target.providerOperationId = `demo-op-${target.id.slice(0, 8)}`;
      target.submitAttempts = 1;
      target.chargedMicroUsd = ESTIMATE;
    }
  }
  function fromBoard(input: { storyboardId?: string; shotId?: string }) {
    if (!input.storyboardId) return;
    const b = board(input.storyboardId);
    if (b.state !== "approved")
      throw new MediaActionError("MEDIA_STORYBOARD_NOT_APPROVED");
    if (input.shotId && !b.shots.some((s) => s.id === input.shotId))
      throw new MediaActionError("MEDIA_STORYBOARD_SHOT_MISMATCH");
  }
  const text = (value: string | undefined, min = 1) =>
    (value ?? "").trim().length >= min;

  return {
    async library(releaseId, signal) {
      await delay(signal);
      guard();
      const r = release(releaseId);
      const library: MediaLibrary = {
        release: { id: r.uuid, version: r.version },
        episodes: clone(r.episodes),
        visuals: [],
        clipRendering: "toolchain_missing",
        enrollments: clone(r.enrollments),
        provider: {
          revision: 1,
          kind: "video",
          modelId: "demo-video-model",
          settings: {
            durationSeconds: SECONDS,
            aspectRatio: "16:9",
            resolution: "720p",
          },
          pricing: {
            microUsdPerOutputSecond: RATE,
            source: "Demo rate card (fictional)",
            reviewedAt: "2026-10-01",
          },
          availability: "ready",
          estimateMicroUsd: ESTIMATE,
          units: { outputSeconds: SECONDS, images: 0, requests: 1 },
          capabilities: {
            kind: "video",
            billing: "per_output_second",
            cancellation: "best_effort",
            maxPromptCharacters: 2000,
            retention: { outputHours: 48, providerStoresRequest: false },
          },
          perJobAllowanceMicroUsd: ALLOWANCE,
        },
        // An image model bound beside the video model (fictional).
        imageProvider: {
          revision: 1,
          kind: "image",
          modelId: "demo-image-model",
          settings: { aspectRatio: "16:9", imageSize: "1K" },
          pricing: null,
          availability: "ready",
          estimateMicroUsd: IMAGE_ESTIMATE,
          units: { outputSeconds: 0, images: 1, requests: 1 },
          capabilities: {
            kind: "image",
            billing: "per_image",
            cancellation: "not_applicable",
            maxPromptCharacters: 4000,
            retention: { outputHours: null, providerStoresRequest: false },
          },
          perJobAllowanceMicroUsd: ALLOWANCE,
        },
        permissions: { ...permissions },
        jobs: [...jobs.values()]
          .filter((j) => j.releaseId === releaseId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(view),
        liveGenerationVerified: false,
      };
      return library;
    },
    async detail(jobId, signal) {
      await delay(signal);
      guard();
      return view(job(jobId));
    },
    async estimate(enrollmentId, episodeId, kind) {
      await delay();
      guard("request");
      const { release: r } = enrollmentRelease(enrollmentId);
      if (!r.episodes.some((e) => e.id === episodeId))
        throw new MediaActionError("MEDIA_EPISODE_OUT_OF_SCOPE");
      const available = Math.max(0, BUDGET - reserved(r.releaseId));
      const admissible = available >= ALLOWANCE;
      return {
        kind: kind ?? "video",
        estimateMicroUsd: kind === "image" ? IMAGE_ESTIMATE : ESTIMATE,
        reserveMicroUsd: ALLOWANCE,
        availableMicroUsd: available,
        admissible,
        reason: admissible ? null : "MEDIA_BUDGET_EXHAUSTED",
      };
    },
    request(enrollmentId, input, key) {
      return once(key, ["request", enrollmentId, input], () => {
        guard("request");
        if (!text(input.title) || !text(input.objective) || !text(input.script))
          throw new MediaActionError("INVALID_INPUT");
        if (input.script.length > 2000)
          throw new MediaActionError("MEDIA_PROMPT_TOO_LONG");
        fromBoard(input);
        const { release: r, enrollment } = enrollmentRelease(enrollmentId);
        const created = newJob(r, enrollment, {
          ...input,
          kind: "generated_short_video",
        });
        submitPaid(created);
        jobs.set(created.id, created);
        return view(created);
      });
    },
    requestImage(enrollmentId, input, key) {
      return once(key, ["image", enrollmentId, input], () => {
        guard("request");
        if (!text(input.title) || !text(input.objective) || !text(input.prompt))
          throw new MediaActionError("INVALID_INPUT");
        if (input.prompt.length > 2000)
          throw new MediaActionError("MEDIA_PROMPT_TOO_LONG");
        fromBoard(input);
        const { release: r, enrollment } = enrollmentRelease(enrollmentId);
        const created = newJob(r, enrollment, {
          ...input,
          script: input.prompt,
          kind: "generated_image",
        });
        submitPaid(created);
        jobs.set(created.id, created);
        return view(created);
      });
    },
    requestClip(enrollmentId, input, key) {
      return once(key, ["clip", enrollmentId, input], () => {
        guard("request");
        // The demo has no renderer; exact clips need the server's toolchain.
        throw new MediaActionError("MEDIA_CLIP_TOOLCHAIN_MISSING");
      });
    },
    compose(storyboardId, key) {
      return once(key, ["compose", storyboardId], () => {
        guard("request");
        const b = board(storyboardId);
        if (b.state !== "approved")
          throw new MediaActionError("MEDIA_STORYBOARD_NOT_APPROVED");
        throw new MediaActionError("MEDIA_CLIP_TOOLCHAIN_MISSING");
      });
    },
    async storyboards(releaseId, signal) {
      await delay(signal);
      guard();
      release(releaseId);
      return [...boards.values()]
        .filter((b) => b.releaseId === releaseId)
        .map(boardView);
    },
    createStoryboard(enrollmentId, input, key) {
      return once(key, ["storyboard", enrollmentId, input], () => {
        guard("request");
        // The demo has no drafting model; staff write the shots themselves.
        if (input.draftWith === "model")
          throw new MediaActionError("MEDIA_ASSISTANT_UNAVAILABLE");
        if (
          !text(input.title) ||
          !text(input.objective) ||
          !input.shots?.length ||
          input.shots.length > 8
        )
          throw new MediaActionError("INVALID_INPUT");
        const { release: r } = enrollmentRelease(enrollmentId);
        if (!r.episodes.some((e) => e.id === input.episodeId))
          throw new MediaActionError("MEDIA_EPISODE_OUT_OF_SCOPE");
        const created: Storyboard & { releaseId: string } = {
          releaseId: r.releaseId,
          id: demoUuid(`storyboard-${++sequence}`),
          enrollmentId,
          episodeId: input.episodeId,
          title: input.title.trim(),
          objective: input.objective.trim(),
          script: input.script,
          shots: clone(input.shots),
          referenceVisualId: input.referenceVisualId ?? null,
          draftedBy: "staff",
          draftStatus: "ready",
          state: "draft",
          revision: 1,
          reviewNote: null,
          updatedAt: iso(),
        };
        boards.set(created.id, created);
        return boardView(created);
      });
    },
    editStoryboard(storyboardId, expectedRevision, shots, key) {
      return once(key, ["edit", storyboardId, expectedRevision, shots], () => {
        guard("request");
        const b = board(storyboardId);
        if (b.state !== "draft")
          throw new MediaActionError("MEDIA_STORYBOARD_NOT_DRAFT");
        if (b.revision !== expectedRevision)
          throw new MediaActionError("MEDIA_STORYBOARD_REVISION_CONFLICT");
        if (!shots.length || shots.length > 8)
          throw new MediaActionError("INVALID_INPUT");
        b.shots = clone(shots);
        b.draftedBy = "staff";
        b.revision++;
        b.updatedAt = iso();
        return boardView(b);
      });
    },
    reviewStoryboard(storyboardId, expectedRevision, decision, key) {
      return once(
        key,
        ["review-board", storyboardId, expectedRevision, decision],
        () => {
          guard("review");
          const b = board(storyboardId);
          if (b.state !== "draft")
            throw new MediaActionError("MEDIA_STORYBOARD_NOT_DRAFT");
          if (b.revision !== expectedRevision)
            throw new MediaActionError("MEDIA_STORYBOARD_REVISION_CONFLICT");
          b.state = decision;
          b.revision++;
          b.updatedAt = iso();
          return boardView(b);
        },
      );
    },
    check(jobId, input, key) {
      return once(key, ["check", jobId, input], () => {
        guard("review");
        const j = job(jobId);
        if (j.state !== "under_review" || !j.asset)
          throw new MediaActionError("MEDIA_NOT_UNDER_REVIEW");
        if (!text(input.visualDescription))
          throw new MediaActionError("MEDIA_TEXT_ALTERNATIVE_REQUIRED");
        const result: MediaCheck = {
          rules: { verifier: "rules", verdict: "consistent", findings: [] },
          // The demo has no checking model; a model check is reported as not run.
          model: input.useModel
            ? {
                verifier: "model",
                verdict: "unverified",
                findings: [],
                failure: "MEDIA_ASSISTANT_UNAVAILABLE",
              }
            : null,
        };
        j.checks = [
          ...(j.checks ?? []),
          {
            id: demoUuid(`check-${++sequence}`),
            assetSha256: j.asset.sha256,
            verifier: "rules" as const,
            verdict: "consistent" as const,
            findings: [],
            at: iso(),
          },
        ].slice(-20);
        return result;
      });
    },
    review(jobId, input, key) {
      return once(key, ["review", jobId, input], () => {
        guard("review");
        const j = job(jobId);
        if (j.state !== "under_review" || !j.asset)
          throw new MediaActionError("MEDIA_NOT_UNDER_REVIEW");
        if (input.assetSha256 !== j.asset.sha256)
          throw new MediaActionError("MEDIA_ASSET_CHANGED");
        if (!text(input.rationale, 20))
          throw new MediaActionError("INVALID_INPUT");
        const approving = input.decision === "approved";
        const image = j.kind === "generated_image";
        if (approving) {
          if (!Object.values(input.findings).every(Boolean))
            throw new MediaActionError("MEDIA_REVIEW_FINDINGS_INCOMPLETE");
          if (!text(input.visualDescription, 20))
            throw new MediaActionError("MEDIA_TEXT_ALTERNATIVE_REQUIRED");
          if (!image && !/-->/.test(input.captionsVtt ?? ""))
            throw new MediaActionError("MEDIA_CAPTIONS_REQUIRED");
        }
        j.review = {
          id: demoUuid(`review-${++sequence}`),
          decision: input.decision,
          assetSha256: j.asset.sha256,
          rationale: input.rationale.trim(),
          hasCaptions: approving && !image,
          transcript: approving ? (input.transcript?.trim() ?? null) : null,
          visualDescription: approving
            ? (input.visualDescription?.trim() ?? null)
            : null,
          reviewedAt: iso(),
        };
        move(j, input.decision, approving ? null : "MEDIA_REVIEW_REJECTED");
        if (!approving) j.failureCode = "MEDIA_REVIEW_REJECTED";
        return { jobId, state: j.state, reviewId: j.review.id };
      });
    },
    attach(jobId, expiresAt, key) {
      return once(key, ["attach", jobId, expiresAt], () => {
        guard("attach");
        const j = job(jobId);
        if (j.state !== "approved")
          throw new MediaActionError("MEDIA_NOT_APPROVED");
        const at = Date.parse(expiresAt);
        if (
          Number.isNaN(at) ||
          at <= now().getTime() ||
          at > now().getTime() + 366 * 86_400_000
        )
          throw new MediaActionError("MEDIA_EXPIRY_INVALID");
        j.attachment = {
          id: demoUuid(`attachment-${++sequence}`),
          episodeId: j.episodeId,
          expiresAt: new Date(at).toISOString(),
          state: "active",
          revokedAt: null,
          revokeReason: null,
        };
        move(j, "attached");
        j.learnerVisible = true;
        return { jobId, attachmentId: j.attachment.id };
      });
    },
    cancel(jobId, key) {
      return once(key, ["cancel", jobId], () => {
        guard("request");
        const j = job(jobId);
        const cancellable = [
          "requested",
          "admitted",
          "submitted",
          "polling",
          "uncertain",
          "generated",
          "under_review",
          "approved",
        ];
        if (!cancellable.includes(j.state))
          throw new MediaActionError("MEDIA_NOT_CANCELLABLE");
        // A request already at the provider may still finish there; its reserve stays spent.
        j.remoteMayContinue = ["submitted", "polling", "uncertain"].includes(
          j.state,
        );
        move(j, "cancelled", "MEDIA_CANCELLED");
        j.failureCode = "MEDIA_CANCELLED";
        return { jobId, state: j.state };
      });
    },
    revoke(attachmentId, reason, key) {
      return once(key, ["revoke", attachmentId, reason], () => {
        guard("review");
        const j = [...jobs.values()].find(
          (item) => item.attachment?.id === attachmentId,
        );
        if (!j?.attachment) throw new MediaActionError("INVALID_INPUT");
        if (j.attachment.state === "revoked")
          throw new MediaActionError("MEDIA_ATTACHMENT_ALREADY_REVOKED");
        if (!text(reason)) throw new MediaActionError("INVALID_INPUT");
        j.attachment.state = "revoked";
        j.attachment.revokedAt = iso();
        j.attachment.revokeReason = reason.trim();
        j.learnerVisible = false;
        j.events = [
          ...(j.events ?? []),
          { from: j.state, to: j.state, code: "MEDIA_REVOKED", at: iso() },
        ];
        j.updatedAt = iso();
        return { attachmentId, state: "revoked" };
      });
    },
    assetUrl(jobId) {
      return jobs.get(jobId)?.asset ? PLACEHOLDER : "";
    },
  };
}
