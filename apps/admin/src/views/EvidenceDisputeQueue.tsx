import { useId, useRef, useState } from "react";
import {
  EVIDENCE_DISPUTE_NOTE_MAX,
  evidenceDisputeErrorMessage,
  type EvidenceDispute,
  type EvidenceDisputeResolution,
  type EvidenceDisputesPort,
} from "../domain/evidenceDisputes";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, when } from "../components/ui";

const age = (days: number) => (days === 0 ? "opened today" : days === 1 ? "open 1 day" : `open ${days} days`);

/** Learners' open disputes of their own evidence. Staff resolve one by reviewing the evidence:
 * uphold a valid result (it does not change) or invalidate it. The learner's explanation is
 * never shown here; it stays with the learner. */
export function EvidenceDisputeQueue({ port, catalogId }: { port: EvidenceDisputesPort; catalogId: string }) {
  const queue = useRemote((signal) => port.queue(catalogId, signal), [port, catalogId]);
  const [message, setMessage] = useState("");
  return (
    <section className="page-stack" aria-labelledby="evidence-dispute-heading">
      <h2 id="evidence-dispute-heading" className="section-title">Disputed evidence</h2>
      <div aria-live="polite">{message && <Notice tone="green">{message}</Notice>}</div>
      {queue.loading ? (
        <Loading label="Loading disputed evidence…" />
      ) : queue.error || !queue.data ? (
        <Notice tone="red">{evidenceDisputeErrorMessage(queue.error)}</Notice>
      ) : queue.data.disputes.length === 0 ? (
        <Card>
          <EmptyState title="No disputed evidence">When a learner disputes a result, it appears here until it is reviewed or withdrawn.</EmptyState>
        </Card>
      ) : (
        <>
          <Notice tone="blue" title="The learner's reason stays private">
            You see which result is disputed, not the learner's explanation. Look at the answer in the learner's enrollment, then
            uphold or invalidate it. Either decision closes the dispute and is recorded with your name.
          </Notice>
          {queue.data.truncated && <Notice tone="gold">Showing the 200 oldest disputes. Resolve some to see the rest.</Notice>}
          {queue.data.disputes.map((dispute) => (
            <DisputeCard
              key={dispute.disputeId}
              dispute={dispute}
              onResolve={async (input, key) => {
                const receipt = await port.resolve(catalogId, dispute.disputeId, input, key);
                setMessage(
                  receipt.invalidated
                    ? `Evidence invalidated for ${dispute.learner} on ${dispute.objectiveId}. The dispute is closed.`
                    : `Result upheld for ${dispute.learner} on ${dispute.objectiveId}. The dispute is closed.`,
                );
                queue.reload();
              }}
            />
          ))}
        </>
      )}
    </section>
  );
}

function DisputeCard({ dispute, onResolve }: { dispute: EvidenceDispute; onResolve: (input: EvidenceDisputeResolution, key: string) => Promise<void> }) {
  const id = useId();
  const [decision, setDecision] = useState<EvidenceDisputeResolution["decision"]>(dispute.canUphold ? "accept" : "reject");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  // One key per distinct decision: a retry of the same decision replays, a changed one is new.
  const key = useRef({ input: "", value: "" });
  const keyFor = (input: EvidenceDisputeResolution) => {
    const digest = JSON.stringify(input);
    if (key.current.input !== digest) key.current = { input: digest, value: "evidence-dispute-" + crypto.randomUUID() };
    return key.current.value;
  };
  const { evidence } = dispute;
  return (
    <Card
      eyebrow={`${dispute.learner} · ${dispute.objectiveId} · ${age(dispute.ageDays)}`}
      title={`Disputed result for ${dispute.objectiveId}`}
      actions={<Badge tone="gold">disputed</Badge>}
    >
      {!dispute.canResolve && <Notice tone="gold">This is your own dispute. Another staff member must resolve it.</Notice>}
      <section className="gate-decision" aria-label={`Disputed evidence for ${dispute.learner}`}>
        <dl className="dispute-facts">
          <div><dt>Item</dt><dd>{evidence.assessmentId}</dd></div>
          <div><dt>Recorded result</dt><dd>{evidence.passed ? "passed" : "not passed"}{evidence.independent ? ", independent" : ", not independent"} ({evidence.mode})</dd></div>
          <div><dt>Course version</dt><dd>{evidence.releaseVersion}</dd></div>
          <div><dt>Disputed</dt><dd>{when(dispute.raisedAt)}</dd></div>
          <div><dt>Evidence</dt><dd className="mono">{evidence.evidenceId}</dd></div>
        </dl>
      </section>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const input = { decision, note: note.trim() };
          setPending(true);
          setError(undefined);
          onResolve(input, keyFor(input))
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        <fieldset className="review-criterion gate-outcome">
          <legend>Decision</legend>
          <label className="check-label">
            <input type="radio" name={`${id}-decision`} checked={decision === "accept"} disabled={!dispute.canUphold} onChange={() => setDecision("accept")} />
            Uphold the result: it stays as recorded
          </label>
          {dispute.canResolve && !dispute.canUphold && (
            <p className="muted">Only an independent, unassisted, passing answer on a checked item can be upheld here.</p>
          )}
          <label className="check-label">
            <input type="radio" name={`${id}-decision`} checked={decision === "reject"} disabled={!dispute.canResolve} onChange={() => setDecision("reject")} />
            Invalidate this evidence: progress is recomputed without it
          </label>
        </fieldset>
        <Field label="Review note" htmlFor={`${id}-note`} hint="Required. Recorded with the review; an invalidation keeps it as the reason.">
          <textarea id={`${id}-note`} rows={3} maxLength={EVIDENCE_DISPUTE_NOTE_MAX} value={note} disabled={!dispute.canResolve} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error !== undefined && <Notice tone="red">{evidenceDisputeErrorMessage(error)}</Notice>}
        <Button kind="primary" type="submit" disabled={pending || !dispute.canResolve || !note.trim()}>
          {decision === "reject" ? "Invalidate evidence" : "Uphold result"}
        </Button>
      </form>
    </Card>
  );
}
