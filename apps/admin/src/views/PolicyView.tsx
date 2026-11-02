import { useScopeLabel } from "../components/scopeLabel";
import { PolicyMigrationEditor } from "../components/PolicyMigrationEditor";
import {
  useEffect,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { RefreshCw, Search } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import type { LearningPolicy, ScopePolicy } from "../domain/policy";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Notice,
  Stat,
  TechnicalDetails,
  SkeletonRows,
  PageIntro,
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
import { PolicyHistory } from "../components/PolicyHistory";
import { CohortMigrationDialog } from "../components/CohortMigrationDialog";
import type { LedgerAction, LedgerResult } from "../domain/policyLedger";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";
import { learnerName } from "../domain/learnerName";
import { serverMessageText } from "../domain/serverMessages";
import { SectionNav } from "../components/SectionNav";
import "./policy.css";

/** First strong isolate … pop directional isolate: a name or version keeps its own direction and
 * never reorders the text around it (a Latin name in a Hebrew option, a version after it). */
const isolate = (text: string) => `\u2068${text}\u2069`;

/** The page's sections, in page order, for the link bar. */
const SECTIONS = [
  ["policy-course", "policyView.nav.course"],
  ["policy-learner", "policyView.nav.learner"],
  ["policy-attempts", "policyView.nav.attempts"],
  ["policy-deadlines", "policyView.nav.deadlines"],
  ["policy-work", "policyView.nav.work"],
  ["policy-extensions", "policyView.nav.extensions"],
  ["policy-offers", "policyView.nav.offers"],
  ["policy-history", "policyView.nav.history"],
] as const satisfies readonly (readonly [string, MessageKey])[];
type SectionId = (typeof SECTIONS)[number][0];

/** A section the link bar can reach: focusable so keyboard and screen-reader users land in it. */
function Section({ id, children }: PropsWithChildren<{ id: SectionId }>) {
  return (
    <div id={id} className="policy-section" tabIndex={-1}>
      {children}
    </div>
  );
}

/** The sticky "On this page" bar (SectionNav). It lists only the sections that are on the page
 * now (a card hidden from people without access is skipped). */
function PolicySectionNav() {
  const t = useT();
  const all = SECTIONS.map(([id]) => id);
  const [present, setPresent] = useState<SectionId[]>(all);
  useEffect(() => {
    const update = () => {
      const ids = all.filter(
        (id) => (document.getElementById(id)?.childElementCount ?? 0) > 0,
      );
      setPresent((before) => (before.join() === ids.join() ? before : ids));
    };
    update();
    const page = document.querySelector(".policy-page");
    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(update);
    if (page) observer?.observe(page, { childList: true, subtree: true });
    return () => observer?.disconnect();
  }, []);
  if (present.length < 2) return null;
  return (
    <SectionNav
      label={t("policyView.nav.label")}
      sections={SECTIONS.filter(([id]) => present.includes(id)).map(
        ([id, key]) => ({ id, label: t(key) }),
      )}
    />
  );
}

export function PolicyView({
  data,
  client,
  actions,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const [enrollmentId, setEnrollmentId] = useState(
    data.enrollments[0]?.id ?? "",
  );
  const remote = useRemote(
    (signal) => client.getPolicy(enrollmentId, signal),
    [client, enrollmentId],
  );
  const canWrite = data.permissions.includes("policy.write");
  const [cohort, setCohort] = useState(false);
  const [courseMessage, setCourseMessage] = useState("");
  const settingsShown = Boolean(client.getPolicySettings);
  // A deadline change for every learner is a course-wide action: it sits with the course
  // settings. It lists the course's levels from the policy of the learner shown below.
  const cohortAction =
    canWrite &&
    client.previewCohortMigration &&
    client.applyCohortMigration &&
    remote.data ? (
      <Button type="button" onClick={() => setCohort(true)}>
        {t("policyView.cohort")}
      </Button>
    ) : undefined;
  const picker = (
    <Field label={t("policyView.enrollment")} htmlFor="policy-enrollment">
      <select
        id="policy-enrollment"
        value={enrollmentId}
        onChange={(e) => setEnrollmentId(e.target.value)}
      >
        {data.enrollments.map((item) => (
          <option key={item.id} value={item.id}>
            {t("policyView.enrollment.option", {
              name: isolate(learnerName(t, item)),
              version: isolate(item.releaseVersion),
            })}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="page-stack policy-page">
      <PageIntro>{t("policyView.intro")}</PageIntro>
      <PolicySectionNav />
      {settingsShown && (
        <Section id="policy-course">
          <PolicySettingsCard
            client={client}
            courseId={data.course.id}
            canWrite={canWrite}
            actions={cohortAction}
          >
            {courseMessage && <Notice tone="green">{courseMessage}</Notice>}
          </PolicySettingsCard>
        </Section>
      )}
      {cohort && remote.data && (
        <CohortMigrationDialog
          client={client}
          courseId={data.course.id}
          policy={remote.data}
          onClose={() => setCohort(false)}
          onApplied={(result) => {
            setCourseMessage(
              result.message !== undefined
                ? serverMessageText(i18n, result.message)
                : t("policyView.cohortApplied", { count: result.applied }),
            );
            void actions.resync();
            // Reload the learner shown below: the change may have moved their dates.
            remote.reload();
          }}
        />
      )}
      {!data.enrollments.length ? (
        <Section id="policy-learner">
          <EmptyState title={t("policyView.noEnrollments.title")}>
            {t("policyView.noEnrollments.body")}
          </EmptyState>
        </Section>
      ) : remote.data && !remote.loading ? (
        <PolicyWorkspace
          key={`${enrollmentId}:${remote.data.revision}`}
          initial={remote.data}
          client={client}
          picker={picker}
          canPropose={data.permissions.includes("extension.propose")}
          canMigrate={canWrite}
          extraActions={settingsShown ? undefined : cohortAction}
          onRefresh={remote.reload}
          onChanged={actions.resync}
        />
      ) : (
        <Section id="policy-learner">
          <Card
            title={t("policyView.learner.title")}
            eyebrow={t("policyView.learner.eyebrow")}
          >
            {picker}
            {remote.loading ? (
              <SkeletonRows label={t("policyView.loading")} rows={6} />
            ) : (
              <ErrorState error={remote.error} onRetry={remote.reload} />
            )}
          </Card>
        </Section>
      )}
      {client.platform && data.permissions.includes("policy.read") && (
        <Section id="policy-history">
          <PolicyHistory port={client.platform} courseId={data.course.id} />
        </Section>
      )}
    </div>
  );
}

/** The number of levels from which the list offers a search field. */
const SEARCH_FROM = 8;

/** The course's levels as a searchable list bounded to a few screens' worth: beside the detail on
 * a wide screen (and in view while it scrolls), above it on a narrow one. */
function ScopePicker({
  policy,
  scopeId,
  onSelect,
}: {
  policy: LearningPolicy;
  scopeId: string | undefined;
  onSelect: (scopeId: string) => void;
}) {
  const t = useT();
  const { whenUtc } = useFormatters();
  const scopeNames = useScopeLabel();
  const [query, setQuery] = useState("");
  const depth = (scope: ScopePolicy) => {
    let level = 0;
    for (
      let parent = policy.scopes.find((s) => s.scopeId === scope.parentScopeId);
      parent && level < 6;
      parent = policy.scopes.find((s) => s.scopeId === parent!.parentScopeId)
    )
      level++;
    return level;
  };
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? policy.scopes.filter((scope) =>
        scopeNames
          .name(scope, scope.scopeId)
          .toLocaleLowerCase()
          .includes(needle),
      )
    : policy.scopes;
  const searchable = policy.scopes.length >= SEARCH_FROM;
  return (
    <Card
      className="policy-scope-picker"
      title={t("policyView.scopes.title")}
      eyebrow={t("policyView.scopes.eyebrow")}
    >
      {searchable && (
        <Field label={t("policyView.scopes.find")} htmlFor="policy-scope-find">
          <div className="search-field">
            <Search size={17} aria-hidden="true" />
            <input
              id="policy-scope-find"
              type="search"
              value={query}
              placeholder={t("policyView.scopes.find.placeholder")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </Field>
      )}
      {searchable && (
        <p className="policy-scope-count" aria-live="polite">
          {needle
            ? t("policyView.scopes.shown", {
                shown: shown.length,
                total: policy.scopes.length,
              })
            : t("policyView.scopes.count", { count: policy.scopes.length })}
        </p>
      )}
      <div
        className="selector-list"
        role="group"
        aria-label={t("policyView.scopes.title")}
      >
        {shown.map((item) => {
          const resolved = policy.constraints.find(
            (c) => c.scopeId === item.scopeId,
          );
          return (
            <button
              key={item.scopeId}
              type="button"
              className={`selector-item ${item.scopeId === scopeId ? "selected" : ""}`}
              aria-pressed={item.scopeId === scopeId}
              style={{ paddingInlineStart: 12 + Math.min(depth(item), 3) * 12 }}
              onClick={() => onSelect(item.scopeId)}
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
                        date: whenUtc(resolved.effectiveDeadline),
                      })
                    : t("policyView.noEffective")}
                </small>
              </span>
            </button>
          );
        })}
        {!shown.length && <small>{t("policyView.scopes.none")}</small>}
      </div>
    </Card>
  );
}

function PolicyWorkspace({
  initial,
  client,
  picker,
  canPropose,
  canMigrate,
  extraActions,
  onRefresh,
  onChanged,
}: {
  initial: LearningPolicy;
  client: AdminClient;
  picker: ReactNode;
  canPropose: boolean;
  canMigrate: boolean;
  extraActions?: ReactNode;
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
  const [rejectReason, setRejectReason] = useState("");
  const approvals = useSingleFlight();
  const ledgerUpdated = (result: LedgerResult) => {
    setPolicy(result.policy);
    setMessage(
      t("policyView.receiptMessage", {
        message: serverMessageText(i18n, result.message),
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
  const poolUnit = (poolId: string) =>
    policy.pools.find((pool) => pool.poolId === poolId)?.unit ?? "other";
  // Actions on the selected level sit with that level's detail.
  const scopeActions = (
    <div className="policy-actions">
      {canMigrate &&
        client.previewAccommodation &&
        client.applyAccommodation &&
        scopeId &&
        policy.status === "active" && (
          <Button type="button" onClick={() => setAccommodating(true)}>
            {t("policyView.accommodation")}
          </Button>
        )}
      {canLedger &&
        scope &&
        (scope.window || scope.hardDeadline) &&
        policy.status === "active" && (
          <Button
            type="button"
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
    </div>
  );
  return (
    <>
      <Section id="policy-learner">
        <Card
          title={t("policyView.learner.title")}
          eyebrow={t("policyView.learner.eyebrow")}
          actions={
            <div className="policy-actions">
              {canMigrate &&
                client.previewPolicyChange &&
                client.migratePolicy && (
                  <Button
                    type="button"
                    kind="primary"
                    onClick={() => setMigrating(true)}
                  >
                    {t("policyView.editScopes")}
                  </Button>
                )}
              {extraActions}
              <Button type="button" kind="quiet" onClick={onRefresh}>
                <RefreshCw size={16} aria-hidden="true" />
                {t("policyView.refresh")}
              </Button>
            </div>
          }
        >
          {picker}
          <p className="policy-meta">
            <Badge tone={policy.status === "active" ? "green" : "gold"}>
              {t(`policyView.status.${policy.status}` as MessageKey)}
            </Badge>
            <span>
              {t("policyView.badge.enrollmentRevision", {
                revision: policy.revision,
              })}
            </span>
            <span>
              {t("policyView.badge.policyRevision", {
                revision: policy.policyRevision,
              })}
            </span>
            <span>
              {t("policyView.badge.ledgerRevision", {
                revision: policy.ledgerRevision,
              })}
            </span>
          </p>
          {message && <Notice tone="green">{message}</Notice>}
          {policy.coverage && (
            <>
              <h3>{t("policyView.coverage.title")}</h3>
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
                      policy.coverage.personalExtras.committed
                        .additionalMinutes,
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
            </>
          )}
        </Card>
      </Section>
      {ledgerAction && (
        <LedgerActionDialog
          client={client}
          policy={policy}
          initial={ledgerAction}
          onClose={() => setLedgerAction(undefined)}
          onUpdated={ledgerUpdated}
        />
      )}
      {client.getAssessmentAttempts && (
        <Section id="policy-attempts">
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
        </Section>
      )}
      {accommodating && scopeId && (
        <AccommodationEditor
          client={client}
          policy={policy}
          scopeId={scopeId}
          onClose={() => setAccommodating(false)}
          onUpdated={(result) => {
            setPolicy(result.policy);
            setMessage(serverMessageText(i18n, result.message));
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
            setMessage(serverMessageText(i18n, result.message));
            void onChanged();
          }}
        />
      )}
      <Section id="policy-deadlines">
        <div className="master-detail policy-hierarchy">
          <ScopePicker
            policy={policy}
            scopeId={scopeId}
            onSelect={(id) => {
              setScopeId(id);
              setMessage("");
            }}
          />
          {scope && constraint ? (
            <ScopeDetails
              scope={scope}
              constraint={constraint}
              policy={policy}
              actions={scopeActions}
            />
          ) : (
            <EmptyState title={t("policyView.noScope.title")}>
              {t("policyView.noScope.body")}
            </EmptyState>
          )}
        </div>
      </Section>
      {scope && constraint && (
        <>
          <Section id="policy-work">
            <Card
              title={t("policyView.envelope.title")}
              eyebrow={t("policyView.envelope.eyebrow")}
            >
              <p>{t("policyView.envelope.body")}</p>
              <ScopeQuotas
                key={scope.scopeId}
                quotas={constraint.quotas}
                scopes={policy.scopes}
                conceptTitles={policy.conceptTitles}
              />
              <Notice tone="blue">{t("policyView.envelope.notice")}</Notice>
            </Card>
          </Section>
          <Section id="policy-extensions">
            <Card
              title={t("policyView.allowance.title")}
              eyebrow={t("policyView.allowance.eyebrow")}
            >
              {policy.pools
                .filter((pool) =>
                  scope.extensions?.poolIds.includes(pool.poolId),
                )
                .map((pool) => {
                  const balance = policy.balances.find(
                    (item) => item.poolId === pool.poolId,
                  );
                  return (
                    <div className="stack" key={pool.poolId}>
                      <h3>
                        {t("policyView.pool.heading", { unit: pool.unit })}
                      </h3>
                      <div className="stats-grid">
                        <Stat
                          label={t("policyView.pool.total")}
                          value={pool.total}
                          detail={t("policyView.pool.unit", {
                            unit: pool.unit,
                          })}
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
                <small className="muted">
                  {t("policyView.limits", {
                    hours: scope.extensions.offerCooldownHours,
                    outstanding: scope.extensions.maxOutstandingOffersPerScope,
                    lifetime: scope.extensions.maxOffersPerScope,
                  })}
                </small>
              )}
              {Boolean(scope.extensions?.poolIds.length) && (
                <TechnicalDetails
                  rows={scope.extensions!.poolIds.map((poolId) => [
                    t("policyDetails.technical.pool", {
                      unit: poolUnit(poolId),
                    }),
                    poolId,
                  ])}
                />
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
                    message: serverMessageText(i18n, result.message),
                    id: result.receipt.id,
                  }),
                );
              }}
              onRefresh={onRefresh}
            />
          </Section>
        </>
      )}
      <Section id="policy-offers">
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
                <small className="muted">
                  {t("policyView.offer.expires", {
                    date: when(offer.terms.expiresAt),
                  })}
                </small>
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
                          maxLength={1000}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                        />
                      </Field>
                      <div className="tag-row">
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
                      {t("policyView.terms.addedWork", {
                        minutes: offer.terms.addedWork.additionalMinutes,
                        episodes: offer.terms.addedWork.additionalEpisodes,
                        approvals:
                          offer.terms.requiredApprovals.join(", ") ||
                          t("policyView.terms.noApprovals"),
                      })}
                    </small>
                    <TechnicalDetails
                      rows={[
                        [
                          t("policyDetails.technical.offer"),
                          offer.terms.offerId,
                        ],
                        [
                          t("policyDetails.technical.digest"),
                          offer.termsDigest,
                        ],
                        ...(offer.acceptance
                          ? ([
                              [
                                t("policyDetails.technical.receipt"),
                                offer.acceptance.receiptId,
                              ],
                              [
                                t("policyDetails.technical.learner"),
                                offer.acceptance.learnerId,
                              ],
                            ] as [string, string][])
                          : []),
                        [
                          t("policyDetails.technical.evidence"),
                          offer.terms.rationaleEvidenceRefs.join(", ") || "—",
                        ],
                        [
                          t("policyDetails.technical.activities"),
                          offer.terms.proposedActivities.join(", ") || "—",
                        ],
                      ]}
                    />
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
                  <strong>
                    {t("policyView.grant.row", {
                      scope: scopeLabel(
                        policy.offers.find(
                          (o) => o.terms.offerId === grant.offerId,
                        )?.terms.scopeId ?? "",
                      ),
                      date: when(grant.grantedAt),
                    })}
                  </strong>
                  {grant.revocation && (
                    <Badge tone="red">
                      {t("policyView.grant.revoked", {
                        date: when(grant.revocation.revokedAt),
                      })}
                    </Badge>
                  )}
                  <TechnicalDetails
                    rows={[
                      [t("policyDetails.technical.grant"), grant.grantId],
                      [
                        t("policyDetails.technical.receipt"),
                        grant.learnerAcceptanceReceipt.receiptId,
                      ],
                      [
                        t("policyDetails.technical.digest"),
                        grant.acceptedTermsDigest,
                      ],
                      [
                        t("policyDetails.technical.transaction"),
                        grant.atomicLedgerTransactionId,
                      ],
                    ]}
                  />
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
                      unit: poolUnit(refund.poolId),
                    })}
                  </strong>
                  <small className="muted">{when(refund.refundedAt)}</small>
                  <TechnicalDetails
                    rows={[
                      [t("policyDetails.technical.grant"), refund.grantId],
                      [
                        t("policyDetails.technical.pool", {
                          unit: poolUnit(refund.poolId),
                        }),
                        refund.poolId,
                      ],
                    ]}
                  />
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
                  <small className="muted">{when(entry.grantedAt)}</small>
                  {entry.revocation ? (
                    <Badge tone="red">
                      {t("policyView.exceptional.revoked", {
                        date: when(entry.revocation.revokedAt),
                      })}
                    </Badge>
                  ) : (
                    canLedger &&
                    policy.status === "active" && (
                      <div className="tag-row">
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
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>
    </>
  );
}
