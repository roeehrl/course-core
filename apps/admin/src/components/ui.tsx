import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ArrowRight,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";
import { errorMessage } from "../domain/errors";
import { useI18n, useT, type MessageKey } from "../i18n";
import type { Permission } from "../domain/contracts";

export function Button({
  kind = "secondary",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: "primary" | "secondary" | "quiet" | "danger";
}) {
  return (
    <button {...props} className={`button ${kind} ${props.className ?? ""}`}>
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{
  tone?: "neutral" | "blue" | "gold" | "green" | "red";
}>) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
const statusTone = (status: string) =>
  /accepted|approved|published|completed|recorded|eligible/.test(status)
    ? "green"
    : /pending|draft/.test(status)
      ? "gold"
      : /denied|failed|rejected|blocked|stale|absent|missing/.test(status)
        ? "red"
        : "neutral";
/**
 * A state badge. Pass a translated `label`, or let the shared state names in the `ui`
 * namespace (`ui.status.<code>`) name a common state; an unknown code is shown as is.
 */
export function Status({ value, label }: { value: string; label?: string }) {
  const i18n = useI18n();
  const key = `ui.status.${value}` as MessageKey;
  return (
    <Badge tone={statusTone(value)}>
      {label ?? (i18n.has(key) ? i18n.t(key) : value.replaceAll("_", " "))}
    </Badge>
  );
}
export function Card({
  title,
  titleDir,
  eyebrow,
  children,
  actions,
  className = "",
}: PropsWithChildren<{
  title?: ReactNode;
  /** "auto" when the title is user or course text, "ltr" for an identifier. */
  titleDir?: "auto" | "ltr";
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
}>) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="section-heading">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && <h2 dir={titleDir}>{title}</h2>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function Field({
  label,
  labelDir,
  hint,
  children,
  htmlFor,
}: PropsWithChildren<{
  label: string;
  /** "auto" when the label is user or course text (a course's own field name). */
  labelDir?: "auto" | "ltr";
  hint?: string;
  htmlFor: string;
}>) {
  return (
    <div className="field">
      <label htmlFor={htmlFor} dir={labelDir}>
        {label}
      </label>
      {children}
      {hint && <small id={`${htmlFor}-hint`}>{hint}</small>}
    </div>
  );
}
export function Notice({
  children,
  tone = "blue",
  title,
}: PropsWithChildren<{
  tone?: "blue" | "gold" | "red" | "green";
  title?: string;
}>) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "red" ? "alert" : "status"}
    >
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const t = useT();
  return (
    <div className="stack">
      <Notice tone="red">{errorMessage(error, t)}</Notice>
      {onRetry && (
        <Button onClick={onRetry}>
          {t("ui.retry")}{" "}
          <ArrowRight size={16} aria-hidden="true" className="flip-rtl" />
        </Button>
      )}
    </div>
  );
}
export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="loading" role="status">
      <LoaderCircle size={24} className="spinner" aria-hidden="true" />
      <span>{label ?? t("ui.loading")}</span>
    </div>
  );
}
export function EmptyState({
  title,
  children,
}: PropsWithChildren<{ title: string }>) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function PermissionHint({
  permissions,
  required,
}: {
  permissions: Permission[];
  required: Permission;
}) {
  const t = useT();
  return permissions.includes(required) ? null : (
    <p className="permission-note">
      <LockKeyhole size={14} aria-hidden="true" />
      {t("ui.readOnly")}
    </p>
  );
}
export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail: string;
}) {
  return (
    <div className="stat">
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
export function Dialog({
  title,
  titleDir,
  onClose,
  children,
  pending = false,
  eyebrow,
  className = "",
}: PropsWithChildren<{
  title: string;
  /** "auto" when the title is user or course text. */
  titleDir?: "auto" | "ltr";
  onClose: () => void;
  pending?: boolean;
  eyebrow?: string;
  className?: string;
}>) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`dialog ${className}`.trim()}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) {
          const rect = ref.current!.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">{eyebrow ?? t("ui.dialogEyebrow")}</p>
          <h2 id={titleId} dir={titleDir}>
            {title}
          </h2>
        </div>
        <Button
          kind="quiet"
          aria-label={t("ui.closeNamed", { title })}
          onClick={onClose}
          disabled={pending}
        >
          <X size={20} aria-hidden="true" />
        </Button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
