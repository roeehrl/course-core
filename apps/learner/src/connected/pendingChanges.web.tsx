import React, { createContext, startTransition, useContext, useEffect, useRef, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";
import { Icon } from "../components/icons/Icon.web";
import { useT } from "../i18n";
import { lessonNavigator } from "./companion/bridge";
import { PreparingDots } from "./ui/PreparingDots.web";

/** A generated addition that waits for the learner to finish their current attempt
 * (the server's safe-boundary rule). Its content is not shown before it is added. */
export interface PendingChange {
  pendingId: string;
  episodeId: string;
  episodeTitle: string;
  kind: string;
  reason: string;
  addableNow: boolean;
  waitingFor?: string;
}

/** Waiting changes for this enrollment, reloaded whenever the learner's course revision changes. */
export function usePendingChanges(api: CourseApi, enrollmentId: string | undefined, revision: number) {
  const [items, setItems] = useState<PendingChange[]>([]);
  useEffect(() => {
    if (!enrollmentId) return setItems([]);
    // A background reload after a revision: applied as a transition, so it never holds back the
    // paint of what the learner just did (an answer's result, a started check).
    const controller = new AbortController();
    api
      .request<{ pending: PendingChange[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/personal-changes/pending`, "GET", undefined, {
        signal: controller.signal,
      })
      .then((value) => !controller.signal.aborted && startTransition(() => setItems(value.pending ?? [])))
      // Without the list nothing waiting is offered; the change still waits on the server.
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && startTransition(() => setItems([])));
    return () => controller.abort();
  }, [api, enrollmentId, revision]);
  return items;
}

/**
 * What the lesson tells the offer (ConnectedLesson.web.tsx provides it): the learner's plan
 * revision, which moves when an addition is applied and stays when it lapsed, the lesson's parts,
 * and whether a part can be shown now (a part read, or the next one to read).
 */
export interface LessonPlace {
  planRevision?: number;
  episodeId: string;
  blocks: readonly { id: string; type: string }[];
  showable: (blockId: string) => boolean;
}
export const LessonPlaceContext = createContext<LessonPlace | null>(null);

type Outcome = { state: "added" | "declined" | "gone"; item: PendingChange; goTo?: string };
type Choice = { pendingId: string; kind: "add" | "decline"; planRevision?: number; blocks: string[]; settled: number | null };
/** How long a choice waits, once no request is running, for the waiting list to drop the addition
 * before it is offered again (the request failed or never started). */
const SETTLE_MS = 4000;
const READABLE = ["text", "visual", "media"];

/**
 * New material for this lesson (§4.6, 18c), at its end: what it is, why it is here, and the
 * learner's choice. While it waits for a safe point (the server's rule) it says so and cannot be
 * added yet. After a choice the card says what happened: "Preparing it…" while it is added, then
 * added (with "Go to it"), not added, or no longer available.
 */
export function PendingChangesNotice({
  items,
  episodeId,
  pending,
  onAdd,
  onDecline,
}: {
  items: PendingChange[];
  episodeId: string;
  pending: boolean;
  onAdd: (pendingId: string) => void;
  onDecline: (pendingId: string) => void;
}) {
  const t = useT();
  const place = useContext(LessonPlaceContext);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const seen = useRef(new Map<string, PendingChange>());
  // The card whose choice was just made: its pressed button goes, so the line that says what is
  // happening takes the focus, and then the line that says what happened.
  const focusAfter = useRef<string | null>(null);
  const here = items.filter((item) => item.episodeId === episodeId);
  for (const item of here) seen.current.set(item.pendingId, item);
  // A choice is settled once the host's request is over; the addition then leaves the waiting list
  // (added, turned down or lapsed), or, after a failed request, stays and is offered again.
  useEffect(() => {
    if (!choice) return;
    if (pending) return;
    const listed = items.some((item) => item.pendingId === choice.pendingId);
    if (!listed) {
      const item = seen.current.get(choice.pendingId);
      setChoice(null);
      if (!item) return;
      const applied = choice.kind === "add" && (place?.planRevision ?? 0) > (choice.planRevision ?? 0);
      const added = place?.blocks.find((block) => !choice.blocks.includes(block.id) && READABLE.includes(block.type));
      setOutcomes((all) => [
        ...all.filter((row) => row.item.pendingId !== item.pendingId),
        { state: choice.kind === "decline" ? "declined" : applied ? "added" : "gone", item, ...(applied && added ? { goTo: added.id } : {}) },
      ]);
      return;
    }
    if (choice.settled === null) return setChoice({ ...choice, settled: Date.now() });
    const timer = setTimeout(() => setChoice((now) => (now === choice ? null : now)), Math.max(0, choice.settled + SETTLE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [choice, items, pending, place?.planRevision, place?.blocks]);
  const choose = (item: PendingChange, kind: Choice["kind"]) => {
    focusAfter.current = item.pendingId;
    setChoice({ pendingId: item.pendingId, kind, planRevision: place?.planRevision, blocks: place?.blocks.map((block) => block.id) ?? [], settled: null });
    (kind === "add" ? onAdd : onDecline)(item.pendingId);
  };
  const takeFocus = (id: string, last: boolean) => (line: HTMLParagraphElement | null) => {
    if (!line || focusAfter.current !== id) return;
    const active = document.activeElement;
    if (active && active !== document.body && !line.parentElement?.contains(active)) return;
    line.focus({ preventScroll: true });
    if (last) focusAfter.current = null;
  };
  // Each card keeps its place while its choice settles and after, so focus and reading stay put.
  const kept = (id: string) => choice?.pendingId === id || outcomes.some((row) => row.item.pendingId === id);
  const shown = [...seen.current.values()].filter((item) => item.episodeId === episodeId && (here.includes(item) || kept(item.pendingId)));
  if (!shown.length) return null;
  return (
    <div className="cc-ai-offers">
      {shown.map((item) => {
        const outcome = outcomes.find((row) => row.item.pendingId === item.pendingId);
        const preparing = choice?.pendingId === item.pendingId && choice.kind === "add";
        const titleId = `pending-title-${item.pendingId}`, waitId = `pending-wait-${item.pendingId}`;
        const goTo = outcome?.goTo && place?.showable(outcome.goTo) ? outcome.goTo : undefined;
        return (
          <section key={item.pendingId} className="connected-pending cc-ai-offer" data-state={outcome?.state ?? (preparing ? "preparing" : item.addableNow ? "ready" : "waiting")}
            aria-labelledby={titleId}>
            <h2 id={titleId} className={outcome || preparing ? "cc-ui-sr-only" : "cc-ai-offer-title"}>
              {!outcome && !preparing && <Icon name="sparkle" size={16} />}
              <span>{t("pendingChanges.title", { kind: item.kind })}</span>
            </h2>
            {outcome ? (
              <p ref={takeFocus(item.pendingId, true)} tabIndex={-1} className={outcome.state === "declined" ? "cc-ai-offer-outcome is-muted" : "cc-ai-offer-outcome"}>
                {outcome.state === "added" && <Icon name="check" size={16} />}
                {outcome.state === "gone" && <Icon name="alert-circle" size={16} />}
                <span>{t(outcome.state === "added" ? "pendingChanges.added" : outcome.state === "declined" ? "pendingChanges.declined" : "pendingChanges.lapsed")}</span>
                {goTo && (
                  <button type="button" className="cc-ui-text-button" onClick={() => lessonNavigator.show({ episodeId: place?.episodeId, blockId: goTo, focus: "block" })}>
                    {t("pendingChanges.goTo")}
                  </button>
                )}
              </p>
            ) : preparing ? (
              <p ref={takeFocus(item.pendingId, false)} tabIndex={-1} className="cc-ai-offer-preparing">
                <PreparingDots />
                <span>{t("pendingChanges.preparing")}</span>
              </p>
            ) : (
              <>
                <p className="cc-ai-offer-body">{t("pendingChanges.body")}</p>
                {!item.addableNow && (
                  <p className="cc-ai-offer-body" id={waitId}>
                    {t(item.waitingFor === "activity_in_progress" ? "pendingChanges.waitingActivity" : "pendingChanges.waitingAttempt")}
                  </p>
                )}
                <div className="cc-ai-offer-actions">
                  <button
                    type="button"
                    className="cc-ui-pill cc-ui-pill-accent cc-ui-pill-40"
                    disabled={pending || !item.addableNow}
                    aria-describedby={item.addableNow ? undefined : waitId}
                    onClick={() => choose(item, "add")}
                  >
                    {t("pendingChanges.add")}
                  </button>
                  <button type="button" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-40" disabled={pending} onClick={() => choose(item, "decline")}>
                    {t("pendingChanges.decline")}
                  </button>
                </div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Keeps the learner's place while a waiting change is added (E03): the part of the lesson at the
 * top of their view (or the control they had focused) stays where it was on screen, and focus
 * stays on it. Call before the change; call the returned function once it has been applied.
 * A focused control inside a sticky bar (the answer actions) never moves on screen, so it is not
 * used as the anchor; the first visible part of the lesson is.
 */
export function keepLessonPlace(scroller: () => HTMLElement | null): () => void {
  if (typeof document === "undefined") return () => {};
  const lesson = document.querySelector<HTMLElement>(".connected-lesson-keeper");
  if (!lesson) return () => {};
  const focused = document.activeElement instanceof HTMLElement && lesson.contains(document.activeElement) ? document.activeElement : null;
  const sticky = (element: HTMLElement) => {
    for (let node: HTMLElement | null = element; node && node !== lesson; node = node.parentElement)
      if (getComputedStyle(node).position === "sticky") return true;
    return false;
  };
  const anchor =
    (focused && !sticky(focused) ? focused : null) ??
    Array.from(lesson.querySelectorAll<HTMLElement>("h1, h2, h3, p, section, [data-presence-block]")).find(
      (element) => !element.closest("[hidden]") && element.getBoundingClientRect().bottom > 0,
    ) ??
    null;
  if (!anchor) return () => {};
  const top = anchor.getBoundingClientRect().top;
  return () => {
    // After React has rendered the refreshed lesson.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!anchor.isConnected) return;
        const moved = anchor.getBoundingClientRect().top - top;
        if (moved) (scroller() ?? window).scrollBy?.({ top: moved, behavior: "instant" });
        if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
      }),
    );
  };
}
