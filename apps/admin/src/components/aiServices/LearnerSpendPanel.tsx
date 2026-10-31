import { useEffect, useId, useState, type ReactNode } from "react";
import {
  lastDays,
  type LearnerSpend,
  type LearnerSpendPort,
} from "../../domain/learnerSpend";
import { Field, Ltr, Message, errorText, jobName, useAiText } from "./shared";

const PAGE_SIZE = 10;
const PERIODS = [7, 30, 90] as const;

/**
 * What learners actually spend on AI, and a per-learner limit suggested from it once there is
 * enough data. Loaded when opened. Learners appear by enrollment, never by name. `onUse` (owners
 * and administrators on a connected server) saves the suggestion as the limit for each learner
 * through the same save and consent as the form above; without it the suggestion is read-only.
 */
export function LearnerSpendPanel({
  load,
  workspaceId,
  onUse,
  currentLimit,
}: {
  load: LearnerSpendPort["learnerSpend"];
  workspaceId: string;
  onUse?: (microUsd: number) => Promise<void>;
  /** The saved limit for each learner, when one is set. */
  currentLimit?: number | null;
}) {
  const text = useAiText();
  const { t } = text;
  const base = useId().replaceAll(":", "");
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<LearnerSpend | "failed">();
  const [using, setUsing] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  }>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setView(undefined);
    load(
      workspaceId,
      { ...lastDays(days), page, pageSize: PAGE_SIZE },
      controller.signal,
    )
      .then(setView)
      .catch(() => {
        if (!controller.signal.aborted) setView("failed");
      });
    return () => controller.abort();
  }, [open, days, page, load, workspaceId]);
  const money = (value: string | number) => (
    <Ltr>{text.money(Number(value))}</Ltr>
  );
  async function use(microUsd: number) {
    if (!onUse) return;
    setUsing(true);
    setMessage(undefined);
    try {
      await onUse(microUsd);
      setMessage({
        tone: "ok",
        text: t("aiServices.learnerSpend.rec.saved", {
          amount: text.money(microUsd),
        }),
      });
    } catch (error) {
      setMessage({ tone: "error", text: errorText(text, error) });
    } finally {
      setUsing(false);
    }
  }
  const data = view && view !== "failed" ? view : null;
  const first = data ? (data.page - 1) * data.pageSize + 1 : 0,
    last = data ? first + data.rows.length - 1 : 0;
  return (
    <details
      className="ai-history ai-learner-spend"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>{t("aiServices.learnerSpend.title")}</summary>
      <div className="ai-form">
        <p className="ai-muted">{t("aiServices.learnerSpend.intro")}</p>
        <Field
          id={`${base}-period`}
          label={t("aiServices.learnerSpend.period")}
        >
          <select
            id={`${base}-period`}
            value={days}
            onChange={(event) => {
              setDays(Number(event.target.value) as (typeof PERIODS)[number]);
              setPage(1);
            }}
          >
            {PERIODS.map((n) => (
              <option key={n} value={n}>
                {t("aiServices.learnerSpend.lastDays", { days: n })}
              </option>
            ))}
          </select>
        </Field>
        {!view && open && (
          <p role="status">{t("aiServices.learnerSpend.loading")}</p>
        )}
        {view === "failed" && (
          <Message tone="error">{t("aiServices.err.unavailable")}</Message>
        )}
        {data && (
          <>
            <Recommendation
              data={data}
              using={using}
              currentLimit={currentLimit ?? null}
              onUse={onUse ? use : undefined}
            />
            {message && <Message tone={message.tone}>{message.text}</Message>}
            {data.learners === 0 ? (
              <p className="ai-muted">{t("aiServices.learnerSpend.empty")}</p>
            ) : (
              <>
                <dl className="ai-totals">
                  <div>
                    <dt>{t("aiServices.learnerSpend.learners")}</dt>
                    <dd>{data.learners}</dd>
                  </div>
                  <div>
                    <dt>{t("aiServices.learnerSpend.learnerDays")}</dt>
                    <dd>{data.learnerDays}</dd>
                  </div>
                  <div>
                    <dt>{t("aiServices.learnerSpend.charged")}</dt>
                    <dd>{money(data.totals.charged)}</dd>
                  </div>
                  <div>
                    <dt>{t("aiServices.learnerSpend.reserved")}</dt>
                    <dd>{money(data.totals.reserved)}</dd>
                  </div>
                  <div>
                    <dt>{t("aiServices.learnerSpend.actual")}</dt>
                    <dd>
                      {money(data.totals.actual)}
                      <span className="ai-muted ai-block">
                        {t("aiServices.learnerSpend.actualKnown", {
                          reconciled: data.totals.reconciledCalls,
                          calls: data.totals.calls,
                        })}
                      </span>
                    </dd>
                  </div>
                </dl>
                <div className="ai-table-wrap">
                  <table>
                    <caption>
                      {t("aiServices.learnerSpend.spreadCaption")}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">
                          {t("aiServices.learnerSpend.measure")}
                        </th>
                        <th scope="col" className="num">
                          {t("aiServices.learnerSpend.median")}
                        </th>
                        <th scope="col" className="num">
                          {t("aiServices.learnerSpend.p90")}
                        </th>
                        <th scope="col" className="num">
                          {t("aiServices.learnerSpend.max")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ["perDay", data.distributions.learnerDay],
                          ["perHour", data.distributions.activeHour],
                          ["perLearner", data.distributions.learnerTotal],
                        ] as const
                      ).map(([label, value]) => (
                        <tr key={label}>
                          <th scope="row">
                            {t(`aiServices.learnerSpend.${label}`)}
                          </th>
                          <td className="num">{money(value.p50)}</td>
                          <td className="num">{money(value.p90)}</td>
                          <td className="num">{money(value.max)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Breakdown
                  caption={t("aiServices.learnerSpend.byJob")}
                  head={t("aiServices.history.job")}
                  rows={data.byRole.map((r) => ({
                    key: r.role,
                    name: jobName(t, r.role),
                    learners: r.learners,
                    calls: r.calls,
                    charged: r.charged,
                  }))}
                />
                <Breakdown
                  caption={t("aiServices.learnerSpend.byLesson")}
                  head={t("aiServices.learnerSpend.lesson")}
                  rows={data.byLesson.map((r) => ({
                    key: r.episodeId ?? "",
                    name: r.episodeId ? (
                      <Ltr>{r.episodeId}</Ltr>
                    ) : (
                      t("aiServices.learnerSpend.noLesson")
                    ),
                    learners: r.learners,
                    calls: r.calls,
                    charged: r.charged,
                  }))}
                />
                <h3 className="ai-subtitle">
                  {t("aiServices.learnerSpend.listTitle")}
                </h3>
                <ul className="ai-learner-list">
                  {data.rows.map((row) => (
                    <li key={row.enrollmentId}>
                      <details>
                        <summary>
                          {t("aiServices.learnerSpend.learnerSummary", {
                            learner: row.enrollmentId.slice(0, 8),
                            course: row.courseKey,
                            amount: text.money(Number(row.charged)),
                            days: row.activeDays,
                          })}
                        </summary>
                        <dl className="ai-totals">
                          <div>
                            <dt>{t("aiServices.learnerSpend.typicalDay")}</dt>
                            <dd>{money(row.perDay.p50)}</dd>
                          </div>
                          <div>
                            <dt>{t("aiServices.learnerSpend.highestDay")}</dt>
                            <dd>{money(row.perDay.max)}</dd>
                          </div>
                          <div>
                            <dt>{t("aiServices.learnerSpend.activeHours")}</dt>
                            <dd>{row.activeHours}</dd>
                          </div>
                          <div>
                            <dt>{t("aiServices.learnerSpend.actual")}</dt>
                            <dd>
                              {money(row.actual)}
                              <span className="ai-muted ai-block">
                                {t("aiServices.learnerSpend.actualKnown", {
                                  reconciled: row.reconciledCalls,
                                  calls: row.calls,
                                })}
                              </span>
                            </dd>
                          </div>
                        </dl>
                        <Breakdown
                          caption={t("aiServices.learnerSpend.byJob")}
                          head={t("aiServices.history.job")}
                          rows={row.byRole.map((r) => ({
                            key: r.role,
                            name: jobName(t, r.role),
                            calls: r.calls,
                            charged: r.charged,
                          }))}
                        />
                        <Breakdown
                          caption={t("aiServices.learnerSpend.byLesson")}
                          head={t("aiServices.learnerSpend.lesson")}
                          rows={row.byLesson.map((r) => ({
                            key: r.episodeId ?? "",
                            name: r.episodeId ? (
                              <Ltr>{r.episodeId}</Ltr>
                            ) : (
                              t("aiServices.learnerSpend.noLesson")
                            ),
                            calls: r.calls,
                            charged: r.charged,
                          }))}
                        />
                        <Breakdown
                          caption={t("aiServices.learnerSpend.byDay")}
                          head={t("aiServices.learnerSpend.day")}
                          rows={row.byDay.map((r) => ({
                            key: r.day,
                            name: <Ltr>{r.day}</Ltr>,
                            calls: r.calls,
                            charged: r.charged,
                          }))}
                        />
                      </details>
                    </li>
                  ))}
                </ul>
                <nav
                  className="ai-actions"
                  aria-label={t("aiServices.learnerSpend.pages")}
                >
                  <span role="status">
                    {t("aiServices.learnerSpend.pageStatus", {
                      first,
                      last,
                      total: data.totalLearners,
                    })}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={data.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    {t("aiServices.learnerSpend.previous")}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={last >= data.totalLearners}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t("aiServices.learnerSpend.next")}
                  </button>
                </nav>
              </>
            )}
            <p className="ai-muted">{t("aiServices.learnerSpend.note")}</p>
          </>
        )}
      </div>
    </details>
  );
}

function Recommendation({
  data,
  using,
  currentLimit,
  onUse,
}: {
  data: LearnerSpend;
  using: boolean;
  currentLimit: number | null;
  onUse?: (microUsd: number) => void;
}) {
  const text = useAiText();
  const { t } = text;
  const r = data.recommendation;
  return (
    <section className="ai-recommendation" aria-labelledby="ai-rec-title">
      <h3 id="ai-rec-title" className="ai-subtitle">
        {t("aiServices.learnerSpend.rec.title")}
      </h3>
      {r.status === "not_enough_data" ? (
        <p>
          {t("aiServices.learnerSpend.rec.notEnough", {
            learners: r.learners,
            days: r.learnerDays,
            minLearners: r.minimumLearners,
            minDays: r.minimumLearnerDays,
          })}
        </p>
      ) : (
        <>
          <p className="ai-rec-amount">
            <Ltr>{text.money(r.microUsd)}</Ltr>{" "}
            {t("aiServices.learnerSpend.rec.perLearner")}
          </p>
          <p>
            {t("aiServices.learnerSpend.rec.why", {
              windowDays: r.basis.windowDays,
              p90: text.money(r.basis.p90LearnerTotalMicroUsd),
              margin: Math.round((r.basis.margin - 1) * 100),
              amount: text.money(r.microUsd),
            })}
          </p>
          {r.basis.cappedAtWorkspaceTotal && (
            <p>
              {t("aiServices.learnerSpend.rec.capped", {
                amount: text.money(r.microUsd),
              })}
            </p>
          )}
          <p className="ai-muted">
            {t("aiServices.learnerSpend.rec.daily", {
              p90Day: text.money(r.basis.p90LearnerDayMicroUsd),
              daily: text.money(r.dailyMicroUsd),
            })}
          </p>
          {onUse &&
            (currentLimit === r.microUsd ? (
              <p className="ai-muted">
                {t("aiServices.learnerSpend.rec.current")}
              </p>
            ) : (
              <>
                <p className="ai-muted">
                  {t("aiServices.learnerSpend.rec.consent")}
                </p>
                <div className="ai-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={using}
                    onClick={() => onUse(r.microUsd)}
                  >
                    {using
                      ? t("aiServices.spending.saving")
                      : t("aiServices.learnerSpend.rec.use", {
                          amount: text.money(r.microUsd),
                        })}
                  </button>
                </div>
              </>
            ))}
        </>
      )}
    </section>
  );
}

function Breakdown({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string;
  rows: {
    key: string;
    name: ReactNode;
    learners?: number;
    calls: number;
    charged: string;
  }[];
}) {
  const text = useAiText();
  const { t } = text;
  if (!rows.length) return null;
  const withLearners = rows.some((r) => r.learners !== undefined);
  return (
    <div className="ai-table-wrap">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{head}</th>
            {withLearners && (
              <th scope="col" className="num">
                {t("aiServices.learnerSpend.learnersCol")}
              </th>
            )}
            <th scope="col" className="num">
              {t("aiServices.history.calls")}
            </th>
            <th scope="col" className="num">
              {t("aiServices.history.charged")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.name}</th>
              {withLearners && <td className="num">{row.learners}</td>}
              <td className="num">{row.calls}</td>
              <td className="num">
                <Ltr>{text.money(Number(row.charged))}</Ltr>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
