import React, { useEffect, useState } from "react";
import type {
  EnrollmentPolicy,
  ExtensionOffer,
  PolicyBalance,
} from "../client/policyClient";
import type { ServerSnapshot } from "../client/apiClient";
import {
  policyDate,
  policyTimeZone,
  quotaLabel,
  scopeLabel,
} from "../connected/policyPresentation";
export interface PolicyPanelProps {
  server: ServerSnapshot;
  episodeId?: string;
  data?: EnrollmentPolicy;
  loading: boolean;
  error?: string;
  pending: boolean;
  onRefresh: () => void;
  onAccept: (offer: ExtensionOffer) => void;
  onDecline: (offer: ExtensionOffer) => void;
}
function BalanceList({
  values,
  server,
}: {
  values: PolicyBalance[];
  server: ServerSnapshot;
}) {
  return (
    <ul className="connected-policy-list">
      {values.map((value) => {
        const calendar = value.poolId.endsWith(":calendar"),
          scope = calendar ? value.poolId.slice(0, -9) : "";
        return (
          <li key={value.poolId}>
            {calendar
              ? `${scopeLabel(scope, server.course)} extension allowance`
              : "Additional allowance"}
            : {value.remaining} {calendar ? "calendar days" : "units"},{" "}
            {value.grantsRemaining} extensions remaining.
          </li>
        );
      })}
    </ul>
  );
}
function OfferCard({
  offer,
  server,
  data,
  pending,
  loading,
  onAccept,
  onDecline,
}: Required<
  Pick<
    PolicyPanelProps,
    "server" | "data" | "pending" | "loading" | "onAccept" | "onDecline"
  >
> & { offer: ExtensionOffer }) {
  const [consent, setConsent] = useState(false),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const ms = Date.parse(offer.terms.expiresAt) - Date.now();
    if (ms <= 0) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(ms + 20, 2147483647),
    );
    return () => clearTimeout(timer);
  }, [offer.terms.expiresAt, now]);
  const t = offer.terms,
    zone = policyTimeZone(server.course.policy),
    expired = Date.parse(t.expiresAt) <= now,
    stale = t.expectedPolicyRevision !== data.policyRevision;
  const actionable =
    offer.state === "proposed" &&
    !expired &&
    !stale &&
    !pending &&
    !loading &&
    !server.closureReport;
  const status =
    expired && ["proposed", "accepted_pending_admin"].includes(offer.state)
      ? "Expired"
      : (
          {
            proposed: "Your choice",
            accepted_pending_admin: "Accepted · waiting for approval",
            granted: "Extension granted",
            declined: "Declined",
            expired: "Expired",
            rejected: "Not approved",
            superseded: "Replaced by updated terms",
          } as const
        )[offer.state];
  return (
    <article
      className="connected-extension-offer"
      aria-label={`Extension offer for ${scopeLabel(t.scopeId, server.course)}`}
    >
      <div className="connected-offer-top">
        <h3>{scopeLabel(t.scopeId, server.course)} · extension offer</h3>
        <span>{status}</span>
      </div>
      <p>{t.planImpact}</p>
      <div className="connected-offer-comparison">
        <section aria-label="Before extension">
          <h4>Before</h4>
          <p>Due: {policyDate(t.currentEffectiveDeadline, zone)}</p>
          <BalanceList values={t.balanceBefore} server={server} />
        </section>
        <section aria-label="After extension">
          <h4>If granted</h4>
          <p>Due: {policyDate(t.proposedEffectiveDeadline, zone)}</p>
          <BalanceList values={t.balanceAfter} server={server} />
        </section>
      </div>
      <p>
        Added work: {t.addedWork.additionalMinutes} minutes,{" "}
        {t.addedWork.additionalEpisodes} lessons
        {t.addedWork.remediation.length
          ? `, ${t.addedWork.remediation.reduce((sum, item) => sum + item.cycles, 0)} review rounds`
          : ""}
        .
      </p>
      <p>Offer expires: {policyDate(t.expiresAt, zone)}.</p>
      {t.requiredApprovals.length > 0 && (
        <p>
          Acceptance also needs course-team approval. Your current dates stay in
          effect until the extension is granted.
        </p>
      )}
      <details>
        <summary>Plan details and alternatives</summary>
        <ul className="connected-policy-list">
          {t.proposedActivities.map((id) => (
            <li key={id}>
              {server.course.chapters
                .flatMap((ch) => ch.episodes)
                .find((ep) => ep.id === id)?.title ?? "A course activity"}
            </li>
          ))}
        </ul>
        <h4>Alternatives</h4>
        <ul className="connected-policy-list">
          {t.alternatives.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
        {t.proposedWorkQuotas.length > 0 && (
          <>
            <h4>Additional-work limits if granted</h4>
            <ul className="connected-policy-list">
              {t.proposedWorkQuotas.map((q, index) => (
                <li key={index}>
                  {quotaLabel[q.metric]}: {q.remaining} remaining of {q.limit}.
                </li>
              ))}
            </ul>
          </>
        )}
        {t.bindingAncestorCaps.length > 0 && (
          <>
            <h4>Other limits still apply</h4>
            <ul className="connected-policy-list">
              {t.bindingAncestorCaps.map((cap, index) => (
                <li key={index}>
                  {scopeLabel(cap.scopeId, server.course)}:{" "}
                  {policyDate(cap.at, zone)}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
      {offer.state === "proposed" && (
        <>
          {stale && (
            <p className="connected-policy-error">
              Your plan changed. Refresh and review an updated offer before
              accepting.
            </p>
          )}
          {!expired && !stale && (
            <label className="connected-offer-consent">
              <input
                type="checkbox"
                checked={consent}
                disabled={!actionable}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                I accept these dates, added work, and use of my extension
                allowance.
              </span>
            </label>
          )}
          <div className="connected-offer-actions">
            <button
              className="connected-button"
              type="button"
              disabled={!actionable || !consent}
              onClick={() => {
                if (actionable && consent) onAccept(offer);
              }}
            >
              Accept this extension
            </button>
            <button
              className="connected-link-button"
              type="button"
              disabled={!actionable}
              onClick={() => onDecline(offer)}
            >
              Decline offer
            </button>
          </div>
        </>
      )}
    </article>
  );
}
export function PolicyPanel(props: PolicyPanelProps) {
  const { server, data, loading, error } = props;
  const chapter = server.course.chapters.find((ch) =>
    ch.episodes.some(
      (ep) => ep.id === (props.episodeId ?? server.nextEpisodeId),
    ),
  );
  const courseDue = data?.constraints.find(
      (value) => value.scopeId === "course",
    ),
    chapterDue = data?.constraints.find(
      (value) => value.scopeId === `chapter:${chapter?.id}`,
    );
  const zone = policyTimeZone(server.course.policy),
    chapterZone = policyTimeZone(chapter?.policy ?? server.course.policy);
  const activeOffers =
    data?.offers.filter(
      (offer) =>
        offer.state === "proposed" || offer.state === "accepted_pending_admin",
    ) ?? [];
  return (
    <details
      className="connected-policy-panel"
      onToggle={(event) => {
        if (event.currentTarget.open) props.onRefresh();
      }}
    >
      <summary>
        <span className="connected-policy-caption">
          Study dates & optional extensions
        </span>
        <span className="connected-policy-dates">
          {loading
            ? "Updating saved dates…"
            : error
              ? "Saved dates unavailable"
              : courseDue
                ? `Course due: ${policyDate(courseDue.effectiveDeadline, zone)}`
                : "Loading saved dates…"}
          {!loading && !error && chapter && chapterDue && (
            <span>
              {chapter.title}:{" "}
              {policyDate(chapterDue.effectiveDeadline, chapterZone)}
            </span>
          )}
        </span>
        {activeOffers.length > 0 && (
          <span className="connected-policy-offer-count">
            {activeOffers.length} extension{" "}
            {activeOffers.length === 1 ? "offer" : "offers"} to review
          </span>
        )}
      </summary>
      <div className="connected-policy-body">
        {error && (
          <p role="status" className="connected-policy-error">
            {error}
          </p>
        )}
        <button
          className="connected-link-button"
          type="button"
          onClick={props.onRefresh}
          disabled={loading}
        >
          Refresh dates and offers
        </button>
        <p>
          These are the server’s saved effective dates. Reopening a course or
          lesson never resets its clock. Extensions apply only after server
          confirmation.
        </p>
        {chapter?.policy?.window && (
          <p>
            {chapter.title} has a {chapter.policy.window.calendarDays}-day
            chapter window,{" "}
            {chapter.policy.window.anchor === "scope_started"
              ? "beginning with its first recorded learning activity"
              : chapter.policy.window.anchor === "scope_assigned"
                ? "beginning when assigned"
                : "beginning with enrollment"}
            . Course limits still apply.
          </p>
        )}
        {data && (
          <>
            <h3>Remaining extension allowance</h3>
            {data.balances.length ? (
              <BalanceList values={data.balances} server={server} />
            ) : (
              <p>No extension allowance is recorded.</p>
            )}
            {chapterDue?.quotas.length || courseDue?.quotas.length ? (
              <details>
                <summary>Additional learning limits</summary>
                <ul className="connected-policy-list">
                  {(chapterDue?.quotas ?? courseDue?.quotas ?? []).map(
                    (q, index) => (
                      <li key={index}>
                        {scopeLabel(q.scopeId, server.course)} ·{" "}
                        {quotaLabel[q.metric]}: {q.remaining} remaining of{" "}
                        {q.limit}.
                      </li>
                    ),
                  )}
                </ul>
              </details>
            ) : null}
            {activeOffers.map((offer) => (
              <OfferCard
                key={`${offer.terms.offerId}:${offer.termsDigest}:${data.policyRevision}`}
                offer={offer}
                server={server}
                data={data}
                pending={props.pending}
                loading={loading || Boolean(error)}
                onAccept={props.onAccept}
                onDecline={props.onDecline}
              />
            ))}
            {data.grants.length > 0 && (
              <p>
                {data.grants.length}{" "}
                {data.grants.length === 1 ? "extension has" : "extensions have"}{" "}
                been granted and included in the saved dates above.
              </p>
            )}
            {!activeOffers.length && (
              <p>No extension offer needs a decision.</p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
