import React, { startTransition, useCallback, useEffect, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";
import { Button } from "../components/ui";
import { useT } from "../i18n";

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
 * What is waiting for this lesson, why it waits, and the learner's choice: add it once they are
 * at a safe point (the server checks again) or turn it down. Shown above the lesson content.
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
  const here = items.filter((item) => item.episodeId === episodeId);
  const describe = useCallback(
    (item: PendingChange) =>
      item.addableNow
        ? t("pendingChanges.ready")
        : item.waitingFor === "activity_in_progress"
          ? t("pendingChanges.waitingActivity")
          : t("pendingChanges.waitingAttempt"),
    [t],
  );
  if (!here.length) return null;
  return (
    <section className="connected-pending" aria-labelledby="connected-pending-title">
      <h2 id="connected-pending-title">{t("pendingChanges.title")}</h2>
      <ul>
        {here.map((item) => (
          <li key={item.pendingId}>
            <p>
              <strong>{t("pendingChanges.kind", { kind: item.kind })}</strong> {describe(item)}
            </p>
            <p className="connected-muted" id={`pending-note-${item.pendingId}`}>
              {t("pendingChanges.note")}
            </p>
            <div className="connected-pending-actions">
              <Button label={t("pendingChanges.decline")} kind="quiet" disabled={pending} onPress={() => onDecline(item.pendingId)} />
              <Button
                label={t("pendingChanges.add")}
                kind="primary"
                disabled={pending || !item.addableNow}
                describedBy={`pending-note-${item.pendingId}`}
                onPress={() => onAdd(item.pendingId)}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
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
