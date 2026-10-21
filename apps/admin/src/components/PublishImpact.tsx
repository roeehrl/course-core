import { useState } from "react";
import { useRemote } from "../hooks/useAdmin";
import {
  releaseEditingErrorMessage,
  type ReleaseEditingPort,
} from "../domain/releaseEditing";
import { Badge, Button, Loading, Notice } from "./ui";
import { useI18n, useT, type MessageKey } from "../i18n";

/** Who publishing an approved draft affects, confirmed before publishing. Existing learners keep
 * the version they started; the confirmation carries the digest of exactly what was shown. */
export function PublishImpact({
  port,
  courseId,
  releaseId,
  version,
  pending,
  onConfirm,
}: {
  port: ReleaseEditingPort;
  courseId: string;
  releaseId: string;
  version: string;
  pending: boolean;
  onConfirm: (impactDigest: string) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const remote = useRemote(
    (signal) => port.publishImpact(courseId, releaseId, signal),
    [port, courseId, releaseId],
  );
  const [consent, setConsent] = useState(false);
  if (remote.loading) return <Loading label={t("publishImpact.loading")} />;
  if (remote.error || !remote.data)
    return (
      <div className="stack">
        <Notice tone="red">
          {releaseEditingErrorMessage(remote.error, t)}
        </Notice>
        <Button onClick={remote.reload}>{t("publishImpact.reload")}</Button>
      </div>
    );
  const { impact, impactDigest } = remote.data;
  const kinds = Object.entries(impact.kinds ?? {}).filter(
    ([, k]) => k.added + k.removed + k.changed > 0,
  );
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (consent) onConfirm(impactDigest);
      }}
    >
      <p>{t("publishImpact.intro", { version })}</p>
      <dl className="facts">
        <div>
          <dt>{t("publishImpact.newLearners")}</dt>
          <dd>
            {t("publishImpact.newLearnersValue", {
              version: impact.newLearnersGet,
              recent: impact.enrollmentsLast30Days,
            })}
          </dd>
        </div>
        <div>
          <dt>{t("publishImpact.pinned")}</dt>
          <dd>
            {impact.from
              ? t("publishImpact.pinnedValue", {
                  count: impact.learnersPinnedToActive,
                  version: impact.from.version,
                })
              : t("publishImpact.noLive")}
          </dd>
        </div>
        {impact.from && (
          <div>
            <dt>{t("publishImpact.midway")}</dt>
            <dd>
              {t("publishImpact.midwayValue", {
                count: impact.learnersMidwayInChangedLessons,
              })}
            </dd>
          </div>
        )}
      </dl>
      {impact.from && (
        <>
          <h3>
            {t("publishImpact.changes", { count: impact.contentChanges ?? 0 })}
          </h3>
          {kinds.length === 0 ? (
            <p>{t("publishImpact.noChanges")}</p>
          ) : (
            <ul>
              {kinds.map(([kind, k]) => (
                <li key={kind}>
                  {i18n.has(`publishImpact.kind.${kind}` as MessageKey)
                    ? t(`publishImpact.kind.${kind}` as MessageKey)
                    : kind}
                  {": "}
                  {t("publishImpact.kindCounts", {
                    added: k.added,
                    changed: k.changed,
                    removed: k.removed,
                  })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {impact.defectiveItemsFixed.length > 0 && (
        <Notice tone="green">
          {t("publishImpact.fixed", {
            count: impact.defectiveItemsFixed.length,
          })}{" "}
          {impact.defectiveItemsFixed.map((id) => (
            <Badge key={id}>
              <span dir="ltr">{id}</span>
            </Badge>
          ))}
        </Notice>
      )}
      {impact.defectiveItemsCarriedOver.length > 0 && (
        <Notice tone="gold" title={t("publishImpact.carried.title")}>
          {t("publishImpact.carried.body", {
            count: impact.defectiveItemsCarriedOver.length,
          })}{" "}
          {impact.defectiveItemsCarriedOver.map((id) => (
            <Badge key={id}>
              <span dir="ltr">{id}</span>
            </Badge>
          ))}
        </Notice>
      )}
      <Notice tone="blue">{t("publishImpact.nobodyMoves")}</Notice>
      <label className="check-label">
        <input
          type="checkbox"
          checked={consent}
          disabled={pending}
          onChange={(e) => setConsent(e.target.checked)}
        />
        {t("publishImpact.confirmLabel", { version })}
      </label>
      <Button kind="primary" type="submit" disabled={!consent || pending}>
        {pending ? t("publishImpact.publishing") : t("publishImpact.publish")}
      </Button>
    </form>
  );
}
