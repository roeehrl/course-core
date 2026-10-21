import { useEffect, useId, useRef, useState } from "react";
import { Quote } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  reviewErrorMessage,
  type Appeal,
  type AppealDecision,
  type PendingReview,
  type ReviewInput,
} from "../domain/reviews";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
} from "../components/ui";
import { useFormatters, useI18n, useT } from "../i18n";
import { GateReviewQueue } from "./GateReviewQueue";
import { EvidenceDisputeQueue } from "./EvidenceDisputeQueue";
import { randomId } from "../domain/webCrypto";
import {
  emptyFindings,
  findingsPayload,
  requiredMet,
  RubricFindings,
  type Finding,
} from "../components/RubricFindings";

/** Reviewers judge each criterion against the learner's own words. A met
 * criterion requires an exact quotation; the server rejects anything else. */
export function ReviewsView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  if (!client.reviews && !client.gateReviews && !client.evidenceDisputes)
    return (
      <Card title={t("reviewsView.queue.title")}>
        <EmptyState title={t("reviewsView.unavailable.title")}>
          {t("reviewsView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  return (
    <>
      {client.reviews && (
        <ReviewQueue port={client.reviews} catalogId={data.course.id} />
      )}
      {client.reviews?.appeals && client.reviews.decideAppeal && (
        <AppealQueue port={client.reviews} catalogId={data.course.id} />
      )}
      {client.gateReviews && (
        <GateReviewQueue port={client.gateReviews} catalogId={data.course.id} />
      )}
      {client.evidenceDisputes && (
        <EvidenceDisputeQueue
          port={client.evidenceDisputes}
          catalogId={data.course.id}
        />
      )}
    </>
  );
}

function ReviewQueue({
  port,
  catalogId,
}: {
  port: NonNullable<AdminClient["reviews"]>;
  catalogId: string;
}) {
  const t = useT();
  const queue = useRemote(
    (signal) => port.pending(catalogId, signal),
    [port, catalogId],
  );
  const [message, setMessage] = useState("");
  if (queue.loading) return <Loading label={t("reviewsView.queue.loading")} />;
  if (queue.error || !queue.data)
    return <Notice tone="red">{reviewErrorMessage(queue.error, t)}</Notice>;
  return (
    <div className="page-stack">
      <Notice tone="blue" title={t("reviewsView.queue.intro.title")}>
        {t("reviewsView.queue.intro.body")}
      </Notice>
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
      </div>
      {queue.data.pending.length === 0 ? (
        <Card title={t("reviewsView.queue.title")}>
          <EmptyState title={t("reviewsView.queue.empty.title")}>
            {t("reviewsView.queue.empty.body")}
          </EmptyState>
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
                    setMessage(
                      t("reviewsView.queue.draftRequested", {
                        learner: item.learner,
                      }),
                    );
                    queue.reload();
                  },
                }
              : {})}
            onSubmit={async (input, key) => {
              await port.review(item.attemptId, input, key);
              setMessage(
                t("reviewsView.queue.saved", { learner: item.learner }),
              );
              queue.reload();
            }}
          />
        ))
      )}
    </div>
  );
}

function ReviewCard({
  item,
  onSubmit,
  onRequestDraft,
}: {
  item: PendingReview;
  onSubmit: (input: ReviewInput, key: string) => Promise<void>;
  onRequestDraft?: (key: string) => Promise<void>;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const id = useId();
  const key = useRef("admin-" + randomId());
  const draftKey = useRef("assist-" + randomId());
  const [usedDraft, setUsedDraft] = useState(false);
  const draft = item.assist?.draft ?? null;
  const [findings, setFindings] = useState<Record<string, Finding>>(
    Object.fromEntries(
      item.rubric.map((c) => [c.id, { met: false, quote: "", note: "" }]),
    ),
  );
  const [decision, setDecision] = useState<ReviewInput["decision"]>("not_met");
  const [learnerNote, setLearnerNote] = useState("");
  const [probeOnly, setProbeOnly] = useState(false);
  // In a conversation, quotations may come from any of the learner's turns.
  const learnerWords = [
    ...(item.thread ?? []).map((turn) => turn.response),
    item.response,
  ];
  const inAnswer = (quote: string) =>
    learnerWords.some((w) => w.includes(quote));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const requiredMet = item.rubric
    .filter((c) => c.required)
    .every((c) => findings[c.id]!.met);
  // Keep the decision consistent with the findings; clarification stays a choice.
  useEffect(() => {
    setDecision((current) =>
      current === "needs_clarification"
        ? current
        : requiredMet
          ? "met"
          : "not_met",
    );
  }, [requiredMet]);
  const update = (criterion: string, patch: Partial<Finding>) =>
    setFindings({
      ...findings,
      [criterion]: { ...findings[criterion]!, ...patch },
    });
  function quoteSelection(criterion: string) {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (selected && inAnswer(selected))
      update(criterion, { quote: selected, met: true });
  }
  return (
    <Card
      eyebrow={t("reviewsView.card.eyebrow", {
        learner: item.learner,
        episode: item.episodeId,
        submitted: when(item.submittedAt),
      })}
      title={<bdi>{item.prompt}</bdi>}
      actions={
        <Badge tone={item.independentEligible ? "green" : "gold"}>
          {item.independentEligible
            ? t("reviewsView.card.independent")
            : t("reviewsView.card.practice")}
        </Badge>
      }
    >
      {item.ownSubmission && (
        <Notice tone="gold">{t("reviewsView.card.ownSubmission")}</Notice>
      )}
      {(item.thread ?? []).map((turn, i) => (
        <div key={turn.attemptId} className="review-turn">
          <div
            className="review-response"
            dir="auto"
            tabIndex={0}
            role="region"
            aria-label={t("reviewsView.card.earlierAnswer", {
              n: i + 1,
              learner: item.learner,
            })}
          >
            {turn.response}
          </div>
          {turn.reviewerNote && (
            <p className="muted">
              {i18n.rich(
                "reviewsView.card.reviewerAsked",
                {
                  probe: turn.probeOnly ? "yes" : "no",
                  note: turn.reviewerNote,
                },
                {
                  note: (children, key) => <bdi key={key}>{children}</bdi>,
                },
              )}
            </p>
          )}
        </div>
      ))}
      <div
        className="review-response"
        dir="auto"
        tabIndex={0}
        role="region"
        aria-label={t("reviewsView.card.answerLabel", {
          latest: item.thread?.length ? "yes" : "no",
          learner: item.learner,
        })}
      >
        {item.response}
      </div>
      {item.assist && !item.ownSubmission && (
        <AssistPanel
          state={item.assist.state}
          rejectionReason={item.assist.rejectionReason ?? null}
          origin={item.assist.origin ?? null}
          automaticCheck={item.assist.automaticCheck ?? null}
          draft={draft}
          rubric={item.rubric}
          used={usedDraft}
          {...(onRequestDraft
            ? {
                onRequest: async () => {
                  await onRequestDraft(draftKey.current);
                  // A later request (after this one fails) is a new request, not a retry.
                  draftKey.current = "assist-" + randomId();
                },
              }
            : {})}
          onUse={() => {
            if (!draft) return;
            setFindings(
              Object.fromEntries(
                item.rubric.map((c) => {
                  const d = draft.criteria.find((x) => x.criterionId === c.id);
                  return [
                    c.id,
                    {
                      met: Boolean(d?.met),
                      quote: d?.met ? d.quote : "",
                      note: d?.note ?? "",
                    },
                  ];
                }),
              ),
            );
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
                return {
                  criterionId: c.id,
                  met: f.met,
                  ...(f.met && f.quote.trim() ? { quote: f.quote.trim() } : {}),
                  ...(f.note.trim() ? { note: f.note.trim() } : {}),
                };
              }),
              ...(learnerNote.trim()
                ? { learnerNote: learnerNote.trim() }
                : {}),
              ...(draft ? { suggestionId: draft.suggestionId } : {}),
              ...(decision === "needs_clarification" && probeOnly
                ? { probeOnly: true }
                : {}),
            },
            key.current,
          )
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        {item.rubric.map((c) => {
          const f = findings[c.id]!;
          const quoted =
            !f.met || (f.quote.trim().length >= 10 && inAnswer(f.quote.trim()));
          return (
            <fieldset key={c.id} className="review-criterion">
              <legend>
                <bdi>{c.description}</bdi>{" "}
                {c.required ? (
                  <Badge>{t("reviewsView.criterion.required")}</Badge>
                ) : (
                  <Badge tone="gold">
                    {t("reviewsView.criterion.optional")}
                  </Badge>
                )}
              </legend>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={f.met}
                  onChange={(e) => update(c.id, { met: e.target.checked })}
                />
                {t("reviewsView.criterion.shows")}
              </label>
              {f.met && (
                <>
                  <Field
                    label={t("reviewsView.criterion.quote")}
                    htmlFor={`${id}-${c.id}-quote`}
                    hint={
                      quoted
                        ? undefined
                        : t("reviewsView.criterion.quoteNotFound")
                    }
                  >
                    <textarea
                      id={`${id}-${c.id}-quote`}
                      dir="auto"
                      rows={2}
                      maxLength={800}
                      value={f.quote}
                      onChange={(e) => update(c.id, { quote: e.target.value })}
                    />
                  </Field>
                  <Button
                    type="button"
                    kind="quiet"
                    onClick={() => quoteSelection(c.id)}
                  >
                    <Quote size={14} aria-hidden="true" />{" "}
                    {t("reviewsView.criterion.useSelection")}
                  </Button>
                </>
              )}
              <Field
                label={t("reviewsView.criterion.note")}
                htmlFor={`${id}-${c.id}-note`}
              >
                <input
                  id={`${id}-${c.id}-note`}
                  dir="auto"
                  maxLength={500}
                  value={f.note}
                  onChange={(e) => update(c.id, { note: e.target.value })}
                />
              </Field>
            </fieldset>
          );
        })}
        <fieldset className="segmented">
          <legend>{t("reviewsView.decision.legend")}</legend>
          {(["met", "not_met", "needs_clarification"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`${id}-decision`}
                checked={decision === value}
                disabled={
                  (value === "met" && !requiredMet) ||
                  (value === "not_met" && requiredMet)
                }
                onChange={() => setDecision(value)}
              />
              {t(`reviewsView.decision.${value}`)}
            </label>
          ))}
        </fieldset>
        <Field
          label={t("reviewsView.note.label")}
          htmlFor={`${id}-note`}
          hint={
            decision === "needs_clarification"
              ? t("reviewsView.note.hintClarify")
              : t("reviewsView.note.hintOptional")
          }
        >
          <textarea
            id={`${id}-note`}
            dir="auto"
            rows={2}
            maxLength={2000}
            value={learnerNote}
            onChange={(e) => setLearnerNote(e.target.value)}
          />
        </Field>
        {decision === "needs_clarification" && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={probeOnly}
              onChange={(e) => setProbeOnly(e.target.checked)}
            />
            {t("reviewsView.note.probeOnly")}
          </label>
        )}
        {error !== undefined && (
          <Notice tone="red">{reviewErrorMessage(error, t)}</Notice>
        )}
        <Button
          kind="primary"
          type="submit"
          disabled={
            pending ||
            item.ownSubmission ||
            (decision === "met" && !requiredMet)
          }
        >
          {t("reviewsView.save")}
        </Button>
      </form>
    </Card>
  );
}

/** An AI draft is a starting point for the reviewer, never a grade. Its quotes
 * were checked to appear in the answer; whether they show the criterion is the
 * reviewer's judgement. */
function AssistPanel({
  state,
  rejectionReason,
  origin,
  automaticCheck,
  draft,
  rubric,
  used,
  onRequest,
  onUse,
}: {
  state: NonNullable<PendingReview["assist"]>["state"];
  rejectionReason: string | null;
  origin: "staff" | "supervisor" | null;
  automaticCheck: { state: string } | null;
  draft: NonNullable<PendingReview["assist"]>["draft"];
  rubric: PendingReview["rubric"];
  used: boolean;
  onRequest?: () => Promise<void>;
  onUse: () => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const again = onRequest ? "yes" : "no";
  if (state === "not_consented")
    return <Notice tone="blue">{t("reviewsView.assist.notConsented")}</Notice>;
  if (state === "available" || state === "failed" || state === "rejected")
    return (
      <div className="stack">
        {state === "failed" && (
          <Notice tone="gold">
            {t("reviewsView.assist.failed", { again })}
          </Notice>
        )}
        {state === "rejected" && (
          <Notice tone="gold" title={t("reviewsView.assist.rejected.title")}>
            {t("reviewsView.assist.rejected.body", {
              reason: rejectionReason ?? "unknown",
              again,
            })}
          </Notice>
        )}
        {onRequest && (
          <Button
            type="button"
            kind="quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              onRequest()
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {state === "available"
              ? t("reviewsView.assist.request")
              : t("reviewsView.assist.requestAgain")}
          </Button>
        )}
        {error !== undefined && (
          <Notice tone="red">{reviewErrorMessage(error, t)}</Notice>
        )}
      </div>
    );
  if (state === "requested")
    return (
      <Notice tone="blue">
        {t("reviewsView.assist.requested", { origin: origin ?? "staff" })}
      </Notice>
    );
  if (!draft)
    return <Notice tone="gold">{t("reviewsView.assist.noDraft")}</Notice>;
  return (
    <section
      className="review-draft"
      aria-label={t("reviewsView.assist.region")}
    >
      <Notice tone="gold" title={t("reviewsView.assist.draft.title")}>
        {t("reviewsView.assist.draft.body", { origin: origin ?? "staff" })}
      </Notice>
      {automaticCheck && automaticCheck.state !== "confirmed" && (
        <Notice tone="blue" title={t("reviewsView.assist.check.title")}>
          {t("reviewsView.assist.check.body", {
            reason: automaticCheck.state,
          })}
        </Notice>
      )}
      <p dir="auto">{draft.summary}</p>
      <ul>
        {rubric.map((c) => {
          const d = draft.criteria.find((x) => x.criterionId === c.id);
          return (
            <li key={c.id}>
              <strong>
                {d?.met
                  ? t("reviewsView.assist.shown")
                  : t("reviewsView.assist.notShown")}
              </strong>{" "}
              · <bdi>{c.description}</bdi>
              {d?.met && d.quote && (
                <blockquote dir="auto">{d.quote}</blockquote>
              )}
              {d?.note && (
                <span className="muted">
                  {" "}
                  <bdi>{d.note}</bdi>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <Button type="button" kind="quiet" onClick={onUse} disabled={used}>
        {used ? t("reviewsView.assist.copied") : t("reviewsView.assist.copy")}
      </Button>
    </section>
  );
}

/** Second opinions: a different reviewer re-reviews a judged answer under the
 * same quoting rules. Only a changed decision replaces the original evidence. */
function AppealQueue({
  port,
  catalogId,
}: {
  port: NonNullable<AdminClient["reviews"]>;
  catalogId: string;
}) {
  const t = useT();
  const queue = useRemote(
    (signal) => port.appeals!(catalogId, signal),
    [port, catalogId],
  );
  const [message, setMessage] = useState("");
  if (queue.loading || queue.error || !queue.data || !queue.data.appeals.length)
    return null;
  return (
    <div className="page-stack">
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
      </div>
      {queue.data.appeals.map((appeal) => (
        <AppealCard
          key={appeal.appealId}
          appeal={appeal}
          onDecide={async (input, key) => {
            await port.decideAppeal!(appeal.appealId, input, key);
            setMessage(
              t("reviewsView.appeal.saved", { learner: appeal.learner }),
            );
            queue.reload();
          }}
        />
      ))}
    </div>
  );
}

function AppealCard({
  appeal,
  onDecide,
}: {
  appeal: Appeal;
  onDecide: (input: AppealDecision, key: string) => Promise<void>;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const id = useId();
  const key = useRef("appeal-" + randomId());
  const [findings, setFindings] = useState<Record<string, Finding>>(() =>
    emptyFindings(appeal.rubric),
  );
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const words = [
    ...appeal.thread.map((turn) => turn.response),
    appeal.response,
  ];
  const met = requiredMet(appeal.rubric, findings);
  return (
    <Card
      eyebrow={t("reviewsView.appeal.eyebrow", {
        learner: appeal.learner,
        created: when(appeal.createdAt),
      })}
      title={<bdi>{appeal.prompt}</bdi>}
      actions={
        <Badge tone="gold">
          {t(`reviewsView.appeal.original.${appeal.original.decision}`)}
        </Badge>
      }
    >
      <Notice tone="blue" title={t("reviewsView.appeal.reason.title")}>
        <bdi>{appeal.reason}</bdi>
      </Notice>
      {!appeal.canDecide && (
        <Notice tone="gold">{t("reviewsView.appeal.cannotDecide")}</Notice>
      )}
      {words.map((text, i) => (
        <div
          key={i}
          className="review-response"
          dir="auto"
          tabIndex={0}
          role="region"
          aria-label={t("reviewsView.appeal.answerLabel", {
            n: i + 1,
            learner: appeal.learner,
          })}
        >
          {text}
        </div>
      ))}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          onDecide(
            {
              decision: met ? "met" : "not_met",
              criteria: findingsPayload(appeal.rubric, findings),
              note: note.trim(),
            },
            key.current,
          )
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        <RubricFindings
          idPrefix={id}
          rubric={appeal.rubric}
          findings={findings}
          words={words}
          disabled={!appeal.canDecide}
          onChange={setFindings}
        />
        <p>
          {i18n.rich(
            "reviewsView.appeal.decision",
            {
              met: met ? "yes" : "no",
              keeps:
                (met ? "met" : "not_met") === appeal.original.decision
                  ? "yes"
                  : "no",
            },
            {
              strong: (children, key) => <strong key={key}>{children}</strong>,
            },
          )}
        </p>
        <Field
          label={t("reviewsView.note.label")}
          htmlFor={`${id}-appeal-note`}
          hint={t("reviewsView.appeal.noteHint")}
        >
          <textarea
            id={`${id}-appeal-note`}
            dir="auto"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {error !== undefined && (
          <Notice tone="red">{reviewErrorMessage(error, t)}</Notice>
        )}
        <Button
          kind="primary"
          type="submit"
          disabled={pending || !appeal.canDecide || !note.trim()}
        >
          {t("reviewsView.appeal.save")}
        </Button>
      </form>
    </Card>
  );
}
