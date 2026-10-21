import { useScopeLabel } from "../components/scopeLabel";
import { PolicyMigrationEditor } from "../components/PolicyMigrationEditor";
import { useState } from "react";
import { CalendarClock } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import type { LearningPolicy } from "../domain/policy";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Notice,
  Stat,
} from "../components/ui";
import { ScopeDetails, ScopeQuotas } from "../components/PolicyDetails";
import { ExtensionComposer } from "../components/ExtensionComposer";
import { ExtensionTerms } from "../components/ExtensionTerms";
import { AccommodationEditor } from "../components/AccommodationEditor";
import {
  LedgerActionDialog,
  useSingleFlight,
} from "../components/LedgerActionDialog";
import { PolicySettingsCard } from "../components/PolicySettingsCard";
import { AssessmentAttemptsCard } from "../components/AssessmentPolicy";
import { OrganizationCeilingsCard } from "../components/OrganizationCeilingsCard";
import { CohortMigrationDialog } from "../components/CohortMigrationDialog";
import type { LedgerAction, LedgerResult } from "../domain/policyLedger";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";

export function PolicyView({
  data,
  client,
  actions,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
}) {
  const t = useT();
  const [enrollmentId, setEnrollmentId] = useState(
    data.enrollments[0]?.id ?? "",
  );
  const remote = useRemote(
    (signal) => client.getPolicy(enrollmentId, signal),
    [client, enrollmentId],
  );
  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <h2>{t("policyView.heading")}</h2>
          <p>{t("policyView.intro")}</p>
        </div>
        <span className="large-icon">
          <CalendarClock size={28} aria-hidden="true" />
        </span>
      </div>
      {client.getPolicyCeilings && data.course.workspaceId && (
        <OrganizationCeilingsCard
          client={client}
          workspaceId={data.course.workspaceId}
          canWrite={data.permissions.includes("policy.write")}
        />
      )}
      {client.getPolicySettings && (
        <PolicySettingsCard
          client={client}
          courseId={data.course.id}
          canWrite={data.permissions.includes("policy.write")}
        />
      )}
      {!data.enrollments.length ? (
        <EmptyState title={t("policyView.noEnrollments.title")}>
          {t("policyView.noEnrollments.body")}
        </EmptyState>
      ) : (
        <>
          <Field label={t("policyView.enrollment")} htmlFor="policy-enrollment">
            <select
              id="policy-enrollment"
              value={enrollmentId}
              onChange={(e) => setEnrollmentId(e.target.value)}
            >
              {data.enrollments.map((item) => (
                <option key={item.id} value={item.id}>
                  {t("policyView.enrollment.option", {
                    name: item.profile.displayName,
                    version: item.releaseVersion,
                  })}
                </option>
              ))}
            </select>
          </Field>
          {remote.loading ? (
            <Loading label={t("policyView.loading")} />
          ) : remote.error ? (
            <ErrorState error={remote.error} onRetry={remote.reload} />
          ) : (
            remote.data && (
              <PolicyWorkspace
                key={`${enrollmentId}:${remote.data.revision}`}
                initial={remote.data}
                client={client}
                courseId={data.course.id}
                canPropose={data.permissions.includes("extension.propose")}
                canMigrate={data.permissions.includes("policy.write")}
                onRefresh={remote.reload}
                onChanged={actions.resync}
              />
            )
          )}
        </>
      )}
    </div>
  );
}
function PolicyWorkspace({
  initial,
  client,
  courseId,
  canPropose,
  canMigrate,
  onRefresh,
  onChanged,
}: {
  initial: LearningPolicy;
  client: AdminClient;
  courseId: string;
  canPropose: boolean;
  canMigrate: boolean;
  onRefresh: () => void;
  onChanged: () => Promise<void>;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const [policy, setPolicy] = useState(initial);
  const scopeNames = useScopeLabel();
  const scopeLabel = (scopeId: string) =>
    scopeNames.byId(policy.scopes, scopeId);
  const [scopeId, setScopeId] = useState(
    initial.scopes.find(
      (scope) => scope.kind === "chapter" && scope.mode === "bounded",
    )?.scopeId ?? initial.scopes[0]?.scopeId,
  );
  const [message, setMessage] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [accommodating, setAccommodating] = useState(false);
  const [ledgerAction, setLedgerAction] = useState<LedgerAction>();
  const [cohort, setCohort] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const approvals = useSingleFlight();
  const ledgerUpdated = (result: LedgerResult) => {
    setPolicy(result.policy);
    setMessage(
      t("policyView.receiptMessage", {
        message: result.message,
        id: result.receipt.id,
      }),
    );
    void onChanged();
  };
  const canLedger =
    canMigrate &&
    Boolean(client.previewLedgerAction && client.applyLedgerAction);
  const scope = policy.scopes.find((item) => item.scopeId === scopeId);
  const constraint = policy.constraints.find(
    (item) => item.scopeId === scopeId,
  );
  return (
    <>
      <div className="split-line">
        <div className="tag-row">
          <Badge>
            {t("policyView.badge.enrollmentRevision", {
              revision: policy.revision,
            })}
          </Badge>
          <Badge>
            {t("policyView.badge.policyRevision", {
              revision: policy.policyRevision,
            })}
          </Badge>
          <Badge>
            {t("policyView.badge.ledgerRevision", {
              revision: policy.ledgerRevision,
            })}
          </Badge>
          <Badge tone={policy.status === "active" ? "blue" : "gold"}>
            {t(`policyView.status.${policy.status}` as MessageKey)}
          </Badge>
        </div>
        <div className="tag-row">
          <Button onClick={onRefresh}>{t("policyView.refresh")}</Button>
          {canMigrate && client.previewPolicyChange && client.migratePolicy && (
            <Button onClick={() => setMigrating(true)}>
              {t("policyView.editScopes")}
            </Button>
          )}
          {canMigrate &&
            client.previewAccommodation &&
            client.applyAccommodation &&
            scopeId &&
            policy.status === "active" && (
              <Button onClick={() => setAccommodating(true)}>
                {t("policyView.accommodation")}
              </Button>
            )}
          {canLedger &&
            scope &&
            (scope.window || scope.hardDeadline) &&
            policy.status === "active" && (
              <Button
                onClick={() =>
                  setLedgerAction({
                    kind: "exception",
                    scopeId: scope.scopeId,
                    days: 3,
                    deadlineKind: scope.window ? "window" : "absolute",
                  })
                }
              >
                {t("policyView.exceptional")}
              </Button>
            )}
          {canMigrate &&
            client.previewCohortMigration &&
            client.applyCohortMigration && (
              <Button onClick={() => setCohort(true)}>
                {t("policyView.cohort")}
              </Button>
            )}
        </div>
      </div>
      {message && <Notice tone="green">{message}</Notice>}
      {ledgerAction && (
        <LedgerActionDialog
          client={client}
          policy={policy}
          initial={ledgerAction}
          onClose={() => setLedgerAction(undefined)}
          onUpdated={ledgerUpdated}
        />
      )}
      {cohort && (
        <CohortMigrationDialog
          client={client}
          courseId={courseId}
          policy={policy}
          onClose={() => setCohort(false)}
          onApplied={(result) => {
            setMessage(
              result.message ??
                t("policyView.cohortApplied", { count: result.applied }),
            );
            void onChanged();
            // Reload this learner's policy in place so the confirmation stays visible.
            void client
              .getPolicy(policy.enrollmentId)
              .then(setPolicy, () => undefined);
          }}
        />
      )}
      {policy.coverage && (
        <Card
          title={t("policyView.coverage.title")}
          eyebrow={t("policyView.coverage.eyebrow")}
        >
          <div className="stats-grid">
            <Stat
              label={t("policyView.coverage.covered")}
              value={t("policyView.coverage.covered.value", {
                covered: policy.coverage.coveredCoreObjectives,
                total: policy.coverage.denominator,
              })}
              detail={t("policyView.coverage.covered.detail")}
            />
            <Stat
              label={t("policyView.coverage.extras")}
              value={policy.coverage.personalExtras.committed.count}
              detail={t("policyView.coverage.extras.detail", {
                minutes:
                  policy.coverage.personalExtras.committed.additionalMinutes,
              })}
            />
            <Stat
              label={t("policyView.coverage.headroom")}
              value={policy.coverage.headroom.reduce(
                (n, h) => n + h.remaining.additionalMinutes,
                0,
              )}
              detail={t("policyView.coverage.headroom.detail")}
            />
            {policy.afterClosure && (
              <Stat
                label={t("policyView.coverage.afterClosure")}
                value={policy.afterClosure.questionBudget}
                detail={t("policyView.coverage.afterClosure.detail")}
              />
            )}
          </div>
        </Card>
      )}
      {client.getAssessmentAttempts && (
        <AssessmentAttemptsCard
          client={client}
          enrollmentId={policy.enrollmentId}
          revision={policy.revision}
          canGrant={canMigrate}
          onGranted={(text) => {
            setMessage(text);
            void onChanged();
            // The grant moved the enrollment revision; reload this learner's policy in place.
            void client
              .getPolicy(policy.enrollmentId)
              .then(setPolicy, () => undefined);
          }}
        />
      )}
      {accommodating && scopeId && (
        <AccommodationEditor
          client={client}
          policy={policy}
          scopeId={scopeId}
          onClose={() => setAccommodating(false)}
          onUpdated={(result) => {
            setPolicy(result.policy);
            setMessage(result.message);
            void onChanged();
          }}
        />
      )}
      {migrating && (
        <PolicyMigrationEditor
          client={client}
          policy={policy}
          onClose={() => setMigrating(false)}
          onUpdated={(result) => {
            setPolicy(result.policy);
            setMessage(result.message);
            void onChanged();
          }}
        />
      )}
      <div className="master-detail policy-hierarchy">
        <Card
          title={t("policyView.scopes.title")}
          eyebrow={t("policyView.scopes.eyebrow")}
        >
          <div className="selector-list">
            {policy.scopes.map((item) => {
              const resolved = policy.constraints.find(
                (c) => c.scopeId === item.scopeId,
              );
              return (
                <button
                  key={item.scopeId}
                  className={`selector-item ${item.scopeId === scopeId ? "selected" : ""}`}
                  aria-pressed={item.scopeId === scopeId}
                  onClick={() => {
                    setScopeId(item.scopeId);
                    setMessage("");
                  }}
                >
                  <span>
                    <strong>
                      <bdi>{scopeNames.name(item, item.scopeId)}</bdi>
                    </strong>
                    <Badge tone={item.mode === "bounded" ? "blue" : "gold"}>
                      {t(`policyView.mode.${item.mode}` as MessageKey)}
                    </Badge>
                    <small>
                      {resolved?.effectiveDeadline
                        ? t("policyView.effective", {
                            date: when(resolved.effectiveDeadline),
                          })
                        : t("policyView.noEffective")}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
        {scope && constraint ? (
          <ScopeDetails scope={scope} constraint={constraint} policy={policy} />
        ) : (
          <EmptyState title={t("policyView.noScope.title")}>
            {t("policyView.noScope.body")}
          </EmptyState>
        )}
      </div>
      {scope && constraint && (
        <>
          <Card
            title={t("policyView.envelope.title")}
            eyebrow={t("policyView.envelope.eyebrow")}
          >
            <p>{t("policyView.envelope.body")}</p>
            <ScopeQuotas quotas={constraint.quotas} scopes={policy.scopes} />
            <Notice tone="blue">{t("policyView.envelope.notice")}</Notice>
          </Card>
          <Card
            title={t("policyView.allowance.title")}
            eyebrow={t("policyView.allowance.eyebrow")}
          >
            {policy.pools
              .filter((pool) => scope.extensions?.poolIds.includes(pool.poolId))
              .map((pool) => {
                const balance = policy.balances.find(
                  (item) => item.poolId === pool.poolId,
                );
                return (
                  <div className="stack" key={pool.poolId}>
                    <div className="split-line">
                      <h3>
                        {t("policyView.pool.heading", { unit: pool.unit })}
                      </h3>
                      <small className="mono" dir="ltr">
                        {pool.poolId}
                      </small>
                    </div>
                    <div className="stats-grid">
                      <Stat
                        label={t("policyView.pool.total")}
                        value={pool.total}
                        detail={t("policyView.pool.unit", { unit: pool.unit })}
                      />
                      <Stat
                        label={t("policyView.pool.maxGrants")}
                        value={pool.maxGrants}
                        detail={
                          balance
                            ? t("policyView.pool.grantsRemaining", {
                                count: balance.grantsRemaining,
                              })
                            : t("policyView.pool.grantsRemaining.unknown")
                        }
                      />
                      <Stat
                        label={
                          ["calendar_day", "scope_calendar_day"].includes(
                            pool.unit,
                          )
                            ? t("policyView.pool.maxDays")
                            : t("policyView.pool.maxUnits")
                        }
                        value={pool.maxPerGrant}
                        detail={t("policyView.pool.maxPerGrant.detail")}
                      />
                      <Stat
                        label={t("policyView.pool.balance")}
                        value={
                          balance?.remaining ?? t("policyView.pool.unknown")
                        }
                        detail={t("policyView.pool.balance.detail")}
                      />
                    </div>
                  </div>
                );
              })}
            {!scope.extensions?.poolIds.length && (
              <EmptyState title={t("policyView.noAllowance.title")}>
                {t("policyView.noAllowance.body")}
              </EmptyState>
            )}
            {scope.extensions && (
              <small>
                {t("policyView.limits", {
                  hours: scope.extensions.offerCooldownHours,
                  outstanding: scope.extensions.maxOutstandingOffersPerScope,
                  lifetime: scope.extensions.maxOffersPerScope,
                })}
              </small>
            )}
          </Card>
          <ExtensionComposer
            key={`${scopeId}:${policy.revision}:${policy.ledgerRevision}`}
            policy={policy}
            scope={scope}
            client={client}
            canPropose={canPropose}
            onUpdated={(result) => {
              setPolicy(result.policy);
              void onChanged();
              setMessage(
                t("policyView.receiptMessage", {
                  message: result.message,
                  id: result.receipt.id,
                }),
              );
            }}
            onRefresh={onRefresh}
          />
        </>
      )}
      <Card
        title={t("policyView.offers.title")}
        eyebrow={t("policyView.offers.eyebrow")}
      >
        <Notice tone="gold">{t("policyView.offers.notice")}</Notice>
        {!policy.offers.length && (
          <EmptyState title={t("policyView.noOffers.title")}>
            {t("policyView.noOffers.body")}
          </EmptyState>
        )}
        {policy.offers.map((offer) => {
          const exactConsent =
            offer.acceptance?.explicit === true &&
            offer.acceptance.termsDigest === offer.termsDigest &&
            offer.acceptance.offerId === offer.terms.offerId &&
            offer.acceptance.enrollmentId === policy.enrollmentId &&
            offer.acceptance.learnerId === policy.learnerId &&
            Date.parse(offer.acceptance.acceptedAt) >=
              Date.parse(offer.terms.createdAt) &&
            Date.parse(offer.acceptance.acceptedAt) <
              Date.parse(offer.terms.expiresAt);
          return (
            <article key={offer.terms.offerId} className="record">
              <div className="split-line">
                <h3 dir="auto">{scopeLabel(offer.terms.scopeId)}</h3>
                <Badge tone={exactConsent ? "green" : "gold"}>
                  {t(`policyView.offerState.${offer.state}` as MessageKey)}
                </Badge>
              </div>
              <strong>
                {exactConsent
                  ? t("policyView.consent.exact")
                  : offer.state === "proposed"
                    ? t("policyView.consent.awaiting")
                    : t("policyView.consent.none")}
              </strong>
              <small>
                {i18n.rich(
                  "policyView.offer.digest",
                  { digest: offer.termsDigest },
                  {
                    id: (children, key) => (
                      <span key={key} className="mono" dir="ltr">
                        {children}
                      </span>
                    ),
                  },
                )}
              </small>
              <small>
                {t("policyView.offer.meta", {
                  id: offer.terms.offerId,
                  date: when(offer.terms.expiresAt),
                })}
              </small>
              {offer.acceptance && (
                <small>
                  {t("policyView.offer.consent", {
                    receipt: offer.acceptance.receiptId,
                    learner: offer.acceptance.learnerId,
                  })}
                </small>
              )}
              {offer.state === "accepted_pending_admin" &&
                canMigrate &&
                client.approveExtension &&
                client.rejectExtension && (
                  <div className="stack">
                    <Notice tone="gold">
                      {t("policyView.approval.notice")}
                    </Notice>
                    {Boolean(approvals.error) && (
                      <ErrorState error={approvals.error} />
                    )}
                    <div className="tag-row">
                      <Button
                        kind="primary"
                        disabled={approvals.pending}
                        onClick={() =>
                          void approvals.run(async () =>
                            ledgerUpdated(
                              await client.approveExtension!(
                                policy.enrollmentId,
                                offer.terms.offerId,
                                {
                                  expectedRevision: policy.revision,
                                  idempotencyKey: approvals.key([
                                    "approve",
                                    offer.terms.offerId,
                                    policy.revision,
                                  ]),
                                },
                              ),
                            ),
                          )
                        }
                      >
                        {t("policyView.approve")}
                      </Button>
                    </div>
                    <Field
                      label={t("policyView.rejectReason")}
                      htmlFor={`reject-${offer.terms.offerId}`}
                    >
                      <input
                        id={`reject-${offer.terms.offerId}`}
                        dir="auto"
                        maxLength={1000}
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                      />
                    </Field>
                    <Button
                      kind="danger"
                      disabled={approvals.pending || !rejectReason.trim()}
                      onClick={() =>
                        void approvals.run(async () =>
                          ledgerUpdated(
                            await client.rejectExtension!(
                              policy.enrollmentId,
                              offer.terms.offerId,
                              rejectReason.trim(),
                              {
                                expectedRevision: policy.revision,
                                idempotencyKey: approvals.key([
                                  "reject",
                                  offer.terms.offerId,
                                  policy.revision,
                                  rejectReason.trim(),
                                ]),
                              },
                            ),
                          ),
                        )
                      }
                    >
                      {t("policyView.reject")}
                    </Button>
                  </div>
                )}
              <details>
                <summary>{t("policyView.inspect")}</summary>
                <div className="stack">
                  <ExtensionTerms
                    terms={offer.terms}
                    scopes={policy.scopes}
                    pools={policy.pools}
                  />
                  <p>
                    {i18n.rich(
                      "policyView.terms.planImpact",
                      { impact: offer.terms.planImpact },
                      {
                        label: (children, key) => (
                          <strong key={key}>{children}</strong>
                        ),
                      },
                    )}
                  </p>
                  <p>
                    {i18n.rich(
                      "policyView.terms.alternatives",
                      { list: offer.terms.alternatives.join("; ") },
                      {
                        label: (children, key) => (
                          <strong key={key}>{children}</strong>
                        ),
                      },
                    )}
                  </p>
                  <small>
                    {t("policyView.terms.rationale", {
                      rationale: offer.terms.rationaleEvidenceRefs.join(", "),
                      activities: offer.terms.proposedActivities.join(", "),
                    })}
                  </small>
                  <small>
                    {t("policyView.terms.addedWork", {
                      minutes: offer.terms.addedWork.additionalMinutes,
                      episodes: offer.terms.addedWork.additionalEpisodes,
                      approvals:
                        offer.terms.requiredApprovals.join(", ") ||
                        t("policyView.terms.noApprovals"),
                    })}
                  </small>
                </div>
              </details>
            </article>
          );
        })}
        {policy.grants.length > 0 && (
          <div className="stack">
            <h3>{t("policyView.grants.title")}</h3>
            {policy.grants.map((grant) => (
              <div className="record" key={grant.grantId}>
                <strong dir="ltr">{grant.grantId}</strong>
                <small>
                  {t("policyView.grant.receipt", {
                    id: grant.learnerAcceptanceReceipt.receiptId,
                  })}
                </small>
                <small>
                  {i18n.rich(
                    "policyView.grant.digest",
                    {
                      digest: grant.acceptedTermsDigest,
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
                <small>
                  {t("policyView.grant.transaction", {
                    id: grant.atomicLedgerTransactionId,
                    date: when(grant.grantedAt),
                  })}
                </small>
                {grant.revocation && (
                  <Badge tone="red">
                    {t("policyView.grant.revoked", {
                      date: when(grant.revocation.revokedAt),
                    })}
                  </Badge>
                )}
                {canLedger && (
                  <div className="tag-row">
                    {!grant.revocation && policy.status === "active" && (
                      <Button
                        onClick={() =>
                          setLedgerAction({
                            kind: "revocation",
                            grantId: grant.grantId,
                          })
                        }
                      >
                        {t("policyView.revokeGrant")}
                      </Button>
                    )}
                    {grant.poolDebits[0] && (
                      <Button
                        onClick={() =>
                          setLedgerAction({
                            kind: "refund",
                            grantId: grant.grantId,
                            poolId: grant.poolDebits[0]!.poolId,
                            amount: grant.poolDebits[0]!.amount,
                          })
                        }
                      >
                        {t("policyView.refund")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {(policy.refunds?.length ?? 0) > 0 && (
          <div className="stack">
            <h3>{t("policyView.refunds.title")}</h3>
            {policy.refunds!.map((refund) => (
              <div className="record" key={refund.refundId}>
                <strong>
                  {t("policyView.refund.row", {
                    amount: refund.amount,
                    pool: refund.poolId,
                  })}
                </strong>
                <small>
                  {t("policyView.refund.meta", {
                    grant: refund.grantId,
                    date: when(refund.refundedAt),
                  })}
                </small>
              </div>
            ))}
          </div>
        )}
        {(policy.exceptionalGrants?.length ?? 0) > 0 && (
          <div className="stack">
            <h3>{t("policyView.exceptional.title")}</h3>
            {policy.exceptionalGrants!.map((entry) => (
              <div className="record" key={entry.exceptionId}>
                <strong>
                  {t("policyView.exceptional.row", {
                    scope: scopeLabel(entry.adjustment.scopeId),
                  })}
                </strong>
                <small>{when(entry.grantedAt)}</small>
                {entry.revocation ? (
                  <Badge tone="red">
                    {t("policyView.exceptional.revoked", {
                      date: when(entry.revocation.revokedAt),
                    })}
                  </Badge>
                ) : (
                  canLedger &&
                  policy.status === "active" && (
                    <Button
                      onClick={() =>
                        setLedgerAction({
                          kind: "revocation",
                          grantId: entry.exceptionId,
                        })
                      }
                    >
                      {t("policyView.revokeExceptional")}
                    </Button>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
