import { useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type { LearningPolicy } from "../domain/policy";
import type { CohortPreview, CohortResult } from "../domain/policyLedger";
import { useSingleFlight } from "./LedgerActionDialog";
import { Button, Dialog, ErrorState, Field, Notice, when } from "./ui";

/** A reviewed policy change for every active learner of this course. The server previews
 * each enrollment, names every grant the change would shorten, and applies nothing until
 * each shortened grant is acknowledged and no enrollment changed since the preview. */
export function CohortMigrationDialog({
  client,
  courseId,
  policy,
  onClose,
  onApplied,
}: {
  client: AdminClient;
  courseId: string;
  policy: LearningPolicy;
  onClose: () => void;
  onApplied: (result: CohortResult) => void;
}) {
  const [scopeId, setScopeId] = useState(
    policy.scopes.find((s) => s.parentScopeId === null)?.scopeId ??
      policy.scopes[0]!.scopeId,
  );
  const [deadline, setDeadline] = useState("");
  const [preview, setPreview] = useState<CohortPreview>();
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const flight = useSingleFlight();
  const label = (id: string) =>
    policy.scopes.find((s) => s.scopeId === id)?.label ?? id;
  const reset = () => {
    setPreview(undefined);
    setAcknowledged([]);
  };
  const instant = deadline ? new Date(`${deadline}:00Z`).toISOString() : "";
  const allAcknowledged =
    preview !== undefined &&
    preview.shortenedGrantIds.every((id) => acknowledged.includes(id));
  return (
    <Dialog
      title="Change a deadline for all learners"
      onClose={onClose}
      pending={flight.pending}
      eyebrow="Cohort-wide policy migration"
    >
      <Notice tone="gold">
        Existing anchors, pools, grants and ledger history are preserved. Time
        already promised by a grant is never shortened silently: each affected
        grant must be acknowledged.
      </Notice>
      <Field label="Scope" htmlFor="cohort-scope">
        <select
          id="cohort-scope"
          value={scopeId}
          onChange={(e) => {
            setScopeId(e.target.value);
            reset();
          }}
        >
          {policy.scopes
            .filter((s) => s.kind !== "episode")
            .map((s) => (
              <option key={s.scopeId} value={s.scopeId}>
                {s.label}
              </option>
            ))}
        </select>
      </Field>
      <Field label="New absolute deadline (UTC)" htmlFor="cohort-deadline">
        <input
          id="cohort-deadline"
          type="datetime-local"
          value={deadline}
          onChange={(e) => {
            setDeadline(e.target.value);
            reset();
          }}
        />
      </Field>
      {Boolean(flight.error) && <ErrorState error={flight.error} />}
      <Button
        disabled={flight.pending || !instant}
        onClick={() =>
          void flight.run(async () =>
            setPreview(
              await client.previewCohortMigration!(courseId, {
                scopeId,
                hardDeadline: instant,
              }),
            ),
          )
        }
      >
        Preview every enrollment
      </Button>
      {preview && (
        <div className="stack">
          <h3>
            Impact on {preview.enrollments.length} active enrollment
            {preview.enrollments.length === 1 ? "" : "s"}
          </h3>
          <small className="mono">
            {preview.previewDigest} · expires {when(preview.expiresAt)}
          </small>
          <ul>
            {preview.enrollments.map((entry) => (
              <li key={entry.enrollmentId}>
                <strong>{entry.displayName}</strong>:{" "}
                {entry.impacts.length
                  ? entry.impacts
                      .map(
                        (i) =>
                          `${label(i.scopeId)} ${i.effectiveDeadlineBefore ? when(i.effectiveDeadlineBefore) : "none"} → ${i.effectiveDeadlineAfter ? when(i.effectiveDeadlineAfter) : "none"}`,
                      )
                      .join("; ")
                  : "no effective deadline changes"}
              </li>
            ))}
            {preview.refused.map((entry) => (
              <li key={entry.enrollmentId}>
                Not changed ({entry.code.replaceAll("_", " ").toLowerCase()}):{" "}
                {entry.enrollmentId}
              </li>
            ))}
          </ul>
          {preview.shortenedGrantIds.length > 0 && (
            <fieldset className="stack">
              <legend>Grants this change shortens</legend>
              {preview.enrollments.flatMap((entry) =>
                entry.shortenedGrants.map((grant) => (
                  <label key={grant.entryId} className="check-label">
                    <input
                      type="checkbox"
                      checked={acknowledged.includes(grant.entryId)}
                      onChange={(e) =>
                        setAcknowledged(
                          e.target.checked
                            ? [...acknowledged, grant.entryId]
                            : acknowledged.filter((id) => id !== grant.entryId),
                        )
                      }
                    />
                    <span>
                      I acknowledge that {entry.displayName}'s{" "}
                      {grant.kind.replaceAll("_", " ")} ends{" "}
                      {when(grant.effectiveDeadlineAfter)} instead of{" "}
                      {when(grant.effectiveDeadlineBefore)}.
                    </span>
                  </label>
                )),
              )}
            </fieldset>
          )}
          <Field label="Reason for this change" htmlFor="cohort-reason">
            <input
              id="cohort-reason"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button
            kind="primary"
            disabled={flight.pending || !reason.trim() || !allAcknowledged}
            onClick={() =>
              void flight.run(async () => {
                onApplied(
                  await client.applyCohortMigration!(courseId, {
                    migrationId: preview.migrationId,
                    previewDigest: preview.previewDigest,
                    reason: reason.trim(),
                    acknowledgedShortenedGrantIds: acknowledged,
                  }),
                );
                onClose();
              })
            }
          >
            Apply to all previewed learners
          </Button>
        </div>
      )}
    </Dialog>
  );
}
