import { useId, useRef, useState } from "react";
import {
  GATE_REVIEW_NOTE_MIN,
  gateReviewErrorMessage,
  type GateReview,
  type GateReviewResolution,
  type GateReviewsPort,
} from "../domain/gateReviews";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, when } from "../components/ui";

const statusLabel: Record<GateReview["decision"]["status"], string> = {
  ready: "ready",
  needs_evidence: "needs evidence",
  needs_help: "needs help",
  under_review: "under review",
  closed_with_gaps: "closed with gaps",
};

/** Learners' requests to look at a gate decision again. Staff either uphold the decision with a
 * reason the learner reads, or (with enrollment rights) grant an audited exception that lets the
 * learner advance past this checkpoint. Neither changes the decision or counts as evidence. */
export function GateReviewQueue({ port, catalogId }: { port: GateReviewsPort; catalogId: string }) {
  const queue = useRemote((signal) => port.queue(catalogId, signal), [port, catalogId]);
  const [message, setMessage] = useState("");
  return (
    <section className="page-stack" aria-labelledby="gate-review-heading">
      <h2 id="gate-review-heading" className="section-title">Gate review requests</h2>
      <div aria-live="polite">{message && <Notice tone="green">{message}</Notice>}</div>
      {queue.loading ? (
        <Loading label="Loading gate review requests…" />
      ) : queue.error || !queue.data ? (
        <Notice tone="red">{gateReviewErrorMessage(queue.error)}</Notice>
      ) : queue.data.reviews.length === 0 ? (
        <Card>
          <EmptyState title="No gate reviews waiting">Learners' requests to look at a checkpoint decision again appear here.</EmptyState>
        </Card>
      ) : (
        queue.data.reviews.map((review) => (
          <GateReviewCard
            key={review.requestId}
            review={review}
            onResolve={async (input, key) => {
              const receipt = await port.resolve(review.requestId, input, key);
              setMessage(
                receipt.state === "exception_granted"
                  ? `Exception granted for ${review.learner} on ${review.gateId}.`
                  : `Decision upheld for ${review.learner} on ${review.gateId}.`,
              );
              queue.reload();
            }}
          />
        ))
      )}
    </section>
  );
}

function GateReviewCard({ review, onResolve }: { review: GateReview; onResolve: (input: GateReviewResolution, key: string) => Promise<void> }) {
  const id = useId();
  const [outcome, setOutcome] = useState<GateReviewResolution["outcome"]>("upheld");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  // One key per distinct decision: a retry of the same decision replays, a changed one is new.
  const key = useRef({ input: "", value: "" });
  const keyFor = (input: GateReviewResolution) => {
    const digest = JSON.stringify(input);
    if (key.current.input !== digest) key.current = { input: digest, value: "gate-review-" + crypto.randomUUID() };
    return key.current.value;
  };
  const { decision } = review;
  const noteReady = note.trim().length >= GATE_REVIEW_NOTE_MIN;
  return (
    <Card
      eyebrow={`${review.learner} · ${review.gateId} · ${when(review.requestedAt)}`}
      title={`Review requested for ${review.gateId}`}
      actions={<Badge tone="gold">{statusLabel[decision.status]}</Badge>}
    >
      <Notice tone="blue" title="The learner asks">
        {review.reason}
      </Notice>
      {!review.canUphold && <Notice tone="gold">This is your own request. Another staff member must decide it.</Notice>}
      <section className="gate-decision" aria-label={`Decision under review for ${review.learner}`}>
        <p>
          <strong>Decision</strong> · version {decision.gateVersion} · decided {when(decision.decidedAt)}
        </p>
        <p className="muted">{decision.learnerVisibleReason}</p>
        <ul className="gate-criteria">
          {decision.criterionResults.map((c) => (
            <li key={c.criterionId}>
              <Badge tone={c.met === true ? "green" : c.met === "pending" ? "gold" : "red"}>
                {c.met === true ? "met" : c.met === "pending" ? "pending" : "not met"}
              </Badge>{" "}
              <span>{c.reason || c.criterionId}</span>
            </li>
          ))}
        </ul>
        {decision.missingObjectiveIds.length > 0 && <p className="muted">Objectives not yet shown: {decision.missingObjectiveIds.join(", ")}</p>}
      </section>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const input = { outcome, note: note.trim() };
          setPending(true);
          setError(undefined);
          onResolve(input, keyFor(input))
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        <fieldset className="review-criterion gate-outcome">
          <legend>Outcome</legend>
          <label className="check-label">
            <input type="radio" name={`${id}-outcome`} checked={outcome === "upheld"} disabled={!review.canUphold} onChange={() => setOutcome("upheld")} />
            Uphold the decision: the learner keeps working toward the gate
          </label>
          {review.canGrantException ? (
            <label className="check-label">
              <input type="radio" name={`${id}-outcome`} checked={outcome === "exception"} onChange={() => setOutcome("exception")} />
              Grant an exception: let the learner advance past this checkpoint on this course version
            </label>
          ) : (
            review.canUphold && <p className="muted">Only owners, admins and instructors can grant an exception.</p>
          )}
        </fieldset>
        {outcome === "exception" && (
          <Notice tone="gold" title="An exception is not evidence">
            The decision keeps its status and open criteria, and the objectives are not counted as shown. It is recorded with your
            name and applies only to this course and gate version.
          </Notice>
        )}
        <Field label="Message to the learner" htmlFor={`${id}-note`} hint={`Required: at least ${GATE_REVIEW_NOTE_MIN} characters. The learner reads it.`}>
          <textarea id={`${id}-note`} rows={3} maxLength={2000} value={note} disabled={!review.canUphold} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error !== undefined && <Notice tone="red">{gateReviewErrorMessage(error)}</Notice>}
        <Button kind="primary" type="submit" disabled={pending || !review.canUphold || !noteReady}>
          {outcome === "exception" ? "Grant exception" : "Uphold decision"}
        </Button>
      </form>
    </Card>
  );
}
