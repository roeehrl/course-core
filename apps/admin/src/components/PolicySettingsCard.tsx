import { useState, type PropsWithChildren, type ReactNode } from "react";
import type { AdminClient } from "../domain/contracts";
import type {
  PolicySettings,
  PolicySettingsView,
} from "../domain/policyLedger";
import { useRemote } from "../hooks/useAdmin";
import { useSingleFlight } from "./LedgerActionDialog";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Notice,
  SkeletonRows,
} from "./ui";
import { ExtensionPoolsEditor } from "./ExtensionPoolsEditor";
import {
  AssessmentPolicyFields,
  useAssessmentPolicySummary,
} from "./AssessmentPolicy";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";
import { serverMessageText } from "../domain/serverMessages";

const optional = (value: string) => (value.trim() ? Number(value) : null);
const text = (value: number | null) => (value === null ? "" : String(value));

/** Course policy settings a release cannot author yet: the hard-deadline time zone, DST
 * disambiguation, approvals and offer limits, reserved headroom, the closed-course
 * question budget and a study-pace estimate. They apply to new enrollments only, and
 * the server previews feasibility and daylight-saving effects before anything is saved. */
export function PolicySettingsCard({
  client,
  courseId,
  canWrite,
  actions,
  children,
}: PropsWithChildren<{
  client: AdminClient;
  courseId: string;
  canWrite: boolean;
  /** Course-wide actions for the card's heading (a deadline change for every learner). */
  actions?: ReactNode;
}>) {
  const t = useT();
  const remote = useRemote(
    (signal) => client.getPolicySettings!(courseId, signal),
    [client, courseId],
  );
  if (remote.data && !remote.loading)
    return (
      <SettingsForm
        key={remote.data.revision}
        view={remote.data}
        client={client}
        courseId={courseId}
        canWrite={canWrite}
        actions={actions}
      >
        {children}
      </SettingsForm>
    );
  return (
    <Card
      title={t("policySettingsCard.title")}
      eyebrow={t("policySettingsCard.eyebrow")}
      actions={actions}
    >
      {children}
      {remote.loading ? (
        <SkeletonRows label={t("policySettingsCard.loading")} rows={4} />
      ) : (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      )}
    </Card>
  );
}

function SettingsForm({
  view,
  client,
  courseId,
  canWrite,
  actions,
  children,
}: PropsWithChildren<{
  view: PolicySettingsView;
  client: AdminClient;
  courseId: string;
  canWrite: boolean;
  actions?: ReactNode;
}>) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  /** A server code shown through the catalog; an unknown code falls back. */
  const label = (key: string, fallback: string) =>
    i18n.has(key as MessageKey) ? t(key as MessageKey) : fallback;
  const [draft, setDraft] = useState<PolicySettings>(
    structuredClone(view.settings),
  );
  const [current, setCurrent] = useState(view);
  const [preview, setPreview] = useState<PolicySettingsView | undefined>(
    view.preview ? view : undefined,
  );
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const flight = useSingleFlight();
  const attempts = useAssessmentPolicySummary();
  const update = (next: PolicySettings) => {
    setDraft(next);
    setPreview(undefined);
    setMessage("");
  };
  const reviewed =
    preview &&
    JSON.stringify(preview.preview?.settings) === JSON.stringify(draft);
  const feasibility = reviewed ? preview.preview?.feasibility : undefined;
  const changed = JSON.stringify(draft) !== JSON.stringify(current.settings);
  const canCheck = canWrite && Boolean(client.previewPolicySettings);
  const canSave = canWrite && Boolean(client.savePolicySettings);
  // Why Save cannot be pressed yet, in the order the steps are taken.
  const blocked = !changed
    ? t("policySettingsCard.blocked.noChanges")
    : !reviewed
      ? t("policySettingsCard.blocked.check")
      : !reason.trim()
        ? t("policySettingsCard.blocked.reason")
        : "";
  const cancel = () => {
    setDraft(structuredClone(current.settings));
    setPreview(view.preview ? view : undefined);
    setReason("");
    flight.setError(undefined);
    setEditing(false);
  };
  const shown = current.settings;
  const minutes = (value: number | null) =>
    value === null
      ? t("policySettingsCard.summary.notDeclared")
      : t("policySettingsCard.summary.minutes", { count: value });
  const number = (
    labelText: string,
    idText: string,
    value: number,
    set: (n: number) => void,
    hint?: string,
  ) => (
    <Field label={labelText} htmlFor={idText} {...(hint ? { hint } : {})}>
      <input
        id={idText}
        type="number"
        min={0}
        value={value}
        disabled={!canWrite}
        onChange={(e) => set(Number(e.target.value))}
      />
    </Field>
  );
  const status = (
    <p className="policy-meta">
      <Badge tone={current.source === "configured" ? "blue" : "gold"}>
        {current.source === "configured"
          ? t("policySettingsCard.revision", { revision: current.revision })
          : t("policySettingsCard.defaults")}
      </Badge>
      {current.changedAt && (
        <span>
          {t("policySettingsCard.saved", { date: when(current.changedAt) })}
        </span>
      )}
    </p>
  );
  const feasibilityBlock = feasibility && (
    <div className="stack" aria-label={t("policySettingsCard.feasibility")}>
      <h3>{t("policySettingsCard.feasibility")}</h3>
      <Notice tone={feasibility.feasible ? "green" : "red"}>
        {feasibility.feasible
          ? t("policySettingsCard.feasible")
          : t("policySettingsCard.infeasible")}
      </Notice>
      {feasibility.issues.length > 0 && (
        <ul className="policy-why">
          {feasibility.issues.map((issue, index) => (
            <li key={index}>
              <Badge tone={issue.severity === "error" ? "red" : "gold"}>
                {t(
                  `policySettingsCard.severity.${issue.severity}` as MessageKey,
                )}
              </Badge>{" "}
              {label(`policySettingsCard.issue.${issue.code}`, issue.message)}
              {issue.neededMinutes !== undefined && (
                <>
                  {" "}
                  {t("policySettingsCard.issue.needs", {
                    needed: issue.neededMinutes,
                    available: issue.availableMinutes ?? 0,
                  })}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {feasibility.alternatives.length > 0 && (
        <p>
          {t("policySettingsCard.alternatives", {
            list: feasibility.alternatives
              .map((a) =>
                label(
                  `policySettingsCard.alternative.${a}`,
                  a.replaceAll("_", " "),
                ),
              )
              .join("; "),
          })}
        </p>
      )}
    </div>
  );
  if (!editing)
    return (
      <Card
        title={t("policySettingsCard.title")}
        eyebrow={t("policySettingsCard.eyebrow")}
        actions={
          (canWrite || actions) && (
            <div className="policy-actions">
              {canWrite && (
                <Button type="button" onClick={() => setEditing(true)}>
                  {t("policySettingsCard.edit")}
                </Button>
              )}
              {actions}
            </div>
          )
        }
      >
        {children}
        {status}
        <p className="muted">{t("policySettingsCard.summary.intro")}</p>
        {message && <Notice tone="green">{message}</Notice>}
        <dl className="policy-summary">
          <div>
            <dt>{t("policySettingsCard.zone")}</dt>
            <dd>
              <span dir="ltr">{shown.timeZone}</span>
            </dd>
          </div>
          <div>
            <dt>{t("policySettingsCard.approval")}</dt>
            <dd>
              {shown.extensions.approval === "learner"
                ? t("policySettingsCard.approval.learner")
                : t("policySettingsCard.approval.learnerAndAdmin")}
              <small>
                {t("policySettingsCard.summary.offers", {
                  hours: shown.extensions.offerCooldownHours,
                  count: shown.extensions.maxOutstandingOffersPerScope,
                })}
              </small>
            </dd>
          </div>
          <div>
            <dt>{t("policySettingsCard.summary.attempts")}</dt>
            <dd>
              {shown.assessment.maxGradedAttemptsPerCheck === null
                ? t("policySettingsCard.summary.attemptsUnlimited")
                : t("policySettingsCard.summary.attemptsLimit", {
                    count: shown.assessment.maxGradedAttemptsPerCheck,
                  })}
              <small>{attempts(shown.assessment)}</small>
            </dd>
          </div>
          <div>
            <dt>{t("policySettingsCard.summary.allowances")}</dt>
            <dd>
              {shown.extensionPools.length
                ? t("policySettingsCard.summary.allowancesCount", {
                    count: shown.extensionPools.length,
                  })
                : t("policySettingsCard.summary.allowancesNone")}
              {shown.extensions.ultimateDeadline && (
                <small>
                  {t("policySettingsCard.summary.ultimate", {
                    date: when(shown.extensions.ultimateDeadline),
                  })}
                </small>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("policySettingsCard.summary.pace")}</dt>
            <dd>
              {shown.pacing.studyMinutesPerDay === null
                ? t("policySettingsCard.summary.notDeclared")
                : t("policySettingsCard.summary.perDay", {
                    count: shown.pacing.studyMinutesPerDay,
                  })}
              <small>
                {t("policySettingsCard.summary.perEpisode", {
                  value: minutes(shown.pacing.minutesPerRequiredEpisode),
                })}
              </small>
            </dd>
          </div>
          <div>
            <dt>{t("policySettingsCard.summary.headroom")}</dt>
            <dd>
              {t("policySettingsCard.summary.headroomValue", {
                core: shown.headroom.core.additionalMinutes,
                final: shown.headroom.finalAssessment.additionalMinutes,
              })}
            </dd>
          </div>
          <div>
            <dt>{t("policySettingsCard.questions")}</dt>
            <dd>{i18n.number(shown.closedQuestionBudget)}</dd>
          </div>
        </dl>
        {feasibilityBlock}
      </Card>
    );
  return (
    <Card
      title={t("policySettingsCard.title")}
      eyebrow={t("policySettingsCard.eyebrow")}
    >
      {children}
      {status}
      <Notice tone="blue">{t("policySettingsCard.notice")}</Notice>
      <div className="input-grid">
        <Field
          label={t("policySettingsCard.zone")}
          htmlFor="settings-zone"
          hint={t("policySettingsCard.zone.hint")}
        >
          <input
            id="settings-zone"
            dir="ltr"
            value={draft.timeZone}
            disabled={!canWrite}
            onChange={(e) => update({ ...draft, timeZone: e.target.value })}
          />
        </Field>
        <Field
          label={t("policySettingsCard.hardDisambiguation")}
          htmlFor="settings-hard-disambiguation"
          hint={t("policySettingsCard.hardDisambiguation.hint")}
        >
          <select
            id="settings-hard-disambiguation"
            value={draft.hardDeadlineDisambiguation}
            disabled={!canWrite}
            onChange={(e) =>
              update({
                ...draft,
                hardDeadlineDisambiguation: e.target
                  .value as PolicySettings["hardDeadlineDisambiguation"],
              })
            }
          >
            <option value="reject">
              {t("policySettingsCard.option.reject")}
            </option>
            <option value="compatible">
              {t("policySettingsCard.option.compatible")}
            </option>
            <option value="earlier">
              {t("policySettingsCard.option.earlier")}
            </option>
            <option value="later">
              {t("policySettingsCard.option.later")}
            </option>
          </select>
        </Field>
        <Field
          label={t("policySettingsCard.windowDisambiguation")}
          htmlFor="settings-disambiguation"
          hint={t("policySettingsCard.windowDisambiguation.hint")}
        >
          <select
            id="settings-disambiguation"
            value={draft.disambiguation}
            disabled={!canWrite}
            onChange={(e) =>
              update({
                ...draft,
                disambiguation: e.target
                  .value as PolicySettings["disambiguation"],
              })
            }
          >
            <option value="compatible">
              {t("policySettingsCard.option.compatible")}
            </option>
            <option value="earlier">
              {t("policySettingsCard.option.earlier")}
            </option>
            <option value="later">
              {t("policySettingsCard.option.later")}
            </option>
            <option value="reject">
              {t("policySettingsCard.option.reject")}
            </option>
          </select>
        </Field>
        <Field
          label={t("policySettingsCard.approval")}
          htmlFor="settings-approval"
        >
          <select
            id="settings-approval"
            value={draft.extensions.approval}
            disabled={!canWrite}
            onChange={(e) =>
              update({
                ...draft,
                extensions: {
                  ...draft.extensions,
                  approval: e.target
                    .value as PolicySettings["extensions"]["approval"],
                },
              })
            }
          >
            <option value="learner">
              {t("policySettingsCard.approval.learner")}
            </option>
            <option value="learner_and_admin">
              {t("policySettingsCard.approval.learnerAndAdmin")}
            </option>
          </select>
        </Field>
        {number(
          t("policySettingsCard.cooldown"),
          "settings-cooldown",
          draft.extensions.offerCooldownHours,
          (n) =>
            update({
              ...draft,
              extensions: { ...draft.extensions, offerCooldownHours: n },
            }),
        )}
        {number(
          t("policySettingsCard.outstanding"),
          "settings-outstanding",
          draft.extensions.maxOutstandingOffersPerScope,
          (n) =>
            update({
              ...draft,
              extensions: {
                ...draft.extensions,
                maxOutstandingOffersPerScope: n,
              },
            }),
        )}
        {number(
          t("policySettingsCard.questions"),
          "settings-questions",
          draft.closedQuestionBudget,
          (n) => update({ ...draft, closedQuestionBudget: n }),
          t("policySettingsCard.questions.hint"),
        )}
        {number(
          t("policySettingsCard.coreMinutes"),
          "settings-core-minutes",
          draft.headroom.core.additionalMinutes,
          (n) =>
            update({
              ...draft,
              headroom: {
                ...draft.headroom,
                core: { ...draft.headroom.core, additionalMinutes: n },
              },
            }),
          t("policySettingsCard.coreMinutes.hint"),
        )}
        {number(
          t("policySettingsCard.finalMinutes"),
          "settings-final-minutes",
          draft.headroom.finalAssessment.additionalMinutes,
          (n) =>
            update({
              ...draft,
              headroom: {
                ...draft.headroom,
                finalAssessment: {
                  ...draft.headroom.finalAssessment,
                  additionalMinutes: n,
                },
              },
            }),
        )}
        <Field
          label={t("policySettingsCard.episodeMinutes")}
          htmlFor="settings-episode-minutes"
          hint={t("policySettingsCard.episodeMinutes.hint")}
        >
          <input
            id="settings-episode-minutes"
            type="number"
            min={1}
            value={text(draft.pacing.minutesPerRequiredEpisode)}
            disabled={!canWrite}
            onChange={(e) =>
              update({
                ...draft,
                pacing: {
                  ...draft.pacing,
                  minutesPerRequiredEpisode: optional(e.target.value),
                },
              })
            }
          />
        </Field>
        <Field
          label={t("policySettingsCard.pace")}
          htmlFor="settings-pace"
          hint={t("policySettingsCard.pace.hint")}
        >
          <input
            id="settings-pace"
            type="number"
            min={1}
            value={text(draft.pacing.studyMinutesPerDay)}
            disabled={!canWrite}
            onChange={(e) =>
              update({
                ...draft,
                pacing: {
                  ...draft.pacing,
                  studyMinutesPerDay: optional(e.target.value),
                },
              })
            }
          />
        </Field>
      </div>
      <AssessmentPolicyFields
        value={draft.assessment}
        canWrite={canWrite}
        onChange={(assessment) => update({ ...draft, assessment })}
      />
      <ExtensionPoolsEditor
        pools={draft.extensionPools}
        ultimateDeadline={draft.extensions.ultimateDeadline}
        canWrite={canWrite}
        coverage={reviewed ? preview.preview?.pools : undefined}
        onChange={(pools, ultimateDeadline) =>
          update({
            ...draft,
            extensionPools: pools,
            extensions: { ...draft.extensions, ultimateDeadline },
          })
        }
      />
      {feasibilityBlock}
      {reviewed &&
        preview.preview &&
        preview.preview.calendar.some((row) => row.transitions.length > 0) && (
          <div className="table-wrap">
            <table aria-label={t("policySettingsCard.dst")}>
              <thead>
                <tr>
                  <th scope="col">{t("policySettingsCard.dst.rule")}</th>
                  <th scope="col">{t("policySettingsCard.dst.localDate")}</th>
                  <th scope="col">{t("policySettingsCard.dst.localTimes")}</th>
                  <th scope="col">{t("policySettingsCard.dst.resolution")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.calendar.flatMap((row) =>
                  row.transitions.map((transition) => (
                    <tr
                      key={`${row.scopeId}:${row.rule}:${transition.transitionAt}`}
                    >
                      <td>
                        {row.rule === "window"
                          ? t("policySettingsCard.dst.window", {
                              days: row.calendarDays,
                              zone: row.timeZone,
                            })
                          : t("policySettingsCard.dst.deadline", {
                              zone: row.timeZone,
                            })}
                      </td>
                      <td>
                        <span dir="ltr">{transition.localDate}</span>
                      </td>
                      <td>
                        {t("policySettingsCard.dst.times", {
                          kind: transition.kind,
                          start: transition.localStart.slice(0, 5),
                          end: transition.localEnd.slice(0, 5),
                        })}
                      </td>
                      <td>
                        {transition.resolution === "rejected"
                          ? t("policySettingsCard.dst.refused")
                          : t("policySettingsCard.dst.resolves", {
                              resolution: transition.resolution,
                            })}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      {reviewed &&
        preview.preview?.calendar.some(
          (row) =>
            row.rejectsSomeStarts || row.rejectedExtensionDays.length > 0,
        ) && (
          <Notice tone="gold">
            {(() => {
              const details = preview.preview.calendar
                .filter((row) => row.rejectedExtensionDays.length > 0)
                .map((row) =>
                  t("policySettingsCard.rejected.row", {
                    days: row.rejectedExtensionDays.join(", "),
                    count: row.rejectedExtensionDays.length,
                    zone: row.timeZone,
                  }),
                )
                .join(" ");
              return details
                ? t("policySettingsCard.rejected.withDetails", { details })
                : t("policySettingsCard.rejected");
            })()}
          </Notice>
        )}
      {changed && (
        <Field label={t("policySettingsCard.reason")} htmlFor="settings-reason">
          <input
            id="settings-reason"
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      {Boolean(flight.error) && <ErrorState error={flight.error} />}
      <div className="action-row">
        {canSave && (
          <Button
            type="button"
            kind="primary"
            reason={blocked || ""}
            disabled={flight.pending || Boolean(blocked)}
            onClick={() =>
              void flight.run(async () => {
                const saved = await client.savePolicySettings!(courseId, {
                  expectedRevision: current.revision,
                  settings: draft,
                  reason: reason.trim(),
                });
                setCurrent(saved);
                setReason("");
                setEditing(false);
                setMessage(
                  saved.message !== undefined
                    ? serverMessageText(i18n, saved.message)
                    : t("policySettingsCard.savedMessage"),
                );
              })
            }
          >
            {t("policySettingsCard.save")}
          </Button>
        )}
        {canCheck && (
          <Button
            type="button"
            disabled={flight.pending || Boolean(reviewed)}
            onClick={() =>
              void flight.run(async () =>
                setPreview(
                  await client.previewPolicySettings!(courseId, draft),
                ),
              )
            }
          >
            {t("policySettingsCard.previewButton")}
          </Button>
        )}
        <Button
          type="button"
          kind="quiet"
          disabled={flight.pending}
          onClick={cancel}
        >
          {t("policySettingsCard.cancel")}
        </Button>
      </div>
    </Card>
  );
}
