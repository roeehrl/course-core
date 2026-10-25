import { useScopeLabel } from "./scopeLabel";
import { useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type { LearningPolicy } from "../domain/policy";
import type { CohortPreview, CohortResult } from "../domain/policyLedger";
import { useSingleFlight } from "./LedgerActionDialog";
import { Button, Dialog, ErrorState, Field, Notice } from "./ui";
import { useFormatters, useI18n, type MessageKey } from "../i18n";

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
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const deadlineOrNone = (iso: string | null) =>
    iso ? when(iso) : t("cohortMigrationDialog.none");
  const grantKind = (kind: string) => {
    const key = `cohortMigrationDialog.grantKind.${kind}` as MessageKey;
    return i18n.has(key) ? t(key) : kind.replaceAll("_", " ");
  };
  const [scopeId, setScopeId] = useState(
    // The course level by default; the organization level above it is set in its own card.
    policy.scopes.find((s) => s.kind === "course")?.scopeId ??
      policy.scopes.find((s) => s.parentScopeId === null)?.scopeId ??
      policy.scopes[0]!.scopeId,
  );
  const [deadline, setDeadline] = useState("");
  const [preview, setPreview] = useState<CohortPreview>();
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const flight = useSingleFlight();
  const scopeNames = useScopeLabel();
  const label = (id: string) => scopeNames.byId(policy.scopes, id);
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
      title={t("cohortMigrationDialog.title")}
      onClose={onClose}
      pending={flight.pending}
      eyebrow={t("cohortMigrationDialog.eyebrow")}
    >
      <Notice tone="gold">{t("cohortMigrationDialog.notice")}</Notice>
      <Field label={t("cohortMigrationDialog.scope")} htmlFor="cohort-scope">
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
              <option key={s.scopeId} value={s.scopeId} dir="auto">
                {scopeNames.name(s, s.scopeId)}
              </option>
            ))}
        </select>
      </Field>
      <Field
        label={t("cohortMigrationDialog.deadline")}
        htmlFor="cohort-deadline"
      >
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
        {t("cohortMigrationDialog.preview")}
      </Button>
      {preview && (
        <div className="stack">
          <h3>
            {t("cohortMigrationDialog.impact", {
              count: preview.enrollments.length,
            })}
          </h3>
          <small>
            {i18n.rich(
              "cohortMigrationDialog.expires",
              {
                digest: preview.previewDigest,
                date: when(preview.expiresAt),
              },
              {
                id: (children, key) => (
                  <span key={key} className="mono" dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </small>
          <ul>
            {preview.enrollments.map((entry) => (
              <li key={entry.enrollmentId}>
                {i18n.rich(
                  "cohortMigrationDialog.entry",
                  {
                    name: entry.displayName,
                    changes: entry.impacts.length
                      ? entry.impacts
                          .map((i) =>
                            t("cohortMigrationDialog.change", {
                              scope: label(i.scopeId),
                              before: deadlineOrNone(i.effectiveDeadlineBefore),
                              after: deadlineOrNone(i.effectiveDeadlineAfter),
                            }),
                          )
                          .join("; ")
                      : t("cohortMigrationDialog.noChanges"),
                  },
                  {
                    name: (children, key) => (
                      <strong key={key}>{children}</strong>
                    ),
                  },
                )}
              </li>
            ))}
            {preview.refused.map((entry) => (
              <li key={entry.enrollmentId}>
                {t("cohortMigrationDialog.refused", {
                  code: entry.code.replaceAll("_", " ").toLowerCase(),
                  id: entry.enrollmentId,
                })}
              </li>
            ))}
          </ul>
          {preview.shortenedGrantIds.length > 0 && (
            <fieldset className="stack">
              <legend>{t("cohortMigrationDialog.shortened")}</legend>
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
                      {t("cohortMigrationDialog.acknowledge", {
                        name: entry.displayName,
                        kind: grantKind(grant.kind),
                        after: when(grant.effectiveDeadlineAfter),
                        before: when(grant.effectiveDeadlineBefore),
                      })}
                    </span>
                  </label>
                )),
              )}
            </fieldset>
          )}
          <Field
            label={t("cohortMigrationDialog.reason")}
            htmlFor="cohort-reason"
          >
            <input
              id="cohort-reason"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="dialog-footer">
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
              {t("cohortMigrationDialog.apply")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
