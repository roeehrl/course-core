import { useEffect, useId, useMemo, useState } from "react";
import {
  AiServicesError,
  activeRoles,
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
const RULES = [
  "hint_leakage",
  "grounding",
  "diagnosis_restraint",
  "factuality",
  "authority",
] as const;

/**
 * The quality-check gate, on the page: which models wait for a check, running the check on the
 * server with the workspace's own key (its estimated cost first, then progress and the result per
 * job), and, as a secondary option for owners, the audited approval without a check.
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
          <RunCheck {...props} draft={draft!} />
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
        <p>{t("aiServices.check.nothingWaiting")}</p>
      )}
      <h3>{t("aiServices.check.onTitle")}</h3>
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
    </Section>
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

/** Why a check cannot start (or was refused), in plain language. */
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

function RunCheck(props: Props & { draft: Draft }) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, draft } = props;
  const status: QualityStatus | null = data.quality;
  const [check, setCheck] = useState<QualityCheck | null>(
    status?.latest?.draftId === draft.id ? status.latest : null,
  );
  const [message, setMessage] = useState<string>();
  const [starting, setStarting] = useState(false);
  const keys = useRequestKeys();
  useEffect(() => {
    setCheck(status?.latest?.draftId === draft.id ? status.latest : null);
  }, [status, draft.id]);
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
          if (next.state !== "running") void reload();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [running, checkId, port, workspaceId, reload]);
  const service = serviceOf(t, data, draft);
  async function start() {
    setMessage(undefined);
    setStarting(true);
    const request = { draftId: draft.id };
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
  const blocked =
    status && status.draftId === draft.id && !running ? status.blocked : null;
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
            status.draftId === draft.id && (
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
              dir="auto"
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
