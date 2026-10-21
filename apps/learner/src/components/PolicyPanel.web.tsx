import React, { useEffect, useState } from "react";
import type {
  EnrollmentPolicy,
  ExtensionOffer,
  PolicyBalance,
  PolicyConstraint,
} from "../client/policyClient";
import type { ServerSnapshot } from "../client/apiClient";
import {
  policyDate,
  policyTimeZone,
  quotaLabel,
  quotaName,
  scopeLabel,
} from "../connected/policyPresentation";
import { useT, type MessageKey } from "../i18n";

type OfferUnit = "days" | "minutes" | "lessons" | "units";
/** The named unit one pool debit of an offer pays for. Day pools say so in their name; any
 * other debit is matched to the one change of the same size, else stays an unnamed unit. */
export function debitUnit(offer: ExtensionOffer, debit: { poolId: string; amount: number }): OfferUnit {
  const change = offer.terms.change;
  if (debit.poolId.endsWith(":calendar")) return "days";
  const amounts: [OfferUnit, number | undefined][] = [
    ["days", change?.deadline?.calendarDays],
    ["minutes", change?.work?.additionalMinutes],
    ["lessons", change?.work?.additionalEpisodes],
  ];
  const matches = amounts.filter(([, amount]) => amount === debit.amount);
  return matches.length === 1 ? matches[0]![0] : "units";
}
/** Which level sets this scope's date and its tightest work limits, in plain words. */
function BindingExplanation({ constraint }: { constraint: PolicyConstraint }) {
  const t = useT();
  const binding = constraint.binding;
  if (!binding) return null;
  return (
    <div className="connected-policy-binding">
      {binding.deadline && (
        <p>{t("policyPanel.binding.deadline", { level: binding.deadline.level })}</p>
      )}
      {binding.quotas.filter((q) => q.metric !== "remediationCyclesPerConcept" || q.remaining === 0).length > 0 && (
        <ul className="connected-policy-list">
          {binding.quotas
            .filter((q) => q.metric !== "remediationCyclesPerConcept" || q.remaining === 0)
            .map((q, index) => (
              <li key={index}>
                {t("policyPanel.binding.quota", {
                  metric: quotaName(q.metric, t),
                  remaining: q.remaining,
                  limit: q.limit,
                  level: q.level,
                })}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
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
  const t = useT();
  return (
    <ul className="connected-policy-list">
      {values.map((value) => {
        const calendar = value.poolId.endsWith(":calendar"),
          scope = calendar ? value.poolId.slice(0, -9) : "";
        return (
          <li key={value.poolId}>
            {calendar
              ? t("policyPanel.balance.calendar", {
                  scope: scopeLabel(scope, server.course),
                  remaining: value.remaining,
                  grants: value.grantsRemaining,
                })
              : t("policyPanel.balance.units", {
                  remaining: value.remaining,
                  grants: value.grantsRemaining,
                })}
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
  const t = useT();
  const terms = offer.terms,
    zone = policyTimeZone(server.course.policy),
    expired = Date.parse(terms.expiresAt) <= now,
    stale = terms.expectedPolicyRevision !== data.policyRevision;
  const actionable =
    offer.state === "proposed" &&
    !expired &&
    !stale &&
    !pending &&
    !loading &&
    !server.closureReport;
  const status = t(
    `policyPanel.status.${
      expired && ["proposed", "accepted_pending_admin"].includes(offer.state)
        ? "expired"
        : offer.state
    }` as MessageKey,
  );
  return (
    <article
      className="connected-extension-offer"
      aria-label={t("policyPanel.offer.label", {
        scope: scopeLabel(terms.scopeId, server.course),
      })}
    >
      <div className="connected-offer-top">
        <h3>
          {t("policyPanel.offer.heading", {
            scope: scopeLabel(terms.scopeId, server.course),
          })}
        </h3>
        <span>{status}</span>
      </div>
      <p dir="auto">{terms.planImpact}</p>
      <div className="connected-offer-comparison">
        <section aria-label={t("policyPanel.offer.beforeLabel")}>
          <h4>{t("policyPanel.offer.before")}</h4>
          <p>
            {t("policyPanel.offer.due", {
              date: policyDate(terms.currentEffectiveDeadline, zone),
            })}
          </p>
          <BalanceList values={terms.balanceBefore} server={server} />
        </section>
        <section aria-label={t("policyPanel.offer.afterLabel")}>
          <h4>{t("policyPanel.offer.after")}</h4>
          <p>
            {t("policyPanel.offer.due", {
              date: policyDate(terms.proposedEffectiveDeadline, zone),
            })}
          </p>
          <BalanceList values={terms.balanceAfter} server={server} />
        </section>
      </div>
      {(terms.change?.deadline || terms.change?.work) && (
        <section aria-label={t("policyPanel.offer.changeLabel")}>
          <h4>{t("policyPanel.offer.changeHeading")}</h4>
          <ul className="connected-policy-list">
            {terms.change.deadline && (
              <li>{t("policyPanel.offer.change.days", { days: terms.change.deadline.calendarDays })}</li>
            )}
            {terms.change.work?.additionalMinutes ? (
              <li>{t("policyPanel.offer.change.minutes", { minutes: terms.change.work.additionalMinutes })}</li>
            ) : null}
            {terms.change.work?.additionalEpisodes ? (
              <li>{t("policyPanel.offer.change.lessons", { lessons: terms.change.work.additionalEpisodes })}</li>
            ) : null}
          </ul>
          {terms.poolDebits && terms.poolDebits.length > 0 && (
            <ul className="connected-policy-list">
              {terms.poolDebits.map((debit) => {
                const before = terms.balanceBefore.find((b) => b.poolId === debit.poolId),
                  after = terms.balanceAfter.find((b) => b.poolId === debit.poolId);
                return (
                  <li key={debit.poolId}>
                    {t("policyPanel.offer.cost", {
                      unit: debitUnit(offer, debit),
                      amount: debit.amount,
                      before: before?.remaining ?? 0,
                      after: after?.remaining ?? 0,
                    })}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <p>
        {terms.addedWork.remediation.length
          ? t("policyPanel.offer.addedWorkWithReview", {
              minutes: terms.addedWork.additionalMinutes,
              lessons: terms.addedWork.additionalEpisodes,
              rounds: terms.addedWork.remediation.reduce(
                (sum, item) => sum + item.cycles,
                0,
              ),
            })
          : t("policyPanel.offer.addedWork", {
              minutes: terms.addedWork.additionalMinutes,
              lessons: terms.addedWork.additionalEpisodes,
            })}
      </p>
      <p>
        {t("policyPanel.offer.expires", {
          date: policyDate(terms.expiresAt, zone),
        })}
      </p>
      {terms.requiredApprovals.length > 0 && (
        <p>{t("policyPanel.offer.needsApproval")}</p>
      )}
      <details>
        <summary>{t("policyPanel.offer.details")}</summary>
        <ul className="connected-policy-list">
          {terms.proposedActivities.map((id) => {
            const title = server.course.chapters
              .flatMap((ch) => ch.episodes)
              .find((ep) => ep.id === id)?.title;
            return (
              <li key={id} dir={title ? "auto" : undefined}>
                {title ?? t("policyPanel.offer.unknownActivity")}
              </li>
            );
          })}
        </ul>
        <h4>{t("policyPanel.offer.alternatives")}</h4>
        <ul className="connected-policy-list">
          {terms.alternatives.map((text, index) => (
            <li key={index} dir="auto">
              {text}
            </li>
          ))}
        </ul>
        {terms.proposedWorkQuotas.length > 0 && (
          <>
            <h4>{t("policyPanel.offer.quotasHeading")}</h4>
            <ul className="connected-policy-list">
              {terms.proposedWorkQuotas.map((q, index) => (
                <li key={index}>
                  {t("policyPanel.quota", {
                    metric: quotaLabel[q.metric],
                    remaining: q.remaining,
                    limit: q.limit,
                  })}
                </li>
              ))}
            </ul>
          </>
        )}
        {terms.bindingAncestorCaps.length > 0 && (
          <>
            <h4>{t("policyPanel.offer.capsHeading")}</h4>
            <ul className="connected-policy-list">
              {terms.bindingAncestorCaps.map((cap, index) => (
                <li key={index}>
                  {t("policyPanel.offer.cap", {
                    scope: scopeLabel(cap.scopeId, server.course),
                    date: policyDate(cap.at, zone),
                  })}
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
              {t("policyPanel.offer.stale")}
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
              <span>{t("policyPanel.offer.consent")}</span>
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
              {t("policyPanel.offer.accept")}
            </button>
            <button
              className="connected-link-button"
              type="button"
              disabled={!actionable}
              onClick={() => onDecline(offer)}
            >
              {t("policyPanel.offer.decline")}
            </button>
          </div>
        </>
      )}
    </article>
  );
}
export function PolicyPanel(props: PolicyPanelProps) {
  const t = useT();
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
          {t("policyPanel.caption")}
        </span>
        <span className="connected-policy-dates">
          {loading
            ? t("policyPanel.dates.updating")
            : error
              ? t("policyPanel.dates.unavailable")
              : courseDue
                ? t("policyPanel.dates.courseDue", {
                    date: policyDate(courseDue.effectiveDeadline, zone),
                  })
                : t("policyPanel.dates.loading")}
          {!loading && !error && chapter && chapterDue && (
            <span>
              {t("policyPanel.dates.chapterDue", {
                chapter: chapter.title,
                date: policyDate(chapterDue.effectiveDeadline, chapterZone),
              })}
            </span>
          )}
        </span>
        {activeOffers.length > 0 && (
          <span className="connected-policy-offer-count">
            {t("policyPanel.offerCount", { count: activeOffers.length })}
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
          {t("policyPanel.refresh")}
        </button>
        <p>{t("policyPanel.explainer")}</p>
        {chapter?.policy?.window && (
          <p>
            {t("policyPanel.window", {
              chapter: chapter.title,
              days: chapter.policy.window.calendarDays,
              anchor: chapter.policy.window.anchor,
            })}
          </p>
        )}
        {data && courseDue && <BindingExplanation constraint={chapterDue ?? courseDue} />}
        {data && (
          <>
            <h3>{t("policyPanel.balanceHeading")}</h3>
            {data.balances.length ? (
              <BalanceList values={data.balances} server={server} />
            ) : (
              <p>{t("policyPanel.noBalance")}</p>
            )}
            {chapterDue?.quotas.length || courseDue?.quotas.length ? (
              <details>
                <summary>{t("policyPanel.limitsHeading")}</summary>
                <ul className="connected-policy-list">
                  {(chapterDue?.quotas ?? courseDue?.quotas ?? []).map(
                    (q, index) => (
                      <li key={index}>
                        {t("policyPanel.scopedQuota", {
                          scope: scopeLabel(q.scopeId, server.course, t),
                          metric: quotaLabel[q.metric],
                          remaining: q.remaining,
                          limit: q.limit,
                        })}
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
              <p>{t("policyPanel.granted", { count: data.grants.length })}</p>
            )}
            {!activeOffers.length && <p>{t("policyPanel.noOffers")}</p>}
          </>
        )}
      </div>
    </details>
  );
}
