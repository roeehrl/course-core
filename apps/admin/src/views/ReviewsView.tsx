import { useEffect, useId, useRef, useState } from "react";
import { Quote } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { reviewErrorMessage, type PendingReview, type ReviewInput } from "../domain/reviews";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, when } from "../components/ui";

type Finding = { met: boolean; quote: string; note: string };

/** Reviewers judge each criterion against the learner's own words. A met
 * criterion requires an exact quotation; the server rejects anything else. */
export function ReviewsView({ data, client }: { data: CourseWorkspace; client: AdminClient }) {
  if (!client.reviews)
    return (
      <Card title="Written answer reviews">
        <EmptyState title="Reviews are not available here">Use a connected administration session.</EmptyState>
      </Card>
    );
  return <ReviewQueue port={client.reviews} catalogId={data.course.id} />;
}

function ReviewQueue({ port, catalogId }: { port: NonNullable<AdminClient["reviews"]>; catalogId: string }) {
  const queue = useRemote((signal) => port.pending(catalogId, signal), [port, catalogId]);
  const [message, setMessage] = useState("");
  if (queue.loading) return <Loading label="Loading written answers…" />;
  if (queue.error || !queue.data) return <Notice tone="red">{reviewErrorMessage(queue.error)}</Notice>;
  return (
    <div className="page-stack">
      <Notice tone="blue" title="Evidence comes from the learner's words">
        Mark a criterion as met only when you can quote where the answer shows it. A clarification request records no
        judgement. Decisions are final for that answer and become independent evidence only when the item was answered
        without help.
      </Notice>
      <div aria-live="polite">{message && <Notice tone="green">{message}</Notice>}</div>
      {queue.data.pending.length === 0 ? (
        <Card title="Written answer reviews">
          <EmptyState title="Nothing waiting">New written answers appear here for review.</EmptyState>
        </Card>
      ) : (
        queue.data.pending.map((item) => (
          <ReviewCard
            key={item.attemptId}
            item={item}
            onSubmit={async (input, key) => {
              await port.review(item.attemptId, input, key);
              setMessage(`Review saved for ${item.learner}.`);
              queue.reload();
            }}
          />
        ))
      )}
    </div>
  );
}

function ReviewCard({ item, onSubmit }: { item: PendingReview; onSubmit: (input: ReviewInput, key: string) => Promise<void> }) {
  const id = useId();
  const key = useRef("admin-" + crypto.randomUUID());
  const [findings, setFindings] = useState<Record<string, Finding>>(
    Object.fromEntries(item.rubric.map((c) => [c.id, { met: false, quote: "", note: "" }])),
  );
  const [decision, setDecision] = useState<ReviewInput["decision"]>("not_met");
  const [learnerNote, setLearnerNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const requiredMet = item.rubric.filter((c) => c.required).every((c) => findings[c.id]!.met);
  // Keep the decision consistent with the findings; clarification stays a choice.
  useEffect(() => {
    setDecision((current) => (current === "needs_clarification" ? current : requiredMet ? "met" : "not_met"));
  }, [requiredMet]);
  const update = (criterion: string, patch: Partial<Finding>) => setFindings({ ...findings, [criterion]: { ...findings[criterion]!, ...patch } });
  function quoteSelection(criterion: string) {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (selected && item.response.includes(selected)) update(criterion, { quote: selected, met: true });
  }
  return (
    <Card
      eyebrow={`${item.learner} · ${item.episodeId} · ${when(item.submittedAt)}`}
      title={item.prompt}
      actions={<Badge tone={item.independentEligible ? "green" : "gold"}>{item.independentEligible ? "independent" : "practice"}</Badge>}
    >
      {item.ownSubmission && <Notice tone="gold">This is your own answer. Another reviewer must review it.</Notice>}
      <div className="review-response" tabIndex={0} role="region" aria-label={`Answer from ${item.learner}`}>
        {item.response}
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          onSubmit(
            {
              decision,
              criteria: item.rubric.map((c) => {
                const f = findings[c.id]!;
                return { criterionId: c.id, met: f.met, ...(f.met && f.quote.trim() ? { quote: f.quote.trim() } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) };
              }),
              ...(learnerNote.trim() ? { learnerNote: learnerNote.trim() } : {}),
            },
            key.current,
          )
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        {item.rubric.map((c) => {
          const f = findings[c.id]!;
          const quoted = !f.met || (f.quote.trim().length >= 10 && item.response.includes(f.quote.trim()));
          return (
            <fieldset key={c.id} className="review-criterion">
              <legend>
                {c.description} {c.required ? <Badge>required</Badge> : <Badge tone="gold">optional</Badge>}
              </legend>
              <label className="check-label">
                <input type="checkbox" checked={f.met} onChange={(e) => update(c.id, { met: e.target.checked })} />
                The answer shows this
              </label>
              {f.met && (
                <>
                  <Field label="Exact quotation from the answer" htmlFor={`${id}-${c.id}-quote`} hint={quoted ? undefined : "Not found exactly in the answer."}>
                    <textarea id={`${id}-${c.id}-quote`} rows={2} maxLength={800} value={f.quote} onChange={(e) => update(c.id, { quote: e.target.value })} />
                  </Field>
                  <Button type="button" kind="quiet" onClick={() => quoteSelection(c.id)}>
                    <Quote size={14} aria-hidden="true" /> Use text selected in the answer
                  </Button>
                </>
              )}
              <Field label="Note (optional)" htmlFor={`${id}-${c.id}-note`}>
                <input id={`${id}-${c.id}-note`} maxLength={500} value={f.note} onChange={(e) => update(c.id, { note: e.target.value })} />
              </Field>
            </fieldset>
          );
        })}
        <fieldset className="segmented">
          <legend>Decision</legend>
          {(["met", "not_met", "needs_clarification"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`${id}-decision`}
                checked={decision === value}
                disabled={(value === "met" && !requiredMet) || (value === "not_met" && requiredMet)}
                onChange={() => setDecision(value)}
              />
              {value === "met" ? "Criteria met" : value === "not_met" ? "Not yet" : "Ask for clarification"}
            </label>
          ))}
        </fieldset>
        <Field label="Message to the learner" htmlFor={`${id}-note`} hint={decision === "needs_clarification" ? "Required: say what to clarify." : "Optional."}>
          <textarea id={`${id}-note`} rows={2} maxLength={2000} value={learnerNote} onChange={(e) => setLearnerNote(e.target.value)} />
        </Field>
        {error !== undefined && <Notice tone="red">{reviewErrorMessage(error)}</Notice>}
        <Button kind="primary" type="submit" disabled={pending || item.ownSubmission || (decision === "met" && !requiredMet)}>
          Save review
        </Button>
      </form>
    </Card>
  );
}
