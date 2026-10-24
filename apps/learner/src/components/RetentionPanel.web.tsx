import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";
import type { RetentionPanelProps } from "./RetentionPanel";
import { useI18n, type MessageKey } from "../i18n";
import { useFirstLoadDone } from "../connected/firstLoad";
import { ChangedElsewhere } from "./ChangedElsewhere";
import { useEditableSnapshot } from "../hooks/useEditableSnapshot";

interface RetentionItem {
  objectiveId: string;
  description: string;
  state: "demonstrated" | "retained" | "needs_review";
  dueAt: string | null;
  due: boolean;
  freshItemsLeft: number;
  lastOutcome?: "retained" | "missed" | "unsure" | "assisted" | null;
  movedForAvailability?: boolean;
}
interface RetentionView { available: boolean; items: RetentionItem[]; availability?: { weekdays: number[]; timeZone: string } | null }
const WEEK = [0, 1, 2, 3, 4, 5, 6];
// A known Sunday, to name each weekday in the learner's language.
const SUNDAY = Date.UTC(2026, 9, 25, 12);
/** The browser's time zone, which study days are read in. */
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Delayed independent checks. They record retention beside demonstrated
 * understanding and never change completion or unlock steps. */
export function RetentionPanel({ api, enrollmentId, revision, onStart, onSaveAvailability }: RetentionPanelProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const [items, setItems] = useState<RetentionItem[]>([]);
  const [availability, setAvailability] = useState<RetentionView["availability"]>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [read, setRead] = useState(false);
  useFirstLoadDone("retention", read);
  // The saved days until the learner picks others; a reload after any revision never resets a
  // choice, and days saved elsewhere meanwhile are named (useEditableSnapshot).
  const daysEdit = useEditableSnapshot<number[]>(availability?.weekdays ?? WEEK);
  const days = daysEdit.edited ? daysEdit.value : null;
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<RetentionView>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/retention`, "GET", undefined, { signal: controller.signal })
      .then((v) => {
        if (controller.signal.aborted) return;
        setItems(v.available ? v.items : []);
        setAvailability(v.availability ?? null);
        setRead(true);
      })
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setItems([]);
        setRead(true);
      });
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
              {item.lastOutcome === "missed" && <span className="connected-muted"> · {t("retentionPanel.outcome.missed")}</span>}
              {item.lastOutcome === "unsure" && <span className="connected-muted"> · {t("retentionPanel.outcome.unsure")}</span>}
              {item.movedForAvailability && item.dueAt && !item.due && <span className="connected-muted"> · {t("retentionPanel.moved")}</span>}
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
      {onSaveAvailability && (
        <fieldset className="connected-retention-days">
          <legend>{t("retentionPanel.days.legend")}</legend>
          <p className="connected-muted">
            {availability ? t("retentionPanel.days.current", { zone: availability.timeZone }) : t("retentionPanel.days.anyDay")}
          </p>
          <div role="group" aria-label={t("retentionPanel.days.legend")} className="connected-retention-day-list">
            {WEEK.map((day) => {
              const chosen = daysEdit.value.includes(day);
              return (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={chosen}
                    onChange={() => {
                      daysEdit.set((current) => (chosen ? current.filter((d) => d !== day) : [...current, day].sort()));
                      setSaved("");
                    }}
                  />{" "}
                  {i18n.dateTime(SUNDAY + day * 86_400_000, { weekday: "long", timeZone: "UTC" })}
                </label>
              );
            })}
          </div>
          <p className="connected-input-hint">{t("retentionPanel.days.hint")}</p>
          {daysEdit.changedElsewhere && (
            <ChangedElsewhere disabled={Boolean(busy)} onShowSaved={daysEdit.discard} onKeep={daysEdit.keep} />
          )}
          <div className="connected-gate-actions">
            <button
              type="button"
              className="connected-button"
              disabled={Boolean(busy) || days === null || days.length === 0 || daysEdit.changedElsewhere}
              onClick={async () => {
                if (days === null || daysEdit.changedElsewhere) return;
                setBusy("days");
                setError("");
                try {
                  await onSaveAvailability(days.length === 7 ? null : days, browserZone());
                  daysEdit.settle();
                  setSaved(t("retentionPanel.days.saved"));
                } catch {
                  setError(t("retentionPanel.days.failed"));
                } finally {
                  setBusy("");
                }
              }}
            >
              {t("retentionPanel.days.save")}
            </button>
            {days !== null && days.length === 0 && <span className="connected-muted">{t("retentionPanel.days.pickOne")}</span>}
          </div>
        </fieldset>
      )}
      <div aria-live="polite">
        {error && <p role="alert" className="connected-error-text">{error}</p>}
        {saved && <p className="connected-muted">{saved}</p>}
      </div>
    </section>
  );
}
