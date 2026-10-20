import { useRef, useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type { LearningPolicy } from "../domain/policy";
import type {
  LedgerAction,
  LedgerPreview,
  LedgerResult,
} from "../domain/policyLedger";
import { Button, Dialog, ErrorState, Field, Notice, when } from "./ui";
import { randomId } from "../domain/webCrypto";

/** One action at a time, with a stable idempotency key per reviewed preview and reason. */
export function useSingleFlight() {
  const busy = useRef(false),
    keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function run(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function key(fingerprint: unknown) {
    const text = JSON.stringify(fingerprint);
    let value = keys.current.get(text);
    if (!value) {
      value = randomId();
      keys.current.set(text, value);
    }
    return value;
  }
  return { pending, error, setError, run, key };
}

const titles: Record<LedgerAction["kind"], string> = {
  revocation: "Revoke grant",
  refund: "Refund allowance",
  exception: "Exceptional grant",
};

/** Revocation, refund and exceptional grant are separate audited operations: the
 * server computes the exact effect first, then applies that reviewed preview only. */
export function LedgerActionDialog({
  client,
  policy,
  initial,
  onClose,
  onUpdated,
}: {
  client: AdminClient;
  policy: LearningPolicy;
  initial: LedgerAction;
  onClose: () => void;
  onUpdated: (result: LedgerResult) => void;
}) {
  const [action, setAction] = useState(initial);
  const [preview, setPreview] = useState<LedgerPreview>();
  const [reason, setReason] = useState("");
  const flight = useSingleFlight();
  const label = (scopeId: string) =>
    policy.scopes.find((s) => s.scopeId === scopeId)?.label ?? scopeId;
  const change = (next: LedgerAction) => {
    setAction(next);
    setPreview(undefined);
    flight.setError(undefined);
  };
  return (
    <Dialog
      title={titles[action.kind]}
      onClose={onClose}
      pending={flight.pending}
      eyebrow="Audited ledger operation"
    >
      {action.kind === "revocation" && (
        <Notice tone="gold">
          A revocation keeps the grant and its usage in the ledger and does not
          refund allowance. Refunding is a separate operation.
        </Notice>
      )}
      {action.kind === "refund" && (
        <>
          <Notice tone="blue">
            A refund returns allowance units to the pool. It never moves a
            deadline.
          </Notice>
          <Field label="Units to refund" htmlFor="ledger-refund-amount">
            <input
              id="ledger-refund-amount"
              type="number"
              min={1}
              max={366}
              value={action.amount}
              onChange={(e) =>
                change({ ...action, amount: Number(e.target.value) })
              }
            />
          </Field>
        </>
      )}
      {action.kind === "exception" && (
        <>
          <Notice tone="gold">
            For this learner only, outside every allowance pool. It changes{" "}
            {label(action.scopeId)} explicitly; an earlier ancestor deadline
            still binds.
          </Notice>
          <Field label="Extra calendar days" htmlFor="ledger-exception-days">
            <input
              id="ledger-exception-days"
              type="number"
              min={1}
              max={366}
              value={action.days}
              onChange={(e) =>
                change({ ...action, days: Number(e.target.value) })
              }
            />
          </Field>
        </>
      )}
      {Boolean(flight.error) && <ErrorState error={flight.error} />}
      <Button
        disabled={flight.pending}
        onClick={() =>
          void flight.run(async () =>
            setPreview(
              await client.previewLedgerAction!(policy.enrollmentId, action),
            ),
          )
        }
      >
        {flight.pending && !preview ? "Computing…" : "Preview the effect"}
      </Button>
      {preview && (
        <div className="stack">
          <h3>Reviewed effect</h3>
          <small className="mono">
            {preview.previewDigest} · expires {when(preview.expiresAt)}
          </small>
          {preview.previewKind === "revocation" && (
            <ul>
              {preview.impacts.map((impact) => (
                <li key={impact.scopeId}>
                  {label(impact.scopeId)}:{" "}
                  {impact.effectiveDeadlineBefore
                    ? when(impact.effectiveDeadlineBefore)
                    : "no deadline"}{" "}
                  →{" "}
                  {impact.effectiveDeadlineAfter
                    ? when(impact.effectiveDeadlineAfter)
                    : "no deadline"}
                  {impact.shortened ? " (earlier)" : ""}
                </li>
              ))}
              <li>
                {preview.shortensDeadline
                  ? "This shortens promised time for the learner."
                  : "No deadline gets earlier."}
              </li>
            </ul>
          )}
          {preview.previewKind === "refund" && (
            <ul>
              <li>
                Balance {preview.balanceBefore.remaining} →{" "}
                {preview.balanceAfter.remaining} ({preview.poolId})
              </li>
            </ul>
          )}
          {preview.previewKind === "exception" && (
            <ul>
              <li>
                Effective deadline{" "}
                {preview.effectiveDeadlineBefore
                  ? when(preview.effectiveDeadlineBefore)
                  : "none"}{" "}
                →{" "}
                {preview.effectiveDeadlineAfter
                  ? when(preview.effectiveDeadlineAfter)
                  : "none"}
              </li>
              <li>No allowance pool is debited.</li>
            </ul>
          )}
          <Field
            label="Reason"
            htmlFor="ledger-reason"
            hint="A reference such as a ticket or decision number, not personal details."
          >
            <input
              id="ledger-reason"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button
            kind={action.kind === "revocation" ? "danger" : "primary"}
            disabled={flight.pending || !reason.trim()}
            onClick={() =>
              void flight.run(async () => {
                const input = {
                  previewId: preview.previewId,
                  previewDigest: preview.previewDigest,
                  reason: reason.trim(),
                };
                const result = await client.applyLedgerAction!(
                  policy.enrollmentId,
                  action,
                  input,
                  {
                    expectedRevision: preview.revision,
                    idempotencyKey: flight.key(input),
                  },
                );
                onUpdated(result);
                onClose();
              })
            }
          >
            {`Apply: ${titles[action.kind].toLowerCase()}`}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
