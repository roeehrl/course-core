import React, { useEffect, useId, useState } from "react";
import type { CourseApi, ServerSnapshot } from "../client/apiClient";
import type { StudyConsentProps } from "./StudyConsent";
import { useI18n } from "../i18n";
import { useFirstLoadDone } from "../connected/firstLoad";

interface StudyView {
  revision: number;
  study: null | {
    id: string; title: string; purpose: string; state: "recruiting" | "closed"; consentDigest: string;
    versions: string[]; collected: string[]; neverCollected: string[]; usabilityMeasures?: boolean;
  };
  participation: null | {
    consent: "consented" | "withdrawn"; participantCode: string; consentedAt: string; withdrawnAt: string | null;
    version: null | { label: string; behaviour: string; explanation: string };
  };
}
// i18n-ignore: session storage key, not shown to people
const dismissedKey = (enrollmentId: string, studyId: string) => `study-prompt:${enrollmentId}:${studyId}`;
function dismissed(key: string) {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** The learner's own, explicit choice to take part in a research study of this course, separate
 * from enrolling. Plain-language explanation of what changes and what is collected; leaving is
 * always available and takes effect at once. Staff can never make this choice for a learner. */
export function StudyConsent({ api, server, mode, onChanged }: StudyConsentProps) {
  const id = useId();
  const i18n = useI18n(),
    t = i18n.t;
  const [view, setView] = useState<StudyView>();
  const [agree, setAgree] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [read, setRead] = useState(false);
  useFirstLoadDone("study", read);
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<StudyView>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/study`, "GET", undefined, { signal: controller.signal })
      .then((v) => {
        if (controller.signal.aborted) return;
        setView(v);
        if (v.study) setHidden(dismissed(dismissedKey(server.enrollmentId, v.study.id)));
        setRead(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRead(true);
      });
    return () => controller.abort();
  }, [api, server.enrollmentId, server.revision]);
  const study = view?.study, participation = view?.participation;
  if (!study) return null;
  const undecided = !participation && study.state === "recruiting";
  if (mode === "prompt" && (!undecided || hidden)) return null;
  async function send(action: "study/consent" | "study/withdraw", data: Record<string, unknown>, failure: string) {
    setBusy(true);
    setError("");
    try {
      const next = await (api as CourseApi).command<StudyView>(server as ServerSnapshot, action, { studyId: study!.id, ...data });
      setView(next);
      setAgree(false);
      setConfirmLeave(false);
      onChanged();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const joinForm = (again: boolean) => (
    <>
      <p dir="auto">{study.purpose}</p>
      <h3>{t("studyConsent.join.ifYouTakePart")}</h3>
      <p>{t("studyConsent.join.draw")}</p>
      <ul>
        {study.versions.map((v) => (
          <li key={v} dir="auto">{v}</li>
        ))}
      </ul>
      <h3>{t("studyConsent.join.collected")}</h3>
      <ul>
        {study.collected.map((v) => (
          <li key={v} dir="auto">{v}</li>
        ))}
        {study.usabilityMeasures && <li>{t("studyConsent.join.usability")}</li>}
      </ul>
      <h3>{t("studyConsent.join.neverCollected")}</h3>
      <ul>
        {study.neverCollected.map((v) => (
          <li key={v} dir="auto">{v}</li>
        ))}
      </ul>
      <p className="connected-muted">{t("studyConsent.join.choice")}</p>
      <label className="connected-check">
        <input type="checkbox" checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
        {t("studyConsent.join.agree")}
      </label>
      <div className="connected-study-actions">
        <button type="button" className="connected-primary" disabled={!agree || busy}
          onClick={() => void send("study/consent", { consentDigest: study.consentDigest }, t("studyConsent.join.failed"))}>
          {t(again ? "studyConsent.join.again" : "studyConsent.join.button")}
        </button>
        {mode === "prompt" && (
          <button type="button" className="connected-secondary" disabled={busy} onClick={() => {
            try {
              window.sessionStorage.setItem(dismissedKey(server.enrollmentId, study.id), "1");
            } catch {
              // Not remembered: the prompt shows again next time.
            }
            setHidden(true);
          }}>
            {t("studyConsent.join.notNow")}
          </button>
        )}
      </div>
    </>
  );
  return (
    <section className="connected-reading-card connected-study" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t(mode === "prompt" ? "studyConsent.title.prompt" : "studyConsent.title.settings", { title: study.title })}</h2>
      {undecided && joinForm(false)}
      {participation?.consent === "consented" && (
        <>
          <p>
            {i18n.rich(
              study.state === "closed" ? "studyConsent.taking.ended" : "studyConsent.taking.active",
              { code: participation.participantCode },
              { strong: (children, key) => <strong key={key} dir="ltr">{children}</strong> },
            )}
          </p>
          {participation.version && <p>{t("studyConsent.taking.version", { explanation: participation.version.explanation })}</p>}
          {participation.version && study.usabilityMeasures && <p>{t("studyConsent.taking.usability")}</p>}
          {!confirmLeave ? (
            <button type="button" className="connected-secondary" disabled={busy} onClick={() => setConfirmLeave(true)}>
              {t("studyConsent.leave.button")}
            </button>
          ) : (
            <div role="group" aria-label={t("studyConsent.leave.confirmLabel")}>
              <p>{t("studyConsent.leave.explain")}</p>
              <div className="connected-study-actions">
                <button type="button" className="connected-button connected-danger" disabled={busy}
                  onClick={() => void send("study/withdraw", {}, t("studyConsent.leave.failed"))}>
                  {t("studyConsent.leave.button")}
                </button>
                <button type="button" className="connected-secondary" disabled={busy} onClick={() => setConfirmLeave(false)}>
                  {t("studyConsent.leave.stay")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {participation?.consent === "withdrawn" && (
        <>
          <p>{t("studyConsent.withdrawn")}</p>
          {study.state === "recruiting" && joinForm(true)}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
