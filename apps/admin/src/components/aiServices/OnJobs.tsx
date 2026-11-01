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
import { CheckResult, POLL_MS, blockedText, isJobCheck } from "./CheckSection";

type Props = SectionProps & {
  /** The jobs of the active setup. */
  active: ActiveRole[];
  /** Jobs that are on and flagged above with their own "Run check" (ActiveNeedsCheck). */
  needing: ActiveCheck[];
  /** The flagged list above shows its own "check all of them at once". */
  allAtOnceShown: boolean;
  /** The service the jobs that are on use, for key messages. */
  service: string;
};

/**
 * "Jobs that are on": each job with its model and how it was turned on (passed the check, or
 * approved without checking, and when), and two actions: run the quality check again for that
 * job (or for all of them), and turn it off. A check never turns a job off by itself: when one
 * fails, the result says the job is still on and offers to turn it off. Turning a job off asks
 * first, in plain words, since learners lose that help until it is turned on again.
 */
export function OnJobs(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, active, needing, service } = props;
  const quality = data.quality;
  const latest = quality?.latest ?? null;
  const keys = useRequestKeys();
  const [check, setCheck] = useState<QualityCheck | null>(
    latest?.target === "active" ? latest : null,
  );
  // Checks started here: their result shows here even while the flagged list above is shown.
  const [mine, setMine] = useState<ReadonlySet<string>>(new Set());
  const [starting, setStarting] = useState<Job | "all" | null>(null);
  const [message, setMessage] = useState<{
    scope: Job | "all";
    text: string;
  }>();
  const [confirming, setConfirming] = useState<Job | null>(null);
  const [turning, setTurning] = useState(false);
  const [turnedOff, setTurnedOff] = useState<Job | null>(null);
  const [turnError, setTurnError] = useState<{ role: Job; text: string }>();
  useEffect(() => {
    if (latest?.target === "active") setCheck(latest);
  }, [latest]);
  const running = check?.state === "running";
  const checkId = check?.id;
  const changed = useRef(reload);
  changed.current = reload;
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
  const flagged = (role: string) => needing.some((r) => r.role === role);
  // A finished check shows here once: always when it was started here, otherwise only when the
  // flagged list above (which shows its own results) is not on the page.
  const ended =
    check && !running && (mine.has(check.id) || !needing.length) ? check : null;
  const onAll = quality?.onAll ?? null;
  const showAll =
    !props.allAtOnceShown && !!onAll && (quality?.onRoles.length ?? 0) > 1;
  const anyRunning =
    running || quality?.blocked?.code === "PROVIDER_QUALITY_CHECK_RUNNING";

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
      setMine((current) => new Set(current).add(started.id));
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
  function progress(value: QualityCheck, label: string) {
    return (
      <div role="status" aria-live="polite" className="ai-run-progress">
        <p>
          {t("aiServices.check.run.progress", {
            done: value.completed,
            total: value.total,
          })}
        </p>
        <progress
          max={value.total}
          value={value.completed}
          aria-label={label}
        />
        <p className="ai-muted">{t("aiServices.check.run.canLeave")}</p>
      </div>
    );
  }
  const blockedFor = <B extends { code: string }>(
    blocked: B | null | undefined,
  ): B | null =>
    blocked && blocked.code !== "PROVIDER_QUALITY_CHECK_RUNNING"
      ? blocked
      : null;
  const allBlocked = blockedFor(onAll?.blocked);
  const allCheck =
    check && !isJobCheck(check) && (mine.has(check.id) || !needing.length)
      ? check
      : null;

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
        <ul className="ai-role-checks">
          {active.map((role) => {
            const job = jobName(t, role.role);
            const state = data.evals?.roles.find((r) => r.role === role.role);
            const plan = quality?.onRoles.find((r) => r.role === role.role);
            const own =
              !!check && isJobCheck(check) && check.roles[0] === role.role;
            const blocked = blockedFor(plan?.blocked);
            // Flagged jobs have their own "Run check" in the list above.
            const runnable = !!plan && !flagged(role.role);
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
                  ) : state ? (
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
                {own && running ? (
                  progress(
                    check,
                    t("aiServices.check.flag.progressLabel", { job }),
                  )
                ) : (
                  <>
                    {runnable && !blocked && (
                      <p className="ai-muted">
                        {t("aiServices.check.flag.estimate", {
                          amount: text.money(plan.estimateMicroUsd ?? 0),
                          count: plan.conversations,
                        })}
                      </p>
                    )}
                    {runnable && blocked && (
                      <Message tone="warn">
                        {blockedText(text, blocked.code, blocked)}
                      </Message>
                    )}
                    {(runnable || canTurnOff) && (
                      <div className="ai-actions ai-actions-start">
                        {runnable && !blocked && (
                          <button
                            type="button"
                            className="button primary"
                            disabled={starting !== null || anyRunning}
                            aria-label={t("aiServices.check.on.runFor", {
                              job,
                            })}
                            onClick={() => void start(role.role)}
                          >
                            {starting === role.role
                              ? t("aiServices.check.run.starting")
                              : t("aiServices.check.on.run")}
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
                  </>
                )}
                {own && ended && result(ended)}
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
      {(showAll || allCheck) && (
        <div className="ai-on-all">
          {allCheck?.state === "running" ? (
            progress(allCheck, t("aiServices.check.run.progressLabel"))
          ) : (
            <>
              {showAll &&
                (allBlocked ? (
                  <Message tone="warn">
                    {blockedText(text, allBlocked.code, allBlocked)}
                  </Message>
                ) : (
                  <>
                    <p>
                      {t("aiServices.check.on.allEstimate", {
                        amount: text.money(onAll.estimateMicroUsd),
                        count: onAll.conversations,
                      })}
                    </p>
                    <p className="ai-muted">
                      {t("aiServices.check.run.reserve", {
                        amount: text.money(onAll.reserveMicroUsd),
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
                ))}
              {allCheck && result(allCheck)}
            </>
          )}
          {message?.scope === "all" && (
            <Message tone="error">{message.text}</Message>
          )}
        </div>
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
