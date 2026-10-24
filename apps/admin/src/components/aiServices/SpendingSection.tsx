import { useEffect, useId, useMemo, useState } from "react";
import { parseUsd, usdInput, type SectionState } from "../../domain/aiServices";
import type { SpendView } from "../../domain/providerCosts";
import type { SectionProps } from "./AiServicesPage";
import {
  ErrorSummary,
  Field,
  Ltr,
  Message,
  jobName,
  Section,
  described,
  errorText,
  useRequestKeys,
  serviceName,
  sectionAnchor,
  useAiText,
  type FieldError,
} from "./shared";
import { ChangedElsewhere } from "../ChangedElsewhere";
import { useEditableSnapshot } from "../../hooks/useEditableSnapshot";

type Props = SectionProps & { state: SectionState; unsaved: boolean };
/** Proposed when nothing is set yet (the operator's decision): $25 in total, $2 per learner. */
export const DEFAULT_TOTAL = "25.00";
export const DEFAULT_PER_LEARNER = "2.00";
const MAX = 1000_000_000;

export function SpendingSection(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, onDirty } = props;
  const base = useId().replaceAll(":", "");
  const budgets = data.budgets;
  const savedTotal = Number(budgets?.workspace.limit_micro_usd ?? 0),
    savedLearner = Number(budgets?.defaultEnrollment.limit_micro_usd ?? 0),
    used = Number(budgets?.workspace.used_micro_usd ?? 0);
  const initial = useMemo(
    () => ({
      total: savedTotal ? usdInput(savedTotal) : DEFAULT_TOTAL,
      learner: savedLearner ? usdInput(savedLearner) : DEFAULT_PER_LEARNER,
    }),
    [savedTotal, savedLearner],
  );
  // Until the operator edits a limit the form shows the saved (or proposed) values, derived
  // rather than copied in, so an edit typed the moment the section appears or while the page
  // reloads is kept (see useEditableSnapshot).
  const snapshot = useEditableSnapshot(initial);
  const form = snapshot.value,
    touched = snapshot.edited;
  const total = parseUsd(form.total, MAX),
    learner = parseUsd(form.learner, MAX);
  // Changed: there is something to save (the proposed limits count). Unsaved: the operator edited it.
  const changed =
    total !== savedTotal ||
    learner !== savedLearner ||
    (budgets?.defaultEnrollment.limit_micro_usd ?? null) === null;
  const dirty = touched && changed;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  }>();
  const [saving, setSaving] = useState(false);
  const keys = useRequestKeys();
  const totalId = `${base}-total`,
    learnerId = `${base}-learner`;
  const kinds = [...new Set(data.connections.connections.map((c) => c.kind))];
  const policy = data.setup.jobPolicy;
  async function save() {
    setMessage(undefined);
    const problems: FieldError[] = [];
    if (total === null)
      problems.push({
        field: totalId,
        message: t("aiServices.spending.errAmount"),
      });
    else if (total < used)
      problems.push({
        field: totalId,
        message: t("aiServices.spending.errBelowUsage", {
          used: text.money(used),
        }),
      });
    if (learner === null)
      problems.push({
        field: learnerId,
        message: t("aiServices.spending.errAmount"),
      });
    else if (total !== null && learner > total)
      problems.push({
        field: learnerId,
        message: t("aiServices.spending.errLearnerMore"),
      });
    setErrors(problems);
    if (
      problems.length ||
      total === null ||
      learner === null ||
      !budgets ||
      snapshot.changedElsewhere
    )
      return;
    setSaving(true);
    try {
      if (total !== savedTotal) {
        const request = {
          expectedRevision: budgets.workspace.revision,
          scope: "workspace" as const,
          limits: { microUsd: total },
          paidWorkApproved: total > 0,
        };
        await port.saveBudget(workspaceId, {
          ...request,
          idempotencyKey: keys.key(request),
        });
      }
      if (
        learner !== savedLearner ||
        budgets.defaultEnrollment.limit_micro_usd === null
      ) {
        const request = {
          expectedRevision: budgets.defaultEnrollment.revision,
          scope: "default_enrollment" as const,
          limits: { microUsd: learner },
          paidWorkApproved: learner > 0,
        };
        await port.saveBudget(workspaceId, {
          ...request,
          idempotencyKey: keys.key(request),
        });
      }
      keys.settle();
      snapshot.settle();
      setMessage({
        tone: "ok",
        text: total
          ? t("aiServices.spending.saved")
          : t("aiServices.spending.savedOff"),
      });
      await reload();
    } catch (error) {
      keys.settle(error);
      setMessage({ tone: "error", text: errorText(text, error) });
    } finally {
      setSaving(false);
    }
  }
  const totalError = errors.find((e) => e.field === totalId)?.message,
    learnerError = errors.find((e) => e.field === learnerId)?.message;
  return (
    <Section
      id="spending"
      title={t("aiServices.section.spending")}
      state={props.state}
      unsaved={props.unsaved}
    >
      {!budgets ? (
        <Message tone="error">{t("aiServices.err.unavailable")}</Message>
      ) : (
        <form
          className="ai-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ErrorSummary errors={errors} />
          <div className="ai-grid">
            <Field
              id={totalId}
              label={t("aiServices.spending.total")}
              error={totalError}
              hint={
                savedTotal
                  ? t("aiServices.spending.used", {
                      used: text.money(used),
                      limit: text.money(savedTotal),
                    })
                  : undefined
              }
            >
              <span className="ai-money" dir="ltr">
                <span aria-hidden="true">$</span>
                <input
                  id={totalId}
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.total}
                  disabled={saving}
                  onChange={(event) => {
                    const total = event.target.value;
                    snapshot.set((current) => ({ ...current, total }));
                  }}
                  {...described(totalId, !!savedTotal, totalError)}
                />
              </span>
            </Field>
            <Field
              id={learnerId}
              label={t("aiServices.spending.perLearner")}
              error={learnerError}
              hint={t("aiServices.spending.perLearnerHint")}
            >
              <span className="ai-money" dir="ltr">
                <span aria-hidden="true">$</span>
                <input
                  id={learnerId}
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.learner}
                  disabled={saving}
                  onChange={(event) => {
                    const learner = event.target.value;
                    snapshot.set((current) => ({ ...current, learner }));
                  }}
                  {...described(learnerId, true, learnerError)}
                />
              </span>
            </Field>
          </div>
          <p>
            <strong>{t("aiServices.spending.perRequest")}:</strong>{" "}
            {t("aiServices.spending.perRequestSummary", {
              amount: text.money(policy.allowance.microUsd),
              minutes: Math.max(1, Math.round(policy.durationMs / 60000)),
            })}{" "}
            <a
              href={`#${sectionAnchor("advanced")}`}
              onClick={(event) => {
                event.preventDefault();
                const target = document.getElementById(
                  sectionAnchor("advanced"),
                );
                if (target instanceof HTMLDetailsElement) target.open = true;
                target?.scrollIntoView({ block: "start" });
                target?.querySelector("summary")?.focus();
              }}
            >
              {t("aiServices.spending.change")}
            </a>
          </p>
          <p className="ai-muted">
            {kinds.length === 1
              ? t("aiServices.spending.note", {
                  service: serviceName(t, kinds[0]!),
                })
              : t("aiServices.spending.noteGeneric")}
          </p>
          <p className="ai-muted">{t("aiServices.spending.consent")}</p>
          {message && <Message tone={message.tone}>{message.text}</Message>}
          {snapshot.changedElsewhere && (
            <ChangedElsewhere
              disabled={saving}
              onShowSaved={snapshot.discard}
              onKeep={snapshot.keep}
            />
          )}
          <div className="ai-actions">
            <button
              type="submit"
              className="button primary"
              disabled={saving || !changed || snapshot.changedElsewhere}
            >
              {saving
                ? t("aiServices.spending.saving")
                : total
                  ? t("aiServices.spending.allow", {
                      amount: text.money(total),
                    })
                  : total === 0
                    ? t("aiServices.spending.noSpend")
                    : t("aiServices.spending.allow", { amount: form.total })}
            </button>
          </div>
        </form>
      )}
      <SpendHistory port={port} workspaceId={workspaceId} />
    </Section>
  );
}

/** Spending recorded so far (Course Core's ledger, not an invoice), loaded when opened. */
function SpendHistory({
  port,
  workspaceId,
}: {
  port: Props["port"];
  workspaceId: string;
}) {
  const text = useAiText();
  const { t } = text;
  const base = useId().replaceAll(":", "");
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<"day" | "month">("day");
  const [view, setView] = useState<SpendView | "failed">();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setView(undefined);
    port
      .spend(workspaceId, period, controller.signal)
      .then(setView)
      .catch(() => {
        if (!controller.signal.aborted) setView("failed");
      });
    return () => controller.abort();
  }, [open, period, port, workspaceId]);
  const money = (value: string) => <Ltr>{text.money(Number(value))}</Ltr>;
  return (
    <details
      className="ai-history"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>{t("aiServices.history.title")}</summary>
      {!view && open && <p role="status">{t("aiServices.history.loading")}</p>}
      {view === "failed" && (
        <Message tone="error">{t("aiServices.err.unavailable")}</Message>
      )}
      {view && view !== "failed" && (
        <div className="ai-form">
          <dl className="ai-totals">
            <div>
              <dt>{t("aiServices.history.charged")}</dt>
              <dd>{money(view.totals.charged)}</dd>
            </div>
            <div>
              <dt>{t("aiServices.history.actual")}</dt>
              <dd>{money(view.totals.actual)}</dd>
            </div>
            <div>
              <dt>{t("aiServices.history.held")}</dt>
              <dd>{money(view.totals.held)}</dd>
            </div>
          </dl>
          {view.totals.calls === 0 ? (
            <p className="ai-muted">{t("aiServices.history.empty")}</p>
          ) : (
            <>
              <div className="ai-table-wrap">
                <table>
                  <caption>{t("aiServices.history.byJob")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("aiServices.history.job")}</th>
                      <th scope="col">{t("aiServices.history.calls")}</th>
                      <th scope="col">{t("aiServices.history.charged")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.byRole.map((row) => (
                      <tr key={row.role}>
                        <th scope="row">{jobName(t, row.role)}</th>
                        <td>{row.calls}</td>
                        <td>{money(row.charged)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Field
                id={`${base}-period`}
                label={t("aiServices.history.period")}
              >
                <select
                  id={`${base}-period`}
                  value={period}
                  onChange={(event) =>
                    setPeriod(event.target.value as "day" | "month")
                  }
                >
                  <option value="day">{t("aiServices.history.day")}</option>
                  <option value="month">{t("aiServices.history.month")}</option>
                </select>
              </Field>
              <div className="ai-table-wrap">
                <table>
                  <caption>{t("aiServices.history.byPeriod")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("aiServices.history.when")}</th>
                      <th scope="col">{t("aiServices.history.calls")}</th>
                      <th scope="col">{t("aiServices.history.charged")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.byPeriod.map((row) => (
                      <tr key={row.period}>
                        <th scope="row">
                          <Ltr>{row.period}</Ltr>
                        </th>
                        <td>{row.calls}</td>
                        <td>{money(row.charged)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="ai-muted">{t("aiServices.history.note")}</p>
        </div>
      )}
    </details>
  );
}
