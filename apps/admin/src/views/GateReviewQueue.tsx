import { useId, useRef, useState } from "react";
import {
  GATE_REVIEW_NOTE_MIN,
  gateReviewErrorMessage,
  type GateReview,
  type GateReviewResolution,
  type GateReviewsPort,
} from "../domain/gateReviews";
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
import { randomId } from "../domain/webCrypto";
import { gateText } from "../components/LearnerViewScreen";
import { useFormatters, useI18n, useT } from "../i18n";

/** Learners' requests to look at a gate decision again. Staff either uphold the decision with a
 * reason the learner reads, or (with enrollment rights) grant an audited exception that lets the
 * learner advance past this checkpoint. Neither changes the decision or counts as evidence. */
export function GateReviewQueue({
  port,
  catalogId,
}: {
  port: GateReviewsPort;
  catalogId: string;
}) {
  const t = useT();
  const queue = useRemote(
    (signal) => port.queue(catalogId, signal),
    [port, catalogId],
  );
  const [message, setMessage] = useState("");
  return (
    <section className="page-stack" aria-labelledby="gate-review-heading">
      <h2 id="gate-review-heading" className="section-title">
        {t("gateReviewQueue.title")}
      </h2>
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
      </div>
      {queue.loading ? (
        <Loading label={t("gateReviewQueue.loading")} />
      ) : queue.error || !queue.data ? (
        <Notice tone="red">{gateReviewErrorMessage(queue.error, t)}</Notice>
      ) : queue.data.reviews.length === 0 ? (
        <Card>
          <EmptyState title={t("gateReviewQueue.empty.title")}>
            {t("gateReviewQueue.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        queue.data.reviews.map((review) => (
          <GateReviewCard
            key={review.requestId}
            review={review}
            onResolve={async (input, key) => {
              const receipt = await port.resolve(review.requestId, input, key);
              setMessage(
                t(
                  receipt.state === "exception_granted"
                    ? "gateReviewQueue.saved.exception"
                    : "gateReviewQueue.saved.upheld",
                  { learner: review.learner, gate: review.gateId },
                ),
              );
              queue.reload();
            }}
          />
        ))
      )}
    </section>
  );
}

function GateReviewCard({
  review,
  onResolve,
}: {
  review: GateReview;
  onResolve: (input: GateReviewResolution, key: string) => Promise<void>;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const id = useId();
  const [outcome, setOutcome] =
    useState<GateReviewResolution["outcome"]>("upheld");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  // One key per distinct decision: a retry of the same decision replays, a changed one is new.
  const key = useRef({ input: "", value: "" });
  const keyFor = (input: GateReviewResolution) => {
    const digest = JSON.stringify(input);
    if (key.current.input !== digest)
      key.current = { input: digest, value: "gate-review-" + randomId() };
    return key.current.value;
  };
  const { decision } = review;
  const noteReady = note.trim().length >= GATE_REVIEW_NOTE_MIN;
  return (
    <Card
      eyebrow={t("gateReviewQueue.card.eyebrow", {
        learner: review.learner,
        gate: review.gateId,
        requested: when(review.requestedAt),
      })}
      title={t("gateReviewQueue.card.title", { gate: review.gateId })}
      actions={
        <Badge tone="gold">
          {t(`gateReviewQueue.status.${decision.status}`)}
        </Badge>
      }
    >
      <Notice tone="blue" title={t("gateReviewQueue.card.reasonTitle")}>
        <bdi>{review.reason}</bdi>
      </Notice>
      {!review.canUphold && (
        <Notice tone="gold">{t("gateReviewQueue.card.ownRequest")}</Notice>
      )}
      <section
        className="gate-decision"
        aria-label={t("gateReviewQueue.decision.label", {
          learner: review.learner,
        })}
      >
        <p>
          {i18n.rich(
            "gateReviewQueue.decision.summary",
            {
              version: decision.gateVersion,
              decided: when(decision.decidedAt),
            },
            {
              strong: (children, key) => <strong key={key}>{children}</strong>,
            },
          )}
        </p>
        {/* Server English (a decision made before codes) keeps its own direction. */}
        <p className="muted" dir={decision.messages ? undefined : "auto"}>
          {gateText(
            decision.messages?.reason,
            decision.learnerVisibleReason,
            i18n,
          )}
        </p>
        <ul className="gate-criteria">
          {decision.criterionResults.map((c) => (
            <li key={c.criterionId}>
              <Badge
                tone={
                  c.met === true
                    ? "green"
                    : c.met === "pending"
                      ? "gold"
                      : "red"
                }
              >
                {c.met === true
                  ? t("gateReviewQueue.criterion.met")
                  : c.met === "pending"
                    ? t("gateReviewQueue.criterion.pending")
                    : t("gateReviewQueue.criterion.notMet")}
              </Badge>{" "}
              {c.reason ? (
                <span
                  dir={
                    decision.messages?.criteria[c.criterionId]
                      ? undefined
                      : "auto"
                  }
                >
                  {gateText(
                    decision.messages?.criteria[c.criterionId],
                    c.reason,
                    i18n,
                  )}
                </span>
              ) : (
                <span dir="ltr">{c.criterionId}</span>
              )}
            </li>
          ))}
        </ul>
        {decision.missingObjectiveIds.length > 0 && (
          <p className="muted">
            {i18n.rich(
              "gateReviewQueue.decision.missing",
              { ids: i18n.list(decision.missingObjectiveIds, "unit") },
              {
                ids: (children, key) => (
                  <span key={key} dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </p>
        )}
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
          <legend>{t("gateReviewQueue.outcome.legend")}</legend>
          <label className="check-label">
            <input
              type="radio"
              name={`${id}-outcome`}
              checked={outcome === "upheld"}
              disabled={!review.canUphold}
              onChange={() => setOutcome("upheld")}
            />
            {t("gateReviewQueue.outcome.uphold")}
          </label>
          {review.canGrantException ? (
            <label className="check-label">
              <input
                type="radio"
                name={`${id}-outcome`}
                checked={outcome === "exception"}
                onChange={() => setOutcome("exception")}
              />
              {t("gateReviewQueue.outcome.exception")}
            </label>
          ) : (
            review.canUphold && (
              <p className="muted">
                {t("gateReviewQueue.outcome.exceptionRoles")}
              </p>
            )
          )}
        </fieldset>
        {outcome === "exception" && (
          <Notice tone="gold" title={t("gateReviewQueue.exception.title")}>
            {t("gateReviewQueue.exception.body")}
          </Notice>
        )}
        <Field
          label={t("gateReviewQueue.note.label")}
          htmlFor={`${id}-note`}
          hint={t("gateReviewQueue.note.hint", { min: GATE_REVIEW_NOTE_MIN })}
        >
          <textarea
            id={`${id}-note`}
            dir="auto"
            rows={3}
            maxLength={2000}
            value={note}
            disabled={!review.canUphold}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {error !== undefined && (
          <Notice tone="red">{gateReviewErrorMessage(error, t)}</Notice>
        )}
        <Button
          kind="primary"
          type="submit"
          disabled={pending || !review.canUphold || !noteReady}
        >
          {outcome === "exception"
            ? t("gateReviewQueue.submit.exception")
            : t("gateReviewQueue.submit.uphold")}
        </Button>
      </form>
    </Card>
  );
}
