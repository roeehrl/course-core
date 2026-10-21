import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Circle, XCircle } from "lucide-react";
import { randomId } from "../../domain/webCrypto";
import { aiTranslator, type AiKey, type AiText } from "../../text/aiServices";
import { AiServicesError, type Job, type SectionId, type SectionState } from "../../domain/aiServices";

export const TextContext = createContext<AiText>(aiTranslator("en"));
export const useAiText = () => useContext(TextContext);
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
      if (!(error instanceof AiServicesError) || !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.code))
        ref.current.clear();
    },
  };
}

/** Left-to-right content (ids, model names, key endings, money, URLs) isolated in any locale. */
export function Ltr({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <bdi dir="ltr" className={className}>
      {children}
    </bdi>
  );
}
export const sectionAnchor = (section: SectionId | "advanced") => `ai-${section}`;

const PILL_KEYS: Record<SectionState["pill"], AiKey> = {
  working: "pill.working",
  done: "pill.done",
  notConnected: "pill.notConnected",
  notTested: "pill.notTested",
  modelNeeded: "pill.modelNeeded",
  waitingCheck: "pill.waitingCheck",
  notOn: "pill.notOn",
  priceNeeded: "pill.priceNeeded",
  spendingOff: "pill.spendingOff",
  learnerLimitNeeded: "pill.learnerLimitNeeded",
  keyProblem: "pill.keyProblem",
  nothingYet: "pill.nothingYet",
};
export function StatusPill({ state, unsaved }: { state?: SectionState; unsaved?: boolean }) {
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
      {unsaved && <span className="ai-pill unsaved">{t("pill.unsaved")}</span>}
    </span>
  );
}
export function Section({
  id,
  title,
  state,
  unsaved,
  children,
}: PropsWithChildren<{ id: SectionId; title: string; state?: SectionState; unsaved?: boolean }>) {
  const heading = `${sectionAnchor(id)}-title`;
  return (
    <section id={sectionAnchor(id)} className="ai-section" aria-labelledby={heading} tabIndex={-1}>
      <div className="ai-section-heading">
        <h2 id={heading}>{title}</h2>
        <StatusPill state={state} unsaved={unsaved} />
      </div>
      {children}
    </section>
  );
}
/** A polite live message: what a save did, or a refusal (with `tone="error"`, an alert). */
export function Message({ tone, children }: PropsWithChildren<{ tone: "ok" | "info" | "warn" | "error" }>) {
  return (
    <div className={`ai-message ${tone}`} role={tone === "error" ? "alert" : "status"}>
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
      <strong>{t("err.summary")}</strong>
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
export const described = (id: string, hint: boolean, error: string | undefined) => ({
  "aria-describedby": [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined,
  "aria-invalid": error ? (true as const) : undefined,
});
export function jobName(t: AiText["t"], job: Job | string) {
  return (["companion", "supervisor", "research", "reviewer", "media"] as string[]).includes(job)
    ? t(`role.${job}.name` as AiKey)
    : job;
}
export function serviceName(t: AiText["t"], kind: string, fallback?: string) {
  return kind === "google" || kind === "anthropic" ? t(`service.${kind}` as AiKey) : (fallback ?? kind);
}
/** The sentence for a refusal of the AI services API. Key-test codes have their own copy. */
export function errorText(text: AiText, error: unknown, service = ""): string {
  const { t } = text;
  if (!(error instanceof AiServicesError)) return t("err.generic");
  const jobs = text.list((error.details?.roles ?? []).map((r) => jobName(t, r)));
  switch (error.code) {
    case "STALE_PROVIDER_REVISION":
    case "STALE_PROVIDER_BUDGET_REVISION":
    case "STALE_PROVIDER_PRICING_VERSION":
    case "STALE_PROVIDER_COST_SETTINGS":
      return t("err.stale");
    case "FORBIDDEN":
      return t("err.forbidden");
    case "UNAVAILABLE":
    case "INVALID_RESPONSE":
      return t("err.unavailable");
    case "PROVIDER_EVAL_REQUIRED":
      return t("err.evalRequired");
    case "PROVIDER_CONNECTION_IN_USE":
      return jobs ? t("err.connectionInUse", { jobs }) : t("err.generic");
    case "PROVIDER_BUDGET_BELOW_USAGE":
      return t("err.budgetBelowUsage");
    case "PAID_WORK_CONSENT_REQUIRED":
      return t("err.consent");
    case "PROVIDER_TOKEN_RESERVATION_TOO_SMALL":
      return t("err.tooSmall");
    case "PROVIDER_GUIDE_MODEL_UNAVAILABLE":
    case "PROVIDER_GUIDE_METHOD_UNSUPPORTED":
      return t("err.modelUnavailable");
    case "PROVIDER_GUIDE_CONTEXT_TOO_SMALL":
    case "PROVIDER_GUIDE_LIMITS_UNKNOWN":
      return t("err.contextTooSmall");
    case "PROVIDER_GUIDE_VIDEO_PARAMETERS_REQUIRED":
      return t("models.errVideo");
    case "PROVIDER_CONFIGURATION_INVALID":
    case "PROVIDER_DRAFT_INVALID":
      return t("err.configInvalid");
    case "PROVIDER_SECRET_FIELD_FORBIDDEN":
      return t("err.secretField");
    default:
      return keyProblemText(text, error.code, service) ?? t("err.generic");
  }
}
/** Copy for a key test or model-list refusal code; undefined when the code is not about the key. */
export function keyProblemText(text: AiText, code: string, service: string): string | undefined {
  const { t } = text;
  const s = { service };
  switch (code) {
    case "PROVIDER_METADATA_KEY_INVALID":
    case "PROVIDER_METADATA_CREDENTIAL_MISSING":
      return t("connect.errRejected", s);
    case "PROVIDER_METADATA_API_NOT_ENABLED":
    case "PROVIDER_METADATA_KEY_RESTRICTED":
    case "PROVIDER_METADATA_PERMISSION_DENIED":
      return t("connect.errForbidden", s);
    case "PROVIDER_METADATA_RATE_LIMITED":
    case "PROVIDER_METADATA_REJECTED":
      return t("connect.errQuota", s);
    case "PROVIDER_METADATA_NETWORK":
    case "PROVIDER_METADATA_TIMEOUT":
    case "PROVIDER_METADATA_UPSTREAM_ERROR":
      return t("connect.errUnreachable", s);
    case "PROVIDER_METADATA_CREDENTIAL_MALFORMED":
    case "PROVIDER_CREDENTIAL_MALFORMED":
      return t("connect.errMalformed");
    case "PROVIDER_CREDENTIAL_EMPTY":
      return t("connect.errEmpty", s);
    case "PROVIDER_KEY_TEST_RATE_LIMITED":
      return t("connect.errRateLimited", { minutes: 1 });
    case "PROVIDER_METADATA_INVALID":
    case "PROVIDER_METADATA_TOO_LARGE":
    case "PROVIDER_METADATA_UNAVAILABLE":
    case "PROVIDER_METADATA_UNSUPPORTED":
    case "PROVIDER_KEY_TEST_INVALID":
      return t("connect.errUnexpected");
    default:
      return undefined;
  }
}
export const unreachable = (code: string) =>
  ["PROVIDER_METADATA_NETWORK", "PROVIDER_METADATA_TIMEOUT", "PROVIDER_METADATA_UPSTREAM_ERROR"].includes(code);

/** A modal confirmation in the page's language. */
export function Confirm({
  title,
  body,
  confirm,
  onConfirm,
  onCancel,
  pending,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  const text = useAiText();
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId(),
    bodyId = useId();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null,
      dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      before?.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="dialog ai-confirm"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      lang={text.locale}
      dir={text.dir}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <p id={bodyId}>{body}</p>
      <div className="ai-actions">
        <button type="button" className="button secondary" onClick={onCancel} disabled={pending}>
          {text.t("confirm.cancel")}
        </button>
        <button type="button" className="button danger" onClick={onConfirm} disabled={pending}>
          {confirm}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
/** "2 minutes ago" in the page's language. */
export function relativeTime(locale: string, iso: string, now = Date.now()) {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000),
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "minute");
}
