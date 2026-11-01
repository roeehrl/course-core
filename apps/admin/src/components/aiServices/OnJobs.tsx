import { useEffect, useRef, useState } from "react";
import {
  AiServicesError,
  type ActiveCheck,
  type ActiveRole,
  type Job,
  type QualityCheck,
} from "../../domain/aiServices";
import type { SectionProps } from "./AiServicesPage";
import {
  Confirm,
  Ltr,
  Message,
  errorText,
  jobName,
  useAiText,
  useRequestKeys,
  type AiKey,
} from "./shared";
import {
  CheckProgress,
  CheckResult,
  POLL_MS,
  blockedText,
  isJobCheck,
} from "./CheckSection";

type Props = SectionProps & {
  /** The jobs of the active setup. */
  active: ActiveRole[];
  /** Jobs that are on without a passing check or approval for the current checks. */
  needing: ActiveCheck[];
  /** The latest check of any kind (null: none yet). */
  latest: QualityCheck | null;
  /** The id of a check the open draft's part of the section already shows, not repeated here. */
  shownAbove: string | null;
  /** The service the jobs that are on use, for key messages. */
  service: string;
};

/**
 * "Jobs that are on", read top to bottom: one card per job (its model, how it stands — checked on
 * a date, approved without checking, didn't pass the latest check, needs a new check — and "Run
 * check" and "Turn off"), then "Check all jobs that are on" with its cost, then the latest check:
 * its progress while it runs, and once it ends its result, cost, date and the details of each
 * conversation. The latest check shows here on every visit, not only right after a run. A check
 * never turns a job off by itself: when one fails, the result says the job is still on and offers
 * to turn it off. Turning a job off asks first, in plain words.
 */
export function OnJobs(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, active, needing, service } = props;
  const quality = data.quality;
  const keys = useRequestKeys();
  const [check, setCheck] = useState<QualityCheck | null>(props.latest);
  const [starting, setStarting] = useState<Job | "all" | null>(null);
  const [message, setMessage] = useState<{
    scope: Job | "all";
    text: string;
  }>();
  const [confirming, setConfirming] = useState<Job | null>(null);
  const [turning, setTurning] = useState(false);
  const [turnedOff, setTurnedOff] = useState<Job | null>(null);
  const [turnError, setTurnError] = useState<{ role: Job; text: string }>();
  // The page's status names the latest check; a reload (after a check ends, or anything else)
  // brings its newest state.
  useEffect(() => setCheck(props.latest), [props.latest]);
  const shown = check && check.id !== props.shownAbove ? check : null;
  const running = shown?.state === "running";
  const checkId = shown?.id;
  const changed = useRef(reload);
  changed.current = reload;
  // Poll a running check (as the draft's check does); once it ends, reload the page data, which
  // names it as the latest check with its result.
  useEffect(() => {
    if (!running || !checkId) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      port
        .qualityCheck(workspaceId, checkId, controller.signal)
        .then((next) => {
          setCheck(next);
          if (next.state !== "running") void changed.current();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [running, checkId, port, workspaceId]);

  const canTurnOff = !!port.turnOff;
  const isRunning = (blocked: { code: string } | null | undefined) =>
    blocked?.code === "PROVIDER_QUALITY_CHECK_RUNNING";
  const blockedFor = <B extends { code: string }>(
    blocked: B | null | undefined,
  ): B | null => (blocked && !isRunning(blocked) ? blocked : null);
  // What checking one job alone runs: every job that is on and the check covers (`onRoles`), or,
  // from an older server, the flagged ones (`activeRoles`).
  const planOf = (role: Job) =>
    quality?.onRoles.find((r) => r.role === role) ??
    quality?.activeRoles.find((r) => r.role === role);
  // What checking all of them runs; an older server names it as the active target.
  const all =
    quality?.onAll ??
    (quality?.target === "active"
      ? {
          conversations: quality.conversations,
          estimateMicroUsd: quality.estimateMicroUsd,
          reserveMicroUsd: quality.reserveMicroUsd,
          blocked: quality.blocked,
        }
      : null);
  const checkable = active.filter((r) => !!planOf(r.role)).length;
  const showAll = !!all && checkable > 1;
  const allBlocked = blockedFor(all?.blocked);
  const anyRunning =
    running ||
    isRunning(quality?.blocked) ||
    isRunning(all?.blocked) ||
    active.some((r) => isRunning(planOf(r.role)?.blocked));

  async function start(scope: Job | "all") {
    setMessage(undefined);
    setStarting(scope);
    const request =
      scope === "all"
        ? { target: "active" as const }
        : { target: "active" as const, role: scope };
    try {
      const started = await port.startQualityCheck(workspaceId, {
        ...request,
        idempotencyKey: keys.key(request),
      });
      keys.settle();
      setCheck(started);
    } catch (error) {
      keys.settle(error);
      setMessage({
        scope,
        text:
          error instanceof AiServicesError
            ? blockedText(text, error.code, error.details)
            : t("aiServices.err.generic"),
      });
    } finally {
      setStarting(null);
    }
  }
  async function turnOff(role: Job) {
    if (!port.turnOff) return;
    setTurnError(undefined);
    setTurning(true);
    const request = { expectedRevision: data.setup.revision, role };
    try {
      await port.turnOff(workspaceId, {
        ...request,
        idempotencyKey: keys.key(request),
      });
      keys.settle();
      setTurnedOff(role);
      setConfirming(null);
      await reload();
    } catch (error) {
      keys.settle(error);
      setConfirming(null);
      setTurnError({ role, text: errorText(text, error) });
    } finally {
      setTurning(false);
    }
  }

  /** The result of a finished check, and for each job it failed that is still on, "Turn off". */
  function result(value: QualityCheck) {
    const failedOn = value.outcome.filter(
      (o) => !o.passed && active.some((r) => r.role === o.role),
    );
    return (
      <CheckResult
        check={value}
        service={service}
        source={{ port, workspaceId }}
        actions={
          failedOn.length > 0 && (
            <Message tone="warn">
              {t("aiServices.check.on.failedStillOn", {
                count: failedOn.length,
              })}
              {canTurnOff && (
                <span className="ai-actions">
                  {failedOn.map((o) => (
                    <button
                      key={o.role}
                      type="button"
                      className="button secondary"
                      disabled={turning}
                      onClick={() => setConfirming(o.role)}
                    >
                      {t("aiServices.check.on.turnOffFor", {
                        job: jobName(t, o.role),
                      })}
                    </button>
                  ))}
                </span>
              )}
            </Message>
          )
        }
      />
    );
  }
  const when = shown?.finishedAt ?? shown?.createdAt ?? null;

  return (
    <div className="ai-on-jobs">
      {turnedOff && !active.some((r) => r.role === turnedOff) && (
        <Message tone="ok">
          {t("aiServices.check.on.turnedOff", {
            job: jobName(t, turnedOff),
          })}
        </Message>
      )}
      {active.length ? (
        <ul
          className="ai-role-checks"
          aria-label={t("aiServices.check.onTitle")}
        >
          {active.map((role) => {
            const job = jobName(t, role.role);
            const state = data.evals?.roles.find((r) => r.role === role.role);
            const flagged = needing.some((r) => r.role === role.role);
            const plan = planOf(role.role);
            const blocked = blockedFor(plan?.blocked);
            const runnable = !!plan && state?.status !== "not_covered";
            return (
              <li
                key={role.role}
                className="ai-role-check"
                data-role={role.role}
              >
                <div className="ai-role-check-head">
                  <strong>{job}</strong>
                  {state?.status === "passed" ? (
                    <span className="ai-pill ok">
                      {t("aiServices.check.state.passed")}
                    </span>
                  ) : state?.status === "override" ? (
                    <span className="ai-pill warn">
                      {t("aiServices.check.state.override")}
                    </span>
                  ) : state && flagged ? (
                    <span
                      className={`ai-pill ${state.status === "failed" ? "bad" : "warn"}`}
                    >
                      {t(
                        state.status === "not_covered"
                          ? "aiServices.check.flag.needsApproval"
                          : "aiServices.check.flag.needsCheck",
                      )}
                    </span>
                  ) : null}
                </div>
                <p>
                  <Ltr className="mono">{role.remoteModel ?? role.modelId}</Ltr>
                </p>
                {state && (
                  <p className="ai-muted">
                    {state.status === "passed" && state.evaluatedAt
                      ? t("aiServices.check.on.checkedOn", {
                          date: text.date(state.evaluatedAt),
                        })
                      : state.status === "override" && state.overriddenAt
                        ? t("aiServices.check.on.approvedOn", {
                            date: text.date(state.overriddenAt),
                          })
                        : t(`aiServices.check.state.${state.status}` as AiKey)}
                  </p>
                )}
                {runnable && blocked && (
                  <Message tone="warn">
                    {blockedText(text, blocked.code, blocked)}
                  </Message>
                )}
                {runnable && !blocked && (
                  <p className="ai-muted">
                    {t(
                      plan.judge
                        ? plan.judge.self
                          ? "aiServices.check.flag.estimateJudgedSelf"
                          : "aiServices.check.flag.estimateJudged"
                        : "aiServices.check.flag.estimate",
                      {
                        amount: text.money(plan.estimateMicroUsd ?? 0),
                        count: plan.conversations,
                        model: plan.judge?.remoteModel ?? "",
                      },
                    )}
                  </p>
                )}
                {((runnable && !blocked) || canTurnOff) && (
                  <div className="ai-actions ai-actions-start">
                    {runnable && !blocked && (
                      <button
                        type="button"
                        className="button primary"
                        disabled={starting !== null || anyRunning}
                        aria-label={t("aiServices.check.flag.runFor", { job })}
                        onClick={() => void start(role.role)}
                      >
                        {starting === role.role
                          ? t("aiServices.check.run.starting")
                          : t("aiServices.check.flag.run")}
                      </button>
                    )}
                    {canTurnOff && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={turning}
                        aria-label={t("aiServices.check.on.turnOffFor", {
                          job,
                        })}
                        onClick={() => setConfirming(role.role)}
                      >
                        {t("aiServices.check.on.turnOff")}
                      </button>
                    )}
                  </div>
                )}
                {message?.scope === role.role && (
                  <Message tone="error">{message.text}</Message>
                )}
                {turnError?.role === role.role && (
                  <Message tone="error">{turnError.text}</Message>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ai-muted">{t("aiServices.check.noneOn")}</p>
      )}
      {showAll && (
        <div className="ai-on-all">
          {allBlocked ? (
            <Message tone="warn">
              {blockedText(text, allBlocked.code, allBlocked)}
            </Message>
          ) : (
            <>
              <p>
                {t("aiServices.check.on.allEstimate", {
                  amount: text.money(all.estimateMicroUsd),
                  count: all.conversations,
                })}
              </p>
              <p className="ai-muted">
                {t("aiServices.check.run.reserve", {
                  amount: text.money(all.reserveMicroUsd),
                })}
              </p>
              <div className="ai-actions ai-actions-start">
                <button
                  type="button"
                  className="button primary"
                  disabled={starting !== null || anyRunning}
                  onClick={() => void start("all")}
                >
                  {starting === "all"
                    ? t("aiServices.check.run.starting")
                    : t("aiServices.check.on.runAll")}
                </button>
              </div>
            </>
          )}
          {message?.scope === "all" && (
            <Message tone="error">{message.text}</Message>
          )}
        </div>
      )}
      {(checkable > 0 || shown) && (
        <p className="ai-muted">{t("aiServices.check.disclaimer")}</p>
      )}
      {shown && (
        <section
          className="ai-latest"
          aria-label={t("aiServices.check.latest.title")}
        >
          <h4>{t("aiServices.check.latest.title")}</h4>
          {running ? (
            <CheckProgress
              check={shown}
              label={
                isJobCheck(shown)
                  ? t("aiServices.check.flag.progressLabel", {
                      job: jobName(t, shown.roles[0]!),
                    })
                  : t("aiServices.check.run.progressLabel")
              }
            />
          ) : (
            <>
              {when && (
                <p className="ai-muted">
                  {t("aiServices.check.on.checkedOn", {
                    date: text.date(when),
                  })}
                </p>
              )}
              {result(shown)}
            </>
          )}
        </section>
      )}
      {confirming && (
        <Confirm
          title={t("aiServices.check.on.turnOffTitle", {
            job: jobName(t, confirming),
          })}
          body={t("aiServices.check.on.turnOffBody")}
          confirm={
            turning
              ? t("aiServices.check.on.turningOff")
              : t("aiServices.check.on.turnOffConfirm")
          }
          pending={turning}
          onConfirm={() => void turnOff(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
