import { useRef, useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type { LearningPolicy } from "../domain/policy";
import type {
  LedgerAction,
  LedgerPreview,
  LedgerResult,
} from "../domain/policyLedger";
import { Button, Dialog, ErrorState, Field, Notice } from "./ui";
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n, type MessageKey } from "../i18n";

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
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
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
      title={t(`ledgerActionDialog.title.${action.kind}` as MessageKey)}
      onClose={onClose}
      pending={flight.pending}
      eyebrow={t("ledgerActionDialog.eyebrow")}
    >
      {action.kind === "revocation" && (
        <Notice tone="gold">{t("ledgerActionDialog.revocation.notice")}</Notice>
      )}
      {action.kind === "refund" && (
        <>
          <Notice tone="blue">{t("ledgerActionDialog.refund.notice")}</Notice>
          <Field
            label={t("ledgerActionDialog.refund.units")}
            htmlFor="ledger-refund-amount"
          >
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
            {t("ledgerActionDialog.exception.notice", {
              scope: label(action.scopeId),
            })}
          </Notice>
          <Field
            label={t("ledgerActionDialog.exception.days")}
            htmlFor="ledger-exception-days"
          >
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
        {flight.pending && !preview
          ? t("ledgerActionDialog.computing")
          : t("ledgerActionDialog.preview")}
      </Button>
      {preview && (
        <div className="stack">
          <h3>{t("ledgerActionDialog.reviewed")}</h3>
          <small>
            {i18n.rich(
              "ledgerActionDialog.expires",
              {
                digest: preview.previewDigest,
                date: when(preview.expiresAt),
              },
              {
                id: (children, key) => (
                  <span key={key} className="mono" dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </small>
          {preview.previewKind === "revocation" && (
            <ul>
              {preview.impacts.map((impact) => (
                <li key={impact.scopeId}>
                  {t(
                    impact.shortened
                      ? "ledgerActionDialog.impact.earlier"
                      : "ledgerActionDialog.impact",
                    {
                      scope: label(impact.scopeId),
                      before: impact.effectiveDeadlineBefore
                        ? when(impact.effectiveDeadlineBefore)
                        : t("ledgerActionDialog.noDeadline"),
                      after: impact.effectiveDeadlineAfter
                        ? when(impact.effectiveDeadlineAfter)
                        : t("ledgerActionDialog.noDeadline"),
                    },
                  )}
                </li>
              ))}
              <li>
                {preview.shortensDeadline
                  ? t("ledgerActionDialog.shortens")
                  : t("ledgerActionDialog.notShorter")}
              </li>
            </ul>
          )}
          {preview.previewKind === "refund" && (
            <ul>
              <li>
                {t("ledgerActionDialog.balance", {
                  before: preview.balanceBefore.remaining,
                  after: preview.balanceAfter.remaining,
                  pool: preview.poolId,
                })}
              </li>
            </ul>
          )}
          {preview.previewKind === "exception" && (
            <ul>
              <li>
                {t("ledgerActionDialog.effective", {
                  before: preview.effectiveDeadlineBefore
                    ? when(preview.effectiveDeadlineBefore)
                    : t("ledgerActionDialog.none"),
                  after: preview.effectiveDeadlineAfter
                    ? when(preview.effectiveDeadlineAfter)
                    : t("ledgerActionDialog.none"),
                })}
              </li>
              <li>{t("ledgerActionDialog.noDebit")}</li>
            </ul>
          )}
          <Field
            label={t("ledgerActionDialog.reason")}
            htmlFor="ledger-reason"
            hint={t("ledgerActionDialog.reason.hint")}
          >
            <input
              id="ledger-reason"
              dir="auto"
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
            {t(`ledgerActionDialog.apply.${action.kind}` as MessageKey)}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
