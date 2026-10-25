import { useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type { AssessmentPolicy } from "../domain/policyLedger";
import type { AssessmentAttempts } from "../domain/assessmentAttempts";
import { useRemote } from "../hooks/useAdmin";
import { useSingleFlight } from "./LedgerActionDialog";
import { Badge, Button, Card, ErrorState, Field, Loading, Notice } from "./ui";
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

/** One learner's graded attempts per check, and the owner/administrator action that allows
 * one more attempt at a check (recorded with a reason; recorded answers never change). */
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
  const flight = useSingleFlight();
  const data =
    view && view.revision >= (remote.data?.revision ?? 0) ? view : remote.data;
  return (
    <Card
      title={t("assessmentPolicy.card.title")}
      eyebrow={t("assessmentPolicy.card.eyebrow")}
    >
      {remote.loading && !data ? (
        <Loading label={t("assessmentPolicy.card.loading")} />
      ) : remote.error && !data ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        data && (
          <div className="stack">
            <p>{summary(data.policy)}</p>
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
                      {canGrant && client.grantAssessmentAttempt && (
                        <th scope="col">
                          {t("assessmentPolicy.card.actions")}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.checks.map((check) => {
                      const full =
                        check.limit !== null && check.used >= check.limit;
                      return (
                        <tr key={check.checkId}>
                          <td dir="auto">{check.title}</td>
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
                          {canGrant && client.grantAssessmentAttempt && (
                            <td>
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
                  <Button onClick={() => setGranting(undefined)}>
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
