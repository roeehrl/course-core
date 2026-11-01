/**
 * The one item above the composer (final design §3.6, §3.13, G10). Limitations come as banners;
 * the credit line (credit's `CreditNotice`) sits there when nothing else does. Only one item shows,
 * by priority; when a banner takes the place while the credit line applies, the credit line moves
 * to the meta line under the pill, so it is never dropped.
 */
export type PausedCeiling = "workspace" | "enrollment" | "daily" | "artifact";

export type Notice =
  /** Every question a closed course allows is used: replaces the pill. */
  | { kind: "exhausted" }
  /** A spending limit holds a question: help is paused (which one says why). */
  | { kind: "paused"; ceiling: PausedCeiling }
  | { kind: "notSetUp" }
  | { kind: "lessonUnavailable" }
  | { kind: "outsideLesson"; next?: { episodeId: string; title: string } }
  | { kind: "offline" }
  | { kind: "draftConflict" }
  | { kind: "recovered" }
  | { kind: "storage" }
  /** A closed course with questions left. */
  | { kind: "closed"; remaining: number; used?: number; budget?: number }
  | { kind: "credit" };

export interface NoticeInput {
  exhausted?: boolean;
  paused?: PausedCeiling;
  notSetUp?: boolean;
  lessonUnavailable?: boolean;
  outsideLesson?: boolean;
  next?: { episodeId: string; title: string };
  offline?: boolean;
  draftConflict?: boolean;
  recovered?: boolean;
  storage?: boolean;
  closed?: { remaining: number; used?: number; budget?: number };
  /** An open counted question is in scope: the credit line applies. */
  credit?: boolean;
}

/** The order of the notice slot, highest first. */
export const NOTICE_PRIORITY = [
  "exhausted",
  "paused",
  "notSetUp",
  "lessonUnavailable",
  "outsideLesson",
  "offline",
  "draftConflict",
  "recovered",
  "storage",
  "closed",
  "credit",
] as const satisfies readonly Notice["kind"][];

/** The notice slot's item, and whether the credit line moves to the meta line. */
export function chooseNotice(input: NoticeInput): { notice?: Notice; creditInMeta: boolean } {
  const banner: Notice | undefined = input.exhausted
    ? { kind: "exhausted" }
    : input.paused
      ? { kind: "paused", ceiling: input.paused }
      : input.notSetUp
        ? { kind: "notSetUp" }
        : input.lessonUnavailable
          ? { kind: "lessonUnavailable" }
          : input.outsideLesson
            ? { kind: "outsideLesson", ...(input.next ? { next: input.next } : {}) }
            : input.offline
              ? { kind: "offline" }
              : input.draftConflict
                ? { kind: "draftConflict" }
                : input.recovered
                  ? { kind: "recovered" }
                  : input.storage
                    ? { kind: "storage" }
                    : input.closed && input.closed.remaining > 0
                      ? { kind: "closed", ...input.closed }
                      : undefined;
  if (banner) return { notice: banner, creditInMeta: Boolean(input.credit) && banner.kind !== "exhausted" };
  return input.credit ? { notice: { kind: "credit" }, creditInMeta: false } : { creditInMeta: false };
}
