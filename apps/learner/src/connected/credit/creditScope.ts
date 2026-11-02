import type { ServerSnapshot } from "../../client/apiClient";
import { questionOrdinal } from "../checkOrdinal";

type Snapshot = Pick<ServerSnapshot, "activeChallenges">;

/** Open, not expired, and still counted. */
const counted = (item: ServerSnapshot["activeChallenges"][number], now: number) =>
  item.independentEligible &&
  (!item.expiresAt || !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) > now);

/**
 * The open counted questions a companion message would turn into practice: those of the lesson it
 * is asked from, and the question attached to it, wherever that is. Open counted questions of other
 * lessons stay counted. The server decides (services/api/src/companion-ask-route.ts,
 * `companionCreditScope`); this previews the same rule so the learner is asked before sending.
 */
export function creditScope(
  server: Snapshot | undefined,
  episodeId: string | undefined,
  now: number,
  attachedChallengeId?: string,
): string[] {
  return (
    server?.activeChallenges
      .filter(
        (item) =>
          counted(item, now) &&
          ((episodeId !== undefined && item.episodeId === episodeId) || (attachedChallengeId !== undefined && item.challengeId === attachedChallengeId)),
      )
      .map((item) => item.challengeId) ?? []
  );
}

/**
 * What the credit line and the confirm name, or none when nothing in scope counts. One question in
 * scope is named by the number the lesson's check shows ("Question 1", checkOrdinal.ts): the
 * attached question when it is in scope, otherwise the lesson's. Several (a lesson's check and a
 * retention item, say) are all made practice by the server, so the line and the confirm say how
 * many (`count`) instead of naming one of them.
 */
export function scopedQuestion(
  server: Pick<ServerSnapshot, "activeChallenges" | "lessons"> | undefined,
  episodeId: string | undefined,
  now: number,
  attachedChallengeId?: string,
): { challengeIds: string[]; ordinal: number; count: number } | undefined {
  const challengeIds = creditScope(server, episodeId, now, attachedChallengeId);
  if (!server || !challengeIds.length) return undefined;
  const named =
    server.activeChallenges.find((item) => item.challengeId === attachedChallengeId && challengeIds.includes(item.challengeId)) ??
    server.activeChallenges.find((item) => challengeIds.includes(item.challengeId))!;
  return { challengeIds, ordinal: questionOrdinal(server, named.episodeId), count: challengeIds.length };
}
