import { createHash } from "node:crypto";
import type { SourceInspection } from "@course-core/research";
import { inspectionDigest, ResearchError } from "@course-core/research/node";
import type { ResearchInspectorPort, ResearchPrincipalInput } from "../src/research-review.js";

export const researchPage =
  "Finding a minimum means comparing every candidate against the best value seen so far. " +
  "Each comparison keeps the smaller value, so after the last element the kept value is no greater than any member.";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/** Test-only inspector. It mirrors the engine contract: the trusted policy alone
 * supplies URLs, and the digest-bound result is never fetched from a network. */
export function syntheticResearchInspector(options: {
  record?: { policy: ResearchPrincipalInput["policy"]; sourceId: string }[];
  failNext?: () => string | undefined;
} = {}): ResearchInspectorPort {
  return {
    async inspect(principal, request) {
      options.record?.push({ policy: principal.policy, sourceId: request.sourceId });
      const failure = options.failNext?.();
      if (failure) throw new ResearchError(failure as never);
      const source = principal.policy.sources.find((s) => s.id === request.sourceId)!;
      const youtube = source.kind === "youtube";
      const videoId = youtube ? new URL(source.url).searchParams.get("v")! : "";
      const text = youtube ? (source.fallback?.text ?? "") : researchPage;
      const body: Omit<SourceInspection, "inspectionId"> = {
        formatVersion: 1,
        state: "unreviewed",
        trust: "untrusted_external_content",
        policy: {
          id: principal.policy.id,
          revision: principal.policy.revision,
          approvalId: principal.policy.approvalId,
          approvedBy: principal.policy.approvedBy,
        },
        sourceId: source.id,
        topicId: request.topicId,
        kind: source.kind,
        title: youtube ? "Minimum walkthrough" : "Finding a minimum",
        content: {
          text,
          digest: sha(text),
          truncated: false,
          basis: youtube ? (source.fallback ? "author_fallback" : "metadata_only") : "page",
        },
        provenance: {
          requestedUrl: source.url,
          finalUrl: source.url,
          fetchedAt: new Date().toISOString(),
          bodyDigest: sha("body:" + source.url),
          bytes: 512,
          mediaType: youtube ? "application/json" : "text/html",
          hops: [{ url: source.url, address: "93.184.215.14", family: 4, status: 200 }],
          extractionVersion: "readable-text-v1",
          metadataAvailability: "available",
        },
        attributions: [{ trust: "untrusted_provider_metadata", providerName: youtube ? "YouTube" : "docs.python.org" }],
        ...(youtube
          ? {
              youtube: {
                videoId,
                watchUrl: "https://www.youtube.com/watch?v=" + videoId,
                embed: {
                  src: `https://www.youtube-nocookie.com/embed/${videoId}?playsinline=1&rel=0`,
                  title: "Minimum walkthrough",
                  aspectRatio: "16:9" as const,
                  requiresUserActivation: true as const,
                  referrerPolicy: "strict-origin-when-cross-origin" as const,
                  allow: "fullscreen; encrypted-media; picture-in-picture" as const,
                  loading: "lazy" as const,
                },
                attribution: null,
                transcript: { status: "not_provided" as const },
                fallback: source.fallback
                  ? { text: source.fallback.text, source: "author" as const, reference: source.fallback.reference }
                  : { text: "Open the video on YouTube.", source: "default" as const, reference: null },
              },
            }
          : {}),
      };
      return { ...body, inspectionId: inspectionDigest(body) };
    },
  };
}

/** Test-only stand-in for the YouTube Data API: deterministic synthetic metadata, no network.
 * It refuses any request without a header key or with a key in the URL. */
export function syntheticYouTubeFetch(record?: { url: URL; key: string | undefined }[]): typeof fetch {
  const videos = [
    { videoId: "aB_cD-eF123", title: "Running minimum, step by step", channelTitle: "Public algorithms channel", duration: "PT4M13S", caption: "true", embeddable: true },
    { videoId: "zZ9_yY8-xX7", title: "Minimum of a list in five minutes", channelTitle: "Open lecture notes", duration: "PT5M", caption: "false", embeddable: false },
  ];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), key = (init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"];
    record?.push({ url, key });
    if (!key || url.search.includes(key)) return new Response('{"error":{"errors":[{"reason":"keyInvalid"}]}}', { status: 400 });
    if (url.pathname.endsWith("/i18nLanguages")) return Response.json({ kind: "youtube#i18nLanguageListResponse", items: [] });
    if (url.pathname.endsWith("/search"))
      return Response.json({ items: videos.map((v) => ({ id: { kind: "youtube#video", videoId: v.videoId }, snippet: { title: v.title, channelTitle: v.channelTitle } })) });
    return Response.json({ items: videos.map((v) => ({ id: v.videoId, contentDetails: { duration: v.duration, caption: v.caption }, status: { embeddable: v.embeddable } })) });
  }) as typeof fetch;
}
