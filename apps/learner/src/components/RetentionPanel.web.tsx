import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";
import type { RetentionPanelProps } from "./RetentionPanel";
import { useI18n, type MessageKey } from "../i18n";

interface RetentionItem {
  objectiveId: string;
  description: string;
  state: "demonstrated" | "retained" | "needs_review";
  dueAt: string | null;
  due: boolean;
  freshItemsLeft: number;
}

/** Delayed independent checks. They record retention beside demonstrated
 * understanding and never change completion or unlock steps. */
export function RetentionPanel({ api, enrollmentId, revision, onStart }: RetentionPanelProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const [items, setItems] = useState<RetentionItem[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ available: boolean; items: RetentionItem[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/retention`, "GET", undefined, { signal: controller.signal })
      .then((v) => !controller.signal.aborted && setItems(v.available ? v.items : []))
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && setItems([]));
    return () => controller.abort();
  }, [api, enrollmentId, revision]);
  if (!items.length) return null;
  return (
    <section className="connected-reading-card connected-retention" aria-labelledby="retention-title">
      <p className="connected-eyebrow">{t("retentionPanel.eyebrow")}</p>
      <h2 id="retention-title">{t("retentionPanel.title")}</h2>
      <p className="connected-muted">{t("retentionPanel.intro")}</p>
      <ul>
        {items.map((item) => (
          <li key={item.objectiveId}>
            <div>
              <strong dir="auto">{item.description}</strong>
              <span className="connected-muted">
                {" "}·{" "}
                {!item.dueAt
                  ? t("retentionPanel.meta.complete", { state: t(`retentionPanel.state.${item.state}` as MessageKey) })
                  : !item.due
                    ? t("retentionPanel.meta.next", {
                        state: t(`retentionPanel.state.${item.state}` as MessageKey),
                        date: i18n.date(item.dueAt, "medium"),
                      })
                    : t(`retentionPanel.state.${item.state}` as MessageKey)}
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
                    setError(t("retentionPanel.startFailed"));
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {t("retentionPanel.start")}
              </button>
            ) : (
              <span className="connected-muted">{t("retentionPanel.noFresh")}</span>
            ))}
          </li>
        ))}
      </ul>
      <div aria-live="polite">{error && <p role="alert" className="connected-error-text">{error}</p>}</div>
    </section>
  );
}
