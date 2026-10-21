import { useEffect, useState } from "react";
import type { AdminClient, Enrollment } from "../domain/contracts";
import type { HypothesisView } from "../domain/hypotheses";
import { useI18n, type MessageKey } from "../i18n";
import { Badge, Card, EmptyState, Notice, Status } from "./ui";

/** Read-only: the learner's teaching hypotheses, probe runs and the trigger
 * table decisions behind them. Only the learner can correct, reject or pin. */
export function TeachingHypothesesCard({
  client,
  enrollment,
}: {
  client: AdminClient;
  enrollment: Enrollment;
}) {
  const [view, setView] = useState<HypothesisView>();
  const [failed, setFailed] = useState(false);
  const i18n = useI18n();
  const t = i18n.t;
  /** A server code shown through its catalog label; an unknown code is shown as is. */
  const label = (key: string, code: string) =>
    i18n.has(key as MessageKey) ? t(key as MessageKey) : code;
  const port = client.teachingHypotheses;
  useEffect(() => {
    if (!port || enrollment.status === "erased") return;
    const abort = new AbortController();
    setView(undefined);
    setFailed(false);
    port.load(enrollment.id, abort.signal).then(setView, () => {
      if (!abort.signal.aborted) setFailed(true);
    });
    return () => abort.abort();
  }, [port, enrollment.id, enrollment.status]);
  if (!port || enrollment.status === "erased") return null;
  return (
    <Card
      title={t("teachingHypothesesCard.title")}
      eyebrow={t("teachingHypothesesCard.eyebrow")}
    >
      <p>{t("teachingHypothesesCard.intro")}</p>
      {failed && (
        <Notice tone="gold">{t("teachingHypothesesCard.unavailable")}</Notice>
      )}
      {view && !view.items.length && (
        <EmptyState title={t("teachingHypothesesCard.empty.title")}>
          {t("teachingHypothesesCard.empty.body")}
        </EmptyState>
      )}
      {view?.items.map((h) => (
        <article
          key={h.hypothesisId}
          className="evidence-item"
          aria-label={t("teachingHypothesesCard.hypothesisLabel", {
            id: h.hypothesisId,
          })}
        >
          <div className="split-line">
            <h3>{label(`teachingHypothesesCard.kind.${h.kind}`, h.kind)}</h3>
            <Status value={h.status} />
          </div>
          {h.statement != null ? (
            <p dir="auto">{h.statement}</p>
          ) : (
            <p>{t("teachingHypothesesCard.statementWithheld")}</p>
          )}
          {h.correctedByLearner && (
            <small>{t("teachingHypothesesCard.correctedByLearner")}</small>
          )}
          <div className="split-line">
            <span>
              <Badge tone="blue">
                {label(`teachingHypothesesCard.source.${h.source}`, h.source)}
              </Badge>{" "}
              <Badge tone="neutral">
                {t("teachingHypothesesCard.uncertainty", {
                  level: label(
                    `teachingHypothesesCard.uncertaintyLevel.${h.uncertainty}`,
                    h.uncertainty,
                  ),
                })}
              </Badge>{" "}
              {h.pinned && (
                <Badge tone="gold">{t("teachingHypothesesCard.pinned")}</Badge>
              )}
            </span>
            <small className="mono">
              {t("teachingHypothesesCard.observations", {
                count: h.observations,
                revision: h.revision,
              })}
            </small>
          </div>
        </article>
      ))}
      {!!view?.probes.length && (
        <table className="data-table">
          <caption>{t("teachingHypothesesCard.probes.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("teachingHypothesesCard.probes.probe")}</th>
              <th scope="col">
                {t("teachingHypothesesCard.probes.requestedBy")}
              </th>
              <th scope="col">{t("teachingHypothesesCard.probes.state")}</th>
            </tr>
          </thead>
          <tbody>
            {view.probes.map((p) => (
              <tr key={p.probeRunId}>
                <td className="mono" dir="ltr">
                  {p.probeId}
                </td>
                <td>
                  {label(
                    `teachingHypothesesCard.requester.${p.requestedBy}`,
                    p.requestedBy,
                  )}
                </td>
                <td>
                  {label(
                    `teachingHypothesesCard.probeState.${p.state}`,
                    p.state,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!!view?.signals.length && (
        <details>
          <summary>{t("teachingHypothesesCard.signals.summary")}</summary>
          <ul>
            {view.signals.map((s, i) => (
              <li key={i}>
                {i18n.rich(
                  "teachingHypothesesCard.signals.item",
                  {
                    kind: s.signalKind,
                    rules:
                      s.ruleIds.join(", ") ||
                      t("teachingHypothesesCard.signals.noRules"),
                    recommended: s.recommendations
                      .map((r) => r.action)
                      .join(", "),
                    hasRecommended: s.recommendations.length ? "yes" : "no",
                    restraints: s.restraints.join(", "),
                    hasRestraints: s.restraints.length ? "yes" : "no",
                  },
                  {
                    code: (children, key) => (
                      <span key={key} className="mono" dir="ltr">
                        {children}
                      </span>
                    ),
                  },
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
