import React, { useCallback, useEffect, useId, useState } from "react";
import { CourseApiError, type CourseApi } from "../client/apiClient";
import type { ConnectedAgentsPanelProps } from "./ConnectedAgentsPanel";
import { useI18n, type MessageKey } from "../i18n";

type Scope = "context" | "profile" | "evidence" | "history" | "propose_intervention";
interface Grant { id: string; label: string; scopes: Scope[]; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null; state: "active" | "expired" | "revoked" }
interface Listing { grants: Grant[]; recentCalls: { grantId: string; tool: string; outcome: string; at: string }[] }
const SCOPES: Scope[] = ["context", "profile", "evidence", "history", "propose_intervention"];
const scopeLabel = (scope: string) => `connectedAgentsPanel.scope.${scope}.label` as MessageKey;
const scopeDetail = (scope: Scope) => `connectedAgentsPanel.scope.${scope}.detail` as MessageKey;
const DAYS = [1, 7, 30, 90];
const DATE: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

/** The learner's own grants for external AI agents: scoped, expiring, revocable. The token is shown once. */
export function ConnectedAgentsPanel({ api, enrollmentId, courseTitle }: ConnectedAgentsPanelProps) {
  const id = useId();
  const i18n = useI18n(), t = i18n.t;
  const when = (value: string) => i18n.date(value, DATE);
  const scopeName = (scope: string) => (i18n.has(scopeLabel(scope)) ? t(scopeLabel(scope)) : scope);
  const base = `/api/enrollments/${encodeURIComponent(enrollmentId)}/agent-grants`;
  const [listing, setListing] = useState<Listing | "unavailable">();
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["context", "profile", "evidence"]);
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState<{ token: string; label: string }>();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setListing(await (api as CourseApi).request<Listing>(base)); } catch { setListing("unavailable"); }
  }, [api, base]);
  useEffect(() => { void load(); }, [load]);
  async function connect() {
    setBusy(true); setError(""); setCopied(false); setCopyFailed(false);
    try {
      const result = await (api as CourseApi).request<{ token: string; grant: Grant }>(base, "POST", { label: label.trim(), scopes, expiresInDays: days });
      setCreated({ token: result.token, label: result.grant.label });
      setLabel("");
      await load();
    } catch (cause) {
      setError(t(cause instanceof CourseApiError && cause.code === "AGENT_GRANT_LIMIT"
        ? "connectedAgentsPanel.error.AGENT_GRANT_LIMIT"
        : "connectedAgentsPanel.error.connect"));
    } finally { setBusy(false); }
  }
  async function disconnect(grant: Grant) {
    setBusy(true); setError("");
    try {
      await (api as CourseApi).request(`${base}/${encodeURIComponent(grant.id)}/revoke`, "POST", {});
      await load();
    } catch { setError(t("connectedAgentsPanel.error.disconnect", { label: grant.label })); } finally { setBusy(false); }
  }
  async function copy() {
    if (!created) return;
    // The clipboard API exists only on a secure (https or localhost) page. Elsewhere,
    // such as a plain-http tailnet address, select the key so it can be copied by hand.
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (typeof clipboard?.writeText !== "function") throw new Error("clipboard unavailable"); // i18n-ignore: internal control flow, caught below and never shown
      await clipboard.writeText(created.token); setCopied(true); setCopyFailed(false);
    } catch {
      setCopied(false); setCopyFailed(true);
      const field = document.getElementById(id + "-token");
      if (field instanceof HTMLInputElement) { field.focus(); field.select(); }
    }
  }
  const toggle = (scope: Scope, on: boolean) => setScopes(current => on ? SCOPES.filter(s => s === scope || current.includes(s)) : current.filter(s => s !== scope));
  const active = listing && listing !== "unavailable" ? listing.grants.filter(g => g.state === "active") : [];
  const earlier = listing && listing !== "unavailable" ? listing.grants.filter(g => g.state !== "active") : [];
  return (
    <section className="connected-reading-card connected-agents" aria-labelledby={id + "-title"}>
      <h2 id={id + "-title"}>{t("connectedAgentsPanel.title")}</h2>
      <p className="connected-muted">
        {t("connectedAgentsPanel.intro", { course: courseTitle })}
      </p>
      {created && (
        <div className="connected-agents-token" role="status">
          <p>
            {i18n.rich("connectedAgentsPanel.token.created", { label: created.label }, {
              strong: (children, key) => <strong key={key}>{children}</strong>,
            })}
          </p>
          <label htmlFor={id + "-token"}>{t("connectedAgentsPanel.token.label")}</label>
          <input id={id + "-token"} dir="ltr" readOnly value={created.token} onFocus={(e) => e.currentTarget.select()} />
          <div className="connected-agents-actions">
            <button type="button" className="connected-button" onClick={() => void copy()}>{t(copied ? "connectedAgentsPanel.token.copied" : "connectedAgentsPanel.token.copy")}</button>
            <button type="button" className="connected-button connected-secondary" onClick={() => setCreated(undefined)}>{t("connectedAgentsPanel.token.saved")}</button>
          </div>
          {copyFailed && <p className="connected-muted" role="alert">{t("connectedAgentsPanel.token.copyFailed")}</p>}
          <p className="connected-muted">
            {i18n.rich(
              "connectedAgentsPanel.token.usage",
              // i18n-ignore: HTTP header and API paths are code, shown left to right
              { header: "Authorization: Bearer", mcp: "/api/agent-tools/mcp", rest: "/api/agent-tools/v1/tools/…" },
              { code: (children, key) => <code key={key} dir="ltr">{children}</code> },
            )}
          </p>
        </div>
      )}
      <details className="connected-review">
        <summary>{t("connectedAgentsPanel.form.summary")}</summary>
        <div className="connected-agents-form">
          <label htmlFor={id + "-label"}>{t("connectedAgentsPanel.form.name")}</label>
          <input id={id + "-label"} maxLength={80} autoComplete="off" value={label} onChange={(e) => setLabel(e.target.value)} />
          <fieldset>
            <legend>{t("connectedAgentsPanel.form.scopes")}</legend>
            {SCOPES.map(scope => (
              <label key={scope} className="connected-agents-scope">
                <input type="checkbox" checked={scopes.includes(scope)} onChange={(e) => toggle(scope, e.target.checked)} />
                <span>{i18n.rich("connectedAgentsPanel.scope.line", { label: t(scopeLabel(scope)), detail: t(scopeDetail(scope)) }, {
                  strong: (children, key) => <strong key={key}>{children}</strong>,
                })}</span>
              </label>
            ))}
          </fieldset>
          <label htmlFor={id + "-days"}>{t("connectedAgentsPanel.form.expiry")}</label>
          <select id={id + "-days"} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map(d => <option key={d} value={d}>{t("connectedAgentsPanel.form.days", { count: d })}</option>)}
          </select>
          <button type="button" className="connected-button" disabled={busy || !label.trim() || !scopes.length} onClick={() => void connect()}>
            {t(busy ? "connectedAgentsPanel.form.connecting" : "connectedAgentsPanel.form.connect")}
          </button>
        </div>
      </details>
      {listing === undefined ? <p className="connected-muted">{t("connectedAgentsPanel.checking")}</p>
        : listing === "unavailable" ? <p className="connected-muted">{t("connectedAgentsPanel.unavailable")}</p>
          : (
            <>
              {active.length ? (
                <ul className="connected-agents-list" aria-label={t("connectedAgentsPanel.active")}>
                  {active.map(grant => (
                    <li key={grant.id}>
                      <div>
                        <strong dir="auto">{grant.label}</strong>
                        <span className="connected-muted"> · {i18n.list(grant.scopes.map(scopeName), "unit")}</span>
                        <div className="connected-muted">
                          {grant.lastUsedAt
                            ? t("connectedAgentsPanel.grant.used", { until: when(grant.expiresAt), used: when(grant.lastUsedAt) })
                            : t("connectedAgentsPanel.grant.unused", { until: when(grant.expiresAt) })}
                        </div>
                      </div>
                      <button type="button" className="connected-button connected-danger" disabled={busy} onClick={() => void disconnect(grant)}
                        aria-label={t("connectedAgentsPanel.grant.disconnectLabel", { label: grant.label })}>{t("connectedAgentsPanel.grant.disconnect")}</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="connected-muted">{t("connectedAgentsPanel.none")}</p>}
              {earlier.length > 0 && (
                <p className="connected-muted">
                  {t("connectedAgentsPanel.earlier", {
                    grants: i18n.list(
                      earlier.map(g => t(g.state === "revoked" ? "connectedAgentsPanel.earlier.revoked" : "connectedAgentsPanel.earlier.expired", { label: g.label })),
                      "unit",
                    ),
                  })}
                </p>
              )}
            </>
          )}
      <div aria-live="polite">{error && <p role="alert" className="connected-error-text">{error}</p>}</div>
    </section>
  );
}
