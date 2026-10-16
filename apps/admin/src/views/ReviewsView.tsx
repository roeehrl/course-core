import { useEffect, useId, useRef, useState } from "react";
import { Quote } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { reviewErrorMessage, type Appeal, type AppealDecision, type PendingReview, type ReviewInput } from "../domain/reviews";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, when } from "../components/ui";
import { GateReviewQueue } from "./GateReviewQueue";
import { EvidenceDisputeQueue } from "./EvidenceDisputeQueue";

type Finding = { met: boolean; quote: string; note: string };

/** Reviewers judge each criterion against the learner's own words. A met
 * criterion requires an exact quotation; the server rejects anything else. */
export function ReviewsView({ data, client }: { data: CourseWorkspace; client: AdminClient }) {
  if (!client.reviews && !client.gateReviews && !client.evidenceDisputes)
    return (
      <Card title="Written answer reviews">
        <EmptyState title="Reviews are not available here">Use a connected administration session.</EmptyState>
      </Card>
    );
  return (
    <>
      {client.reviews && <ReviewQueue port={client.reviews} catalogId={data.course.id} />}
      {client.reviews?.appeals && client.reviews.decideAppeal && <AppealQueue port={client.reviews} catalogId={data.course.id} />}
      {client.gateReviews && <GateReviewQueue port={client.gateReviews} catalogId={data.course.id} />}
      {client.evidenceDisputes && <EvidenceDisputeQueue port={client.evidenceDisputes} catalogId={data.course.id} />}
    </>
  );
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
            {...(port.requestDraft
              ? {
                  onRequestDraft: async (key: string) => {
                    await port.requestDraft!(item.attemptId, key);
                    setMessage(`AI draft requested for ${item.learner}. It appears here once checked.`);
                    queue.reload();
                  },
                }
              : {})}
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

function ReviewCard({ item, onSubmit, onRequestDraft }: { item: PendingReview; onSubmit: (input: ReviewInput, key: string) => Promise<void>; onRequestDraft?: (key: string) => Promise<void> }) {
  const id = useId();
  const key = useRef("admin-" + crypto.randomUUID());
  const draftKey = useRef("assist-" + crypto.randomUUID());
  const [usedDraft, setUsedDraft] = useState(false);
  const draft = item.assist?.draft ?? null;
  const [findings, setFindings] = useState<Record<string, Finding>>(
    Object.fromEntries(item.rubric.map((c) => [c.id, { met: false, quote: "", note: "" }])),
  );
  const [decision, setDecision] = useState<ReviewInput["decision"]>("not_met");
  const [learnerNote, setLearnerNote] = useState("");
  const [probeOnly, setProbeOnly] = useState(false);
  // In a conversation, quotations may come from any of the learner's turns.
  const learnerWords = [...(item.thread ?? []).map((t) => t.response), item.response];
  const inAnswer = (quote: string) => learnerWords.some((w) => w.includes(quote));
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
    if (selected && inAnswer(selected)) update(criterion, { quote: selected, met: true });
  }
  return (
    <Card
      eyebrow={`${item.learner} · ${item.episodeId} · ${when(item.submittedAt)}`}
      title={item.prompt}
      actions={<Badge tone={item.independentEligible ? "green" : "gold"}>{item.independentEligible ? "independent" : "practice"}</Badge>}
    >
      {item.ownSubmission && <Notice tone="gold">This is your own answer. Another reviewer must review it.</Notice>}
      {(item.thread ?? []).map((turn, i) => (
        <div key={turn.attemptId} className="review-turn">
          <div className="review-response" tabIndex={0} role="region" aria-label={`Earlier answer ${i + 1} from ${item.learner}`}>
            {turn.response}
          </div>
          {turn.reviewerNote && (
            <p className="muted">
              Reviewer asked{turn.probeOnly ? " (neutral question)" : " (with a hint)"}: {turn.reviewerNote}
            </p>
          )}
        </div>
      ))}
      <div className="review-response" tabIndex={0} role="region" aria-label={`${item.thread?.length ? "Latest reply" : "Answer"} from ${item.learner}`}>
        {item.response}
      </div>
      {item.assist && !item.ownSubmission && (
        <AssistPanel
          state={item.assist.state}
          origin={item.assist.origin ?? null}
          automaticCheck={item.assist.automaticCheck ?? null}
          draft={draft}
          rubric={item.rubric}
          used={usedDraft}
          {...(onRequestDraft ? { onRequest: async () => {
            await onRequestDraft(draftKey.current);
            // A later request (after this one fails) is a new request, not a retry.
            draftKey.current = "assist-" + crypto.randomUUID();
          } } : {})}
          onUse={() => {
            if (!draft) return;
            setFindings(Object.fromEntries(item.rubric.map((c) => {
              const d = draft.criteria.find((x) => x.criterionId === c.id);
              return [c.id, { met: Boolean(d?.met), quote: d?.met ? d.quote : "", note: d?.note ?? "" }];
            })));
            setUsedDraft(true);
          }}
        />
      )}
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
              ...(draft ? { suggestionId: draft.suggestionId } : {}),
              ...(decision === "needs_clarification" && probeOnly ? { probeOnly: true } : {}),
            },
            key.current,
          )
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        {item.rubric.map((c) => {
          const f = findings[c.id]!;
          const quoted = !f.met || (f.quote.trim().length >= 10 && inAnswer(f.quote.trim()));
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
        {decision === "needs_clarification" && (
          <label className="check-label">
            <input type="checkbox" checked={probeOnly} onChange={(e) => setProbeOnly(e.target.checked)} />
            My message is a neutral question with no hint (the learner's reply can still count as independent)
          </label>
        )}
        {error !== undefined && <Notice tone="red">{reviewErrorMessage(error)}</Notice>}
        <Button kind="primary" type="submit" disabled={pending || item.ownSubmission || (decision === "met" && !requiredMet)}>
          Save review
        </Button>
      </form>
    </Card>
  );
}

/** An AI draft is a starting point for the reviewer, never a grade. Its quotes
 * were checked to appear in the answer; whether they show the criterion is the
 * reviewer's judgement. */
function AssistPanel({ state, origin, automaticCheck, draft, rubric, used, onRequest, onUse }: {
  state: NonNullable<PendingReview["assist"]>["state"];
  origin: "staff" | "supervisor" | null;
  automaticCheck: { state: string } | null;
  draft: NonNullable<PendingReview["assist"]>["draft"];
  rubric: PendingReview["rubric"];
  used: boolean;
  onRequest?: () => Promise<void>;
  onUse: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  if (state === "not_consented")
    return <Notice tone="blue">The learner has not allowed AI drafts for their written answers.</Notice>;
  if (state === "available" || state === "failed")
    return (
      <div className="stack">
        {state === "failed" && <Notice tone="gold">The AI draft could not be produced. Review the answer directly{onRequest ? " or ask again" : ""}.</Notice>}
        {onRequest && <Button
          type="button"
          kind="quiet"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            onRequest().catch(setError).finally(() => setBusy(false));
          }}
        >
          {state === "failed" ? "Ask again for an AI draft" : "Ask for an AI draft of the findings"}
        </Button>}
        {error !== undefined && <Notice tone="red">{reviewErrorMessage(error)}</Notice>}
      </div>
    );
  if (state === "requested")
    return <Notice tone="blue">{origin === "supervisor" ? "The supervisor is drafting findings for this conversation." : "An AI draft was requested."} Refresh to see it once it has been checked.</Notice>;
  if (!draft) return <Notice tone="gold">No usable AI draft for this answer. Review it directly.</Notice>;
  return (
    <section className="review-draft" aria-label="AI draft of the findings">
      <Notice tone="gold" title="AI draft — not a grade">
        {origin === "supervisor" ? "The supervisor proposed these findings when the learner submitted. " : ""}
        A model drafted them from the question, the rubric and the learner&apos;s turns in this conversation only. Its quotations
        appear in the learner&apos;s own words; whether they show each criterion is your judgement. Your saved review is what counts.
      </Notice>
      {automaticCheck && automaticCheck.state !== "confirmed" && (
        <Notice tone="blue" title="Automatic check did not confirm">
          This checkpoint&apos;s fixed check did not confirm the draft ({automaticCheckReason(automaticCheck.state)}), so the answer waits for your review.
        </Notice>
      )}
      <p>{draft.summary}</p>
      <ul>
        {rubric.map((c) => {
          const d = draft.criteria.find((x) => x.criterionId === c.id);
          return (
            <li key={c.id}>
              <strong>{d?.met ? "Shown" : "Not shown"}</strong> · {c.description}
              {d?.met && d.quote && <blockquote>{d.quote}</blockquote>}
              {d?.note && <span className="muted"> {d.note}</span>}
            </li>
          );
        })}
      </ul>
      <Button type="button" kind="quiet" onClick={onUse} disabled={used}>
        {used ? "Draft copied — check every finding before saving" : "Copy the draft into my findings"}
      </Button>
    </section>
  );
}

const automaticCheckReasons: Record<string, string> = {
  evaluator_declined: "it did not accept every quoted finding",
  proposal_not_met: "the draft does not meet every required criterion",
  quotes_not_learner_words: "a quotation is not the learner's own words",
  evaluator_failed: "the check failed to run",
  evaluator_unavailable: "the check is not installed on this server",
  grading_closed: "the course policy does not allow grading now",
  not_ready: "the answer or rubric changed",
};
const automaticCheckReason = (state: string) => automaticCheckReasons[state] ?? "no confirmation";

/** Second opinions: a different reviewer re-reviews a judged answer under the
 * same quoting rules. Only a changed decision replaces the original evidence. */
function AppealQueue({ port, catalogId }: { port: NonNullable<AdminClient["reviews"]>; catalogId: string }) {
  const queue = useRemote((signal) => port.appeals!(catalogId, signal), [port, catalogId]);
  const [message, setMessage] = useState("");
  if (queue.loading || queue.error || !queue.data || !queue.data.appeals.length) return null;
  return (
    <div className="page-stack">
      <div aria-live="polite">{message && <Notice tone="green">{message}</Notice>}</div>
      {queue.data.appeals.map((appeal) => (
        <AppealCard
          key={appeal.appealId}
          appeal={appeal}
          onDecide={async (input, key) => {
            await port.decideAppeal!(appeal.appealId, input, key);
            setMessage(`Second opinion saved for ${appeal.learner}.`);
            queue.reload();
          }}
        />
      ))}
    </div>
  );
}

function AppealCard({ appeal, onDecide }: { appeal: Appeal; onDecide: (input: AppealDecision, key: string) => Promise<void> }) {
  const id = useId();
  const key = useRef("appeal-" + crypto.randomUUID());
  const [findings, setFindings] = useState<Record<string, Finding>>(Object.fromEntries(appeal.rubric.map((c) => [c.id, { met: false, quote: "", note: "" }])));
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const words = [...appeal.thread.map((t) => t.response), appeal.response];
  const requiredMet = appeal.rubric.filter((c) => c.required).every((c) => findings[c.id]!.met);
  const update = (criterion: string, patch: Partial<Finding>) => setFindings({ ...findings, [criterion]: { ...findings[criterion]!, ...patch } });
  return (
    <Card eyebrow={`Second opinion · ${appeal.learner} · ${when(appeal.createdAt)}`} title={appeal.prompt}
      actions={<Badge tone="gold">{appeal.original.decision === "met" ? "originally met" : "originally not yet"}</Badge>}>
      <Notice tone="blue" title="The learner asks for another look">{appeal.reason}</Notice>
      {!appeal.canDecide && <Notice tone="gold">You reviewed this answer (or wrote it). A different reviewer must give the second opinion.</Notice>}
      {words.map((text, i) => (
        <div key={i} className="review-response" tabIndex={0} role="region" aria-label={`Answer ${i + 1} from ${appeal.learner}`}>{text}</div>
      ))}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          onDecide(
            {
              decision: requiredMet ? "met" : "not_met",
              criteria: appeal.rubric.map((c) => {
                const f = findings[c.id]!;
                return { criterionId: c.id, met: f.met, ...(f.met && f.quote.trim() ? { quote: f.quote.trim() } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) };
              }),
              note: note.trim(),
            },
            key.current,
          )
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        {appeal.rubric.map((c) => {
          const f = findings[c.id]!;
          return (
            <fieldset key={c.id} className="review-criterion">
              <legend>{c.description} {c.required ? <Badge>required</Badge> : <Badge tone="gold">optional</Badge>}</legend>
              <label className="check-label">
                <input type="checkbox" checked={f.met} disabled={!appeal.canDecide} onChange={(e) => update(c.id, { met: e.target.checked })} />
                The answer shows this
              </label>
              {f.met && (
                <Field label="Exact quotation from the answer" htmlFor={`${id}-${c.id}-quote`} hint={f.quote.trim().length >= 10 && words.some((w) => w.includes(f.quote.trim())) ? undefined : "Not found exactly in the answer."}>
                  <textarea id={`${id}-${c.id}-quote`} rows={2} maxLength={800} value={f.quote} onChange={(e) => update(c.id, { quote: e.target.value })} />
                </Field>
              )}
            </fieldset>
          );
        })}
        <p>Your decision: <strong>{requiredMet ? "Criteria met" : "Not yet"}</strong>{(requiredMet ? "met" : "not_met") === appeal.original.decision ? " (keeps the original)" : " (changes the original)"}</p>
        <Field label="Message to the learner" htmlFor={`${id}-appeal-note`} hint="Required: explain the second opinion.">
          <textarea id={`${id}-appeal-note`} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error !== undefined && <Notice tone="red">{reviewErrorMessage(error)}</Notice>}
        <Button kind="primary" type="submit" disabled={pending || !appeal.canDecide || !note.trim()}>Save second opinion</Button>
      </form>
    </Card>
  );
}
