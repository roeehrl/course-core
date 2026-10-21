import type { CourseApi } from "./apiClient";
import { safeHttpsUrl } from "../connected/resources";

/** Reviewed external help attached by staff. Optional and never credit-bearing. */
export interface EpisodeResource {
  id: string;
  title: string;
  url: string;
  excerpts: string[];
  whyUseful: string;
  reviewedAt: string;
  expiresAt: string;
  rightsUse: "link_only" | "excerpt" | "embed";
  attributions: { providerName: string; authorName?: string; requiredNotice?: string }[];
  youtube?: {
    videoId: string;
    embedSrc: string;
    title: string;
    fallbackText: string;
    /** The part of the video a reviewer watched, when one was recorded. */
    segment?: { startSeconds: number; endSeconds: number };
  };
  /** Objectives for which a verified supervisor plan suggested this resource to this learner. */
  suggestedFor: string[];
}
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;

/** Strictly re-validates every display field; anything unexpected is dropped
 * rather than rendered. Only HTTPS links and the nocookie embed host load. */
export function parseResources(data: unknown): EpisodeResource[] {
  const body = data as { resources?: unknown; grantsCredit?: unknown; optional?: unknown };
  if (!body || body.grantsCredit !== false || body.optional !== true || !Array.isArray(body.resources))
    throw new Error("INVALID_RESOURCES");
  return body.resources.slice(0, 10).flatMap((raw): EpisodeResource[] => {
    const r = raw as Record<string, unknown>;
    const id = text(r.id, 64),
      title = text(r.title, 300),
      url = safeHttpsUrl(text(r.url, 2048)),
      why = text(r.whyUseful, 2000),
      reviewedAt = text(r.reviewedAt, 64),
      expiresAt = text(r.expiresAt, 64),
      rightsUse = r.rightsUse;
    if (!id || !title || !url || !why || !reviewedAt || !expiresAt) return [];
    if (rightsUse !== "link_only" && rightsUse !== "excerpt" && rightsUse !== "embed") return [];
    const excerpts = Array.isArray(r.excerpts)
      ? r.excerpts.flatMap((e) => (text(e, 800) ? [e as string] : [])).slice(0, 5)
      : [];
    const attributions = Array.isArray(r.attributions)
      ? r.attributions.slice(0, 3).flatMap((a) => {
          const v = a as Record<string, unknown>,
            providerName = text(v.providerName, 200);
          if (!providerName) return [];
          const authorName = text(v.authorName, 300),
            requiredNotice = text(v.requiredNotice, 1000);
          return [{ providerName, ...(authorName ? { authorName } : {}), ...(requiredNotice ? { requiredNotice } : {}) }];
        })
      : [];
    let youtube: EpisodeResource["youtube"];
    const y = r.youtube as
      | { videoId?: unknown; embed?: { src?: unknown; title?: unknown }; fallback?: { text?: unknown }; segment?: { startSeconds?: unknown; endSeconds?: unknown } | null }
      | undefined;
    if (rightsUse === "embed" && y) {
      const videoId = text(y.videoId, 11),
        src = text(y.embed?.src, 2048),
        fallbackText = text(y.fallback?.text, 10000);
      if (
        videoId &&
        /^[A-Za-z0-9_-]{11}$/.test(videoId) &&
        src === `https://www.youtube-nocookie.com/embed/${videoId}?playsinline=1&rel=0` &&
        fallbackText
      )
      {
        const start = y.segment?.startSeconds, end = y.segment?.endSeconds;
        const segment = Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0 && (end as number) > (start as number) && (end as number) <= 86400
          ? { startSeconds: start as number, endSeconds: end as number } : undefined;
        youtube = { videoId, embedSrc: src, title: text(y.embed?.title, 300) ?? title, fallbackText, ...(segment ? { segment } : {}) };
      }
    }
    const suggestedFor = Array.isArray(r.suggestedFor)
      ? r.suggestedFor.flatMap((o) => (typeof o === "string" && /^[a-z][a-z0-9._:-]{0,127}$/.test(o) ? [o] : [])).slice(0, 10)
      : [];
    return [{ id, title, url, excerpts, whyUseful: why, reviewedAt, expiresAt, rightsUse, attributions, suggestedFor, ...(youtube ? { youtube } : {}) }];
  });
}
/** Course-made help: a generated video, exact clip or image, approved and attached by staff.
 * An image has no captions or transcript; its visual description is its alt text. */
export interface GeneratedMedia {
  id: string;
  title: string;
  objective: string;
  transcript: string;
  visualDescription: string;
  assetUrl: string;
  captionsUrl: string | null;
  mimeType: "video/mp4" | "video/webm" | "image/png" | "image/jpeg" | "image/webp";
  reviewedAt: string;
  expiresAt: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Never trusts server-sent URLs: asset and caption paths are rebuilt for this
 * enrollment from a validated id. Anything credit-bearing or malformed is dropped. */
export function parseGeneratedMedia(data: unknown, enrollmentId: string): GeneratedMedia[] {
  const body = data as { media?: unknown; grantsCredit?: unknown; optional?: unknown };
  if (!body || body.grantsCredit !== false || body.optional !== true || !Array.isArray(body.media)) throw new Error("INVALID_MEDIA");
  const base = `/api/enrollments/${encodeURIComponent(enrollmentId)}/media`;
  return body.media.slice(0, 5).flatMap((raw): GeneratedMedia[] => {
    const r = raw as Record<string, unknown>;
    const id = text(r.id, 36),
      title = text(r.title, 200),
      objective = text(r.objective, 2000),
      transcript = text(r.transcript, 20000),
      visualDescription = text(r.visualDescription, 5000),
      reviewedAt = text(r.reviewedAt, 64),
      expiresAt = text(r.expiresAt, 64),
      mimeType = r.mimeType;
    const video = mimeType === "video/mp4" || mimeType === "video/webm";
    const image = mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp";
    if (!id || !uuid.test(id) || !title || !objective || (video && !transcript) || !visualDescription || !reviewedAt || !expiresAt || r.generated !== true) return [];
    if (!video && !image) return [];
    return [{ id, title, objective, transcript: transcript ?? "", visualDescription, reviewedAt, expiresAt, mimeType,
      assetUrl: `${base}/${id}/asset`, captionsUrl: video ? `${base}/${id}/captions.vtt` : null }];
  });
}
export function createResourcesClient(api: Pick<CourseApi, "request">) {
  return {
    async media(enrollmentId: string, episodeId: string, signal?: AbortSignal) {
      return parseGeneratedMedia(
        await api.request(
          `/api/enrollments/${encodeURIComponent(enrollmentId)}/media?episodeId=${encodeURIComponent(episodeId)}`,
          "GET",
          undefined,
          { signal },
        ),
        enrollmentId,
      );
    },
    async episode(enrollmentId: string, episodeId: string, signal?: AbortSignal) {
      return parseResources(
        await api.request(
          `/api/enrollments/${encodeURIComponent(enrollmentId)}/resources?episodeId=${encodeURIComponent(episodeId)}`,
          "GET",
          undefined,
          { signal },
        ),
      );
    },
  };
}
export type ResourcesClient = ReturnType<typeof createResourcesClient>;
