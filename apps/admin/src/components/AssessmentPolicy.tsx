import { useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type { AssessmentPolicy } from "../domain/policyLedger";
import type { AssessmentAttempts } from "../domain/assessmentAttempts";
import { useRemote } from "../hooks/useAdmin";
import { useSingleFlight } from "./LedgerActionDialog";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Notice,
  SkeletonRows,
} from "./ui";
import { useFormatters, useT } from "../i18n";

/** What the assessment policy means for a learner, in one plain sentence per rule. */
export function useAssessmentPolicySummary() {
  const t = useT();
  return (policy: AssessmentPolicy) =>
    [
      policy.maxGradedAttemptsPerCheck === null
        ? t("assessmentPolicy.summary.unlimited")
        : t("assessmentPolicy.summary.limit", {
            count: policy.maxGradedAttemptsPerCheck,
          }),
      policy.retryCooldownMinutes > 0
        ? t("assessmentPolicy.summary.wait", {
            minutes: policy.retryCooldownMinutes,
          })
        : t("assessmentPolicy.summary.noWait"),
      t("assessmentPolicy.summary.practice"),
    ].join(" ");
}

/** The graded-attempt limit and retry wait in the course policy settings form. */
export function AssessmentPolicyFields({
  value,
  canWrite,
  onChange,
}: {
  value: AssessmentPolicy;
  canWrite: boolean;
  onChange: (next: AssessmentPolicy) => void;
}) {
  const t = useT();
  const summary = useAssessmentPolicySummary();
  return (
    <fieldset className="stack" aria-describedby="assessment-policy-summary">
      <legend>{t("assessmentPolicy.legend")}</legend>
      <div className="input-grid">
        <Field
          label={t("assessmentPolicy.limit")}
          htmlFor="settings-attempt-limit"
          hint={t("assessmentPolicy.limit.hint")}
        >
          <input
            id="settings-attempt-limit"
            type="number"
            min={1}
            max={100}
            inputMode="numeric"
            aria-describedby="settings-attempt-limit-hint"
            value={value.maxGradedAttemptsPerCheck ?? ""}
            disabled={!canWrite}
            onChange={(e) =>
              onChange({
                ...value,
                maxGradedAttemptsPerCheck: e.target.value.trim()
                  ? Number(e.target.value)
                  : null,
              })
            }
          />
        </Field>
        <Field
          label={t("assessmentPolicy.wait")}
          htmlFor="settings-retry-wait"
          hint={t("assessmentPolicy.wait.hint")}
        >
          <input
            id="settings-retry-wait"
            type="number"
            min={0}
            max={10080}
            inputMode="numeric"
            aria-describedby="settings-retry-wait-hint"
            value={value.retryCooldownMinutes}
            disabled={!canWrite}
            onChange={(e) =>
              onChange({
                ...value,
                retryCooldownMinutes: Number(e.target.value || 0),
              })
            }
          />
        </Field>
      </div>
      <p id="assessment-policy-summary">{summary(value)}</p>
    </fieldset>
  );
}

/** How many checks the table shows before "Show all". */
const CHECKS_SHOWN = 6;

/** One learner's graded attempts per check, and the owner/administrator action that allows
 * one more attempt at a check (recorded with a reason; recorded answers never change). A course
 * has dozens of checks: the card opens with counts, then the first rows and every check that needs
 * attention (no attempts left, or a wait); "Show all" opens the rest. */
export function AssessmentAttemptsCard({
  client,
  enrollmentId,
  revision,
  canGrant,
  onGranted,
}: {
  client: AdminClient;
  enrollmentId: string;
  /** The enrollment revision the grant is checked against. */
  revision: number;
  canGrant: boolean;
  onGranted: (message: string) => void;
}) {
  const t = useT();
  const { when } = useFormatters();
  const summary = useAssessmentPolicySummary();
  const remote = useRemote(
    (signal) => client.getAssessmentAttempts!(enrollmentId, signal),
    [client, enrollmentId, revision],
  );
  const [view, setView] = useState<AssessmentAttempts>();
  const [granting, setGranting] = useState<string>();
  const [reason, setReason] = useState("");
  const [all, setAll] = useState(false);
  const flight = useSingleFlight();
  const data =
    view && view.revision >= (remote.data?.revision ?? 0) ? view : remote.data;
  const grantable =
    canGrant &&
    !!client.grantAssessmentAttempt &&
    !!data?.checks.some(
      (check) =>
        (check.limit !== null && check.used >= check.limit) || check.retryAt,
    );
  const isFull = (check: AssessmentAttempts["checks"][number]) =>
    check.limit !== null && check.used >= check.limit;
  const needsAttention = (check: AssessmentAttempts["checks"][number]) =>
    isFull(check) || Boolean(check.retryAt) || check.granted > 0;
  const checks = data?.checks ?? [];
  const shown = checks.filter(
    (check, index) =>
      all ||
      index < CHECKS_SHOWN ||
      needsAttention(check) ||
      check.checkId === granting,
  );
  const counts = {
    total: checks.length,
    full: checks.filter(isFull).length,
    waiting: checks.filter((check) => !isFull(check) && check.retryAt).length,
  };
  return (
    <Card
      title={t("assessmentPolicy.card.title")}
      eyebrow={t("assessmentPolicy.card.eyebrow")}
    >
      {remote.loading && !data ? (
        <SkeletonRows label={t("assessmentPolicy.card.loading")} rows={3} />
      ) : remote.error && !data ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        data && (
          <div className="stack">
            <p>{summary(data.policy)}</p>
            {checks.length > 0 && (
              <div className="tag-row">
                <Badge>
                  {t("assessmentPolicy.card.count", { count: counts.total })}
                </Badge>
                <Badge tone="green">
                  {t("assessmentPolicy.card.countOpen", {
                    count: counts.total - counts.full - counts.waiting,
                  })}
                </Badge>
                {counts.waiting > 0 && (
                  <Badge tone="gold">
                    {t("assessmentPolicy.card.countWaiting", {
                      count: counts.waiting,
                    })}
                  </Badge>
                )}
                {counts.full > 0 && (
                  <Badge tone="gold">
                    {t("assessmentPolicy.card.countFull", {
                      count: counts.full,
                    })}
                  </Badge>
                )}
              </div>
            )}
            {data.checks.length === 0 ? (
              <p>{t("assessmentPolicy.card.empty")}</p>
            ) : (
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label={t("assessmentPolicy.card.table")}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("assessmentPolicy.card.check")}</th>
                      <th scope="col">{t("assessmentPolicy.card.used")}</th>
                      <th scope="col">{t("assessmentPolicy.card.state")}</th>
                      {/* The column appears only when a check can be given another attempt. */}
                      {grantable && (
                        <th scope="col" className="row-actions">
                          <span className="sr-only">
                            {t("assessmentPolicy.card.actions")}
                          </span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((check) => {
                      const full = isFull(check);
                      return (
                        <tr key={check.checkId}>
                          <th scope="row">
                            <bdi>{check.title}</bdi>
                          </th>
                          <td>
                            {check.limit === null
                              ? t("assessmentPolicy.card.usedUnlimited", {
                                  used: check.used,
                                })
                              : t("assessmentPolicy.card.usedOf", {
                                  used: check.used,
                                  limit: check.limit,
                                })}
                            {check.granted > 0 && (
                              <>
                                {" "}
                                <Badge tone="blue">
                                  {t("assessmentPolicy.card.granted", {
                                    count: check.granted,
                                  })}
                                </Badge>
                              </>
                            )}
                          </td>
                          <td>
                            {full ? (
                              <Badge tone="gold">
                                {t("assessmentPolicy.card.full")}
                              </Badge>
                            ) : check.retryAt ? (
                              <Badge tone="gold">
                                {t("assessmentPolicy.card.waiting", {
                                  when: when(check.retryAt),
                                })}
                              </Badge>
                            ) : (
                              <Badge tone="green">
                                {t("assessmentPolicy.card.open")}
                              </Badge>
                            )}
                          </td>
                          {grantable && (
                            <td className="row-actions" data-label="">
                              {(full || check.retryAt) && (
                                <Button
                                  onClick={() => {
                                    setGranting(check.checkId);
                                    setReason("");
                                  }}
                                >
                                  {t("assessmentPolicy.card.allow")}
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {checks.length > CHECKS_SHOWN && (
              <div className="policy-more">
                <Button
                  type="button"
                  aria-expanded={all}
                  onClick={() => setAll((value) => !value)}
                >
                  {all
                    ? t("assessmentPolicy.card.fewer")
                    : t("assessmentPolicy.card.all", { count: checks.length })}
                </Button>
                {!all && shown.length < checks.length && (
                  <span>
                    {t("assessmentPolicy.card.shown", {
                      shown: shown.length,
                      total: checks.length,
                    })}
                  </span>
                )}
              </div>
            )}
            {granting && canGrant && client.grantAssessmentAttempt && (
              <div
                className="stack"
                role="group"
                aria-labelledby="grant-attempt-title"
              >
                <h3 id="grant-attempt-title">
                  {t("assessmentPolicy.grant.title", {
                    check:
                      data.checks.find((c) => c.checkId === granting)?.title ??
                      granting,
                  })}
                </h3>
                <Notice tone="blue">
                  {t("assessmentPolicy.grant.effect")}
                </Notice>
                <Field
                  label={t("assessmentPolicy.grant.reason")}
                  htmlFor="grant-attempt-reason"
                  hint={t("assessmentPolicy.grant.reason.hint")}
                >
                  <input
                    id="grant-attempt-reason"
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                {Boolean(flight.error) && <ErrorState error={flight.error} />}
                <div className="tag-row">
                  <Button
                    kind="primary"
                    disabled={flight.pending || !reason.trim()}
                    onClick={() =>
                      void flight.run(async () => {
                        const input = {
                          checkId: granting,
                          reason: reason.trim(),
                        };
                        const result = await client.grantAssessmentAttempt!(
                          enrollmentId,
                          input,
                          {
                            expectedRevision: revision,
                            idempotencyKey: flight.key([
                              enrollmentId,
                              revision,
                              input,
                            ]),
                          },
                        );
                        setView(result);
                        setGranting(undefined);
                        setReason("");
                        onGranted(t("assessmentPolicy.grant.done"));
                      })
                    }
                  >
                    {t("assessmentPolicy.grant.confirm")}
                  </Button>
                  <Button kind="quiet" onClick={() => setGranting(undefined)}>
                    {t("assessmentPolicy.grant.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      )}
    </Card>
  );
}
