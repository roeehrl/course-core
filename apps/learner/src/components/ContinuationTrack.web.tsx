import React, { useEffect, useId, useMemo, useState } from "react";
import { CourseApiError } from "../client/apiClient";
import { createContinuationClient, type ContinuationView } from "../client/policyClient";
import type { ContinuationTrackProps } from "./ContinuationTrack";
import { policyDate, policyTimeZone } from "../connected/policyPresentation";
import { useI18n, type MessageKey } from "../i18n";

const KNOWN_ERRORS = new Set([
  "CONTINUATION_ALREADY_ACTIVE",
  "CONTINUATION_NOT_ACTIVE",
  "ENROLLMENT_NOT_CLOSED",
  "CONTINUATION_NOT_OPTED_IN",
  "CONTINUATION_NO_REQUIRED_WORK",
  "STALE_REVISION",
]);

/** The optional continuation track after a course closes. The learner opts in explicitly to keep
 * spaced review going; it is never required, earns no new credit, keeps the course closed and
 * can be stopped at any time. Staff can never make this choice for a learner. */
export function ContinuationTrack({ api, server, onChanged }: ContinuationTrackProps) {
  const id = useId();
  const i18n = useI18n(),
    t = i18n.t;
  const client = useMemo(() => createContinuationClient(api), [api]);
  const [view, setView] = useState<ContinuationView>();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    client.load(server.enrollmentId, controller.signal).then(
      (v) => !controller.signal.aborted && setView(v),
      () => undefined,
    );
    return () => controller.abort();
  }, [client, server.enrollmentId, server.revision]);
  if (!view?.available) return null;
  const zone = policyTimeZone(server.course.policy);
  const track = view.track,
    active = track?.state === "active";
  const focus = [...new Set([...(view.reviewFocus?.unprovenConceptIds ?? []), ...(view.reviewFocus?.uncoveredObjectiveIds ?? [])])];
  const description = (objective: string) =>
    server.course.objectives.find((row) => row.id === objective)?.description ?? t("continuationTrack.objectiveFallback");
  async function act(action: () => Promise<ContinuationView>) {
    setBusy(true);
    setError("");
    try {
      setView(await action());
      setAgree(false);
      onChanged();
    } catch (cause) {
      const code = cause instanceof CourseApiError ? cause.code : "";
      setError(t(KNOWN_ERRORS.has(code) ? (`continuationTrack.error.${code}` as MessageKey) : "continuationTrack.error.generic"));
      if (code === "STALE_REVISION" || code === "CONTINUATION_ALREADY_ACTIVE" || code === "CONTINUATION_NOT_ACTIVE")
        client.load(server.enrollmentId).then(setView, () => undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="connected-reading-card connected-continuation" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t("continuationTrack.title")}</h2>
      {active ? (
        <>
          <p role="status">
            {t("continuationTrack.active", { date: policyDate(track.optedInAt, zone, i18n) })}
          </p>
          <p>{t("continuationTrack.activeExplain")}</p>
        </>
      ) : (
        <>
          <p>{t("continuationTrack.intro")}</p>
          <ul>
            <li>{t("continuationTrack.terms.optional")}</li>
            <li>{t("continuationTrack.terms.noRequiredWork")}</li>
            <li>{t("continuationTrack.terms.noCredit")}</li>
            <li>{t("continuationTrack.terms.staysClosed")}</li>
            <li>{t("continuationTrack.terms.stopAnytime")}</li>
          </ul>
          {track?.state === "stopped" && track.stoppedAt && (
            <p className="connected-muted">{t("continuationTrack.stopped", { date: policyDate(track.stoppedAt, zone, i18n) })}</p>
          )}
        </>
      )}
      {focus.length > 0 && (
        <>
          <h3>{t("continuationTrack.focusHeading")}</h3>
          <ul>
            {focus.map((objective) => (
              <li key={objective} dir="auto">
                {description(objective)}
              </li>
            ))}
          </ul>
        </>
      )}
      {active ? (
        <button
          type="button"
          className="connected-secondary"
          disabled={busy}
          onClick={() => void act(() => client.stop(server, view))}
        >
          {t("continuationTrack.stop")}
        </button>
      ) : (
        <>
          <label className="connected-check">
            <input type="checkbox" checked={agree} disabled={busy} onChange={(event) => setAgree(event.target.checked)} />
            {t("continuationTrack.consent")}
          </label>
          <button
            type="button"
            className="connected-primary"
            disabled={!agree || busy}
            onClick={() => {
              if (agree) void act(() => client.optIn(server, view, true));
            }}
          >
            {t(track?.state === "stopped" ? "continuationTrack.startAgain" : "continuationTrack.start")}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
