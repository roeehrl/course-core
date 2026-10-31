import { useCallback, useEffect, useId, useState } from "react";
import type { AiServicesPort } from "../../domain/aiServices";
import { AiServicesError } from "../../domain/aiServices";
import type { UncertainCall, UncertainCalls } from "../../domain/providerCosts";
import { useFormatters, useI18n, type MessageKey } from "../../i18n";
import {
  Field,
  Ltr,
  Message,
  described,
  errorText,
  jobName,
  useAiText,
  useRequestKeys,
} from "./shared";

type Decision = "zero" | "reservation";
const HAPPENED: Record<UncertainCall["happened"], MessageKey> = {
  no_response: "aiServices.unknown.happened.noResponse",
  stopped: "aiServices.unknown.happened.stopped",
  stalled: "aiServices.unknown.happened.stalled",
  service_error: "aiServices.unknown.happened.serviceError",
  no_receipt: "aiServices.unknown.happened.noReceipt",
};

/** The short reference of a call: the end of its id (the random part), enough to tell calls apart. */
export const callRef = (id: string) => id.replaceAll("-", "").slice(-8);
/**
 * AI calls whose cost stayed unknown: sent, but no usage report came back (no reply in time, or
 * the reply stopped before the service said how much it used). Course Core keeps the most each
 * call could cost counted against the limits and never decides the amount itself. The owner
 * checks the service's own usage page and settles each call, at $0 or at the amount held, with a
 * short note of what they checked; the decision is final and recorded in the audit log. Shown
 * only while there is something to decide or a recent decision to show.
 *
 * Each call is named by its job, the time it was sent to the second (two calls can fall in the
 * same minute) and a short reference; the message after a decision and the list of recent
 * decisions name the call the same way. Times and the owner's notes are isolated (`<bdi>`,
 * `dir="auto"`), so a Hebrew date or an English note keeps its own order in either direction.
 */
export function UncertainCallsPanel({
  port,
  workspaceId,
  onSettled,
}: {
  port: AiServicesPort;
  workspaceId: string;
  /** Called after a decision, so the limits and spending above show the new amounts. */
  onSettled?: () => Promise<void> | void;
}) {
  const text = useAiText();
  const { t } = text;
  const { when, whenExact } = useFormatters(),
    i18n = useI18n();
  // Exact to the micro-dollar (a held reservation such as $0.031410 is not rounded to cents), so
  // the amount matches the service's own usage page and the decision's record.
  const exact = (microUsd: number) =>
    i18n
      .currency(microUsd / 1_000_000, "USD", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      })
      .replace(/[\u200e\u200f]/g, "");
  const base = useId().replaceAll(":", "");
  const [view, setView] = useState<UncertainCalls | "failed">();
  const [open, setOpen] = useState<string>("");
  const [decision, setDecision] = useState<Decision | "">("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ decision?: string; reason?: string }>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  }>();
  const keys = useRequestKeys();
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!port.uncertainCalls) return;
      try {
        setView(await port.uncertainCalls(workspaceId, signal));
      } catch {
        if (!signal?.aborted) setView("failed");
      }
    },
    [port, workspaceId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  if (!port.uncertainCalls || !port.settleUncertainCall) return null;
  if (view === undefined) return null;
  if (view === "failed")
    return (
      <section className="ai-unknown" aria-labelledby={`${base}-title`}>
        <h3 id={`${base}-title`}>{t("aiServices.unknown.title")}</h3>
        <Message tone="error">{t("aiServices.err.unavailable")}</Message>
      </section>
    );
  if (!view.calls.length && !view.recent.length && !message) return null;
  const money = (microUsd: number) => <Ltr>{exact(microUsd)}</Ltr>;
  function start(call: UncertainCall) {
    setOpen(call.id);
    setDecision("");
    setReason("");
    setErrors({});
    setMessage(undefined);
  }
  async function save(call: UncertainCall) {
    const problems: typeof errors = {};
    if (!decision) problems.decision = t("aiServices.unknown.errDecision");
    if (reason.trim().length < 3)
      problems.reason = t("aiServices.unknown.errReason");
    setErrors(problems);
    if (problems.decision || problems.reason || !decision) {
      document
        .getElementById(
          problems.decision
            ? `${base}-${call.id}-zero`
            : `${base}-${call.id}-reason`,
        )
        ?.focus();
      return;
    }
    const request = {
      decision,
      expectedReservedMicroUsd: call.reservedMicroUsd,
      reason: reason.trim(),
    };
    setSaving(true);
    try {
      const settled = await port.settleUncertainCall!(workspaceId, call.id, {
        ...request,
        idempotencyKey: keys.key({ id: call.id, ...request }),
      });
      keys.settle();
      setOpen("");
      // The message names the call that was decided: its job, when it was sent and its reference.
      const named = {
        job: jobName(t, call.role),
        when: whenExact(call.reservedAt),
        ref: t("aiServices.unknown.ref", { id: callRef(call.id) }),
      };
      setMessage({
        tone: "ok",
        text:
          settled.decision === "zero"
            ? t("aiServices.unknown.savedZero", {
                ...named,
                amount: exact(settled.releasedMicroUsd),
                zero: exact(0),
              })
            : t("aiServices.unknown.savedKept", {
                ...named,
                amount: exact(settled.chargedMicroUsd),
              }),
      });
      await load();
      await onSettled?.();
    } catch (error) {
      keys.settle(error);
      const code = error instanceof AiServicesError ? error.code : "";
      setMessage({
        tone: "error",
        text:
          code === "PROVIDER_SPEND_STILL_SETTLING"
            ? t("aiServices.unknown.errSettling")
            : code === "PROVIDER_SPEND_ALREADY_SETTLED" ||
                code === "STALE_PROVIDER_SPEND_CALL" ||
                code === "PROVIDER_SPEND_CALL_NOT_FOUND"
              ? t("aiServices.unknown.errChanged")
              : errorText(text, error),
      });
      if (code && code !== "UNAVAILABLE") await load();
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="ai-unknown" aria-labelledby={`${base}-title`}>
      <h3 id={`${base}-title`}>{t("aiServices.unknown.title")}</h3>
      {view.calls.length > 0 && (
        <>
          <p>
            {t("aiServices.unknown.intro", {
              count: view.uncertainCalls,
              amount: exact(view.heldMicroUsd),
            })}
          </p>
          <p className="ai-muted">{t("aiServices.unknown.howTo")}</p>
        </>
      )}
      {message && <Message tone={message.tone}>{message.text}</Message>}
      {view.calls.length > 0 && (
        <ul
          className="ai-unknown-list"
          aria-label={t("aiServices.unknown.listLabel")}
        >
          {view.calls.map((call) => {
            const editing = open === call.id;
            const reasonId = `${base}-${call.id}-reason`;
            return (
              <li key={call.id} className="ai-unknown-call">
                <CallName
                  job={jobName(t, call.role)}
                  when={whenExact(call.reservedAt)}
                  reference={t("aiServices.unknown.ref", {
                    id: callRef(call.id),
                  })}
                />
                <p>{t(HAPPENED[call.happened])}</p>
                <p>
                  {t("aiServices.unknown.counted")}{" "}
                  {money(call.reservedMicroUsd)}
                </p>
                {!call.settleable ? (
                  <p className="ai-muted">
                    {t("aiServices.unknown.notYet", {
                      minutes: view.settleAfterMinutes,
                    })}
                  </p>
                ) : !editing ? (
                  <div className="ai-actions ai-actions-start">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => start(call)}
                      disabled={saving}
                    >
                      {t("aiServices.unknown.decide")}
                    </button>
                  </div>
                ) : (
                  <form
                    className="ai-form ai-unknown-form"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save(call);
                    }}
                  >
                    <fieldset
                      className="ai-choice ai-unknown-choice"
                      aria-describedby={
                        errors.decision
                          ? `${base}-${call.id}-decision-error`
                          : undefined
                      }
                    >
                      <legend>{t("aiServices.unknown.question")}</legend>
                      {errors.decision && (
                        <small
                          id={`${base}-${call.id}-decision-error`}
                          className="ai-field-error"
                        >
                          {errors.decision}
                        </small>
                      )}
                      <label>
                        <input
                          id={`${base}-${call.id}-zero`}
                          type="radio"
                          name={`${base}-${call.id}-decision`}
                          value="zero"
                          checked={decision === "zero"}
                          disabled={saving}
                          onChange={() => {
                            setDecision("zero");
                            setErrors(({ reason }) => ({ reason }));
                          }}
                        />
                        {t("aiServices.unknown.zero", {
                          amount: exact(call.reservedMicroUsd),
                          zero: exact(0),
                        })}
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`${base}-${call.id}-decision`}
                          value="reservation"
                          checked={decision === "reservation"}
                          disabled={saving}
                          onChange={() => {
                            setDecision("reservation");
                            setErrors(({ reason }) => ({ reason }));
                          }}
                        />
                        {t("aiServices.unknown.keep", {
                          amount: exact(call.reservedMicroUsd),
                        })}
                      </label>
                    </fieldset>
                    <Field
                      id={reasonId}
                      label={t("aiServices.unknown.reason")}
                      hint={t("aiServices.unknown.reasonHint")}
                      error={errors.reason}
                    >
                      <input
                        id={reasonId}
                        value={reason}
                        maxLength={500}
                        autoComplete="off"
                        disabled={saving}
                        onChange={(event) => {
                          setReason(event.target.value);
                          if (event.target.value.trim().length >= 3)
                            setErrors(({ decision }) => ({ decision }));
                        }}
                        {...described(reasonId, true, errors.reason)}
                      />
                    </Field>
                    <p className="ai-muted">{t("aiServices.unknown.final")}</p>
                    <div className="ai-actions ai-actions-start">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={saving}
                        onClick={() => setOpen("")}
                      >
                        {t("aiServices.unknown.cancel")}
                      </button>
                      <button
                        type="submit"
                        className="button primary"
                        disabled={saving}
                      >
                        {saving
                          ? t("aiServices.unknown.saving")
                          : t("aiServices.unknown.save")}
                      </button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {view.more && <p className="ai-muted">{t("aiServices.unknown.more")}</p>}
      {view.recent.length > 0 && (
        <details className="ai-history">
          <summary>{t("aiServices.unknown.recent")}</summary>
          <ul className="ai-unknown-recent">
            {view.recent.map((row) => (
              <li key={row.ledgerId}>
                <CallName
                  job={row.role ? jobName(t, row.role) : null}
                  when={row.reservedAt ? whenExact(row.reservedAt) : null}
                  reference={t("aiServices.unknown.ref", {
                    id: callRef(row.ledgerId),
                  })}
                />
                <p>
                  {t(
                    row.decision === "zero"
                      ? "aiServices.unknown.recentZero"
                      : "aiServices.unknown.recentKept",
                    {
                      amount: exact(row.reservedMicroUsd),
                      zero: exact(0),
                      when: when(row.decidedAt),
                      who: row.decidedBy ?? t("aiServices.unknown.someone"),
                    },
                  )}
                </p>
                {/* The owner's note, in its own direction (an English note on a Hebrew page). */}
                <q className="ai-unknown-note" dir="auto">
                  {row.reason}
                </q>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * A call's name: its job, when it was sent (to the second) and its short reference. A separator
 * wraps with what follows it, and the time is isolated in its own direction.
 */
function CallName({
  job,
  when,
  reference,
}: {
  job: string | null;
  when: string | null;
  reference: string;
}) {
  const parts = [
    when && (
      <bdi key="when" className="ai-unknown-when">
        {when}
      </bdi>
    ),
    <span key="ref" className="ai-muted">
      {reference}
    </span>,
  ].filter(Boolean);
  return (
    <p className="ai-unknown-head">
      {job && <strong>{job}</strong>}
      {parts.map((part, index) => (
        <span key={index} className="ai-unknown-part">
          {(job || index > 0) && " · "}
          {part}
        </span>
      ))}
    </p>
  );
}
