import React, { useId, useState } from "react";
import type { ServerSnapshot } from "../client/apiClient";
import { useI18n, type MessageKey } from "../i18n";

type Outcome = "moved" | "waiting" | "declined" | "withdrawn";
/** How many personal changes are named in the offer before "and N more". */
const NAMED = 5;

/**
 * "Your course has a new version": the course team moved learners to a newer version, but this
 * learner has personal changes, so they were not moved. They choose: move now (their personal
 * changes are archived, not deleted; the move runs at a safe boundary) or stay with their changes.
 */
export function CourseVersionOffer({
  server,
  onDecide,
}: {
  server: ServerSnapshot;
  onDecide: (moveId: string, accept: boolean) => Promise<{ status: Outcome }>;
}) {
  const id = useId();
  const i18n = useI18n(),
    t = i18n.t;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome | "failed" | null>(null);
  const offer = server.courseVersionOffer;
  // Once answered the offer is gone from the snapshot; say what happened.
  if (!offer)
    return result && result !== "failed" ? (
      <p className="connected-reading-card" role="status">
        {t(`courseVersionNotice.offer.${result}` as MessageKey)}
      </p>
    ) : null;
  const { items, count } = offer.personalChanges;
  const titles = i18n.list(items.slice(0, NAMED).map((item) => item.title));
  const changes =
    count > Math.min(items.length, NAMED)
      ? t("courseVersionNotice.offer.more", {
          changes: titles,
          count: count - Math.min(items.length, NAMED),
        })
      : titles;
  async function decide(accept: boolean) {
    setBusy(true);
    try {
      setResult((await onDecide(offer!.moveId, accept)).status);
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="connected-reading-card connected-version-notice"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`}>{t("courseVersionNotice.offer.title")}</h2>
      <p>
        {items.length
          ? t("courseVersionNotice.offer.body", {
              from: offer.fromVersion,
              to: offer.toVersion,
              changes,
            })
          : t("courseVersionNotice.offer.bodyUnlisted", {
              from: offer.fromVersion,
              to: offer.toVersion,
            })}
      </p>
      <p>
        {t("courseVersionNotice.offer.keeps", {
          lessons: offer.keeps.lessons,
          again: offer.keeps.checkpointsAgain,
        })}
      </p>
      <p className="connected-muted">
        {t("courseVersionNotice.offer.archived")}
      </p>
      {result && (
        <p role={result === "failed" ? "alert" : "status"}>
          {t(`courseVersionNotice.offer.${result}` as MessageKey)}
        </p>
      )}
      <div className="connected-actions">
        <button
          type="button"
          className="connected-primary"
          disabled={busy}
          onClick={() => void decide(true)}
        >
          {t("courseVersionNotice.offer.accept")}
        </button>
        <button
          type="button"
          className="connected-secondary"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          {t("courseVersionNotice.offer.decline")}
        </button>
      </div>
    </section>
  );
}
