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
  when,
} from "../components/ui";
import { ScopeDetails, ScopeQuotas } from "../components/PolicyDetails";
import { ExtensionComposer } from "../components/ExtensionComposer";
import { ExtensionTerms } from "../components/ExtensionTerms";

export function PolicyView({
  data,
  client,
  actions,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
}) {
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
          <h2>Two clocks. Clear limits.</h2>
          <p>
            Calendar deadlines and windows govern when. Planned-work caps govern
            how much. Both inherit ancestor constraints.
          </p>
        </div>
        <span className="large-icon">
          <CalendarClock size={28} aria-hidden="true" />
        </span>
      </div>
      {!data.enrollments.length ? (
        <EmptyState title="No enrolled learners">
          An enrollment is required to inspect its anchored policy and allowance
          ledger.
        </EmptyState>
      ) : (
        <>
          <Field label="Policy enrollment" htmlFor="policy-enrollment">
            <select
              id="policy-enrollment"
              value={enrollmentId}
              onChange={(e) => setEnrollmentId(e.target.value)}
            >
              {data.enrollments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.profile.displayName} · {item.releaseVersion}
                </option>
              ))}
            </select>
          </Field>
          {remote.loading ? (
            <Loading label="Loading calendar policy and ledger…" />
          ) : remote.error ? (
            <ErrorState error={remote.error} onRetry={remote.reload} />
          ) : (
            remote.data && (
              <PolicyWorkspace
                key={`${enrollmentId}:${remote.data.revision}`}
                initial={remote.data}
                client={client}
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
  canPropose,
  canMigrate,
  onRefresh,
  onChanged,
}: {
  initial: LearningPolicy;
  client: AdminClient;
  canPropose: boolean;
  canMigrate: boolean;
  onRefresh: () => void;
  onChanged: () => Promise<void>;
}) {
  const [policy, setPolicy] = useState(initial);
  const [scopeId, setScopeId] = useState(
    initial.scopes.find(
      (scope) => scope.kind === "chapter" && scope.mode === "bounded",
    )?.scopeId ?? initial.scopes[0]?.scopeId,
  );
  const [message, setMessage] = useState("");
  const [migrating, setMigrating] = useState(false);
  const scope = policy.scopes.find((item) => item.scopeId === scopeId);
  const constraint = policy.constraints.find(
    (item) => item.scopeId === scopeId,
  );
  return (
    <>
      <div className="split-line">
        <div className="tag-row">
          <Badge>Enrollment revision {policy.revision}</Badge>
          <Badge>Policy revision {policy.policyRevision}</Badge>
          <Badge>Ledger revision {policy.ledgerRevision}</Badge>
          <Badge tone={policy.status === "active" ? "blue" : "gold"}>
            {policy.status}
          </Badge>
        </div>
        <div className="tag-row">
          <Button onClick={onRefresh}>Refresh policy</Button>
          {canMigrate && client.previewPolicyChange && client.migratePolicy && (
            <Button onClick={() => setMigrating(true)}>
              Edit policy scopes
            </Button>
          )}
        </div>
      </div>
      {message && <Notice tone="green">{message}</Notice>}
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
        <Card title="Policy scopes" eyebrow="Course → chapter → episode">
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
                    <strong>{item.label}</strong>
                    <Badge tone={item.mode === "bounded" ? "blue" : "gold"}>
                      {item.mode.replace("_", "-")}
                    </Badge>
                    <small>
                      {resolved?.effectiveDeadline
                        ? `Effective: ${when(resolved.effectiveDeadline)}`
                        : "No effective calendar deadline"}
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
          <EmptyState title="No resolved scope">
            The adapter must supply a constraint snapshot for each scope.
          </EmptyState>
        )}
      </div>
      {scope && constraint && (
        <>
          <Card
            title="Planned-work envelope"
            eyebrow="A separate constraint from calendar time"
          >
            <p>
              These caps bound additional learning work—not elapsed wall time or
              provider runtime. Undefined local caps still inherit ancestor
              limits.
            </p>
            <ScopeQuotas quotas={constraint.quotas} scopes={policy.scopes} />
            <Notice tone="blue">
              An extension of calendar days does not add minutes, episodes or
              remediation cycles. Work-cap increases require their own exact
              disclosed terms and approval.
            </Notice>
          </Card>
          <Card
            title="Extension allowance"
            eyebrow="Scoped pools and current balances"
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
                      <h3>{pool.unit.replaceAll("_", " ")} allowance</h3>
                      <small className="mono">{pool.poolId}</small>
                    </div>
                    <div className="stats-grid">
                      <Stat
                        label="Total allowance"
                        value={pool.total}
                        detail={pool.unit.replaceAll("_", " ")}
                      />
                      <Stat
                        label="Maximum grants"
                        value={pool.maxGrants}
                        detail={`${balance?.grantsRemaining ?? "Unknown"} grants remaining`}
                      />
                      <Stat
                        label={
                          ["calendar_day", "scope_calendar_day"].includes(
                            pool.unit,
                          )
                            ? "Maximum days per grant"
                            : "Maximum units per grant"
                        }
                        value={pool.maxPerGrant}
                        detail="Applies to each proposed grant"
                      />
                      <Stat
                        label="Current balance"
                        value={balance?.remaining ?? "Unknown"}
                        detail="Debited only by a granted extension"
                      />
                    </div>
                  </div>
                );
              })}
            {!scope.extensions?.poolIds.length && (
              <EmptyState title="No extension allowance">
                This scope does not expose an enabled allowance pool.
              </EmptyState>
            )}
            {scope.extensions && (
              <small>
                Offer cooldown: {scope.extensions.offerCooldownHours} hours ·
                Maximum outstanding offers:{" "}
                {scope.extensions.maxOutstandingOffersPerScope} · Lifetime offer
                limit: {scope.extensions.maxOffersPerScope}. Learner acceptance
                is always required.
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
              setMessage(`${result.message} Receipt: ${result.receipt.id}.`);
            }}
            onRefresh={onRefresh}
          />
        </>
      )}
      <Card
        title="Offers & learner consent"
        eyebrow="Exact terms, explicit acceptance"
      >
        <Notice tone="gold">
          An administrator may propose an offer. Only the learner can accept its
          exact current termsDigest. There is no learner-accept or grant action
          in this admin client.
        </Notice>
        {!policy.offers.length && (
          <EmptyState title="No offers recorded">
            Preview and propose an offer to request learner consent. Previewing
            and proposing do not consume allowance.
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
                <h3>
                  {policy.scopes.find((s) => s.scopeId === offer.terms.scopeId)
                    ?.label ?? offer.terms.scopeId}
                </h3>
                <Badge tone={exactConsent ? "green" : "gold"}>
                  {offer.state.replaceAll("_", " ")}
                </Badge>
              </div>
              <strong>
                {exactConsent
                  ? "Exact learner consent recorded"
                  : offer.state === "proposed"
                    ? "Awaiting exact learner consent"
                    : "No matching learner consent recorded"}
              </strong>
              <small className="mono">termsDigest: {offer.termsDigest}</small>
              <small>
                Offer: {offer.terms.offerId} · Expires{" "}
                {when(offer.terms.expiresAt)}
              </small>
              {offer.acceptance && (
                <small>
                  Consent receipt: {offer.acceptance.receiptId} · Learner:{" "}
                  {offer.acceptance.learnerId}
                </small>
              )}
              <details>
                <summary>Inspect exact offer terms</summary>
                <div className="stack">
                  <ExtensionTerms
                    terms={offer.terms}
                    scopes={policy.scopes}
                    pools={policy.pools}
                  />
                  <p>
                    <strong>Plan impact:</strong> {offer.terms.planImpact}
                  </p>
                  <p>
                    <strong>Alternatives:</strong>{" "}
                    {offer.terms.alternatives.join("; ")}
                  </p>
                  <small>
                    Rationale: {offer.terms.rationaleEvidenceRefs.join(", ")} ·
                    Activities: {offer.terms.proposedActivities.join(", ")}
                  </small>
                  <small>
                    Added work: {offer.terms.addedWork.additionalMinutes}{" "}
                    minutes, {offer.terms.addedWork.additionalEpisodes}{" "}
                    episodes. Required approvals:{" "}
                    {offer.terms.requiredApprovals.join(", ") ||
                      "None beyond learner acceptance"}
                    .
                  </small>
                </div>
              </details>
            </article>
          );
        })}
        {policy.grants.length > 0 && (
          <div className="stack">
            <h3>Recorded grants</h3>
            {policy.grants.map((grant) => (
              <div className="record" key={grant.grantId}>
                <strong>{grant.grantId}</strong>
                <small>
                  Exact consent receipt:{" "}
                  {grant.learnerAcceptanceReceipt.receiptId}
                </small>
                <small className="mono">
                  Accepted digest: {grant.acceptedTermsDigest}
                </small>
                <small>
                  Atomic ledger transaction: {grant.atomicLedgerTransactionId} ·{" "}
                  {when(grant.grantedAt)}
                </small>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
