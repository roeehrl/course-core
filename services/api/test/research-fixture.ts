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
