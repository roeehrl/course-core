import { useState } from "react";
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
  Loading,
  Notice,
  when,
} from "./ui";

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
}: {
  client: AdminClient;
  courseId: string;
  canWrite: boolean;
}) {
  const remote = useRemote(
    (signal) => client.getPolicySettings!(courseId, signal),
    [client, courseId],
  );
  return (
    <Card title="Course policy settings" eyebrow="For new enrollments">
      {remote.loading ? (
        <Loading label="Loading course policy settings…" />
      ) : remote.error ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        remote.data && (
          <SettingsForm
            key={remote.data.revision}
            view={remote.data}
            client={client}
            courseId={courseId}
            canWrite={canWrite}
          />
        )
      )}
    </Card>
  );
}

function SettingsForm({
  view,
  client,
  courseId,
  canWrite,
}: {
  view: PolicySettingsView;
  client: AdminClient;
  courseId: string;
  canWrite: boolean;
}) {
  const [draft, setDraft] = useState<PolicySettings>(
    structuredClone(view.settings),
  );
  const [current, setCurrent] = useState(view);
  const [preview, setPreview] = useState<PolicySettingsView | undefined>(
    view.preview ? view : undefined,
  );
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const flight = useSingleFlight();
  const update = (next: PolicySettings) => {
    setDraft(next);
    setPreview(undefined);
    setMessage("");
  };
  const reviewed =
    preview &&
    JSON.stringify(preview.preview?.settings) === JSON.stringify(draft);
  const feasibility = reviewed ? preview.preview?.feasibility : undefined;
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
  return (
    <div className="stack">
      <div className="tag-row">
        <Badge tone={current.source === "configured" ? "blue" : "gold"}>
          {current.source === "configured"
            ? `Revision ${current.revision}`
            : "Documented defaults"}
        </Badge>
        {current.changedAt && <small>Saved {when(current.changedAt)}</small>}
      </div>
      <Notice tone="blue">
        These settings apply to new enrollments. Existing learners keep the
        terms they started with; change those with a reviewed policy migration.
      </Notice>
      <div className="input-grid">
        <Field
          label="Deadline time zone (IANA)"
          htmlFor="settings-zone"
          hint="Used for absolute deadlines when no window names a zone."
        >
          <input
            id="settings-zone"
            value={draft.timeZone}
            disabled={!canWrite}
            onChange={(e) => update({ ...draft, timeZone: e.target.value })}
          />
        </Field>
        <Field
          label="Hard-deadline daylight-saving resolution"
          htmlFor="settings-hard-disambiguation"
          hint="Refusing is the default: a hard deadline never silently lands on a shifted local time."
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
            <option value="reject">Refuse; require an explicit choice</option>
            <option value="compatible">
              Compatible (later in a gap, earlier in an overlap)
            </option>
            <option value="earlier">Always the earlier time</option>
            <option value="later">Always the later time</option>
          </select>
        </Field>
        <Field
          label="Window daylight-saving resolution"
          htmlFor="settings-disambiguation"
          hint="How a relative window ending on a skipped or repeated local time resolves."
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
              Compatible (later in a gap, earlier in an overlap)
            </option>
            <option value="earlier">Always the earlier time</option>
            <option value="later">Always the later time</option>
            <option value="reject">Refuse; require an explicit choice</option>
          </select>
        </Field>
        <Field label="Extension approval" htmlFor="settings-approval">
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
            <option value="learner">Learner acceptance</option>
            <option value="learner_and_admin">
              Learner acceptance and administrator approval
            </option>
          </select>
        </Field>
        {number(
          "Offer cooldown (hours)",
          "settings-cooldown",
          draft.extensions.offerCooldownHours,
          (n) =>
            update({
              ...draft,
              extensions: { ...draft.extensions, offerCooldownHours: n },
            }),
        )}
        {number(
          "Outstanding offers per scope",
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
          "Closed-course question budget",
          "settings-questions",
          draft.closedQuestionBudget,
          (n) => update({ ...draft, closedQuestionBudget: n }),
          "Explanatory questions allowed after an enrollment closes.",
        )}
        {number(
          "Core headroom (minutes)",
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
          "Reserved before enrichment.",
        )}
        {number(
          "Final-assessment headroom (minutes)",
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
          label="Estimated minutes per required episode"
          htmlFor="settings-episode-minutes"
          hint="Optional. Enables the time-fit check."
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
          label="Study minutes per day"
          htmlFor="settings-pace"
          hint="Optional declared pace."
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
      {Boolean(flight.error) && <ErrorState error={flight.error} />}
      {message && <Notice tone="green">{message}</Notice>}
      {canWrite && client.previewPolicySettings && (
        <Button
          disabled={flight.pending}
          onClick={() =>
            void flight.run(async () =>
              setPreview(await client.previewPolicySettings!(courseId, draft)),
            )
          }
        >
          Preview feasibility and daylight saving
        </Button>
      )}
      {feasibility && (
        <div
          className="stack"
          aria-label="Feasibility for a learner enrolling now"
        >
          <h3>Feasibility for a learner enrolling now</h3>
          <Notice tone={feasibility.feasible ? "green" : "red"}>
            {feasibility.feasible
              ? "The required core path and final assessment fit."
              : "The required core path does not fit this envelope."}{" "}
            Mastery criteria are unchanged.
          </Notice>
          {feasibility.issues.length > 0 && (
            <ul>
              {feasibility.issues.map((issue, index) => (
                <li key={index}>
                  <Badge tone={issue.severity === "error" ? "red" : "gold"}>
                    {issue.severity}
                  </Badge>{" "}
                  {issue.message}
                  {issue.neededMinutes !== undefined &&
                    ` Needs ${issue.neededMinutes} minutes; ${issue.availableMinutes} available.`}
                </li>
              ))}
            </ul>
          )}
          {feasibility.alternatives.length > 0 && (
            <p>
              Alternatives:{" "}
              {feasibility.alternatives
                .map((a) => a.replaceAll("_", " "))
                .join("; ")}
              .
            </p>
          )}
        </div>
      )}
      {reviewed &&
        preview.preview &&
        preview.preview.calendar.some((row) => row.transitions.length > 0) && (
          <div className="table-wrap">
            <table aria-label="Daylight-saving effects">
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Local date</th>
                  <th scope="col">Local times</th>
                  <th scope="col">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.calendar.flatMap((row) =>
                  row.transitions.map((t) => (
                    <tr key={`${row.scopeId}:${row.rule}:${t.transitionAt}`}>
                      <td>
                        {row.rule === "window"
                          ? `${row.calendarDays}-day window (${row.timeZone})`
                          : `Deadline (${row.timeZone})`}
                      </td>
                      <td>{t.localDate}</td>
                      <td>
                        {t.kind === "gap" ? "skipped" : "repeated"}{" "}
                        {t.localStart.slice(0, 5)}–{t.localEnd.slice(0, 5)}
                      </td>
                      <td>
                        {t.resolution === "rejected"
                          ? "Refused"
                          : `Resolves ${t.resolution}`}
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
            Some enrollment starts or extensions would be refused at these times
            {preview.preview.calendar
              .filter((row) => row.rejectedExtensionDays.length > 0)
              .map(
                (row) =>
                  ` (deadline extensions of ${row.rejectedExtensionDays.join(", ")} day${row.rejectedExtensionDays.length === 1 ? "" : "s"} in ${row.timeZone})`,
              )
              .join("")}
            . Choose another resolution to avoid that.
          </Notice>
        )}
      {canWrite && client.savePolicySettings && reviewed && (
        <div className="stack">
          <Field label="Reason for this change" htmlFor="settings-reason">
            <input
              id="settings-reason"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button
            kind="primary"
            disabled={flight.pending || !reason.trim()}
            onClick={() =>
              void flight.run(async () => {
                const saved = await client.savePolicySettings!(courseId, {
                  expectedRevision: current.revision,
                  settings: draft,
                  reason: reason.trim(),
                });
                setCurrent(saved);
                setReason("");
                setMessage(saved.message ?? "Policy settings saved.");
              })
            }
          >
            Save settings for new enrollments
          </Button>
        </div>
      )}
    </div>
  );
}
