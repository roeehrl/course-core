import React, { useEffect, useId, useState } from "react";
import { CourseApiError, type CourseApi } from "../client/apiClient";
import type { YourDataPanelProps } from "./YourDataPanel";
import { LoadingLine } from "./loadingLine.web";
import { useReservedBlock } from "./reservedHeight";
import { isSupportedLocale } from "@course-core/i18n";
import { englishTranslator, useI18n, type MessageKey } from "../i18n";

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
/** A typed (or pasted) confirmation as compared: without direction marks, composed, trimmed. */
const typedPhrase = (value: string) =>
  value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").normalize("NFC").trim();
/** Learner-owned export and erasure. Erasure is irreversible and typed-confirmed;
 * it first stops supervision and waits for running work before redacting. */
export function YourDataPanel({ api, enrollmentId, courseTitle, onErased }: YourDataPanelProps) {
  const id = useId();
  const i18n = useI18n(),
    t = i18n.t;
  const noAccessCopy = t("yourDataPanel.access.none");
  const roleLabel = (role: string) => {
    const key = `yourDataPanel.role.${role}` as MessageKey;
    return i18n.has(key) ? t(key) : role;
  };
  const phrase = `ERASE ${enrollmentId.slice(0, 8)}`;
  const [busy, setBusy] = useState<"" | "export" | "erase">("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [views, setViews] = useState<StaffAccess[] | "unavailable">();
  // The confirmation phrase in the screen's language; the server accepts the phrase of the
  // language the request names (and the English one). A pseudo-locale shows its own version of
  // the phrase and sends the English one, since pseudo-locales never reach the server.
  const accountPhrase = t("yourDataPanel.account.phrase");
  const phraseLocale = isSupportedLocale(i18n.locale) ? i18n.locale : "en";
  const [accountConfirmation, setAccountConfirmation] = useState("");
  const [accountReason, setAccountReason] = useState("");
  // The access list loads after the panel; keep its last settled height, or the
  // empty message's footprint, so the panel below does not move.
  const access = useReservedBlock<HTMLElement>(`staff-access:${enrollmentId}`, views !== undefined);
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
      setStatus(t("yourDataPanel.export.done"));
    } catch {
      setError(t("yourDataPanel.export.failed"));
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
            setStatus(t("yourDataPanel.erase.stopping"));
            await pause(2500);
            continue;
          }
          throw cause;
        }
      }
      setError(t("yourDataPanel.erase.stillFinishing"));
    } catch (cause) {
      setError(
        cause instanceof CourseApiError && cause.code === "ERASURE_CONFIRMATION_REQUIRED"
          ? t("yourDataPanel.erase.confirmationRequired", { phrase })
          : t("yourDataPanel.erase.failed"),
      );
    } finally {
      setBusy("");
    }
  }
  /** Every course and the account itself; the server stops supervision first. */
  async function eraseAccount() {
    setBusy("erase");
    setError("");
    setStatus("");
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await (api as CourseApi).request("/api/account/erase", "POST", {
            confirmation:
              phraseLocale === i18n.locale
                ? typedPhrase(accountConfirmation)
                : englishTranslator().t("yourDataPanel.account.phrase"),
            locale: phraseLocale,
            reason: accountReason.trim(),
          });
          setStatus(t("yourDataPanel.account.erased"));
          window.location.replace("/");
          return;
        } catch (cause) {
          if (cause instanceof CourseApiError && cause.code === "ERASURE_WAITING_FOR_SUPERVISION") {
            setStatus(t("yourDataPanel.account.stopping"));
            await pause(2500);
            continue;
          }
          throw cause;
        }
      }
      setError(t("yourDataPanel.erase.stillFinishing"));
    } catch (cause) {
      setError(
        cause instanceof CourseApiError && cause.code === "ACCOUNT_HAS_STAFF_ROLE"
          ? t("yourDataPanel.account.error.ACCOUNT_HAS_STAFF_ROLE")
          : t("yourDataPanel.account.failed"),
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="connected-reading-card connected-data" aria-labelledby={id + "-title"}>
      <h2 id={id + "-title"}>{t("yourDataPanel.title")}</h2>
      <p>{t("yourDataPanel.export.intro")}</p>
      <button type="button" className="connected-button" disabled={Boolean(busy)} onClick={() => void download()}>
        {busy === "export" ? t("yourDataPanel.export.preparing") : t("yourDataPanel.export.download")}
      </button>
      <details className="connected-review">
        <summary>{t("yourDataPanel.erase.summary", { course: courseTitle })}</summary>
        <div className="connected-data-erase">
          <p>{t("yourDataPanel.erase.body")}</p>
          <label htmlFor={id + "-reason"}>{t("yourDataPanel.erase.reason")}</label>
          <textarea dir="auto" id={id + "-reason"} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <label htmlFor={id + "-confirm"}>
            {i18n.rich("yourDataPanel.confirm", { phrase }, { strong: (children, key) => <strong key={key} dir="ltr">{children}</strong> })}
          </label>
          <input dir="ltr" id={id + "-confirm"} autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          <button
            type="button"
            className="connected-button connected-danger"
            disabled={Boolean(busy) || confirmation.trim() !== phrase || reason.trim().length < 10}
            onClick={() => void erase()}
          >
            {busy === "erase" ? t("yourDataPanel.erase.erasing") : t("yourDataPanel.erase.button")}
          </button>
        </div>
      </details>
      <details className="connected-review">
        <summary>{t("yourDataPanel.account.summary")}</summary>
        <div className="connected-data-erase">
          <p>{t("yourDataPanel.account.body")}</p>
          <label htmlFor={id + "-account-reason"}>{t("yourDataPanel.account.reason")}</label>
          <textarea dir="auto" id={id + "-account-reason"} rows={2} maxLength={1000} value={accountReason} onChange={(e) => setAccountReason(e.target.value)} />
          <label htmlFor={id + "-account-confirm"}>
            {i18n.rich("yourDataPanel.confirm", { phrase: accountPhrase }, { strong: (children, key) => <strong key={key} dir="auto">{children}</strong> })}
          </label>
          <input dir="auto" id={id + "-account-confirm"} autoComplete="off" value={accountConfirmation} onChange={(e) => setAccountConfirmation(e.target.value)} />
          <button
            type="button"
            className="connected-button connected-danger"
            disabled={Boolean(busy) || typedPhrase(accountConfirmation) !== typedPhrase(accountPhrase) || accountReason.trim().length < 10}
            onClick={() => void eraseAccount()}
          >
            {busy === "erase" ? t("yourDataPanel.erase.erasing") : t("yourDataPanel.account.button")}
          </button>
        </div>
      </details>
      <section
        ref={access.ref}
        style={{ minHeight: access.minHeight }}
        className="connected-staff-views"
        aria-labelledby={id + "-views"}
        aria-busy={views === undefined}
      >
        <h3 id={id + "-views"}>{t("yourDataPanel.access.title")}</h3>
        <p className="connected-muted">{t("yourDataPanel.access.body")}</p>
        {views === undefined ? (
          <LoadingLine reserve={noAccessCopy} />
        ) : views === "unavailable" ? (
          <p className="connected-muted">{t("yourDataPanel.access.unavailable")}</p>
        ) : views.length ? (
          <ul>
            {views.map((view) => (
              <li key={view.kind + view.id} data-kind={view.kind}>
                {t(view.kind === "export" ? "yourDataPanel.access.downloaded" : "yourDataPanel.access.viewed", {
                  name: view.name,
                  role: roleLabel(view.role),
                })}{" "}
                · <time dateTime={view.at}>{i18n.dateTime(view.at)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="connected-muted">{noAccessCopy}</p>
        )}
      </section>
      <div aria-live="polite">
        {status && <p className="connected-muted">{status}</p>}
        {error && <p role="alert" className="connected-error-text">{error}</p>}
      </div>
    </section>
  );
}
