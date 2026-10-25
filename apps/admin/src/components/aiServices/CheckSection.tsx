import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AiServicesError,
  activeNeedingCheck,
  activeRoles,
  type ActiveCheck,
  type AiServicesPort,
  type Draft,
  type QualityCheck,
  type QualityStatus,
  type SectionState,
} from "../../domain/aiServices";
import type { SectionProps } from "./AiServicesPage";
import {
  ErrorSummary,
  Field,
  Ltr,
  Message,
  Section,
  described,
  errorText,
  jobName,
  keyProblemText,
  serviceName,
  useRequestKeys,
  useAiText,
  type AiKey,
  type AiText,
  type FieldError,
} from "./shared";

type Props = SectionProps & { state: SectionState; unsaved: boolean };
const MIN_REASON = 20;
/** How often the page asks how far a running check is. */
export const POLL_MS = 1500;
/** Every grader of Core's suite (services/api/src/agent-evals/graders.ts GRADERS). */
const RULES = [
  "hint_leakage",
  "grounding",
  "diagnosis_restraint",
  "factuality",
  "authority",
  "tool_scope",
  "quotes",
  "citations",
  "privacy",
] as const;
/** What a check checks: the open draft, or the jobs that are on now. */
type CheckTarget = { kind: "draft"; draft: Draft } | { kind: "active" };
/**
 * A check of one job that is on (its own "Run check"), as opposed to the check of all of them at
 * once. Its result belongs with that job, never under "Run the quality check".
 */
export function isJobCheck(check: QualityCheck) {
  return check.target === "active" && check.roles.length === 1;
}

/**
 * The quality-check gate, on the page: which models wait for a check, running the check on the
 * server with the workspace's own key (its estimated cost first, then progress and the result per
 * job), and, as a secondary option for owners, the audited approval without a check. Jobs that are
 * on without a passing check for the current checks (for example after an upgrade) keep working;
 * the page says so and offers the same check, or an owner's approval, for them.
 */
export function CheckSection(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, owner, reload, activate } = props;
  const draft = data.draft;
  const waiting =
    draft?.roles.filter((r) => draft.waitingForCheck.includes(r.role)) ?? [];
  const active = useMemo(
    () => activeRoles(data.setup.configuration),
    [data.setup.configuration],
  );
  const dialogues = (data.evals?.suite.coverage ?? [])
    .filter((c) => waiting.some((w) => w.role === c.role))
    .reduce((sum, c) => sum + c.dialogues, 0);
  const latest = data.quality?.latest ?? null;
  const passedForDraft =
    !!draft &&
    !waiting.length &&
    latest?.state === "passed" &&
    latest.draftId === draft.id;
  // Kept here: an approval removes the waiting list (and the form) it was made in.
  const [approvedDraft, setApprovedDraft] = useState<string | null>(null);
  const approved =
    approvedDraft !== null &&
    !waiting.length &&
    (!draft || draft.id === approvedDraft);
  const needing = activeNeedingCheck(data.evals);
  // Kept here: a finished check or an approval of the jobs that are on removes the list it was made in.
  const [activeDone, setActiveDone] = useState<QualityCheck | null>(null);
  const [activeApproved, setActiveApproved] = useState(false);
  const [turning, setTurning] = useState(false);
  const [turnError, setTurnError] = useState<string>();
  async function turnOn() {
    if (!draft) return;
    setTurning(true);
    setTurnError(undefined);
    try {
      await activate(draft);
      await reload();
    } catch (error) {
      setTurnError(errorText(text, error));
    } finally {
      setTurning(false);
    }
  }
  return (
    <Section
      id="check"
      title={t("aiServices.section.check")}
      state={props.state}
      unsaved={props.unsaved}
    >
      {approved && (
        <Message tone="ok">{t("aiServices.check.approved")}</Message>
      )}
      {waiting.length ? (
        <>
          <p>{t("aiServices.check.notChecked", { count: waiting.length })}</p>
          <ul className="ai-list">
            {waiting.map((r) => (
              <li key={r.role}>
                {jobName(t, r.role)} —{" "}
                <Ltr className="mono">{r.remoteModel ?? r.modelId}</Ltr>
              </li>
            ))}
          </ul>
          {dialogues > 0 && (
            <p>{t("aiServices.check.explain", { dialogues })}</p>
          )}
          <RunCheck {...props} target={{ kind: "draft", draft: draft! }} />
          <p className="ai-muted">{t("aiServices.check.disclaimer")}</p>
          <ApproveWithoutCheck
            {...props}
            draft={draft!}
            owner={owner}
            onApproved={() => setApprovedDraft(draft!.id)}
          />
        </>
      ) : passedForDraft ? (
        <>
          <CheckResult check={latest!} service={serviceOf(t, data, draft!)} />
          <Message tone="ok">
            {t("aiServices.check.run.passedTurnOn")}
            <span className="ai-actions">
              <button
                type="button"
                className="button primary"
                disabled={turning}
                onClick={() => void turnOn()}
              >
                {t("aiServices.models.turnOn")}
              </button>
            </span>
            {turnError && <span role="alert">{turnError}</span>}
          </Message>
        </>
      ) : (
        !needing.length && <p>{t("aiServices.check.nothingWaiting")}</p>
      )}
      <h3>{t("aiServices.check.onTitle")}</h3>
      {activeDone && !needing.length && (
        <CheckResult check={activeDone} service={activeService(t, data)} />
      )}
      {activeApproved && !needing.length && (
        <Message tone="ok">{t("aiServices.check.active.approved")}</Message>
      )}
      {needing.length > 0 && (
        <ActiveNeedsCheck
          {...props}
          needing={needing}
          onFinished={setActiveDone}
          onApproved={() => setActiveApproved(true)}
        />
      )}
      {active.length ? (
        <ul className="ai-list">
          {active.map((role) => {
            const state = data.evals?.roles.find((r) => r.role === role.role);
            return (
              <li key={role.role}>
                {jobName(t, role.role)} —{" "}
                <Ltr className="mono">{role.remoteModel ?? role.modelId}</Ltr>
                {state && (
                  <span className="ai-muted">
                    {" "}
                    · {t(`aiServices.check.state.${state.status}` as AiKey)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ai-muted">{t("aiServices.check.noneOn")}</p>
      )}
      <HostFileRoles {...props} />
      <CourseSetups {...props} />
    </Section>
  );
}

/** The server's provider file: what jobs use while the workspace has no setup of its own. */
function HostFileRoles(props: Props) {
  const text = useAiText();
  const { t } = text;
  const host = props.data.evals?.hostFile;
  if (!host?.inUse) return null;
  const unchecked = host.roles.filter(
    (r) => r.status !== "passed" && r.status !== "override",
  );
  return (
    <div className="ai-sub">
      <h3>{t("aiServices.check.hostFile.title")}</h3>
      <p>{t("aiServices.check.hostFile.body")}</p>
      {unchecked.length > 0 && (
        <Message tone="warn">
          {t("aiServices.check.hostFile.unchecked", {
            jobs: text.list(unchecked.map((r) => jobName(t, r.role))),
          })}
        </Message>
      )}
    </div>
  );
}

/**
 * Course-specific setups: a course may ask for a narrower version of a job (fewer tools, shorter
 * answers). Each is its own revision; it answers the course's learners only after a passing check
 * or an owner's approval of that exact setup, and is refused until then (never replaced by the
 * wider standard job).
 */
function CourseSetups(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { port, workspaceId, owner, reload, onDirty } = props;
  const setups = props.data.evals?.courseStrategies ?? [];
  const waiting = setups.filter((s) => s.status === "not_covered");
  const base = useId().replaceAll(":", "");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const keys = useRequestKeys();
  useEffect(() => onDirty(!!reason.trim()), [reason, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  if (!setups.length) return null;
  const reasonId = `${base}-course-reason`;
  async function approve() {
    setMessage(undefined);
    if (reason.trim().length < MIN_REASON) {
      setErrors([
        { field: reasonId, message: t("aiServices.check.errReason") },
      ]);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      for (const setup of waiting) {
        const request = {
          role: setup.role,
          revisionDigest: setup.revisionDigest,
          reason: reason.trim(),
        };
        await port.approve(workspaceId, {
          ...request,
          idempotencyKey: keys.key(request),
        });
      }
      keys.settle();
      setReason("");
      setApproved(true);
      await reload();
    } catch (error) {
      keys.settle(error);
      setMessage(errorText(text, error));
    } finally {
      setSaving(false);
    }
  }
  const reasonError = errors.find((e) => e.field === reasonId)?.message;
  return (
    <div className="ai-sub">
      <h3>{t("aiServices.check.course.title")}</h3>
      <p>{t("aiServices.check.course.body")}</p>
      {approved && !waiting.length && (
        <Message tone="ok">{t("aiServices.check.course.approved")}</Message>
      )}
      <ul className="ai-list">
        {setups.map((setup) => (
          <li key={`${setup.releaseId}:${setup.strategy}`}>
            {t("aiServices.check.course.item", {
              job: jobName(t, setup.role),
              course: setup.courseKey,
              version: setup.version,
            })}{" "}
            <Ltr className="mono">{setup.strategy}</Ltr>
            <span className="ai-muted">
              {" "}
              · {t(`aiServices.check.course.state.${setup.status}`)}
            </span>
          </li>
        ))}
      </ul>
      {waiting.length > 0 &&
        (owner ? (
          <form
            className="ai-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void approve();
            }}
          >
            {message && <Message tone="error">{message}</Message>}
            <p className="ai-muted">
              {t("aiServices.check.course.approveNote")}
            </p>
            <ErrorSummary errors={errors} />
            <Field
              id={reasonId}
              label={t("aiServices.check.reasonLabel")}
              hint={t("aiServices.check.reasonHint")}
              error={reasonError}
            >
              <textarea
                id={reasonId}
                rows={3}
                maxLength={1000}
                value={reason}
                disabled={saving}
                onChange={(event) => setReason(event.target.value)}
                {...described(reasonId, true, reasonError)}
              />
            </Field>
            <div className="ai-actions">
              <button
                type="submit"
                className="button secondary"
                disabled={saving}
              >
                {saving
                  ? t("aiServices.check.approving")
                  : t("aiServices.check.course.approve", {
                      count: waiting.length,
                    })}
              </button>
            </div>
          </form>
        ) : (
          <Message tone="warn">
            {t("aiServices.check.approveOwnersOnly")}
          </Message>
        ))}
    </div>
  );
}

/** The service name of the draft's connection, for key messages. */
function serviceOf(t: AiText["t"], data: Props["data"], draft: Draft) {
  return serviceName(
    t,
    data.connections.connections.find((c) =>
      draft.roles.some((r) => r.connectionId === c.id),
    )?.kind ?? "",
  );
}

/** The service name of the connection the jobs that are on use, for key messages. */
function activeService(t: AiText["t"], data: Props["data"]) {
  const used = activeRoles(data.setup.configuration).map((r) => r.connectionId);
  return serviceName(
    t,
    data.connections.connections.find((c) => used.includes(c.id))?.kind ?? "",
  );
}

/**
 * Jobs that are on but have no passing check or approval for the current checks: they keep
 * working; the check of the active setup (when no draft is open) and the owner's approval.
 */
function ActiveNeedsCheck(
  props: Props & {
    needing: ActiveCheck[];
    onFinished: (check: QualityCheck) => void;
    onApproved: () => void;
  },
) {
  const text = useAiText();
  const { t } = text;
  const { data, needing } = props;
  const uncovered = needing.filter((r) => r.status === "not_covered");
  const quality = data.quality;
  const checkable = !data.draft && quality?.target === "active";
  // "Check all of them at once" shows the result of that check itself.
  const allAtOnce = checkable && needing.length - uncovered.length > 1;
  return (
    <div className="ai-sub ai-active-check">
      <Message tone="warn">
        {t("aiServices.check.active.note", { count: needing.length })}
      </Message>
      <RoleChecks
        port={props.port}
        workspaceId={props.workspaceId}
        needing={needing}
        quality={quality}
        service={activeService(t, data)}
        onChanged={props.reload}
        onFinished={props.onFinished}
        allAtOnceShown={!!allAtOnce}
      />
      {uncovered.length > 0 && (
        <p>
          {t("aiServices.check.active.notCheckable", {
            jobs: text.list(uncovered.map((r) => jobName(t, r.role))),
          })}
        </p>
      )}
      {data.draft
        ? needing.length > uncovered.length && (
            <p className="ai-muted">{t("aiServices.check.active.draftOpen")}</p>
          )
        : allAtOnce && (
            <>
              <h4>{t("aiServices.check.flag.allTitle")}</h4>
              {quality.conversations > 0 && (
                <p>
                  {t("aiServices.check.explain", {
                    dialogues: quality.conversations,
                  })}
                </p>
              )}
              <RunCheck
                {...props}
                target={{ kind: "active" }}
                onFinished={props.onFinished}
              />
              <p className="ai-muted">{t("aiServices.check.disclaimer")}</p>
            </>
          )}
      <ApproveActive {...props} />
    </div>
  );
}
/**
 * Each job that is on and needs a check, flagged on its own with a "Run check" that checks that
 * job only (its estimated cost first, then progress and the result). The job keeps working
 * meanwhile; nothing here turns it off. A job Core's checks don't cover says an owner can approve
 * it instead. Used on the AI services page and on the course overview.
 */
export function RoleChecks({
  port,
  workspaceId,
  needing,
  quality,
  service,
  onChanged,
  onFinished,
  allAtOnceShown = false,
}: {
  port: AiServicesPort;
  workspaceId: string;
  needing: ActiveCheck[];
  quality: QualityStatus | null;
  service: string;
  onChanged: () => void | Promise<void>;
  /** Told when a check started here ends: the page keeps showing its result once the job is no longer flagged. */
  onFinished?: ((check: QualityCheck) => void) | undefined;
  /** "Check all of them at once" is on the page and shows that check's result itself. */
  allAtOnceShown?: boolean;
}) {
  const text = useAiText();
  const { t } = text;
  const keys = useRequestKeys();
  const latest = quality?.latest ?? null;
  const [check, setCheck] = useState<QualityCheck | null>(
    latest?.target === "active" ? latest : null,
  );
  const [starting, setStarting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ role: string; text: string }>();
  // A check that finished while the page was open: its result stays shown after the reload.
  const [done, setDone] = useState<QualityCheck | null>(null);
  useEffect(() => {
    if (latest?.target === "active") setCheck(latest);
  }, [latest]);
  const running = check?.state === "running";
  const checkId = check?.id;
  // Each result shows once. A job's own check shows in that job's row while the job is still
  // flagged, and after the list once it passed (and left the list). The check of all jobs at
  // once shows under "Run the quality check" when that is on the page, else after the list.
  const ended = done ?? (check && !running ? check : null);
  const jobResult = ended && isJobCheck(ended) ? ended : null;
  const listed = (role: string) => needing.some((r) => r.role === role);
  const after =
    done && (isJobCheck(done) ? !listed(done.roles[0]!) : !allAtOnceShown)
      ? done
      : null;
  // The page's reload changes on every render; polling must not restart with it.
  const changed = useRef(onChanged),
    finished = useRef(onFinished);
  changed.current = onChanged;
  finished.current = onFinished;
  useEffect(() => {
    if (!running || !checkId) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      port
        .qualityCheck(workspaceId, checkId, controller.signal)
        .then((next) => {
          setCheck(next);
          if (next.state !== "running") {
            setDone(next);
            finished.current?.(next);
            void changed.current();
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [running, checkId, port, workspaceId]);
  async function start(role: ActiveCheck["role"]) {
    setMessage(undefined);
    setStarting(role);
    const request = { target: "active" as const, role };
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
        role,
        text:
          error instanceof AiServicesError
            ? blockedText(text, error.code, error.details)
            : t("aiServices.err.generic"),
      });
    } finally {
      setStarting(null);
    }
  }
  return (
    <ul className="ai-role-checks" aria-label={t("aiServices.check.flag.list")}>
      {needing.map((r) => {
        const job = jobName(t, r.role);
        const plan = quality?.activeRoles.find((a) => a.role === r.role);
        const mine = !!check && check.roles.includes(r.role);
        return (
          <li key={r.role} className="ai-role-check" data-role={r.role}>
            <div className="ai-role-check-head">
              <strong>{job}</strong>
              <span
                className={`ai-pill ${r.status === "failed" ? "bad" : "warn"}`}
              >
                {t(
                  r.status === "not_covered"
                    ? "aiServices.check.flag.needsApproval"
                    : "aiServices.check.flag.needsCheck",
                )}
              </span>
            </div>
            <p className="ai-muted">
              {t(`aiServices.check.state.${r.status}` as AiKey)}
            </p>
            {mine && running ? (
              <div role="status" aria-live="polite" className="ai-run-progress">
                <p>
                  {t("aiServices.check.run.progress", {
                    done: check.completed,
                    total: check.total,
                  })}
                </p>
                <progress
                  max={check.total}
                  value={check.completed}
                  aria-label={t("aiServices.check.flag.progressLabel", { job })}
                />
                <p className="ai-muted">{t("aiServices.check.run.canLeave")}</p>
              </div>
            ) : r.status === "not_covered" ? (
              <p>{t("aiServices.check.flag.approveInstead")}</p>
            ) : !plan ? null : plan.blocked && !(running && mine) ? (
              <Message tone="warn">
                {blockedText(text, plan.blocked.code, plan.blocked)}
              </Message>
            ) : (
              <div className="ai-actions ai-actions-start">
                <span>
                  {t("aiServices.check.flag.estimate", {
                    amount: text.money(plan.estimateMicroUsd ?? 0),
                    count: plan.conversations,
                  })}
                </span>
                <button
                  type="button"
                  className="button primary"
                  disabled={starting !== null || running}
                  aria-label={t("aiServices.check.flag.runFor", { job })}
                  onClick={() => void start(r.role)}
                >
                  {starting === r.role
                    ? t("aiServices.check.run.starting")
                    : t("aiServices.check.flag.run")}
                </button>
              </div>
            )}
            {jobResult?.roles[0] === r.role && !(mine && running) && (
              <div className="ai-role-check-own">
                <CheckResult check={jobResult} service={service} />
              </div>
            )}
            {message?.role === r.role && (
              <Message tone="error">{message.text}</Message>
            )}
          </li>
        );
      })}
      {after && (
        <li className="ai-role-check-result">
          <CheckResult check={after} service={service} />
        </li>
      )}
    </ul>
  );
}

export function blockedText(
  text: AiText,
  code: string,
  details: {
    roles?: string[];
    neededMicroUsd?: number;
    availableMicroUsd?: number;
  } = {},
): string {
  const { t } = text;
  const jobs = text.list((details.roles ?? []).map((r) => jobName(t, r)));
  switch (code) {
    case "PROVIDER_QUALITY_CHECK_NO_DRAFT":
    case "PROVIDER_DRAFT_NOT_FOUND":
      return t("aiServices.check.run.noDraft");
    case "PROVIDER_QUALITY_CHECK_NOT_NEEDED":
      return t("aiServices.check.nothingWaiting");
    case "PROVIDER_QUALITY_CHECK_RUNNING":
      return t("aiServices.check.run.alreadyRunning");
    case "PROVIDER_QUALITY_CHECK_PRICES_MISSING":
      return jobs
        ? t("aiServices.check.run.pricesMissing", { jobs })
        : t("aiServices.check.run.pricesMissingGeneric");
    case "PROVIDER_QUALITY_CHECK_LIMIT_MISSING":
      return t("aiServices.check.run.limitMissing");
    case "PROVIDER_QUALITY_CHECK_BUDGET_REACHED":
      return details.neededMicroUsd !== undefined &&
        details.availableMicroUsd !== undefined
        ? t("aiServices.check.run.budgetReached", {
            needed: text.money(details.neededMicroUsd),
            available: text.money(details.availableMicroUsd),
          })
        : t("aiServices.check.run.budgetReachedGeneric");
    case "PROVIDER_QUALITY_CHECK_KEY_MISSING":
      return t("aiServices.check.run.keyMissing");
    case "PROVIDER_QUALITY_CHECK_RATE_LIMITED":
      return t("aiServices.check.run.rateLimited");
    case "STALE_PROVIDER_REVISION":
      return t("aiServices.err.stale");
    default:
      return errorText(text, new AiServicesError(code, 409));
  }
}

/** Why a finished check ended without a result, reusing the key messages for provider faults. */
function errorReason(text: AiText, reason: string | null, service: string) {
  const { t } = text;
  switch (reason) {
    case "PROVIDER_QUALITY_CHECK_TIMEOUT":
      return t("aiServices.check.run.timeout");
    case "PROVIDER_QUALITY_CHECK_INTERRUPTED":
      return t("aiServices.check.run.interrupted");
    case "PROVIDER_QUALITY_CHECK_SCOPE_CHANGED":
      return t("aiServices.err.forbidden");
    case "PROVIDER_GUIDE_MODEL_UNAVAILABLE":
      return t("aiServices.err.modelUnavailable");
    default:
      return (
        (reason && keyProblemText(text, reason, service)) ??
        t("aiServices.check.run.failedToRun")
      );
  }
}

/**
 * The check when it is of this target: the open draft (`draftId`) or, with null, all the jobs
 * that are on. A check of one job alone is shown with that job (RoleChecks), not here.
 */
function checkFor(
  value: QualityCheck | null | undefined,
  draftId: string | null,
) {
  if (!value) return null;
  const mine =
    draftId === null
      ? value.target === "active" && !isJobCheck(value)
      : value.target !== "active" && value.draftId === draftId;
  return mine ? value : null;
}

function RunCheck(
  props: Props & {
    target: CheckTarget;
    onFinished?: (check: QualityCheck) => void;
  },
) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, target, onFinished } = props;
  const draftId = target.kind === "draft" ? target.draft.id : null;
  const status: QualityStatus | null = data.quality;
  const [check, setCheck] = useState<QualityCheck | null>(
    checkFor(status?.latest, draftId),
  );
  const [message, setMessage] = useState<string>();
  const [starting, setStarting] = useState(false);
  const keys = useRequestKeys();
  useEffect(() => {
    setCheck(checkFor(status?.latest, draftId));
  }, [status, draftId]);
  const running = check?.state === "running";
  const checkId = check?.id;
  // Poll a running check; once it ends, reload the page data (the draft's checks change).
  useEffect(() => {
    if (!running || !checkId) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      port
        .qualityCheck(workspaceId, checkId, controller.signal)
        .then((next) => {
          setCheck(next);
          if (next.state !== "running") {
            onFinished?.(next);
            void reload();
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [running, checkId, port, workspaceId, reload, onFinished]);
  const service =
    target.kind === "draft"
      ? serviceOf(t, data, target.draft)
      : activeService(t, data);
  async function start() {
    setMessage(undefined);
    setStarting(true);
    const request =
      draftId === null ? { target: "active" as const } : { draftId: draftId };
    try {
      const started = await port.startQualityCheck(workspaceId, {
        ...request,
        idempotencyKey: keys.key(request),
      });
      keys.settle();
      setCheck(started);
    } catch (error) {
      keys.settle(error);
      setMessage(
        error instanceof AiServicesError
          ? blockedText(text, error.code, error.details)
          : t("aiServices.err.generic"),
      );
    } finally {
      setStarting(false);
    }
  }
  // The page's status describes this check: the open draft's, or (no draft) the active setup's.
  const current =
    !!status &&
    (draftId === null
      ? status.target === "active"
      : status.target !== "active" && status.draftId === draftId);
  const blocked = current && !running ? status.blocked : null;
  return (
    <div className="ai-sub ai-run">
      <h3>{t("aiServices.check.run.title")}</h3>
      {running && check ? (
        <div role="status" aria-live="polite" className="ai-run-progress">
          <p>
            {t("aiServices.check.run.progress", {
              done: check.completed,
              total: check.total,
            })}
          </p>
          <progress
            max={check.total}
            value={check.completed}
            aria-label={t("aiServices.check.run.progressLabel")}
          />
          <p className="ai-muted">{t("aiServices.check.run.canLeave")}</p>
        </div>
      ) : (
        <>
          {check && <CheckResult check={check} service={service} />}
          {blocked ? (
            <Message tone="warn">
              {blockedText(text, blocked.code, blocked)}
            </Message>
          ) : (
            status &&
            current && (
              <>
                <p>
                  {t("aiServices.check.run.estimate", {
                    amount: text.money(status.estimateMicroUsd),
                    count: status.conversations,
                  })}
                </p>
                <p className="ai-muted">
                  {t("aiServices.check.run.reserve", {
                    amount: text.money(status.reserveMicroUsd),
                  })}
                </p>
                <div className="ai-actions ai-actions-start">
                  <button
                    type="button"
                    className="button primary"
                    disabled={starting}
                    onClick={() => void start()}
                  >
                    {starting
                      ? t("aiServices.check.run.starting")
                      : check
                        ? t("aiServices.check.run.again")
                        : t("aiServices.check.run.button")}
                  </button>
                </div>
              </>
            )
          )}
          {!status && (
            <Message tone="warn">{t("aiServices.err.unavailable")}</Message>
          )}
        </>
      )}
      {message && <Message tone="error">{message}</Message>}
    </div>
  );
}

function CheckResult({
  check,
  service,
}: {
  check: QualityCheck;
  service: string;
}) {
  const text = useAiText();
  const { t } = text;
  if (check.state === "error")
    return (
      <Message tone="error">
        {t("aiServices.check.run.errorTitle")}{" "}
        {errorReason(text, check.reason, service)}
        {check.chargedMicroUsd !== null && (
          <>
            {" "}
            {t("aiServices.check.run.charged", {
              amount: text.money(check.chargedMicroUsd),
            })}
          </>
        )}
      </Message>
    );
  return (
    <Message tone={check.state === "passed" ? "ok" : "warn"}>
      <strong>
        {check.state === "passed"
          ? t("aiServices.check.run.passed")
          : t("aiServices.check.run.failed")}
      </strong>
      <ul className="ai-list">
        {check.outcome.map((o) => {
          const rules = RULES.map((rule) => ({
            rule,
            count: o.failed.filter((f) => f.graders.includes(rule)).length,
          })).filter((r) => r.count > 0);
          return (
            <li key={o.role}>
              {o.passed
                ? t("aiServices.check.run.jobPassed", {
                    job: jobName(t, o.role),
                    count: o.dialogues,
                  })
                : t("aiServices.check.run.jobFailed", {
                    job: jobName(t, o.role),
                    failed: o.failed.length,
                    count: o.dialogues,
                  })}
              {rules.length > 0 && (
                <ul>
                  {rules.map((r) => (
                    <li key={r.rule}>
                      {t(`aiServices.check.rule.${r.rule}` as AiKey, {
                        count: r.count,
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {check.chargedMicroUsd !== null && (
        <span className="ai-muted">
          {t("aiServices.check.run.charged", {
            amount: text.money(check.chargedMicroUsd),
          })}
        </span>
      )}
    </Message>
  );
}

/** Owners only: the audited approval without a check, after which the waiting models turn on. */
function ApproveWithoutCheck(
  props: Props & { draft: Draft; onApproved: () => void },
) {
  const text = useAiText();
  const { t } = text;
  const { port, workspaceId, owner, reload, activate, onDirty, draft } = props,
    { onApproved } = props;
  const base = useId().replaceAll(":", "");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  }>();
  const [saving, setSaving] = useState(false);
  const keys = useRequestKeys();
  useEffect(() => onDirty(!!reason.trim()), [reason, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const reasonId = `${base}-reason`;
  async function approve() {
    setMessage(undefined);
    if (reason.trim().length < MIN_REASON) {
      setErrors([
        { field: reasonId, message: t("aiServices.check.errReason") },
      ]);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      for (const role of draft.waitingForCheck) {
        const request = { draftId: draft.id, role, reason: reason.trim() };
        await port.approve(workspaceId, {
          ...request,
          idempotencyKey: keys.key(request),
        });
      }
      keys.settle();
      if (await activate(draft)) {
        setReason("");
        setMessage({ tone: "ok", text: t("aiServices.check.approved") });
        onApproved();
      }
      await reload();
    } catch (error) {
      keys.settle(error);
      setMessage({ tone: "error", text: errorText(text, error) });
    } finally {
      setSaving(false);
    }
  }
  const reasonError = errors.find((e) => e.field === reasonId)?.message;
  if (!owner)
    return (
      <Message tone="warn">{t("aiServices.check.approveOwnersOnly")}</Message>
    );
  return (
    <details className="ai-sub ai-approve" open={!!reason || !!message}>
      <summary>{t("aiServices.check.approveTitle")}</summary>
      {message && <Message tone={message.tone}>{message.text}</Message>}
      {
        <form
          className="ai-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void approve();
          }}
        >
          <p className="ai-muted">{t("aiServices.check.approveNote")}</p>
          <ErrorSummary errors={errors} />
          <Field
            id={reasonId}
            label={t("aiServices.check.reasonLabel")}
            hint={t("aiServices.check.reasonHint")}
            error={reasonError}
          >
            <textarea
              id={reasonId}
              rows={3}
              maxLength={1000}
              value={reason}
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
              {...described(reasonId, true, reasonError)}
            />
          </Field>
          <p className="ai-muted" aria-live="polite">
            {t("aiServices.check.reasonCount", {
              count: reason.trim().length,
            })}
          </p>
          <div className="ai-actions">
            <button
              type="submit"
              className="button secondary"
              disabled={saving}
            >
              {saving
                ? t("aiServices.check.approving")
                : t("aiServices.check.approve")}
            </button>
          </div>
        </form>
      }
    </details>
  );
}

/** Owners only: the audited approval of the exact revisions of the jobs that are on, without a check. */
function ApproveActive(
  props: Props & { needing: ActiveCheck[]; onApproved: () => void },
) {
  const text = useAiText();
  const { t } = text;
  const { port, workspaceId, owner, reload, onDirty, needing, onApproved } =
    props;
  const base = useId().replaceAll(":", "");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const keys = useRequestKeys();
  useEffect(() => onDirty(!!reason.trim()), [reason, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const reasonId = `${base}-active-reason`;
  async function approve() {
    setMessage(undefined);
    if (reason.trim().length < MIN_REASON) {
      setErrors([
        { field: reasonId, message: t("aiServices.check.errReason") },
      ]);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      for (const job of needing) {
        const request = {
          role: job.role,
          revisionDigest: job.revisionDigest,
          reason: reason.trim(),
        };
        await port.approve(workspaceId, {
          ...request,
          idempotencyKey: keys.key(request),
        });
      }
      keys.settle();
      setReason("");
      onApproved();
      await reload();
    } catch (error) {
      keys.settle(error);
      setMessage(errorText(text, error));
    } finally {
      setSaving(false);
    }
  }
  const reasonError = errors.find((e) => e.field === reasonId)?.message;
  if (!owner)
    return (
      <Message tone="warn">{t("aiServices.check.approveOwnersOnly")}</Message>
    );
  return (
    <details className="ai-sub ai-approve" open={!!reason || !!message}>
      <summary>{t("aiServices.check.active.approveTitle")}</summary>
      {message && <Message tone="error">{message}</Message>}
      <form
        className="ai-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void approve();
        }}
      >
        <p className="ai-muted">{t("aiServices.check.active.approveNote")}</p>
        <ErrorSummary errors={errors} />
        <Field
          id={reasonId}
          label={t("aiServices.check.reasonLabel")}
          hint={t("aiServices.check.reasonHint")}
          error={reasonError}
        >
          <textarea
            id={reasonId}
            rows={3}
            maxLength={1000}
            value={reason}
            disabled={saving}
            onChange={(event) => setReason(event.target.value)}
            {...described(reasonId, true, reasonError)}
          />
        </Field>
        <p className="ai-muted" aria-live="polite">
          {t("aiServices.check.reasonCount", {
            count: reason.trim().length,
          })}
        </p>
        <div className="ai-actions">
          <button type="submit" className="button secondary" disabled={saving}>
            {saving
              ? t("aiServices.check.approving")
              : t("aiServices.check.active.approve")}
          </button>
        </div>
      </form>
    </details>
  );
}
