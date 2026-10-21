import { useState } from "react";
import type { AdminClient } from "../domain/contracts";
import { AdminError } from "../domain/errors";
import type {
  CeilingsView,
  OrganizationCeilings,
} from "../domain/policyLevels";
import { useRemote } from "../hooks/useAdmin";
import { useSingleFlight } from "./LedgerActionDialog";
import { Badge, Button, Card, ErrorState, Field, Loading, Notice } from "./ui";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";

const optional = (value: string) => (value.trim() ? Number(value) : null);
const text = (value: number | null) => (value === null ? "" : String(value));

/** The organization's outer limits: the top of organization → course → learner → chapter →
 * episode. Every level below may only make them stricter. Previewed against every course
 * before saving; applies to new enrollments only. Hidden for people without access. */
export function OrganizationCeilingsCard({
  client,
  workspaceId,
  canWrite,
}: {
  client: AdminClient;
  workspaceId: string;
  canWrite: boolean;
}) {
  const t = useT();
  const remote = useRemote(
    (signal) => client.getPolicyCeilings!(workspaceId, signal),
    [client, workspaceId],
  );
  // Course-scoped staff cannot read workspace-wide settings: show nothing rather than an error.
  if (
    remote.error instanceof AdminError &&
    remote.error.code === "permission_denied"
  )
    return null;
  return (
    <Card
      title={t("organizationCeilingsCard.title")}
      eyebrow={t("organizationCeilingsCard.eyebrow")}
    >
      {remote.loading ? (
        <Loading label={t("organizationCeilingsCard.loading")} />
      ) : remote.error ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        remote.data && (
          <CeilingsForm
            key={remote.data.revision}
            view={remote.data}
            client={client}
            workspaceId={workspaceId}
            canWrite={canWrite && Boolean(client.savePolicyCeilings)}
          />
        )
      )}
    </Card>
  );
}

function CeilingsForm({
  view,
  client,
  workspaceId,
  canWrite,
}: {
  view: CeilingsView;
  client: AdminClient;
  workspaceId: string;
  canWrite: boolean;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const [current, setCurrent] = useState(view);
  const [draft, setDraft] = useState<OrganizationCeilings>(
    structuredClone(view.ceilings),
  );
  const [preview, setPreview] = useState<CeilingsView>();
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState(false);
  const flight = useSingleFlight();
  const update = (next: OrganizationCeilings) => {
    setDraft(next);
    setPreview(undefined);
    setSaved(false);
  };
  const reviewed =
    preview?.preview &&
    JSON.stringify(preview.preview.ceilings) === JSON.stringify(draft);
  const issue = (code: string) => {
    const key = `organizationCeilingsCard.issue.${code}` as MessageKey;
    return i18n.has(key) ? t(key) : t("organizationCeilingsCard.issue.other");
  };
  const work = (metric: keyof OrganizationCeilings["work"], max: number) => (
    <Field
      label={t(`organizationCeilingsCard.work.${metric}` as MessageKey)}
      htmlFor={`ceilings-${metric}`}
      hint={t("organizationCeilingsCard.blankNoLimit")}
    >
      <input
        id={`ceilings-${metric}`}
        type="number"
        min={0}
        max={max}
        value={text(draft.work[metric])}
        disabled={!canWrite}
        onChange={(e) =>
          update({
            ...draft,
            work: { ...draft.work, [metric]: optional(e.target.value) },
          })
        }
      />
    </Field>
  );
  return (
    <div className="stack">
      <div className="tag-row">
        <Badge tone={current.source === "configured" ? "blue" : "gold"}>
          {current.source === "configured"
            ? t("organizationCeilingsCard.revision", {
                revision: current.revision,
              })
            : t("organizationCeilingsCard.none")}
        </Badge>
        {current.changedAt && (
          <small>
            {t("organizationCeilingsCard.saved", {
              date: when(current.changedAt),
            })}
          </small>
        )}
      </div>
      <Notice tone="blue">{t("organizationCeilingsCard.notice")}</Notice>
      <div className="input-grid">
        <Field
          label={t("organizationCeilingsCard.end")}
          htmlFor="ceilings-end"
          hint={t("organizationCeilingsCard.end.hint")}
        >
          <input
            id="ceilings-end"
            type="datetime-local"
            value={draft.hardDeadline ? draft.hardDeadline.slice(0, 16) : ""}
            disabled={!canWrite}
            onChange={(e) =>
              update({
                ...draft,
                hardDeadline: e.target.value
                  ? new Date(`${e.target.value}:00Z`).toISOString()
                  : null,
              })
            }
          />
        </Field>
        <Field
          label={t("organizationCeilingsCard.days")}
          htmlFor="ceilings-days"
          hint={t("organizationCeilingsCard.days.hint")}
        >
          <input
            id="ceilings-days"
            type="number"
            min={1}
            max={3660}
            value={text(draft.maxEnrollmentDays)}
            disabled={!canWrite}
            onChange={(e) =>
              update({ ...draft, maxEnrollmentDays: optional(e.target.value) })
            }
          />
        </Field>
        <Field
          label={t("organizationCeilingsCard.zone")}
          htmlFor="ceilings-zone"
          hint={t("organizationCeilingsCard.zone.hint")}
        >
          <input
            id="ceilings-zone"
            dir="ltr"
            value={draft.timeZone}
            disabled={!canWrite}
            onChange={(e) => update({ ...draft, timeZone: e.target.value })}
          />
        </Field>
        {work("additionalMinutes", 1_000_000)}
        {work("additionalEpisodes", 10_000)}
        {work("remediationCyclesPerConcept", 100)}
        <Field
          label={t("organizationCeilingsCard.access")}
          htmlFor="ceilings-access"
        >
          <select
            id="ceilings-access"
            value={draft.existingMaterialAccess}
            disabled={!canWrite}
            onChange={(e) =>
              update({
                ...draft,
                existingMaterialAccess: e.target
                  .value as OrganizationCeilings["existingMaterialAccess"],
              })
            }
          >
            <option value="read_only">
              {t("organizationCeilingsCard.access.read_only")}
            </option>
            <option value="closed">
              {t("organizationCeilingsCard.access.closed")}
            </option>
          </select>
        </Field>
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={draft.extensionsAllowed}
          disabled={!canWrite}
          onChange={(e) =>
            update({ ...draft, extensionsAllowed: e.target.checked })
          }
        />
        {t("organizationCeilingsCard.extensions")}
      </label>
      {Boolean(flight.error) && <ErrorState error={flight.error} />}
      {saved && (
        <Notice tone="green">
          {t("organizationCeilingsCard.savedMessage")}
        </Notice>
      )}
      {canWrite && client.previewPolicyCeilings && (
        <div>
          <Button
            type="button"
            disabled={flight.pending}
            onClick={() =>
              void flight.run(async () =>
                setPreview(
                  await client.previewPolicyCeilings!(workspaceId, draft),
                ),
              )
            }
          >
            {t("organizationCeilingsCard.preview")}
          </Button>
        </div>
      )}
      {reviewed && (
        <div
          className="stack"
          aria-label={t("organizationCeilingsCard.impact")}
          role="region"
        >
          <h3>{t("organizationCeilingsCard.impact")}</h3>
          {!preview.impact.length && (
            <small>{t("organizationCeilingsCard.impact.none")}</small>
          )}
          <ul className="stack">
            {preview.impact.map((course) => (
              <li key={course.courseId}>
                <Badge tone={course.feasible ? "green" : "red"}>
                  {course.feasible
                    ? t("organizationCeilingsCard.fits")
                    : t("organizationCeilingsCard.doesNotFit")}
                </Badge>{" "}
                <bdi>{course.title}</bdi>
                {course.issues.length > 0 && (
                  <ul>
                    {course.issues.map((item, index) => (
                      <li key={index}>{issue(item.code)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {preview.moreCourses && (
            <small>{t("organizationCeilingsCard.impact.more")}</small>
          )}
        </div>
      )}
      {canWrite && reviewed && (
        <div className="stack">
          <Field
            label={t("organizationCeilingsCard.reason")}
            htmlFor="ceilings-reason"
          >
            <input
              id="ceilings-reason"
              dir="auto"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div>
            <Button
              type="button"
              kind="primary"
              disabled={flight.pending || !reason.trim()}
              onClick={() =>
                void flight.run(async () => {
                  const next = await client.savePolicyCeilings!(workspaceId, {
                    expectedRevision: current.revision,
                    ceilings: draft,
                    reason: reason.trim(),
                  });
                  setCurrent(next);
                  setDraft(structuredClone(next.ceilings));
                  setPreview(undefined);
                  setReason("");
                  setSaved(true);
                })
              }
            >
              {t("organizationCeilingsCard.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
