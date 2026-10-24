import { useEffect, useId, useMemo, useState } from "react";
import {
  learnerLimitMode,
  parseUsd,
  usdInput,
  type SectionState,
} from "../../domain/aiServices";
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
import { LearnerSpendPanel } from "./LearnerSpendPanel";

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
    savedMode = learnerLimitMode(budgets),
    used = Number(budgets?.workspace.used_micro_usd ?? 0);
  // "limit": each learner up to `learner`; "unlimited": no limit per learner (an explicit choice).
  const initial = useMemo(
    () => ({
      total: savedTotal ? usdInput(savedTotal) : DEFAULT_TOTAL,
      learner: savedLearner ? usdInput(savedLearner) : DEFAULT_PER_LEARNER,
      mode: (savedMode === "unlimited" ? "unlimited" : "limit") as
        "limit" | "unlimited",
    }),
    [savedTotal, savedLearner, savedMode],
  );
  // Until the operator edits a limit the form shows the saved (or proposed) values. Deriving
  // them, rather than copying them in an effect, keeps an edit typed the moment the section
  // appears: a copy effect still pending then would run after the edit and overwrite it.
  const [edited, setEdited] = useState<typeof initial | null>(null);
  const form = edited ?? initial,
    touched = edited !== null;
  const total = parseUsd(form.total, MAX),
    learner = parseUsd(form.learner, MAX),
    unlimited = form.mode === "unlimited";
  // Changed: there is something to save (the proposed limits count). Unsaved: the operator edited it.
  const learnerChanged = unlimited
    ? savedMode !== "unlimited"
    : savedMode !== "limit" || learner !== savedLearner;
  const changed = total !== savedTotal || learnerChanged;
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
    learnerId = `${base}-learner`,
    modeName = `${base}-mode`;
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
    if (unlimited) {
      // No amount to check: the workspace total is the only ceiling.
    } else if (learner === null)
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
      (!unlimited && learner === null) ||
      !budgets
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
      if (learnerChanged) {
        // No limit per learner lets any learner spend up to the total: it needs consent too.
        const request = unlimited
          ? {
              expectedRevision: budgets.defaultEnrollment.revision,
              scope: "default_enrollment" as const,
              mode: "unlimited" as const,
              paidWorkApproved: true,
            }
          : {
              expectedRevision: budgets.defaultEnrollment.revision,
              scope: "default_enrollment" as const,
              limits: { microUsd: learner! },
              paidWorkApproved: learner! > 0,
            };
        await port.saveBudget(workspaceId, {
          ...request,
          idempotencyKey: keys.key(request),
        });
      }
      keys.settle();
      setEdited(null);
      setMessage({
        tone: "ok",
        text: !total
          ? t("aiServices.spending.savedOff")
          : unlimited
            ? t("aiServices.spending.savedNoLearnerLimit")
            : t("aiServices.spending.saved"),
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
                    setEdited((current) => ({
                      ...(current ?? initial),
                      total,
                    }));
                  }}
                  {...described(totalId, !!savedTotal, totalError)}
                />
              </span>
            </Field>
            <fieldset className="ai-choice ai-learner-choice">
              <legend>{t("aiServices.spending.perLearner")}</legend>
              <label>
                <input
                  type="radio"
                  name={modeName}
                  value="limit"
                  checked={!unlimited}
                  disabled={saving}
                  onChange={() =>
                    setEdited((current) => ({
                      ...(current ?? initial),
                      mode: "limit",
                    }))
                  }
                />
                {t("aiServices.spending.learnerLimitOption")}
              </label>
              {!unlimited && (
                <Field
                  id={learnerId}
                  label={t("aiServices.spending.learnerAmount")}
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
                        setEdited((current) => ({
                          ...(current ?? initial),
                          learner,
                        }));
                      }}
                      {...described(learnerId, true, learnerError)}
                    />
                  </span>
                </Field>
              )}
              <label>
                <input
                  type="radio"
                  name={modeName}
                  value="unlimited"
                  checked={unlimited}
                  disabled={saving}
                  onChange={() =>
                    setEdited((current) => ({
                      ...(current ?? initial),
                      mode: "unlimited",
                    }))
                  }
                />
                {t("aiServices.spending.learnerNoneOption")}
              </label>
              {unlimited && (
                <p className="ai-muted">
                  {total
                    ? t("aiServices.spending.learnerNoneMeans", {
                        total: text.money(total),
                      })
                    : t("aiServices.spending.learnerNoneMeansGeneric")}
                </p>
              )}
            </fieldset>
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
          <p className="ai-muted">
            {unlimited
              ? t("aiServices.spending.consentNoLearnerLimit")
              : t("aiServices.spending.consent")}
          </p>
          {message && <Message tone={message.tone}>{message.text}</Message>}
          <div className="ai-actions">
            <button
              type="submit"
              className="button primary"
              disabled={saving || !changed}
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
      {port.learnerSpend && budgets && (
        <LearnerSpendPanel
          load={port.learnerSpend}
          workspaceId={workspaceId}
          currentLimit={savedMode === "limit" ? savedLearner : null}
          onUse={async (microUsd) => {
            // The same save, consent and receipt as the form above.
            const request = {
              expectedRevision: budgets.defaultEnrollment.revision,
              scope: "default_enrollment" as const,
              limits: { microUsd },
              paidWorkApproved: true,
            };
            try {
              await port.saveBudget(workspaceId, {
                ...request,
                idempotencyKey: keys.key(request),
              });
              keys.settle();
            } catch (error) {
              keys.settle(error);
              throw error;
            }
            setEdited(null);
            await reload();
          }}
        />
      )}
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
