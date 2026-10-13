import React, { useEffect, useState } from "react";
import type { CourseApi } from "../client/apiClient";
import type { RetentionPanelProps } from "./RetentionPanel";

interface RetentionItem {
  objectiveId: string;
  description: string;
  state: "demonstrated" | "retained" | "needs_review";
  dueAt: string | null;
  due: boolean;
  freshItemsLeft: number;
}
const label = { demonstrated: "Shown once", retained: "Retained", needs_review: "Worth reviewing" } as const;
const when = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));

/** Delayed independent checks. They record retention beside demonstrated
 * understanding and never change completion or unlock steps. */
export function RetentionPanel({ api, enrollmentId, revision, onStart }: RetentionPanelProps) {
  const [items, setItems] = useState<RetentionItem[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ available: boolean; items: RetentionItem[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/retention`, "GET", undefined, { signal: controller.signal })
      .then((v) => !controller.signal.aborted && setItems(v.available ? v.items : []))
      .catch(() => !controller.signal.aborted && setItems([]));
    return () => controller.abort();
  }, [api, enrollmentId, revision]);
  if (!items.length) return null;
  return (
    <section className="connected-reading-card connected-retention" aria-labelledby="retention-title">
      <p className="connected-eyebrow">OPTIONAL · KEEP IT</p>
      <h2 id="retention-title">Delayed checks</h2>
      <p className="connected-muted">
        A fresh question days later shows what stayed with you. It never changes your progress; a miss just schedules a review.
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.objectiveId}>
            <div>
              <strong>{item.description}</strong>
              <span className="connected-muted">
                {" "}· {label[item.state]}
                {item.dueAt && !item.due ? ` · next check ${when(item.dueAt)}` : ""}
                {!item.dueAt ? " · schedule complete" : ""}
              </span>
            </div>
            {item.due && (item.freshItemsLeft > 0 ? (
              <button
                type="button"
                className="connected-button"
                disabled={Boolean(busy)}
                onClick={async () => {
                  setBusy(item.objectiveId);
                  setError("");
                  try {
                    await onStart(item.objectiveId);
                  } catch {
                    setError("The check could not start. Nothing changed; try again.");
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Take the delayed check
              </button>
            ) : (
              <span className="connected-muted">No unseen questions remain for this check.</span>
            ))}
          </li>
        ))}
      </ul>
      <div aria-live="polite">{error && <p role="alert" className="connected-error-text">{error}</p>}</div>
    </section>
  );
}
