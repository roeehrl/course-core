import { useState, type ReactNode } from "react";
import { useScopeLabel } from "./scopeLabel";
import type { LearningPolicy, Quota, ScopePolicy } from "../domain/policy";
import { Badge, Button, Card, EmptyState, Notice } from "./ui";
import {
  useFormatters,
  useI18n,
  useT,
  type MessageKey,
  type Translate,
} from "../i18n";

export const metricLabel = (t: Translate, metric: Quota["metric"]) =>
  t(`policyDetails.metric.${metric}` as MessageKey);

/** Identifiers kept for support (a policy, an offer, a ledger entry), folded away under
 * "Technical details" so the owner reads sentences, not codes. */
export function TechnicalDetails({
  rows,
}: {
  rows: [label: string, value: ReactNode][];
}) {
  const t = useT();
  return (
    <details className="policy-technical">
      <summary>{t("policyDetails.technical")}</summary>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>
              <span className="mono" dir="ltr">
                {value}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

type BindingQuota = NonNullable<
  LearningPolicy["constraints"][number]["binding"]
>["quotas"][number];

/** The binding work limits in a few lines: one per kind of limit and the level that sets it.
 * A per-concept limit (one row per concept, often dozens) becomes one line with a count, and
 * the concepts themselves fold away under it. */
function WhyQuotas({
  quotas,
  scopes,
}: {
  quotas: BindingQuota[];
  scopes: ScopePolicy[];
}) {
  const t = useT();
  const scopeNames = useScopeLabel();
  const groups = new Map<string, BindingQuota[]>();
  for (const quota of quotas) {
    const key = `${quota.metric}\u0000${quota.scopeId}\u0000${quota.level}`;
    groups.set(key, [...(groups.get(key) ?? []), quota]);
  }
  return (
    <ul className="policy-why">
      {[...groups.values()].map((items) => {
        const first = items[0]!;
        const common = {
          metric: metricLabel(t, first.metric),
          level: scopeNames.level(first.level),
          scope: scopeNames.byId(scopes, first.scopeId),
        };
        if (items.length === 1 && !first.conceptId)
          return (
            <li key={`${first.metric}:${first.scopeId}`}>
              {t("policyDetails.why.quota", {
                ...common,
                remaining: first.remaining,
                limit: first.limit,
              })}
            </li>
          );
        const remaining = items.map((q) => q.remaining);
        const min = Math.min(...remaining),
          max = Math.max(...remaining);
        const uniform =
          min === max && items.every((q) => q.limit === first.limit);
        return (
          <li key={`${first.metric}:${first.scopeId}`}>
            {uniform
              ? t("policyDetails.why.group.same", {
                  ...common,
                  count: items.length,
                  remaining: min,
                  limit: first.limit,
                })
              : t("policyDetails.why.group.range", {
                  ...common,
                  count: items.length,
                  min,
                  max,
                })}
            <details>
              <summary>
                {t("policyDetails.why.group.show", { count: items.length })}
              </summary>
              <ul>
                {items.map((q, i) => (
                  <li key={`${q.conceptId ?? ""}:${i}`}>
                    {t("policyDetails.why.concept", {
                      concept: q.conceptId ?? common.metric,
                      remaining: q.remaining,
                      limit: q.limit,
                    })}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function ScopeDetails({
  scope,
  constraint,
  policy,
  actions,
}: {
  scope: ScopePolicy;
  constraint: LearningPolicy["constraints"][number];
  policy: LearningPolicy;
  /** Actions on this level (an accommodation, an exceptional grant). */
  actions?: ReactNode;
}) {
  const t = useT();
  const { when } = useFormatters();
  const scopeNames = useScopeLabel();
  const scopeLabel = (scopeId: string) =>
    scopeNames.byId(policy.scopes, scopeId);
  const ancestors = constraint.deadlines.filter(
    (d) => d.scopeId !== scope.scopeId || d.kind === "ultimate",
  );
  return (
    <Card
      title={scopeNames.name(scope, scope.scopeId)}
      titleDir="auto"
      eyebrow={t("policyDetails.calendarPolicy")}
      actions={actions}
    >
      <div className="tag-row">
        <Badge tone={scope.mode === "bounded" ? "blue" : "gold"}>
          {t(`policyDetails.mode.${scope.mode}` as MessageKey)}
        </Badge>
      </div>
      <Notice tone="blue">
        {scope.mode === "open_ended"
          ? t("policyDetails.openEnded")
          : t("policyDetails.bounded")}
      </Notice>
      <dl className="facts vertical policy-facts">
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
      {constraint.binding && (
        <div className="stack" aria-label={t("policyDetails.why")}>
          <h3>{t("policyDetails.why")}</h3>
          <p>
            {constraint.binding.deadline
              ? t("policyDetails.why.deadline", {
                  level: scopeNames.level(constraint.binding.deadline.level),
                  scope: scopeLabel(constraint.binding.deadline.scopeId),
                  date: when(constraint.binding.deadline.at),
                })
              : t("policyDetails.why.noDeadline")}
          </p>
          {constraint.binding.quotas.length > 0 && (
            <WhyQuotas
              quotas={constraint.binding.quotas}
              scopes={policy.scopes}
            />
          )}
        </div>
      )}
      {ancestors.length > 0 && (
        <>
          <h3>{t("policyDetails.ancestorCaps")}</h3>
          {ancestors.map((deadline, i) => (
            <div className="cap-row" key={i}>
              <span>
                <bdi>{scopeLabel(deadline.scopeId)}</bdi>
                {" · "}
                {t(`policyDetails.kind.${deadline.kind}` as MessageKey)}
              </span>
              <small>{when(deadline.at)}</small>
            </div>
          ))}
        </>
      )}
      <TechnicalDetails
        rows={[
          [t("policyDetails.technical.policy"), scope.policyId],
          [t("policyDetails.technical.scope"), scope.scopeId],
          ...(scope.window
            ? ([
                [t("policyDetails.technical.anchor"), scope.window.anchorId],
              ] as [string, string][])
            : []),
        ]}
      />
    </Card>
  );
}

/** How many work limits the table shows before "Show all". */
const QUOTAS_SHOWN = 6;

/** The work limits on this level's path, grouped by the level that sets them (its name once, as
 * the group's heading). A long list (one limit per concept) shows its first rows and any limit
 * that is used up; "Show all" opens the rest. */
export function ScopeQuotas({
  quotas,
  scopes,
}: {
  quotas: Quota[];
  scopes: ScopePolicy[];
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const scopeNames = useScopeLabel();
  const [all, setAll] = useState(false);
  if (!quotas.length)
    return (
      <EmptyState title={t("policyDetails.quotas.empty.title")}>
        {t("policyDetails.quotas.empty.body")}
      </EmptyState>
    );
  const visible = new Set(
    quotas.filter((q, i) => all || i < QUOTAS_SHOWN || q.remaining === 0),
  );
  // One group per level, in the order the levels first appear.
  const byScope = new Map<string, Quota[]>();
  for (const quota of quotas)
    if (visible.has(quota))
      byScope.set(quota.scopeId, [
        ...(byScope.get(quota.scopeId) ?? []),
        quota,
      ]);
  const groups = [...byScope].map(([scopeId, rows]) => ({ scopeId, rows }));
  const hidden = quotas.length - visible.size;
  return (
    <div className="stack">
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
              <th scope="col">{t("policyDetails.quotas.metric")}</th>
              <th scope="col" className="num">
                {t("policyDetails.quotas.limit")}
              </th>
              <th scope="col" className="num">
                {t("policyDetails.quotas.consumed")}
              </th>
              <th scope="col" className="num">
                {t("policyDetails.quotas.reserved")}
              </th>
              <th scope="col" className="num">
                {t("policyDetails.quotas.remaining")}
              </th>
            </tr>
          </thead>
          {groups.map((group, g) => (
            <tbody key={`${group.scopeId}:${g}`}>
              <tr className="policy-group-row">
                <th scope="colgroup" colSpan={5}>
                  <bdi>{scopeNames.byId(scopes, group.scopeId)}</bdi>
                </th>
              </tr>
              {group.rows.map((q, i) => (
                <tr key={`${q.metric}:${q.conceptId ?? ""}:${i}`}>
                  <th scope="row">
                    {metricLabel(t, q.metric)}
                    {q.conceptId && (
                      <small>
                        {t("policyDetails.quotas.concept", {
                          concept: q.conceptId,
                        })}
                      </small>
                    )}
                  </th>
                  <td className="num">{i18n.number(q.limit)}</td>
                  <td className="num">{i18n.number(q.consumed)}</td>
                  <td className="num">{i18n.number(q.reserved)}</td>
                  <td className="num">{i18n.number(q.remaining)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {(hidden > 0 || all) && quotas.length > QUOTAS_SHOWN && (
        <div className="policy-more">
          <Button
            type="button"
            aria-expanded={all}
            onClick={() => setAll((value) => !value)}
          >
            {all
              ? t("policyDetails.quotas.fewer")
              : t("policyDetails.quotas.all", { count: quotas.length })}
          </Button>
          {!all && (
            <span>
              {t("policyDetails.quotas.shown", {
                shown: visible.size,
                total: quotas.length,
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
