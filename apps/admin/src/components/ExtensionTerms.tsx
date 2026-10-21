import type {
  ExtensionPreview,
  ScopePolicy,
  LearningPolicy,
} from "../domain/policy";
import { metricLabel } from "./PolicyDetails";
import { useFormatters, useI18n, type MessageKey } from "../i18n";

type Terms = Pick<
  ExtensionPreview,
  | "currentEffectiveDeadline"
  | "proposedEffectiveDeadline"
  | "currentWorkQuotas"
  | "proposedWorkQuotas"
  | "balanceBefore"
  | "balanceAfter"
  | "poolDebits"
  | "bindingAncestorCaps"
  | "requiredApprovals"
>;
export function ExtensionTerms({
  terms,
  scopes,
  pools,
}: {
  terms: Terms;
  scopes: ScopePolicy[];
  pools: LearningPolicy["pools"];
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  /** The pool's unit code, selected inside the messages; "units" when unknown. */
  const unit = (poolId: string) =>
    pools.find((pool) => pool.poolId === poolId)?.unit ?? "units";
  const scopeLabel = (scopeId: string) =>
    scopes.find((s) => s.scopeId === scopeId)?.label ?? scopeId;
  const quota = (q: Terms["currentWorkQuotas"][number]) =>
    t("extensionTerms.quota", {
      limit: q.limit,
      consumed: q.consumed,
      reserved: q.reserved,
      remaining: q.remaining,
    });
  return (
    <div className="stack">
      <div
        className="table-wrap"
        tabIndex={0}
        role="region"
        aria-label={t("extensionTerms.region")}
      >
        <table>
          <caption>{t("extensionTerms.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("extensionTerms.column.term")}</th>
              <th scope="col">{t("extensionTerms.column.current")}</th>
              <th scope="col">{t("extensionTerms.column.proposed")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{t("extensionTerms.effective")}</th>
              <td>
                {terms.currentEffectiveDeadline
                  ? when(terms.currentEffectiveDeadline)
                  : t("extensionTerms.none")}
              </td>
              <td>
                {terms.proposedEffectiveDeadline
                  ? when(terms.proposedEffectiveDeadline)
                  : t("extensionTerms.none")}
              </td>
            </tr>
            {terms.currentWorkQuotas.map((q, i) => {
              const next = terms.proposedWorkQuotas.find(
                (n) =>
                  n.scopeId === q.scopeId &&
                  n.metric === q.metric &&
                  n.conceptId === q.conceptId,
              );
              return (
                <tr key={`quota-${i}`}>
                  <th scope="row">
                    <bdi>{scopeLabel(q.scopeId)}</bdi>
                    <small>
                      {q.conceptId
                        ? t("policyDetails.metricWithConcept", {
                            metric: metricLabel(t, q.metric),
                            concept: q.conceptId,
                          })
                        : metricLabel(t, q.metric)}
                    </small>
                  </th>
                  <td>{quota(q)}</td>
                  <td>
                    {next ? quota(next) : t("extensionTerms.notSupplied")}
                  </td>
                </tr>
              );
            })}
            {terms.balanceBefore.map((before) => {
              const after = terms.balanceAfter.find(
                (b) => b.poolId === before.poolId,
              );
              return (
                <tr key={before.poolId}>
                  <th scope="row">
                    {t("extensionTerms.balance")}
                    <small className="mono" dir="ltr">
                      {before.poolId}
                    </small>
                  </th>
                  <td>
                    {t("extensionTerms.balance.value", {
                      remaining: before.remaining,
                      unit: unit(before.poolId),
                      grants: before.grantsRemaining,
                    })}
                  </td>
                  <td>
                    {after
                      ? t("extensionTerms.balance.value", {
                          remaining: after.remaining,
                          unit: unit(before.poolId),
                          grants: after.grantsRemaining,
                        })
                      : t("extensionTerms.notSupplied")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div>
        <h3>{t("extensionTerms.cost")}</h3>
        {terms.poolDebits.map((debit) => (
          <p key={debit.poolId}>
            {i18n.rich(
              "extensionTerms.cost.row",
              {
                amount: debit.amount,
                unit: unit(debit.poolId),
                pool: debit.poolId,
              },
              {
                pool: (children, key) => (
                  <span key={key} className="mono" dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </p>
        ))}
      </div>
      <div>
        <h3>{t("extensionTerms.ancestor")}</h3>
        {terms.bindingAncestorCaps.map((cap, i) => (
          <p key={i}>
            {t("extensionTerms.ancestor.row", {
              scope: scopeLabel(cap.scopeId),
              kind: t(`policyDetails.kind.${cap.kind}` as MessageKey),
              date: when(cap.at),
            })}
          </p>
        ))}
      </div>
      <small>
        {terms.requiredApprovals.length
          ? t("extensionTerms.approvals", {
              approvals: terms.requiredApprovals.join(", "),
            })
          : t("extensionTerms.approvals.none")}
      </small>
    </div>
  );
}
