import {
  useEffect,
  useMemo,
  useId,
  useRef,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Circle, XCircle } from "lucide-react";
import { randomId } from "../../domain/webCrypto";
import { focusInPlace, lockPageScroll, useMoreBelow } from "../ui";
import { useI18n, type MessageKey } from "../../i18n";
import {
  AiServicesError,
  type Job,
  type SectionId,
  type SectionState,
} from "../../domain/aiServices";

export type AiKey = MessageKey;
export type MessageArgs = Record<string, string | number>;
/** The page's translator (`aiServices` namespace) and the formatters it uses. String arguments
 * are isolated left to right in right-to-left locales by the translator itself. */
export interface AiText {
  locale: string;
  dir: "ltr" | "rtl";
  t: (key: MessageKey, args?: MessageArgs) => string;
  money: (microUsd: number) => string;
  date: (value: string | Date) => string;
  relative: (iso: string) => string;
  list: (items: string[]) => string;
}
export function useAiText(): AiText {
  const i18n = useI18n();
  return useMemo(
    () => ({
      locale: i18n.locale,
      dir: i18n.dir,
      t: (key, args) => i18n.t(key, args),
      money: (microUsd) => {
        const usd = microUsd / 1000000,
          small = usd > 0 && usd < 0.01;
        return i18n
          .currency(usd, "USD", {
            minimumFractionDigits: small ? 4 : 2,
            maximumFractionDigits: small ? 6 : 2,
          })
          .replace(/[\u200e\u200f]/g, "");
      },
      date: (value) => i18n.date(value, "medium"),
      relative: (iso) => i18n.relativeFrom(iso),
      list: (items) => i18n.list(items),
    }),
    [i18n],
  );
}
export const newKey = () => `ai-services:${randomId()}`;
/**
 * Idempotency keys for one form's requests. A request whose answer was lost (the server may
 * have applied it) is retried with the same key, so it is applied at most once; any definite
 * answer starts fresh. The remembered payload stays in memory only.
 */
export function useRequestKeys() {
  const ref = useRef(new Map<string, string>());
  return {
    key(payload: unknown) {
      const id = JSON.stringify(payload);
      let value = ref.current.get(id);
      if (!value) ref.current.set(id, (value = newKey()));
      return value;
    },
    settle(error?: unknown) {
      if (
        !(error instanceof AiServicesError) ||
        !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.code)
      )
        ref.current.clear();
    },
  };
}

/** Left-to-right content (ids, model names, key endings, money, URLs) isolated in any locale. */
export function Ltr({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <bdi dir="ltr" className={className}>
      {children}
    </bdi>
  );
}
export const sectionAnchor = (section: SectionId | "advanced") =>
  `ai-${section}`;

const PILL_KEYS: Record<SectionState["pill"], AiKey> = {
  working: "aiServices.pill.working",
  done: "aiServices.pill.done",
  noLearnerLimit: "aiServices.pill.noLearnerLimit",
  notConnected: "aiServices.pill.notConnected",
  notTested: "aiServices.pill.notTested",
  modelNeeded: "aiServices.pill.modelNeeded",
  waitingCheck: "aiServices.pill.waitingCheck",
  activeNeedsCheck: "aiServices.pill.activeNeedsCheck",
  notOn: "aiServices.pill.notOn",
  priceNeeded: "aiServices.pill.priceNeeded",
  spendingOff: "aiServices.pill.spendingOff",
  learnerLimitNeeded: "aiServices.pill.learnerLimitNeeded",
  keyProblem: "aiServices.pill.keyProblem",
  nothingYet: "aiServices.pill.nothingYet",
};
export function StatusPill({
  state,
  unsaved,
}: {
  state?: SectionState;
  unsaved?: boolean;
}) {
  const { t } = useAiText();
  if (!state && !unsaved) return null;
  return (
    <span className="ai-pills">
      {state && (
        <span className={`ai-pill ${state.tone}`}>
          {state.tone === "ok" ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : state.tone === "bad" ? (
            <XCircle size={15} aria-hidden="true" />
          ) : state.tone === "warn" ? (
            <AlertTriangle size={15} aria-hidden="true" />
          ) : (
            <Circle size={15} aria-hidden="true" />
          )}
          {t(PILL_KEYS[state.pill])}
        </span>
      )}
      {unsaved && (
        <span className="ai-pill unsaved">{t("aiServices.pill.unsaved")}</span>
      )}
    </span>
  );
}
export function Section({
  id,
  title,
  state,
  unsaved,
  children,
}: PropsWithChildren<{
  id: SectionId;
  title: string;
  state?: SectionState;
  unsaved?: boolean;
}>) {
  const heading = `${sectionAnchor(id)}-title`;
  return (
    <section
      id={sectionAnchor(id)}
      className="ai-section"
      aria-labelledby={heading}
      tabIndex={-1}
    >
      <div className="ai-section-heading">
        <h2 id={heading}>{title}</h2>
        <StatusPill state={state} unsaved={unsaved} />
      </div>
      {children}
    </section>
  );
}
/** A polite live message: what a save did, or a refusal (with `tone="error"`, an alert). */
export function Message({
  tone,
  children,
}: PropsWithChildren<{ tone: "ok" | "info" | "warn" | "error" }>) {
  return (
    <div
      className={`ai-message ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {tone === "ok" ? (
        <CheckCircle2 size={17} aria-hidden="true" />
      ) : tone === "error" ? (
        <XCircle size={17} aria-hidden="true" />
      ) : (
        <AlertTriangle size={17} aria-hidden="true" />
      )}
      <div>{children}</div>
    </div>
  );
}
export interface FieldError {
  field: string;
  message: string;
}
/** Errors of one form, summarised at its top with links to the fields; takes focus when shown. */
export function ErrorSummary({ errors }: { errors: FieldError[] }) {
  const { t } = useAiText();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors.length) ref.current?.focus();
  }, [errors]);
  if (!errors.length) return null;
  return (
    <div className="ai-error-summary" role="alert" tabIndex={-1} ref={ref}>
      <strong>{t("aiServices.err.summary")}</strong>
      <ul>
        {errors.map((e) => (
          <li key={e.field + e.message}>
            <a
              href={`#${e.field}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(e.field)?.focus();
              }}
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`ai-field${error ? " invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint && (
        <small id={`${id}-hint`} className="ai-hint">
          {hint}
        </small>
      )}
      {error && (
        <small id={`${id}-error`} className="ai-field-error">
          {error}
        </small>
      )}
      {children}
    </div>
  );
}
/** `aria-describedby` and `aria-invalid` for an input inside `Field`. */
export const described = (
  id: string,
  hint: boolean,
  error: string | undefined,
) => ({
  "aria-describedby":
    [hint ? `${id}-hint` : "", error ? `${id}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined,
  "aria-invalid": error ? (true as const) : undefined,
});
export function jobName(t: AiText["t"], job: Job | string) {
  return (
    ["companion", "supervisor", "research", "reviewer", "media"] as string[]
  ).includes(job)
    ? t(`aiServices.role.${job}.name` as AiKey)
    : job;
}
export function serviceName(t: AiText["t"], kind: string, fallback?: string) {
  return kind === "google" || kind === "anthropic"
    ? t(`aiServices.service.${kind}` as AiKey)
    : (fallback ?? kind);
}
/** The sentence for a refusal of the AI services API. Key-test codes have their own copy. */
export function errorText(text: AiText, error: unknown, service = ""): string {
  const { t } = text;
  if (!(error instanceof AiServicesError)) return t("aiServices.err.generic");
  const jobs = text.list(
    (error.details?.roles ?? []).map((r) => jobName(t, r)),
  );
  switch (error.code) {
    case "STALE_PROVIDER_REVISION":
    case "STALE_PROVIDER_BUDGET_REVISION":
    case "STALE_PROVIDER_PRICING_VERSION":
    case "STALE_PROVIDER_COST_SETTINGS":
      return t("aiServices.err.stale");
    case "FORBIDDEN":
      return t("aiServices.err.forbidden");
    case "UNAVAILABLE":
    case "INVALID_RESPONSE":
      return t("aiServices.err.unavailable");
    case "PROVIDER_EVAL_REQUIRED":
      return jobs
        ? t("aiServices.err.evalRequiredJobs", { jobs })
        : t("aiServices.err.evalRequired");
    case "PROVIDER_CONNECTION_IN_USE":
      return jobs
        ? t("aiServices.err.connectionInUse", { jobs })
        : t("aiServices.err.generic");
    case "PROVIDER_BUDGET_BELOW_USAGE":
      return t("aiServices.err.budgetBelowUsage");
    case "PAID_WORK_CONSENT_REQUIRED":
      return t("aiServices.err.consent");
    case "PROVIDER_TOKEN_RESERVATION_TOO_SMALL":
      return t("aiServices.err.tooSmall");
    case "PROVIDER_GUIDE_MODEL_UNAVAILABLE":
    case "PROVIDER_GUIDE_METHOD_UNSUPPORTED":
      return t("aiServices.err.modelUnavailable");
    case "PROVIDER_GUIDE_CONTEXT_TOO_SMALL":
    case "PROVIDER_GUIDE_LIMITS_UNKNOWN":
      return t("aiServices.err.contextTooSmall");
    case "PROVIDER_GUIDE_VIDEO_PARAMETERS_REQUIRED":
      return t("aiServices.models.errVideo");
    case "PROVIDER_CONFIGURATION_INVALID":
    case "PROVIDER_DRAFT_INVALID":
      return t("aiServices.err.configInvalid");
    case "PROVIDER_SECRET_FIELD_FORBIDDEN":
      return t("aiServices.err.secretField");
    case "PROVIDER_PRICING_EFFECTIVE_DATE_INVALID": {
      const latest = error.details?.latest
        ? text.date(error.details.latest)
        : null;
      if (!latest) return t("aiServices.err.pricingDateGeneric");
      return error.details?.earliest
        ? t("aiServices.err.pricingDate", {
            earliest: text.date(error.details.earliest),
            latest,
          })
        : t("aiServices.err.pricingDateLatest", { latest });
    }
    case "PROVIDER_PRICING_UNKNOWN_MODEL":
      return t("aiServices.err.pricingUnknownModel");
    case "PROVIDER_PRICING_INVALID":
      return t("aiServices.err.pricingInvalid");
    default:
      return (
        keyProblemText(text, error.code, service) ?? t("aiServices.err.generic")
      );
  }
}
/** Copy for a key test or model-list refusal code; undefined when the code is not about the key. */
export function keyProblemText(
  text: AiText,
  code: string,
  service: string,
): string | undefined {
  const { t } = text;
  const s = { service };
  switch (code) {
    case "PROVIDER_METADATA_KEY_INVALID":
    case "PROVIDER_METADATA_CREDENTIAL_MISSING":
      return t("aiServices.connect.errRejected", s);
    case "PROVIDER_METADATA_API_NOT_ENABLED":
    case "PROVIDER_METADATA_KEY_RESTRICTED":
    case "PROVIDER_METADATA_PERMISSION_DENIED":
      return t("aiServices.connect.errForbidden", s);
    case "PROVIDER_METADATA_RATE_LIMITED":
      return t("aiServices.connect.errRateLimitedProvider", s);
    case "PROVIDER_METADATA_QUOTA_EXHAUSTED":
      return t("aiServices.connect.errQuotaUsed", s);
    case "PROVIDER_METADATA_BILLING_REQUIRED":
      return t("aiServices.connect.errBilling", s);
    case "PROVIDER_REQUEST_REJECTED":
      return t("aiServices.connect.errRequestRefused", s);
    // Earlier versions recorded every other client error, billing included, under this code.
    case "PROVIDER_METADATA_REJECTED":
      return t("aiServices.connect.errRefusedTestAgain", s);
    case "PROVIDER_METADATA_NETWORK":
    case "PROVIDER_METADATA_TIMEOUT":
    case "PROVIDER_METADATA_UPSTREAM_ERROR":
      return t("aiServices.connect.errUnreachable", s);
    case "PROVIDER_METADATA_CREDENTIAL_MALFORMED":
    case "PROVIDER_CREDENTIAL_MALFORMED":
      return t("aiServices.connect.errMalformed");
    case "PROVIDER_CREDENTIAL_EMPTY":
      return t("aiServices.connect.errEmpty", s);
    case "PROVIDER_KEY_TEST_RATE_LIMITED":
      return t("aiServices.connect.errRateLimited", { minutes: 1 });
    case "PROVIDER_METADATA_INVALID":
    case "PROVIDER_METADATA_TOO_LARGE":
    case "PROVIDER_METADATA_UNAVAILABLE":
    case "PROVIDER_METADATA_UNSUPPORTED":
    case "PROVIDER_KEY_TEST_INVALID":
      return t("aiServices.connect.errUnexpected");
    default:
      return undefined;
  }
}
export const unreachable = (code: string) =>
  [
    "PROVIDER_METADATA_NETWORK",
    "PROVIDER_METADATA_TIMEOUT",
    "PROVIDER_METADATA_UPSTREAM_ERROR",
  ].includes(code);

/** A modal confirmation in the page's language. */
export function Confirm({
  title,
  body,
  confirm,
  onConfirm,
  onCancel,
  pending,
  tone = "danger",
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  /** A confirmation that loses nothing is primary; one that stops or deletes is danger. */
  tone?: "danger" | "primary";
}) {
  const text = useAiText();
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId(),
    bodyId = useId();
  useMoreBelow(ref);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null,
      dialog = ref.current!;
    const unlock = lockPageScroll();
    dialog.showModal();
    return () => {
      dialog.close();
      if (before?.isConnected) focusInPlace(before);
      unlock();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="dialog ai-confirm"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <p id={bodyId}>{body}</p>
      <div className="ai-actions dialog-footer">
        <button
          type="button"
          className="button secondary"
          onClick={onCancel}
          disabled={pending}
        >
          {text.t("aiServices.confirm.cancel")}
        </button>
        <button
          type="button"
          className={`button ${tone}`}
          onClick={onConfirm}
          disabled={pending}
        >
          {confirm}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
