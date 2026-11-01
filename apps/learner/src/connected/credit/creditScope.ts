import type { ServerSnapshot } from "../../client/apiClient";

/**
 * The open checks a companion message would turn into practice: every open independent check of
 * the enrollment that has not expired (the server decides; this previews it). The lesson and an
 * attached check are accepted for the narrower scope the server will apply.
 */
export function creditScope(
  server: Pick<ServerSnapshot, "activeChallenges"> | undefined,
  _episodeId: string | undefined,
  now: number,
  _attachedChallengeId?: string,
): string[] {
  return (
    server?.activeChallenges
      .filter(
        (item) =>
          item.independentEligible &&
          (!item.expiresAt || !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) > now),
      )
      .map((item) => item.challengeId) ?? []
  );
}
