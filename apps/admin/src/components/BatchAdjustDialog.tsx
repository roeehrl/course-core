import { useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import type { ScopePolicy } from "../domain/policy";
import type {
  BatchPreview,
  BatchRequest,
  BatchResult,
} from "../domain/policyLevels";
import { useSingleFlight } from "./LedgerActionDialog";
import { useScopeLabel } from "./scopeLabel";
import { Badge, Button, Dialog, ErrorState, Field, Notice } from "./ui";
import { useFormatters, useI18n, type MessageKey } from "../i18n";
import { learnerName } from "../domain/learnerName";

/** One reviewed accommodation or outage adjustment for several learners at once. The server
 * previews every learner, applies all or nothing, and records the batch with its reason and
 * each learner's own ledger entry. Allowance pools are never touched. */
export function BatchAdjustDialog({
  client,
  courseId,
  enrollments,
  scopes,
  onClose,
  onApplied,
}: {
  client: AdminClient;
  courseId: string;
  enrollments: CourseWorkspace["enrollments"];
  /** The course's levels, from one learner's policy (chapters and episodes are shared). */
  scopes: ScopePolicy[];
  onClose: () => void;
  onApplied: (result: BatchResult) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const scopeNames = useScopeLabel();
  const choices = scopes.filter(
    (s) => s.kind === "course" || s.kind === "chapter" || s.kind === "episode",
  );
  const [scopeId, setScopeId] = useState(
    choices.find((s) => s.kind === "course")?.scopeId ??
      choices[0]?.scopeId ??
      "course",
  );
  const scope = scopes.find((s) => s.scopeId === scopeId);
  const deadlineKind = scope?.window ? "window" : "absolute";
  const [kind, setKind] = useState<BatchRequest["kind"]>("outage");
  const [days, setDays] = useState("1");
  const [minutes, setMinutes] = useState("");
  const [everyone, setEveryone] = useState(true);
  const active = enrollments.filter((e) => e.status === "active");
  const [chosen, setChosen] = useState<string[]>([]);
  const [preview, setPreview] = useState<BatchPreview>();
  const [reason, setReason] = useState("");
  const flight = useSingleFlight();
  const reset = () => setPreview(undefined);
  const count = (value: string) =>
    value.trim() && Number(value) > 0 ? Number(value) : undefined;
  const request = (): BatchRequest => ({
    scopeId,
    kind,
    change: {
      ...(count(days)
        ? { deadline: { kind: deadlineKind, calendarDays: count(days)! } }
        : {}),
      ...(kind === "accommodation" && count(minutes)
        ? { work: { additionalMinutes: count(minutes)! } }
        : {}),
    },
    ...(everyone ? {} : { enrollmentIds: chosen }),
  });
  const ready =
    (count(days) || (kind === "accommodation" && count(minutes))) &&
    (everyone || chosen.length > 0);
  const name = (displayName: string | null) =>
    displayName ?? t("batchAdjustDialog.unnamed");
  const refusal = (code: string) => {
    const key = `batchAdjustDialog.refused.${code}` as MessageKey;
    return i18n.has(key) ? t(key) : t("batchAdjustDialog.refused.other");
  };
  return (
    <Dialog
      title={t("batchAdjustDialog.title")}
      eyebrow={t("batchAdjustDialog.eyebrow")}
      onClose={onClose}
      pending={flight.pending}
    >
      <Notice tone="gold">{t("batchAdjustDialog.notice")}</Notice>
      <fieldset className="segmented">
        <legend>{t("batchAdjustDialog.kind")}</legend>
        {(["outage", "accommodation"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="batch-kind"
              checked={kind === value}
              onChange={() => {
                setKind(value);
                reset();
              }}
            />
            {t(`batchAdjustDialog.kind.${value}` as MessageKey)}
          </label>
        ))}
      </fieldset>
      <Field label={t("batchAdjustDialog.scope")} htmlFor="batch-scope">
        <select
          id="batch-scope"
          value={scopeId}
          onChange={(e) => {
            setScopeId(e.target.value);
            reset();
          }}
        >
          {choices.map((s) => (
            <option key={s.scopeId} value={s.scopeId} dir="auto">
              {scopeNames.name(s, s.scopeId)}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={t("batchAdjustDialog.days")}
        htmlFor="batch-days"
        hint={t("batchAdjustDialog.days.hint")}
      >
        <input
          id="batch-days"
          type="number"
          min={1}
          max={366}
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
            reset();
          }}
        />
      </Field>
      {kind === "accommodation" && (
        <Field label={t("batchAdjustDialog.minutes")} htmlFor="batch-minutes">
          <input
            id="batch-minutes"
            type="number"
            min={1}
            max={100000}
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value);
              reset();
            }}
          />
        </Field>
      )}
      <fieldset className="stack">
        <legend>{t("batchAdjustDialog.who")}</legend>
        <label className="check-label">
          <input
            type="radio"
            name="batch-who"
            checked={everyone}
            onChange={() => {
              setEveryone(true);
              reset();
            }}
          />
          {t("batchAdjustDialog.who.everyone", { count: active.length })}
        </label>
        <label className="check-label">
          <input
            type="radio"
            name="batch-who"
            checked={!everyone}
            onChange={() => {
              setEveryone(false);
              reset();
            }}
          />
          {t("batchAdjustDialog.who.some")}
        </label>
        {!everyone &&
          active.map((enrollment) => (
            <label className="check-label" key={enrollment.id}>
              <input
                type="checkbox"
                checked={chosen.includes(enrollment.id)}
                onChange={() => {
                  setChosen((list) =>
                    list.includes(enrollment.id)
                      ? list.filter((id) => id !== enrollment.id)
                      : [...list, enrollment.id],
                  );
                  reset();
                }}
              />
              <bdi>{learnerName(t, enrollment)}</bdi>
            </label>
          ))}
      </fieldset>
      {Boolean(flight.error) && <ErrorState error={flight.error} />}
      <div>
        <Button
          type="button"
          disabled={flight.pending || !ready}
          onClick={() =>
            void flight.run(async () =>
              setPreview(
                await client.previewAccommodationBatch!(courseId, request()),
              ),
            )
          }
        >
          {t("batchAdjustDialog.preview")}
        </Button>
      </div>
      {preview && (
        <div
          className="stack"
          role="region"
          aria-label={t("batchAdjustDialog.effect")}
        >
          <h3>
            {t("batchAdjustDialog.effect.count", {
              count: preview.enrollments.length,
            })}
          </h3>
          <ul className="stack">
            {preview.enrollments.map((row) => (
              <li key={row.enrollmentId}>
                {i18n.rich(
                  "batchAdjustDialog.effect.row",
                  {
                    name: name(row.displayName),
                    before: row.effectiveDeadlineBefore
                      ? when(row.effectiveDeadlineBefore)
                      : t("batchAdjustDialog.noDate"),
                    after: row.effectiveDeadlineAfter
                      ? when(row.effectiveDeadlineAfter)
                      : t("batchAdjustDialog.noDate"),
                  },
                  {
                    name: (children, key) => <bdi key={key}>{children}</bdi>,
                  },
                )}
              </li>
            ))}
          </ul>
          {preview.refused.length > 0 && (
            <div className="stack">
              <h3>
                {t("batchAdjustDialog.refused", {
                  count: preview.refused.length,
                })}
              </h3>
              <ul>
                {preview.refused.map((row) => (
                  <li key={row.enrollmentId}>
                    <Badge tone="gold">
                      <bdi>{name(row.displayName)}</bdi>
                    </Badge>{" "}
                    {refusal(row.code)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.enrollments.length > 0 && (
            <>
              <Field
                label={t("batchAdjustDialog.reason")}
                htmlFor="batch-reason"
                hint={t("batchAdjustDialog.reason.hint")}
              >
                <input
                  id="batch-reason"
                  dir="auto"
                  maxLength={300}
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
                      const result = await client.applyAccommodationBatch!(
                        courseId,
                        {
                          batchId: preview.batchId,
                          previewDigest: preview.previewDigest,
                          reason: reason.trim(),
                        },
                      );
                      onApplied(result);
                      onClose();
                    })
                  }
                >
                  {t("batchAdjustDialog.apply", {
                    count: preview.enrollments.length,
                  })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
