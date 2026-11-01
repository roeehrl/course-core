import React, { useCallback, useEffect, useId, useState } from "react";
import { CourseApiError, type CourseApi } from "../client/apiClient";
import type { ConnectedAgentsPanelProps } from "./ConnectedAgentsPanel";
import { Icon } from "./icons/Icon.web";
import { PillButton } from "../connected/ui/PillButton.web";
import { StatusLine } from "../connected/ui/StatusLine.web";
import { Tag } from "../connected/ui/Tag.web";
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
    // Developer-grade and rarely needed, so it waits behind "Advanced" (final design §4.15).
    <details className="cc-prof-advanced">
      <summary className="cc-prof-advanced-summary">{t("connectedAgentsPanel.advanced")}</summary>
      <section className="connected-reading-card connected-agents cc-prof-section" aria-labelledby={id + "-title"}>
        <div className="cc-prof-head">
          <h2 id={id + "-title"} className="cc-prof-title">{t("connectedAgentsPanel.title")}</h2>
          <p className="cc-prof-intro">{t("connectedAgentsPanel.intro", { course: courseTitle })}</p>
        </div>
        {listing === undefined ? <p className="connected-muted">{t("connectedAgentsPanel.checking")}</p>
          : listing === "unavailable" ? <p className="connected-muted">{t("connectedAgentsPanel.unavailable")}</p>
            : (
              <>
                {active.length ? (
                  <ul className="connected-agents-list cc-prof-list" aria-label={t("connectedAgentsPanel.active")}>
                    {active.map(grant => (
                      <li key={grant.id} className="cc-prof-card">
                        <div className="cc-prof-agent-head">
                          <strong dir="auto" className="cc-prof-card-title">{grant.label}</strong>
                          <Tag className="cc-prof-chip" icon="check" label={t("connectedAgentsPanel.grant.connected")} />
                          <button type="button" className="cc-ui-text-button cc-prof-text-button cc-prof-danger" disabled={busy} onClick={() => void disconnect(grant)}
                            aria-label={t("connectedAgentsPanel.grant.disconnectLabel", { label: grant.label })}>{t("connectedAgentsPanel.grant.disconnect")}</button>
                        </div>
                        <div className="cc-prof-agent-when">
                          <p className="cc-prof-detail">{t("connectedAgentsPanel.grant.until", { until: when(grant.expiresAt) })}</p>
                          <p className="cc-prof-detail">
                            {grant.lastUsedAt ? t("connectedAgentsPanel.grant.used", { used: when(grant.lastUsedAt) }) : t("connectedAgentsPanel.grant.unused")}
                          </p>
                        </div>
                        <fieldset className="cc-prof-scopes" disabled>
                          <legend className="cc-prof-detail">{t("connectedAgentsPanel.grant.scopes", { label: grant.label })}</legend>
                          {SCOPES.map(scope => (
                            <label key={scope} className="cc-prof-scope">
                              <input type="checkbox" checked={grant.scopes.includes(scope)} readOnly />
                              <span>{scopeName(scope)}</span>
                            </label>
                          ))}
                        </fieldset>
                      </li>
                    ))}
                  </ul>
                ) : <p className="connected-muted">{t("connectedAgentsPanel.none")}</p>}
                {earlier.length > 0 && (
                  <p className="cc-prof-detail">
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
        {created && (
          <div className="connected-agents-token cc-prof-card" role="status">
            <p className="cc-prof-token-line">
              <Icon name="check" size={16} />
              <span>
                {i18n.rich("connectedAgentsPanel.token.created", { label: created.label }, {
                  strong: (children, key) => <strong key={key}>{children}</strong>,
                })}
              </span>
            </p>
            <label htmlFor={id + "-token"} className="cc-ui-sr-only">{t("connectedAgentsPanel.token.label")}</label>
            <div className="connected-agents-actions">
              <input id={id + "-token"} dir="ltr" readOnly value={created.token} onFocus={(e) => e.currentTarget.select()} />
              <PillButton startIcon="copy" label={t(copied ? "connectedAgentsPanel.token.copied" : "connectedAgentsPanel.token.copy")} onPress={() => void copy()} />
              <PillButton variant="accent" label={t("connectedAgentsPanel.token.saved")} onPress={() => setCreated(undefined)} />
            </div>
            {copyFailed && <p className="cc-prof-detail" role="alert">{t("connectedAgentsPanel.token.copyFailed")}</p>}
            <p className="cc-prof-detail cc-prof-code-line">
              {i18n.rich(
                "connectedAgentsPanel.token.usage",
                // i18n-ignore: HTTP header and API paths are code, shown left to right
                { header: "Authorization: Bearer", mcp: "/api/agent-tools/mcp", rest: "/api/agent-tools/v1/tools/…" },
                { code: (children, key) => <code key={key} dir="ltr">{children}</code> },
              )}
            </p>
          </div>
        )}
        <details className="cc-prof-connect">
          <summary className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36">{t("connectedAgentsPanel.form.summary")}</summary>
          <div className="connected-agents-form">
            <label htmlFor={id + "-label"}>{t("connectedAgentsPanel.form.name")}</label>
            <input id={id + "-label"} maxLength={80} autoComplete="off" value={label} onChange={(e) => setLabel(e.target.value)} />
            <fieldset>
              <legend>{t("connectedAgentsPanel.form.scopes")}</legend>
              {SCOPES.map(scope => (
                <label key={scope} className="connected-agents-scope">
                  <input type="checkbox" checked={scopes.includes(scope)} onChange={(e) => toggle(scope, e.target.checked)} />
                  <span>
                    <span className="cc-prof-scope-name">{t(scopeLabel(scope))}</span>
                    <span className="cc-prof-detail">{t(scopeDetail(scope))}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label htmlFor={id + "-days"}>{t("connectedAgentsPanel.form.expiry")}</label>
            <select id={id + "-days"} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DAYS.map(d => <option key={d} value={d}>{t("connectedAgentsPanel.form.days", { count: d })}</option>)}
            </select>
            <p className="cc-prof-detail">{t("connectedAgentsPanel.form.limits")}</p>
            <PillButton variant="accent" disabled={busy || !label.trim() || !scopes.length} onPress={() => void connect()}
              label={t(busy ? "connectedAgentsPanel.form.connecting" : "connectedAgentsPanel.form.connect")} />
          </div>
        </details>
        <div aria-live="polite">{error && <div role="alert"><StatusLine tone="error" text={error} /></div>}</div>
      </section>
    </details>
  );
}
