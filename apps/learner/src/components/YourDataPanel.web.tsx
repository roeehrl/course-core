import React, { useEffect, useId, useState } from "react";
import { CourseApiError, type CourseApi } from "../client/apiClient";
import type { YourDataPanelProps } from "./YourDataPanel";

interface StaffView { id: string; viewedAt: string; viewerName: string; viewerRole: string }
interface StaffExport { id: string; exportedAt: string; exporterName: string; exporterRole: string }
interface StaffAccess { id: string; kind: "view" | "export"; at: string; name: string; role: string }
/** Views and downloads in one list, oldest first. Older servers send views only. */
function staffAccess(result: { views?: unknown; exports?: unknown } | undefined): StaffAccess[] | "unavailable" {
  if (!Array.isArray(result?.views)) return "unavailable";
  const views = (result.views as StaffView[]).map((v) => ({ id: v.id, kind: "view" as const, at: v.viewedAt, name: v.viewerName, role: v.viewerRole }));
  const exports = (Array.isArray(result.exports) ? (result.exports as StaffExport[]) : []).map((x) => ({
    id: x.id,
    kind: "export" as const,
    at: x.exportedAt,
    name: x.exporterName,
    role: x.exporterRole,
  }));
  return [...views, ...exports].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Learner-owned export and erasure. Erasure is irreversible and typed-confirmed;
 * it first stops supervision and waits for running work before redacting. */
export function YourDataPanel({ api, enrollmentId, courseTitle, onErased }: YourDataPanelProps) {
  const id = useId();
  const phrase = `ERASE ${enrollmentId.slice(0, 8)}`;
  const [busy, setBusy] = useState<"" | "export" | "erase">("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [views, setViews] = useState<StaffAccess[] | "unavailable">();
  useEffect(() => {
    let live = true;
    (api as CourseApi)
      .request<{ views?: unknown; exports?: unknown }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/staff-views`)
      .then((result) => live && setViews(staffAccess(result)))
      .catch(() => live && setViews("unavailable"));
    return () => {
      live = false;
    };
  }, [api, enrollmentId]);
  async function download() {
    setBusy("export");
    setError("");
    setStatus("");
    try {
      const document = await (api as CourseApi).request<unknown>(
        `/api/enrollments/${encodeURIComponent(enrollmentId)}/export`,
      );
      const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = Object.assign(window.document.createElement("a"), { href: url, download: `course-data-${enrollmentId}.json` });
      window.document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Your data file was prepared. Check your downloads.");
    } catch {
      setError("Your data could not be exported right now. Nothing changed. Try again.");
    } finally {
      setBusy("");
    }
  }
  async function erase() {
    setBusy("erase");
    setError("");
    setStatus("");
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await (api as CourseApi).request(`/api/enrollments/${encodeURIComponent(enrollmentId)}/erase`, "POST", {
            confirmation: confirmation.trim(),
            reason: reason.trim(),
          });
          onErased();
          return;
        } catch (cause) {
          if (cause instanceof CourseApiError && cause.code === "ERASURE_WAITING_FOR_SUPERVISION") {
            setStatus("Stopping your course supervisor before erasing…");
            await pause(2500);
            continue;
          }
          throw cause;
        }
      }
      setError("Supervision is still finishing. Nothing was erased yet. Try again in a minute.");
    } catch (cause) {
      setError(
        cause instanceof CourseApiError && cause.code === "ERASURE_CONFIRMATION_REQUIRED"
          ? `Type ${phrase} exactly to confirm.`
          : "Erasure could not be completed. Nothing was erased. Check the confirmation and reason, then retry.",
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="connected-reading-card connected-data" aria-labelledby={id + "-title"}>
      <h2 id={id + "-title"}>Your data</h2>
      <p>
        Download everything this course has recorded about you: profile, answers, checks, companion conversations,
        learner model, deadlines and events. Course content and grading keys are not included.
      </p>
      <button type="button" className="connected-button" disabled={Boolean(busy)} onClick={() => void download()}>
        {busy === "export" ? "Preparing…" : "Download my data (JSON)"}
      </button>
      <details className="connected-review">
        <summary>Erase my learning data for {courseTitle}</summary>
        <div className="connected-data-erase">
          <p>
            This permanently removes your answers, companion conversations, learner model and personal teaching for
            this course. Dates, event types and usage totals are kept without content so audit and budgets stay
            correct. You will not be able to continue this enrollment. Workflow-service history and backups expire on
            their own retention schedule. Download your data first if you want a copy.
          </p>
          <label htmlFor={id + "-reason"}>Why are you erasing it? (10+ characters, kept with the record)</label>
          <textarea id={id + "-reason"} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <label htmlFor={id + "-confirm"}>
            Type <strong>{phrase}</strong> to confirm
          </label>
          <input id={id + "-confirm"} autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          <button
            type="button"
            className="connected-button connected-danger"
            disabled={Boolean(busy) || confirmation.trim() !== phrase || reason.trim().length < 10}
            onClick={() => void erase()}
          >
            {busy === "erase" ? "Erasing…" : "Erase permanently"}
          </button>
        </div>
      </details>
      <section className="connected-staff-views" aria-labelledby={id + "-views"}>
        <h3 id={id + "-views"}>Staff access to your record</h3>
        <p className="connected-muted">
          Course owners and admins can open a read-only view of what you see here to help with your learning. They cannot act
          as you, and that view never shows your companion conversation or your own notes. They can also download a copy of
          your data, which does include them. Every view and download is listed here and in your data download.
        </p>
        {views === undefined ? (
          <p className="connected-muted">Checking…</p>
        ) : views === "unavailable" ? (
          <p className="connected-muted">This list could not be loaded right now.</p>
        ) : views.length ? (
          <ul>
            {views.map((view) => (
              <li key={view.kind + view.id} data-kind={view.kind}>
                {view.name} ({view.role}) {view.kind === "export" ? "downloaded a copy of your data" : "viewed your record"} ·{" "}
                <time dateTime={view.at}>{new Date(view.at).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="connected-muted">No one on the course staff has viewed or downloaded your record.</p>
        )}
      </section>
      <div aria-live="polite">
        {status && <p className="connected-muted">{status}</p>}
        {error && <p role="alert" className="connected-error-text">{error}</p>}
      </div>
    </section>
  );
}
