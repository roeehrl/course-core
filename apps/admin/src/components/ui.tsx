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
export function Status({ value }: { value: string }) {
  return <Badge tone={statusTone(value)}>{value.replaceAll("_", " ")}</Badge>;
}
export function Card({
  title,
  eyebrow,
  children,
  actions,
  className = "",
}: PropsWithChildren<{
  title?: string;
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
            {title && <h2>{title}</h2>}
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
  hint,
  children,
  htmlFor,
}: PropsWithChildren<{ label: string; hint?: string; htmlFor: string }>) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
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
  return (
    <div className="stack">
      <Notice tone="red">{errorMessage(error)}</Notice>
      {onRetry && (
        <Button onClick={onRetry}>
          Refresh and try again <ArrowRight size={16} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
export function Loading({ label = "Loading workspace…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={24} className="spinner" aria-hidden="true" />
      <span>{label}</span>
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
  return permissions.includes(required) ? null : (
    <p className="permission-note">
      <LockKeyhole size={14} aria-hidden="true" />
      Your role has read-only access to this action.
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
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export const when = (value: string) =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value)) + " UTC";

export function Dialog({
  title,
  onClose,
  children,
  pending = false,
  eyebrow = "Workspace action",
  className = "",
}: PropsWithChildren<{
  title: string;
  onClose: () => void;
  pending?: boolean;
  eyebrow?: string;
  className?: string;
}>) {
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
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <Button
          kind="quiet"
          aria-label={`Close ${title}`}
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
