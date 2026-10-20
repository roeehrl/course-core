import { useEffect, useRef, useState } from "react";
import { AdminError, errorMessage } from "../domain/errors";
import {
  REASON_TEXT,
  STATUS_TEXT,
  shortDigest,
  type EvalRequired,
  type EvalStatus,
  type ProviderEvalPort,
} from "../domain/providerEvals";
import { randomId } from "../domain/webCrypto";
import { Badge, Button, Card, Field, Notice } from "./ui";

interface Props {
  workspaceId: string;
  api: ProviderEvalPort;
  /** Revisions a just-refused save needs evidence for (409 PROVIDER_EVAL_REQUIRED). */
  required?: EvalRequired | undefined;
  /** Changes whenever the provider configuration was saved, to reload the status. */
  reloadKey?: number;
}
const ROLES = [
  "supervisor",
  "companion",
  "research",
  "media",
  "reviewer",
] as const;
const tone = (status: EvalStatus["roles"][number]["status"]) =>
  status === "passed"
    ? "green"
    : status === "override"
      ? "blue"
      : status === "failed" || status === "stale"
        ? "red"
        : status === "not_evaluated"
          ? "gold"
          : "neutral";
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

/** Agent evaluation status of the active provider revision, and the owner override. */
export function ProviderEvalPanel({
  workspaceId,
  api,
  required,
  reloadKey = 0,
}: Props) {
  const [status, setStatus] = useState<EvalStatus>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [role, setRole] = useState<string>("companion"),
    [digest, setDigest] = useState(""),
    [reason, setReason] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    api.status(workspaceId, controller.signal).then(
      (value) => {
        if (alive.current) {
          setStatus(value);
          setError("");
        }
      },
      (e) => {
        if (!controller.signal.aborted && alive.current)
          setError(errorMessage(e));
      },
    );
    return () => controller.abort();
  }, [api, workspaceId, reload, reloadKey]);
  useEffect(() => {
    const first = required?.roles[0];
    if (first) {
      setRole(first.role);
      setDigest(first.revisionDigest);
      setNotice("");
    }
  }, [required]);
  async function recordOverride() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const receipt = await api.override(workspaceId, {
        idempotencyKey: randomId(),
        role,
        revisionDigest: digest.trim(),
        reason: reason.trim(),
      });
      if (!alive.current) return;
      setNotice(
        `Override recorded for the ${receipt.role} revision ${shortDigest(receipt.revisionDigest)}. Save the provider settings again to activate it.`,
      );
      setReason("");
      setReload((n) => n + 1);
    } catch (e) {
      if (!alive.current) return;
      setError(
        e instanceof AdminError && e.code === "permission_denied"
          ? "Only a workspace owner can record an override. Ask an owner, or record a passing evaluation report."
          : errorMessage(e),
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const validDigest = /^[a-f0-9]{64}$/.test(digest.trim()),
    validReason = reason.trim().length >= 20 && reason.trim().length <= 1000;
  return (
    <Card
      title="Agent evaluations"
      eyebrow="Provider, model and prompt revisions"
    >
      <div className="stack">
        <p>
          A new or changed revision of an evaluated role activates only after a
          passing evaluation of that exact revision against the current suite,
          or an owner override. Revisions that were active before this gate stay
          active and are shown as not evaluated. Scripted runs check Core's
          prompt path and graders, not a real model.
        </p>
        {error && <Notice tone="red">{error}</Notice>}
        {notice && <Notice tone="green">{notice}</Notice>}
        {required && (
          <Notice tone="gold" title="Waiting for evaluation">
            <ul className="eval-required">
              {required.roles.map((r) => (
                <li key={r.role}>
                  <strong>{r.role}</strong>: {REASON_TEXT[r.reason]}. Revision{" "}
                  <code className="digest">{r.revisionDigest}</code>
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {!status && !error && <p role="status">Loading evaluation status…</p>}
        {status && (
          <>
            <dl className="facts">
              <div>
                <dt>Suite</dt>
                <dd>
                  {status.suite.id} {status.suite.version}
                </dd>
              </div>
              <div>
                <dt>Dialogues</dt>
                <dd>
                  {status.suite.coverage
                    .map((c) => `${c.role} ${c.dialogues}`)
                    .join(" · ")}
                </dd>
              </div>
              <div>
                <dt>Suite digest</dt>
                <dd>
                  <code className="digest">
                    {shortDigest(status.suite.digest)}
                  </code>
                </dd>
              </div>
            </dl>
            {status.roles.length === 0 ? (
              <p>No workspace provider revision is active.</p>
            ) : (
              <ul className="eval-roles" aria-label="Role evaluation status">
                {status.roles.map((r) => (
                  <li key={r.role} className="eval-role">
                    <div className="eval-role-heading">
                      <strong>{r.role}</strong>
                      <Badge tone={tone(r.status)}>
                        {STATUS_TEXT[r.status]}
                      </Badge>
                    </div>
                    <small>
                      Revision{" "}
                      <code className="digest">
                        {shortDigest(r.revisionDigest)}
                      </code>
                      {r.strategy ? ` · ${r.strategy}` : ""}
                      {r.evaluatedAt ? ` · passed ${when(r.evaluatedAt)}` : ""}
                      {r.overriddenAt
                        ? ` · overridden ${when(r.overriddenAt)}`
                        : ""}
                    </small>
                    {r.grandfathered && r.covered && r.status !== "passed" && (
                      <small>
                        Active before the eval gate; kept active until this
                        role's revision changes.
                      </small>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {status.results.length > 0 && (
              <section aria-label="Recent evaluation results" className="stack">
                <h3>Recent evaluation results</h3>
                <ul className="eval-roles">
                  {status.results.slice(0, 10).map((r) => (
                    <li key={r.id} className="eval-role">
                      <div className="eval-role-heading">
                        <strong>{r.role}</strong>
                        <Badge tone={r.outcome === "passed" ? "green" : "red"}>
                          {r.outcome}
                        </Badge>
                      </div>
                      <small>
                        {r.mode} run · revision{" "}
                        <code className="digest">
                          {shortDigest(r.revisionDigest)}
                        </code>{" "}
                        · {when(r.createdAt)}
                      </small>
                      {r.failed.length > 0 && (
                        <small>
                          Failed:{" "}
                          {r.failed
                            .slice(0, 5)
                            .map(
                              (f) =>
                                `${f.dialogueId} (${f.graders.join(", ")})`,
                            )
                            .join("; ")}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {status.overrides.length > 0 && (
              <section aria-label="Owner overrides" className="stack">
                <h3>Owner overrides</h3>
                <ul className="eval-roles">
                  {status.overrides.slice(0, 10).map((o) => (
                    <li key={o.id} className="eval-role">
                      <div className="eval-role-heading">
                        <strong>{o.role}</strong>
                        <small>{when(o.createdAt)}</small>
                      </div>
                      <small>
                        Revision{" "}
                        <code className="digest">
                          {shortDigest(o.revisionDigest)}
                        </code>
                      </small>
                      <small>{o.reason}</small>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        <section aria-label="Record an owner override" className="stack">
          <h3>Owner override</h3>
          <p>
            Owners only. An override is recorded with your account and reason,
            and applies only to this exact role revision and suite.
          </p>
          <Field label="Role" htmlFor="eval-override-role">
            <select
              id="eval-override-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Revision digest"
            htmlFor="eval-override-digest"
            hint="64 hexadecimal characters, from the refused save or the runner report."
          >
            <input
              id="eval-override-digest"
              value={digest}
              onChange={(e) => setDigest(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="eval-override-digest-hint"
              aria-invalid={digest !== "" && !validDigest}
            />
          </Field>
          <Field
            label="Reason"
            htmlFor="eval-override-reason"
            hint="20 to 1000 characters. Visible to owners and administrators."
          >
            <textarea
              id="eval-override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              aria-describedby="eval-override-reason-hint"
            />
          </Field>
          <div>
            <Button
              kind="primary"
              disabled={busy || !validDigest || !validReason}
              onClick={() => void recordOverride()}
            >
              Record owner override
            </Button>
          </div>
        </section>
      </div>
    </Card>
  );
}
