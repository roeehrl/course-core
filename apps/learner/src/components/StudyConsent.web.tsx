import React, { useEffect, useId, useState } from "react";
import type { CourseApi, ServerSnapshot } from "../client/apiClient";
import type { StudyConsentProps } from "./StudyConsent";

interface StudyView {
  revision: number;
  study: null | {
    id: string; title: string; purpose: string; state: "recruiting" | "closed"; consentDigest: string;
    versions: string[]; collected: string[]; neverCollected: string[];
  };
  participation: null | {
    consent: "consented" | "withdrawn"; participantCode: string; consentedAt: string; withdrawnAt: string | null;
    version: null | { label: string; behaviour: string; explanation: string };
  };
}
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
  const [view, setView] = useState<StudyView>();
  const [agree, setAgree] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<StudyView>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/study`, "GET", undefined, { signal: controller.signal })
      .then((v) => {
        if (controller.signal.aborted) return;
        setView(v);
        if (v.study) setHidden(dismissed(dismissedKey(server.enrollmentId, v.study.id)));
      })
      .catch(() => undefined);
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
      <p>{study.purpose}</p>
      <h3>If you take part</h3>
      <p>
        A fair, random draw places you in one of these versions of the course, and you stay in it for the whole study:
      </p>
      <ul>
        {study.versions.map((v) => (
          <li key={v}>{v}</li>
        ))}
      </ul>
      <h3>What is collected</h3>
      <ul>
        {study.collected.map((v) => (
          <li key={v}>{v}</li>
        ))}
      </ul>
      <h3>What is never collected</h3>
      <ul>
        {study.neverCollected.map((v) => (
          <li key={v}>{v}</li>
        ))}
      </ul>
      <p className="connected-muted">
        Taking part is your choice. Saying no changes nothing about your course, your results or your access. You can leave at any time from My
        profile: from then on your data is left out, and you return to the course as everyone else has it.
      </p>
      <label className="connected-check">
        <input type="checkbox" checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
        I have read this and agree to take part
      </label>
      <div className="connected-study-actions">
        <button type="button" className="connected-primary" disabled={!agree || busy}
          onClick={() => void send("study/consent", { consentDigest: study.consentDigest }, "Your choice could not be saved. You have not joined.")}>
          {again ? "Join again" : "Join the study"}
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
            Not now
          </button>
        )}
      </div>
    </>
  );
  return (
    <section className="connected-reading-card connected-study" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{mode === "prompt" ? `Join a research study? ${study.title}` : `Research study: ${study.title}`}</h2>
      {undecided && joinForm(false)}
      {participation?.consent === "consented" && (
        <>
          <p>
            You are taking part{study.state === "closed" ? " (the study has now ended)" : ""}. Your study code is{" "}
            <strong>{participation.participantCode}</strong>; the research team sees this code, never your name.
          </p>
          {participation.version && <p>Your version: {participation.version.explanation}</p>}
          {!confirmLeave ? (
            <button type="button" className="connected-secondary" disabled={busy} onClick={() => setConfirmLeave(true)}>
              Leave the study
            </button>
          ) : (
            <div role="group" aria-label="Confirm leaving the study">
              <p>
                From now on your data is left out of the study and your course returns to the standard version. Your learning progress is kept.
              </p>
              <div className="connected-study-actions">
                <button type="button" className="connected-button connected-danger" disabled={busy}
                  onClick={() => void send("study/withdraw", {}, "Your choice could not be saved. You are still in the study.")}>
                  Leave the study
                </button>
                <button type="button" className="connected-secondary" disabled={busy} onClick={() => setConfirmLeave(false)}>
                  Stay in the study
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {participation?.consent === "withdrawn" && (
        <>
          <p>You left this study. Your data is not included and your course is the standard version.</p>
          {study.state === "recruiting" && joinForm(true)}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
