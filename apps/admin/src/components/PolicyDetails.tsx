import type { LearningPolicy, Quota, ScopePolicy } from "../domain/policy";
import { Badge, Card, EmptyState, Notice } from "./ui";
import { useI18n, type MessageKey, type Translate } from "../i18n";

/** Server times in UTC with the zone name, formatted for the active locale. */
const utc: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
};
export const metricLabel = (t: Translate, metric: Quota["metric"]) =>
  t(`policyDetails.metric.${metric}` as MessageKey);
export function ScopeDetails({
  scope,
  constraint,
  policy,
}: {
  scope: ScopePolicy;
  constraint: LearningPolicy["constraints"][number];
  policy: LearningPolicy;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const when = (iso: string) => i18n.dateTime(iso, utc);
  const scopeLabel = (scopeId: string) =>
    policy.scopes.find((item) => item.scopeId === scopeId)?.label ?? scopeId;
  return (
    <Card title={scope.label} eyebrow={t("policyDetails.calendarPolicy")}>
      <div className="split-line">
        <Badge tone={scope.mode === "bounded" ? "blue" : "gold"}>
          {t(`policyDetails.mode.${scope.mode}` as MessageKey)}
        </Badge>
        <small className="mono" dir="ltr">
          {scope.policyId}
        </small>
      </div>
      <Notice tone="blue">
        {scope.mode === "open_ended"
          ? t("policyDetails.openEnded")
          : t("policyDetails.bounded")}
      </Notice>
      <dl className="facts vertical policy-facts">
        <div>
          <dt>{t("policyDetails.softTarget")}</dt>
          <dd>
            {scope.targetDate
              ? when(scope.targetDate)
              : t("policyDetails.notSet")}
            <small>{t("policyDetails.softTarget.note")}</small>
          </dd>
        </div>
        <div>
          <dt>{t("policyDetails.hardDeadline")}</dt>
          <dd>
            {scope.hardDeadline
              ? t("policyDetails.hardDeadline.value", {
                  date: when(scope.hardDeadline.at),
                  zone: scope.hardDeadline.timeZone,
                })
              : t("policyDetails.hardDeadline.none")}
          </dd>
        </div>
        <div>
          <dt>{t("policyDetails.window")}</dt>
          <dd>
            {scope.window ? (
              <>
                {t("policyDetails.window.value", {
                  days: scope.window.calendarDays,
                  anchor: t(
                    `policyDetails.anchor.${scope.window.anchor}` as MessageKey,
                  ),
                })}
                <small>
                  {t("policyDetails.window.anchor", {
                    date: when(scope.window.anchorInstant),
                  })}
                </small>
                <small>
                  {t("policyDetails.window.end", {
                    date: when(scope.window.resolvedDeadline),
                  })}
                </small>
                <small>
                  {t("policyDetails.window.zone", {
                    zone: scope.window.timeZone,
                    pause: t(
                      `policyDetails.pause.${scope.window.pauseRule}` as MessageKey,
                    ),
                  })}
                </small>
                <small className="mono">
                  {t("policyDetails.window.anchorId", {
                    id: scope.window.anchorId,
                  })}
                </small>
              </>
            ) : (
              t("policyDetails.window.none")
            )}
          </dd>
        </div>
        <div>
          <dt>{t("policyDetails.ultimate")}</dt>
          <dd>
            {scope.ultimateDeadline
              ? when(scope.ultimateDeadline)
              : t("policyDetails.ultimate.none")}
          </dd>
        </div>
        <div>
          <dt>{t("policyDetails.effective")}</dt>
          <dd>
            <strong>
              {constraint.effectiveDeadline
                ? when(constraint.effectiveDeadline)
                : t("policyDetails.effective.none")}
            </strong>
          </dd>
        </div>
        <div>
          <dt>{t("policyDetails.afterCap")}</dt>
          <dd>
            {t(
              `policyDetails.afterCap.${constraint.existingMaterialAccess}` as MessageKey,
            )}
          </dd>
        </div>
        {scope.submissionGraceUntil && (
          <div>
            <dt>{t("policyDetails.grace")}</dt>
            <dd>
              {when(scope.submissionGraceUntil)}
              <small>{t("policyDetails.grace.note")}</small>
            </dd>
          </div>
        )}
      </dl>
      <h3>{t("policyDetails.binding")}</h3>
      {constraint.bindingDeadlines.map((deadline, i) => (
        <div className="cap-row" key={i}>
          <Badge tone="gold">
            {t(`policyDetails.kind.${deadline.kind}` as MessageKey)}
          </Badge>
          <strong>
            <bdi>{scopeLabel(deadline.scopeId)}</bdi>
          </strong>
          <small>{when(deadline.at)}</small>
        </div>
      ))}
      {!constraint.bindingDeadlines.length && (
        <small>{t("policyDetails.binding.none")}</small>
      )}
      <h3>{t("policyDetails.ancestorCaps")}</h3>
      {constraint.deadlines
        .filter((d) => d.scopeId !== scope.scopeId || d.kind === "ultimate")
        .map((deadline, i) => (
          <div className="cap-row" key={i}>
            <span>
              {t("policyDetails.ancestorCaps.row", {
                scope: scopeLabel(deadline.scopeId),
                kind: t(`policyDetails.kind.${deadline.kind}` as MessageKey),
              })}
            </span>
            <small>{when(deadline.at)}</small>
          </div>
        ))}
    </Card>
  );
}
export function ScopeQuotas({
  quotas,
  scopes,
}: {
  quotas: Quota[];
  scopes: ScopePolicy[];
}) {
  const i18n = useI18n();
  const t = i18n.t;
  if (!quotas.length)
    return (
      <EmptyState title={t("policyDetails.quotas.empty.title")}>
        {t("policyDetails.quotas.empty.body")}
      </EmptyState>
    );
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label={t("policyDetails.quotas.region")}
    >
      <table>
        <caption>{t("policyDetails.quotas.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("policyDetails.quotas.scopeMetric")}</th>
            <th scope="col">{t("policyDetails.quotas.limit")}</th>
            <th scope="col">{t("policyDetails.quotas.consumed")}</th>
            <th scope="col">{t("policyDetails.quotas.reserved")}</th>
            <th scope="col">{t("policyDetails.quotas.remaining")}</th>
          </tr>
        </thead>
        <tbody>
          {quotas.map((q, i) => (
            <tr key={i}>
              <th scope="row">
                <bdi>
                  {scopes.find((s) => s.scopeId === q.scopeId)?.label ??
                    q.scopeId}
                </bdi>
                <small>
                  {q.conceptId
                    ? t("policyDetails.metricWithConcept", {
                        metric: metricLabel(t, q.metric),
                        concept: q.conceptId,
                      })
                    : metricLabel(t, q.metric)}
                </small>
              </th>
              <td>{i18n.number(q.limit)}</td>
              <td>{i18n.number(q.consumed)}</td>
              <td>{i18n.number(q.reserved)}</td>
              <td>{i18n.number(q.remaining)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
