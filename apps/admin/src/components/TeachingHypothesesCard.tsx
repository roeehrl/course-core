import { useEffect, useState } from "react";
import type { AdminClient, Enrollment } from "../domain/contracts";
import type { HypothesisView } from "../domain/hypotheses";
import { Badge, Card, EmptyState, Notice, Status } from "./ui";

const kinds: Record<HypothesisView["items"][number]["kind"], string> = {
  misconception: "Possible misconception",
  missing_prerequisite: "Possibly missing prerequisite",
  slip: "Possible slip",
  ambiguous_item: "Possibly ambiguous item",
  useful_analogy: "Useful comparison",
};

/** Read-only: the learner's teaching hypotheses, probe runs and the trigger
 * table decisions behind them. Only the learner can correct, reject or pin. */
export function TeachingHypothesesCard({ client, enrollment }: { client: AdminClient; enrollment: Enrollment }) {
  const [view, setView] = useState<HypothesisView>();
  const [failed, setFailed] = useState(false);
  const port = client.teachingHypotheses;
  useEffect(() => {
    if (!port || enrollment.status === "erased") return;
    const abort = new AbortController();
    setView(undefined);
    setFailed(false);
    port.load(enrollment.id, abort.signal).then(setView, () => {
      if (!abort.signal.aborted) setFailed(true);
    });
    return () => abort.abort();
  }, [port, enrollment.id, enrollment.status]);
  if (!port || enrollment.status === "erased") return null;
  return (
    <Card title="Teaching hypotheses" eyebrow="Learner model · read only">
      <p>
        Revisable ideas guiding this learner's teaching. They are not evidence or grades; only the learner can correct,
        reject or pin them.
      </p>
      {failed && <Notice tone="gold">Teaching hypotheses are unavailable right now.</Notice>}
      {view && !view.items.length && (
        <EmptyState title="No hypotheses">No teaching hypotheses have been recorded for this learner.</EmptyState>
      )}
      {view?.items.map((h) => (
        <article key={h.hypothesisId} className="evidence-item" aria-label={`Hypothesis ${h.hypothesisId}`}>
          <div className="split-line">
            <h3>{kinds[h.kind]}</h3>
            <Status value={h.status} />
          </div>
          <p>{h.learnerCorrection ?? h.statement}</p>
          {h.learnerCorrection && <small>Corrected by the learner. Original: {h.statement}</small>}
          <div className="split-line">
            <span>
              <Badge tone="blue">{h.source}</Badge> <Badge tone="neutral">uncertainty {h.uncertainty}</Badge>{" "}
              {h.pinned && <Badge tone="gold">pinned by learner</Badge>}
            </span>
            <small className="mono">
              {h.observations} observation{h.observations === 1 ? "" : "s"} · r{h.revision}
            </small>
          </div>
        </article>
      ))}
      {!!view?.probes.length && (
        <table className="data-table">
          <caption>Diagnostic probe runs (never evidence)</caption>
          <thead>
            <tr><th scope="col">Probe</th><th scope="col">Requested by</th><th scope="col">State</th></tr>
          </thead>
          <tbody>
            {view.probes.map((p) => (
              <tr key={p.probeRunId}><td className="mono">{p.probeId}</td><td>{p.requestedBy}</td><td>{p.state}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {!!view?.signals.length && (
        <details>
          <summary>Recent trigger table decisions</summary>
          <ul>
            {view.signals.map((s, i) => (
              <li key={i}>
                <span className="mono">{s.signalKind}</span> · rules {s.ruleIds.join(", ") || "none"}
                {s.recommendations.length ? ` · recommended ${s.recommendations.map((r) => r.action).join(", ")}` : ""}
                {s.restraints.length ? ` · restraints ${s.restraints.join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
