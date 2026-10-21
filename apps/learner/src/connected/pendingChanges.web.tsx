import React, { useCallback, useEffect, useState } from "react";
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
    const controller = new AbortController();
    api
      .request<{ pending: PendingChange[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/personal-changes/pending`, "GET", undefined, {
        signal: controller.signal,
      })
      .then((value) => !controller.signal.aborted && setItems(value.pending ?? []))
      // Without the list nothing waiting is offered; the change still waits on the server.
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && setItems([]));
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
              <Button
                label={t("pendingChanges.add")}
                kind="primary"
                disabled={pending || !item.addableNow}
                describedBy={`pending-note-${item.pendingId}`}
                onPress={() => onAdd(item.pendingId)}
              />
              <Button label={t("pendingChanges.decline")} kind="quiet" disabled={pending} onPress={() => onDecline(item.pendingId)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
