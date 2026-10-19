import React, { useCallback, useEffect, useId, useState } from "react";
import { CourseApiError, type CourseApi } from "../client/apiClient";
import type { ConnectedAgentsPanelProps } from "./ConnectedAgentsPanel";

type Scope = "context" | "profile" | "evidence" | "history" | "propose_intervention";
interface Grant { id: string; label: string; scopes: Scope[]; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null; state: "active" | "expired" | "revoked" }
interface Listing { grants: Grant[]; recentCalls: { grantId: string; tool: string; outcome: string; at: string }[] }
const SCOPES: { id: Scope; label: string; detail: string }[] = [
  { id: "context", label: "Course position", detail: "the course, your current lesson and its objectives" },
  { id: "profile", label: "Your stated preferences", detail: "pace, explanation style, prior knowledge you wrote, suggestions you accepted" },
  { id: "evidence", label: "Your progress evidence", detail: "what your answers show per objective, without anything you excluded" },
  { id: "history", label: "Your question history", detail: "your own questions and answer outcomes in a lesson" },
  { id: "propose_intervention", label: "Suggest changes", detail: "suggestions that wait for your review here; they never give credit" },
];
const DAYS = [1, 7, 30, 90];
const when = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The learner's own grants for external AI agents: scoped, expiring, revocable. The token is shown once. */
export function ConnectedAgentsPanel({ api, enrollmentId, courseTitle }: ConnectedAgentsPanelProps) {
  const id = useId();
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
      setError(cause instanceof CourseApiError && cause.code === "AGENT_GRANT_LIMIT"
        ? "You already have the most connected agents allowed for this course. Disconnect one first."
        : "The agent could not be connected. Nothing changed. Try again.");
    } finally { setBusy(false); }
  }
  async function disconnect(grant: Grant) {
    setBusy(true); setError("");
    try {
      await (api as CourseApi).request(`${base}/${encodeURIComponent(grant.id)}/revoke`, "POST", {});
      await load();
    } catch { setError(`"${grant.label}" could not be disconnected. Try again.`); } finally { setBusy(false); }
  }
  async function copy() {
    if (!created) return;
    // The clipboard API exists only on a secure (https or localhost) page. Elsewhere,
    // such as a plain-http tailnet address, select the key so it can be copied by hand.
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (typeof clipboard?.writeText !== "function") throw new Error("clipboard unavailable");
      await clipboard.writeText(created.token); setCopied(true); setCopyFailed(false);
    } catch {
      setCopied(false); setCopyFailed(true);
      const field = document.getElementById(id + "-token");
      if (field instanceof HTMLInputElement) { field.focus(); field.select(); }
    }
  }
  const toggle = (scope: Scope, on: boolean) => setScopes(current => on ? SCOPES.map(s => s.id).filter(s => s === scope || current.includes(s)) : current.filter(s => s !== scope));
  const active = listing && listing !== "unavailable" ? listing.grants.filter(g => g.state === "active") : [];
  const earlier = listing && listing !== "unavailable" ? listing.grants.filter(g => g.state !== "active") : [];
  return (
    <section className="connected-reading-card connected-agents" aria-labelledby={id + "-title"}>
      <h2 id={id + "-title"}>Connected agents</h2>
      <p className="connected-muted">
        Let an AI agent you use elsewhere read parts of your record for {courseTitle} and suggest changes for you to review.
        You choose what it may read and for how long, and you can disconnect it at any time. It cannot answer checks, change
        your progress or see your private notes, your course team&apos;s notes or other learners.
      </p>
      {created && (
        <div className="connected-agents-token" role="status">
          <p><strong>Connected “{created.label}”.</strong> Copy this key into your agent now. It is shown only once; if you lose it, disconnect and connect again.</p>
          <label htmlFor={id + "-token"}>Access key</label>
          <input id={id + "-token"} readOnly value={created.token} onFocus={(e) => e.currentTarget.select()} />
          <div className="connected-agents-actions">
            <button type="button" className="connected-button" onClick={() => void copy()}>{copied ? "Copied" : "Copy key"}</button>
            <button type="button" className="connected-button connected-secondary" onClick={() => setCreated(undefined)}>I saved it</button>
          </div>
          {copyFailed && <p className="connected-muted" role="alert">This page can&apos;t copy for you on this connection. The key is selected: copy it with Ctrl+C (⌘C on a Mac) or your device&apos;s copy menu.</p>}
          <p className="connected-muted">Agents send it as <code>Authorization: Bearer</code> to <code>/api/agent-tools/mcp</code> (MCP) or <code>/api/agent-tools/v1/tools/…</code>.</p>
        </div>
      )}
      <details className="connected-review">
        <summary>Connect an agent</summary>
        <div className="connected-agents-form">
          <label htmlFor={id + "-label"}>Name for this agent</label>
          <input id={id + "-label"} maxLength={80} autoComplete="off" value={label} onChange={(e) => setLabel(e.target.value)} />
          <fieldset>
            <legend>It may</legend>
            {SCOPES.map(scope => (
              <label key={scope.id} className="connected-agents-scope">
                <input type="checkbox" checked={scopes.includes(scope.id)} onChange={(e) => toggle(scope.id, e.target.checked)} />
                <span><strong>{scope.label}</strong> — {scope.detail}</span>
              </label>
            ))}
          </fieldset>
          <label htmlFor={id + "-days"}>Disconnect automatically after</label>
          <select id={id + "-days"} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map(d => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>)}
          </select>
          <button type="button" className="connected-button" disabled={busy || !label.trim() || !scopes.length} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect agent"}
          </button>
        </div>
      </details>
      {listing === undefined ? <p className="connected-muted">Checking…</p>
        : listing === "unavailable" ? <p className="connected-muted">Your connected agents could not be loaded right now.</p>
          : (
            <>
              {active.length ? (
                <ul className="connected-agents-list" aria-label="Agents connected now">
                  {active.map(grant => (
                    <li key={grant.id}>
                      <div>
                        <strong>{grant.label}</strong>
                        <span className="connected-muted"> · {grant.scopes.map(s => SCOPES.find(x => x.id === s)?.label ?? s).join(", ")}</span>
                        <div className="connected-muted">Until {when(grant.expiresAt)} · {grant.lastUsedAt ? `last used ${when(grant.lastUsedAt)}` : "not used yet"}</div>
                      </div>
                      <button type="button" className="connected-button connected-danger" disabled={busy} onClick={() => void disconnect(grant)}
                        aria-label={`Disconnect ${grant.label}`}>Disconnect</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="connected-muted">No agents are connected.</p>}
              {earlier.length > 0 && (
                <p className="connected-muted">
                  Earlier: {earlier.map(g => `${g.label} (${g.state === "revoked" ? "disconnected" : "expired"})`).join(", ")}
                </p>
              )}
            </>
          )}
      <div aria-live="polite">{error && <p role="alert" className="connected-error-text">{error}</p>}</div>
    </section>
  );
}
