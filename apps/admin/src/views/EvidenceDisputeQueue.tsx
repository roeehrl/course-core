import { useId, useRef, useState } from "react";
import {
  EVIDENCE_DISPUTE_NOTE_MAX,
  evidenceDisputeErrorMessage,
  type EvidenceDispute,
  type EvidenceDisputeResolution,
  type EvidenceDisputesPort,
} from "../domain/evidenceDisputes";
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
import { useFormatters, useI18n, useT } from "../i18n";

/** Learners' open disputes of their own evidence. Staff resolve one by reviewing the evidence:
 * uphold a valid result (it does not change) or invalidate it. The learner's explanation is
 * never shown here; it stays with the learner. */
export function EvidenceDisputeQueue({
  port,
  catalogId,
}: {
  port: EvidenceDisputesPort;
  catalogId: string;
}) {
  const t = useT();
  const queue = useRemote(
    (signal) => port.queue(catalogId, signal),
    [port, catalogId],
  );
  const [message, setMessage] = useState("");
  return (
    <section className="page-stack" aria-labelledby="evidence-dispute-heading">
      <h2 id="evidence-dispute-heading" className="section-title">
        {t("evidenceDisputeQueue.title")}
      </h2>
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
      </div>
      {queue.loading ? (
        <Loading label={t("evidenceDisputeQueue.loading")} />
      ) : queue.error || !queue.data ? (
        <Notice tone="red">
          {evidenceDisputeErrorMessage(queue.error, t)}
        </Notice>
      ) : queue.data.disputes.length === 0 ? (
        <Card>
          <EmptyState title={t("evidenceDisputeQueue.empty.title")}>
            {t("evidenceDisputeQueue.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Notice tone="blue" title={t("evidenceDisputeQueue.privacy.title")}>
            {t("evidenceDisputeQueue.privacy.body")}
          </Notice>
          {queue.data.truncated && (
            <Notice tone="gold">
              {t("evidenceDisputeQueue.truncated", { count: 200 })}
            </Notice>
          )}
          {queue.data.disputes.map((dispute) => (
            <DisputeCard
              key={dispute.disputeId}
              dispute={dispute}
              onResolve={async (input, key) => {
                const receipt = await port.resolve(
                  catalogId,
                  dispute.disputeId,
                  input,
                  key,
                );
                setMessage(
                  t(
                    receipt.invalidated
                      ? "evidenceDisputeQueue.saved.invalidated"
                      : "evidenceDisputeQueue.saved.upheld",
                    {
                      learner: dispute.learner,
                      objective: dispute.objectiveId,
                    },
                  ),
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

function DisputeCard({
  dispute,
  onResolve,
}: {
  dispute: EvidenceDispute;
  onResolve: (input: EvidenceDisputeResolution, key: string) => Promise<void>;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const id = useId();
  const [decision, setDecision] = useState<
    EvidenceDisputeResolution["decision"]
  >(dispute.canUphold ? "accept" : "reject");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  // One key per distinct decision: a retry of the same decision replays, a changed one is new.
  const key = useRef({ input: "", value: "" });
  const keyFor = (input: EvidenceDisputeResolution) => {
    const digest = JSON.stringify(input);
    if (key.current.input !== digest)
      key.current = { input: digest, value: "evidence-dispute-" + randomId() };
    return key.current.value;
  };
  const { evidence } = dispute;
  return (
    <Card
      eyebrow={t("evidenceDisputeQueue.card.eyebrow", {
        learner: dispute.learner,
        objective: dispute.objectiveId,
        days: dispute.ageDays,
      })}
      title={t("evidenceDisputeQueue.card.title", {
        objective: dispute.objectiveId,
      })}
      actions={
        <Badge tone="gold">{t("evidenceDisputeQueue.card.disputed")}</Badge>
      }
    >
      {!dispute.canResolve && (
        <Notice tone="gold">{t("evidenceDisputeQueue.card.ownDispute")}</Notice>
      )}
      <section
        className="gate-decision"
        aria-label={t("evidenceDisputeQueue.facts.label", {
          learner: dispute.learner,
        })}
      >
        <dl className="dispute-facts">
          <div>
            <dt>{t("evidenceDisputeQueue.facts.item")}</dt>
            <dd dir="ltr">{evidence.assessmentId}</dd>
          </div>
          <div>
            <dt>{t("evidenceDisputeQueue.facts.result")}</dt>
            <dd>
              {i18n.rich(
                "evidenceDisputeQueue.facts.resultValue",
                {
                  passed: evidence.passed ? "yes" : "no",
                  independent: evidence.independent ? "yes" : "no",
                  mode: evidence.mode,
                },
                {
                  mode: (children, key) => (
                    <span key={key} dir="ltr">
                      {children}
                    </span>
                  ),
                },
              )}
            </dd>
          </div>
          <div>
            <dt>{t("evidenceDisputeQueue.facts.version")}</dt>
            <dd dir="ltr">{evidence.releaseVersion}</dd>
          </div>
          <div>
            <dt>{t("evidenceDisputeQueue.facts.disputed")}</dt>
            <dd>{when(dispute.raisedAt)}</dd>
          </div>
          <div>
            <dt>{t("evidenceDisputeQueue.facts.evidence")}</dt>
            <dd className="mono" dir="ltr">
              {evidence.evidenceId}
            </dd>
          </div>
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
          <legend>{t("evidenceDisputeQueue.decision.legend")}</legend>
          <label className="check-label">
            <input
              type="radio"
              name={`${id}-decision`}
              checked={decision === "accept"}
              disabled={!dispute.canUphold}
              onChange={() => setDecision("accept")}
            />
            {t("evidenceDisputeQueue.decision.uphold")}
          </label>
          {dispute.canResolve && !dispute.canUphold && (
            <p className="muted">
              {t("evidenceDisputeQueue.decision.upholdRule")}
            </p>
          )}
          <label className="check-label">
            <input
              type="radio"
              name={`${id}-decision`}
              checked={decision === "reject"}
              disabled={!dispute.canResolve}
              onChange={() => setDecision("reject")}
            />
            {t("evidenceDisputeQueue.decision.invalidate")}
          </label>
        </fieldset>
        <Field
          label={t("evidenceDisputeQueue.note.label")}
          htmlFor={`${id}-note`}
          hint={t("evidenceDisputeQueue.note.hint")}
        >
          <textarea
            id={`${id}-note`}
            dir="auto"
            rows={3}
            maxLength={EVIDENCE_DISPUTE_NOTE_MAX}
            value={note}
            disabled={!dispute.canResolve}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {error !== undefined && (
          <Notice tone="red">{evidenceDisputeErrorMessage(error, t)}</Notice>
        )}
        <Button
          kind="primary"
          type="submit"
          disabled={pending || !dispute.canResolve || !note.trim()}
        >
          {decision === "reject"
            ? t("evidenceDisputeQueue.submit.invalidate")
            : t("evidenceDisputeQueue.submit.uphold")}
        </Button>
      </form>
    </Card>
  );
}
