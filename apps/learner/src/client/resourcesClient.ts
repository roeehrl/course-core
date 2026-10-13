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
  youtube?: { videoId: string; embedSrc: string; title: string; fallbackText: string };
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
      | { videoId?: unknown; embed?: { src?: unknown; title?: unknown }; fallback?: { text?: unknown } }
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
        youtube = { videoId, embedSrc: src, title: text(y.embed?.title, 300) ?? title, fallbackText };
    }
    return [{ id, title, url, excerpts, whyUseful: why, reviewedAt, expiresAt, rightsUse, attributions, ...(youtube ? { youtube } : {}) }];
  });
}
export function createResourcesClient(api: Pick<CourseApi, "request">) {
  return {
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
