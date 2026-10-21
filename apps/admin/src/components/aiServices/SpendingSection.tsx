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
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setForm(initial);
  }, [initial, touched]);
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
      problems.push({ field: totalId, message: t("spending.errAmount") });
    else if (total < used)
      problems.push({
        field: totalId,
        message: t("spending.errBelowUsage", {
          used: text.ltr(text.money(used)),
        }),
      });
    if (learner === null)
      problems.push({ field: learnerId, message: t("spending.errAmount") });
    else if (total !== null && learner > total)
      problems.push({
        field: learnerId,
        message: t("spending.errLearnerMore"),
      });
    setErrors(problems);
    if (problems.length || total === null || learner === null || !budgets)
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
      setTouched(false);
      setMessage({
        tone: "ok",
        text: total ? t("spending.saved") : t("spending.savedOff"),
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
      title={t("section.spending")}
      state={props.state}
      unsaved={props.unsaved}
    >
      {!budgets ? (
        <Message tone="error">{t("err.unavailable")}</Message>
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
              label={t("spending.total")}
              error={totalError}
              hint={
                savedTotal
                  ? t("spending.used", {
                      used: text.ltr(text.money(used)),
                      limit: text.ltr(text.money(savedTotal)),
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
                    setTouched(true);
                    setForm({ ...form, total: event.target.value });
                  }}
                  {...described(totalId, !!savedTotal, totalError)}
                />
              </span>
            </Field>
            <Field
              id={learnerId}
              label={t("spending.perLearner")}
              error={learnerError}
              hint={t("spending.perLearnerHint")}
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
                    setTouched(true);
                    setForm({ ...form, learner: event.target.value });
                  }}
                  {...described(learnerId, true, learnerError)}
                />
              </span>
            </Field>
          </div>
          <p>
            <strong>{t("spending.perRequest")}:</strong>{" "}
            {t("spending.perRequestSummary", {
              amount: text.ltr(text.money(policy.allowance.microUsd)),
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
              {t("spending.change")}
            </a>
          </p>
          <p className="ai-muted">
            {kinds.length === 1
              ? t("spending.note", { service: serviceName(t, kinds[0]!) })
              : t("spending.noteGeneric")}
          </p>
          <p className="ai-muted">{t("spending.consent")}</p>
          {message && <Message tone={message.tone}>{message.text}</Message>}
          <div className="ai-actions">
            <button
              type="submit"
              className="button primary"
              disabled={saving || !changed}
            >
              {saving
                ? t("spending.saving")
                : total
                  ? t("spending.allow", { amount: text.ltr(text.money(total)) })
                  : total === 0
                    ? t("spending.noSpend")
                    : t("spending.allow", { amount: form.total })}
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
      <summary>{t("history.title")}</summary>
      {!view && open && <p role="status">{t("history.loading")}</p>}
      {view === "failed" && (
        <Message tone="error">{t("err.unavailable")}</Message>
      )}
      {view && view !== "failed" && (
        <div className="ai-form">
          <dl className="ai-totals">
            <div>
              <dt>{t("history.charged")}</dt>
              <dd>{money(view.totals.charged)}</dd>
            </div>
            <div>
              <dt>{t("history.actual")}</dt>
              <dd>{money(view.totals.actual)}</dd>
            </div>
            <div>
              <dt>{t("history.held")}</dt>
              <dd>{money(view.totals.held)}</dd>
            </div>
          </dl>
          {view.totals.calls === 0 ? (
            <p className="ai-muted">{t("history.empty")}</p>
          ) : (
            <>
              <div className="ai-table-wrap">
                <table>
                  <caption>{t("history.byJob")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("history.job")}</th>
                      <th scope="col">{t("history.calls")}</th>
                      <th scope="col">{t("history.charged")}</th>
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
              <Field id={`${base}-period`} label={t("history.period")}>
                <select
                  id={`${base}-period`}
                  value={period}
                  onChange={(event) =>
                    setPeriod(event.target.value as "day" | "month")
                  }
                >
                  <option value="day">{t("history.day")}</option>
                  <option value="month">{t("history.month")}</option>
                </select>
              </Field>
              <div className="ai-table-wrap">
                <table>
                  <caption>{t("history.byPeriod")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("history.when")}</th>
                      <th scope="col">{t("history.calls")}</th>
                      <th scope="col">{t("history.charged")}</th>
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
          <p className="ai-muted">{t("history.note")}</p>
        </div>
      )}
    </details>
  );
}
