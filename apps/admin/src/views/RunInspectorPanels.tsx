import { useId, useState, type ReactNode } from "react";
import "../components/inspector.css";
import type { SupervisorRun } from "../domain/contracts";
import {
  PAYLOAD_REASONS,
  runInspectorErrorMessage,
  type PayloadReason,
  type PayloadReveal,
  type RunInspectorPort,
  type RunReplay,
  type RunWorkflow,
} from "../domain/runInspector";
import { Badge, Button, EmptyState, Field, Notice, Status, when } from "../components/ui";

const show = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toLocaleString("en"));
const pair = (value: { microUsd: number | null; tokens: number | null } | null | undefined) =>
  value ? `${show(value.microUsd)} micro-USD · ${show(value.tokens)} tokens` : "—";

/** The run as a tree: input event → run → checkpoints → attempts → tool calls and artifacts → verification → application. */
export function WorkflowPanel({ workflow }: { workflow: RunWorkflow | undefined }) {
  if (!workflow) return <EmptyState title="No workflow graph">This server does not report the workflow graph.</EmptyState>;
  const children = (parentId: string | null) => workflow.nodes.filter((n) => n.parentId === parentId);
  const render = (parentId: string | null, depth: number): ReactNode => {
    const nodes = children(parentId);
    if (!nodes.length) return null;
    return (
      <ol className={depth ? "workflow-graph nested" : "workflow-graph"}>
        {nodes.map((node) => (
          <li key={node.id} className={`workflow-node kind-${node.kind}`}>
            <div className="split-line">
              <span>
                <small className="eyebrow">{node.kind.replaceAll("_", " ")}</small>
                <strong>{node.label}</strong>
              </span>
              <Status value={node.status} />
            </div>
            {render(node.id, depth + 1)}
          </li>
        ))}
      </ol>
    );
  };
  return (
    <div className="stack">
      <p>
        Workflow <span className="mono">{workflow.workflowId}</span>
        {workflow.generation !== null && ` · generation ${workflow.generation}`}
      </p>
      <nav aria-label="Workflow graph">{render(null, 0)}</nav>
      {workflow.truncated && <Notice tone="gold">Only the first 200 tool calls are drawn.</Notice>}
    </div>
  );
}

export function PoliciesPanel({ run }: { run: SupervisorRun }) {
  const p = run.policies;
  if (!p) return <EmptyState title="No policy view">This server does not report policies and budgets.</EmptyState>;
  const drift = p.fence && p.fence.enrollmentRevisionNow !== null && p.fence.enrollmentRevisionNow !== p.fence.enrollmentRevision;
  return (
    <div className="stack">
      <dl className="facts vertical">
        <div><dt>Fence at the run</dt><dd>{p.fence ? `enrollment r${p.fence.enrollmentRevision} · profile r${p.fence.profileRevision} · policy r${p.fence.policyRevision} · ledger r${p.fence.ledgerRevision}` : "Unavailable"}</dd></div>
        <div><dt>Enrollment now</dt><dd>{p.fence?.enrollmentRevisionNow !== null && p.fence?.enrollmentRevisionNow !== undefined ? `r${p.fence.enrollmentRevisionNow}` : "—"}{drift && <> <Badge tone="gold">changed since the run</Badge></>}</dd></div>
        <div><dt>Course digest</dt><dd className="mono">{p.fence?.courseDigest ?? "—"}</dd></div>
        <div><dt>Deadline</dt><dd>{p.deadline ? when(p.deadline) : "—"}</dd></div>
        <div><dt>Run budget</dt><dd>{pair(p.jobBudget)}</dd></div>
        <div><dt>Charged</dt><dd>{pair(p.charged)}</dd></div>
        <div><dt>Provider configuration</dt><dd>{p.providerConfiguration}</dd></div>
        <div><dt>AI supervision</dt><dd>{p.supervision.state} · revision {p.supervision.revision}</dd></div>
        {p.reason && <div><dt>Runtime reason</dt><dd className="mono">{p.reason}</dd></div>}
      </dl>
      <table className="data-table">
        <caption>Reservations and usage per attempt</caption>
        <thead><tr><th scope="col">Operation</th><th scope="col">Status</th><th scope="col">Reserved</th><th scope="col">Used</th></tr></thead>
        <tbody>
          {p.operations.map((o) => (
            <tr key={o.id + o.attempt}>
              <td className="mono">{o.id.split("/").at(-1)} #{o.attempt}</td>
              <td>{o.status}</td>
              <td>{pair(o.reservation)}</td>
              <td>{o.usage ? `${pair(o.usage)}${o.usageBasis ? ` (${o.usageBasis.microUsd})` : ""}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="data-table">
        <caption>Budgets now</caption>
        <thead><tr><th scope="col">Budget</th><th scope="col">Limit</th><th scope="col">Used</th></tr></thead>
        <tbody>
          <tr><th scope="row">This learner</th><td>{pair(p.enrollmentBudget?.limit)}</td><td>{pair(p.enrollmentBudget?.used)}</td></tr>
          <tr><th scope="row">This learner per day</th><td>{pair(p.enrollmentBudget?.daily)}</td><td>—</td></tr>
          <tr><th scope="row">Per artifact</th><td>{pair(p.enrollmentBudget?.perArtifact)}</td><td>—</td></tr>
          <tr><th scope="row">Workspace</th><td>{pair(p.workspaceBudget?.limit)}</td><td>{pair(p.workspaceBudget?.used)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

export function SyncPanel({ run }: { run: SupervisorRun }) {
  const s = run.sync;
  if (!s) return <EmptyState title="No sync view">This server does not report client and sync state.</EmptyState>;
  const e = s.inputEvent;
  return (
    <dl className="facts vertical">
      <div><dt>Input event</dt><dd>{e ? `#${e.sequence} by ${e.actorKind}${e.recordedAt ? ` · recorded ${when(e.recordedAt)}` : ""}` : "None"}</dd></div>
      <div><dt>Client</dt><dd>{e?.platform ? `${e.platform}${e.appVersion ? ` ${e.appVersion}` : ""}${e.clientSequence ? ` · client sequence ${e.clientSequence}` : ""}` : "Not reported"}</dd></div>
      <div><dt>Client clock</dt><dd>{e?.clockSkewMs !== null && e?.clockSkewMs !== undefined ? `${e.clockSkewMs} ms between the client's time and the server's record` : "Not reported"}</dd></div>
      <div><dt>Course on the client</dt><dd className="mono">{e?.courseDigest ?? "—"}</dd></div>
      <div><dt>Events since</dt><dd>{s.eventsSince} later event(s) · latest #{s.latestSequence ?? "—"}</dd></div>
      <div><dt>Enrollment revision</dt><dd>r{s.enrollmentRevisionAtRun} at the run · r{s.enrollmentRevisionNow ?? "—"} now</dd></div>
      <div><dt>Event delivery to supervision</dt><dd>{s.delivery ? `${s.delivery.deliveredAt ? `delivered ${when(s.delivery.deliveredAt)}` : "not delivered"} · ${s.delivery.attempts} attempt(s)${s.delivery.quarantined ? " · quarantined" : ""}${s.delivery.lastErrorCode ? ` · ${s.delivery.lastErrorCode}` : ""}` : "No delivery record"}</dd></div>
      <div><dt>Run state</dt><dd>{s.run.state}{s.run.generation !== null ? ` · generation ${s.run.generation}` : ""}{s.run.snapshotVersion !== null ? ` · snapshot v${s.run.snapshotVersion}` : ""}{s.run.cancellationRequested ? " · cancellation requested" : ""}</dd></div>
      <div><dt>Last change</dt><dd>{s.run.updatedAt ? when(s.run.updatedAt) : "—"}</dd></div>
    </dl>
  );
}

export function ReplayPanel({ port, courseId, runId }: { port: RunInspectorPort | undefined; courseId: string; runId: string }) {
  const [result, setResult] = useState<RunReplay>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!port) return <EmptyState title="Replay is not available here">Use a connected administration session.</EmptyState>;
  return (
    <div className="stack">
      <p>
        Replays this run's tool loop in a sandbox: frozen inputs, the model's recorded decisions instead of a provider, every tool stubbed to its recorded
        result, a new run id, and a read-only database transaction. Nothing the learner sees changes; only a replay receipt is recorded.
      </p>
      <Button kind="primary" disabled={pending} onClick={() => {
        setPending(true);
        setError(undefined);
        port.replay(courseId, runId).then(setResult, setError).finally(() => setPending(false));
      }}>
        {pending ? "Replaying…" : "Replay in sandbox"}
      </Button>
      <div aria-live="polite">
        {error !== undefined && <Notice tone="red">{runInspectorErrorMessage(error)}</Notice>}
        {result && (
          <div className="stack">
            <Notice tone={result.outcome === "matches" ? "green" : "gold"} title={result.outcome === "matches" ? "Replay matches the recorded plan" : result.outcome === "diverged" ? "Replay diverged" : "This run cannot be replayed"}>
              Replay run <span className="mono">{result.replayRunId}</span> · tools {result.sideEffects} · progress writes {result.progressWrites} · {result.providerCalls} provider calls
              {result.reason && <> · <span className="mono">{result.reason}</span></>}
            </Notice>
            {!!result.steps.length && (
              <table className="data-table">
                <caption>Replayed steps against recorded receipts</caption>
                <thead><tr><th scope="col">Step</th><th scope="col">Tool</th><th scope="col">Recorded receipt</th></tr></thead>
                <tbody>{result.steps.map((s) => <tr key={s.step}><td>{s.step}</td><td>{s.tool}</td><td className="mono">{s.recordedReceiptId}</td></tr>)}</tbody>
              </table>
            )}
            <dl className="facts vertical">
              <div><dt>Recorded plan</dt><dd className="mono">{result.recordedPlanDigest ?? "—"}</dd></div>
              <div><dt>Replayed plan</dt><dd className="mono">{result.replayedPlanDigest ?? "—"}</dd></div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

export function PayloadPanel({ port, courseId, runId, allowed }: { port: RunInspectorPort | undefined; courseId: string; runId: string; allowed: boolean }) {
  const id = useId();
  const [reason, setReason] = useState<PayloadReason | "">("");
  const [revealed, setRevealed] = useState<PayloadReveal>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!port) return <EmptyState title="Payloads are not available here">Use a connected administration session.</EmptyState>;
  if (!allowed)
    return <Notice tone="gold">Run payloads are withheld. Revealing one needs the run.payload permission, which owners and admins hold.</Notice>;
  if (revealed)
    return (
      <div className="stack">
        <Notice tone="blue" title="Payload revealed">
          Receipt <span className="mono">{revealed.receipt.id}</span> is on the learner's record and in the audit log. {revealed.rule.reason}
        </Notice>
        {revealed.payload.inputs.map((input) => (
          <article className="record" key={input.id}>
            <h3>Frozen input · {input.checkpointId}</h3>
            <pre aria-label={`Frozen input ${input.checkpointId}`}>{JSON.stringify(input.context, null, 2)}</pre>
          </article>
        ))}
        {revealed.payload.toolCalls.map((call) => (
          <article className="record" key={call.id}>
            <div className="split-line"><h3>Step {call.step}: {call.tool}</h3>{call.withheld && <Badge tone="gold">withheld</Badge>}</div>
            {call.withheld ? (
              <p>Not revealed: {revealed.withheld.find((w) => w.ref === `tool:${call.id}`)?.category.replaceAll("-", " ") ?? "private"}.</p>
            ) : (
              <pre aria-label={`Step ${call.step} arguments and result`}>{JSON.stringify({ arguments: call.arguments, result: call.result }, null, 2)}</pre>
            )}
          </article>
        ))}
        {revealed.payload.artifacts.map((artifact) => (
          <article className="record" key={artifact.id}>
            <div className="split-line"><h3>{artifact.kind ?? "Artifact"}</h3>{artifact.withheld && <Badge tone="gold">withheld</Badge>}</div>
            {artifact.sha256 && <small className="mono">sha256 {artifact.sha256}</small>}
            {artifact.withheld ? (
              <p>Not revealed: {revealed.withheld.find((w) => w.ref === `artifact:${artifact.id}`)?.category.replaceAll("-", " ") ?? "private"}.</p>
            ) : (
              <pre aria-label={`${artifact.kind ?? "Artifact"} content`}>{JSON.stringify(artifact.content, null, 2)}</pre>
            )}
          </article>
        ))}
        <small>Displayed as inert text. Nothing is executed. Text fingerprints are valid only within this reveal.</small>
      </div>
    );
  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      if (!reason) return;
      setPending(true);
      setError(undefined);
      port.revealPayload(courseId, runId, reason).then(setRevealed, setError).finally(() => setPending(false));
    }}>
      <p>
        The run's inputs, tool arguments and results and its stored output are withheld by default. Revealing shows their structure, identifiers and states,
        and records a receipt that the learner and the audit log show. Model-written text is shown only as its length; the companion conversation, the
        learner model and teaching-hypothesis tool calls stay withheld.
      </p>
      <Field label="Reason for revealing" htmlFor={`${id}-reason`}>
        <select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as PayloadReason | "")}>
          <option value="">Choose a reason</option>
          {PAYLOAD_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </Field>
      {error !== undefined && <Notice tone="red">{runInspectorErrorMessage(error)}</Notice>}
      <Button kind="danger" type="submit" disabled={pending || !reason}>{pending ? "Revealing…" : "Reveal payload with audit receipt"}</Button>
    </form>
  );
}
