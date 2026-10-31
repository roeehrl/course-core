import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ArrowRight,
  CircleCheck,
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
      {/* Drawn in sentence case ("Active"), whatever the catalog's running-text form. */}
      <span className="status-text">
        {label ?? (i18n.has(key) ? i18n.t(key) : value.replaceAll("_", " "))}
      </span>
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
/**
 * Moves focus to a control without scrolling the page. Focus that goes back to a control in the
 * sticky app bar (the account menu, the bell, the navigation button) made the browser scroll the
 * page so the control cleared the bar's scroll padding: the page jumped by hundreds of pixels
 * each time a menu or dialog closed. Use it whenever focus returns to where the person already
 * is; let focus that leads somewhere new scroll as usual.
 */
export function focusInPlace(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true });
}
/**
 * Notes where the window is scrolled to now and returns a function that puts it back there if
 * anything moved it meanwhile (a browser restoring focus, a scroll lock, a layout change).
 */
export function keepScrollPosition() {
  const left = window.scrollX,
    top = window.scrollY;
  return () => {
    if (
      Math.round(window.scrollX) !== Math.round(left) ||
      Math.round(window.scrollY) !== Math.round(top)
    )
      window.scrollTo({ left, top, behavior: "instant" });
  };
}
/**
 * Stops the page scrolling behind a modal without moving it: where the window shows a classic
 * scrollbar, its space stays reserved while the scrollbar is hidden, and the page is where it was
 * when the lock ends. Returns the undo.
 */
export function lockPageScroll() {
  const root = document.documentElement,
    body = document.body;
  const before = {
    overflow: body.style.overflow,
    gutter: root.style.scrollbarGutter,
  };
  const restore = keepScrollPosition();
  if (window.innerWidth - root.clientWidth > 0)
    root.style.scrollbarGutter = "stable";
  body.style.overflow = "hidden";
  return () => {
    body.style.overflow = before.overflow;
    root.style.scrollbarGutter = before.gutter;
    restore();
  };
}
/**
 * Marks a scrolling dialog with `data-more-below` while part of it is below its bottom edge, so
 * its sticky actions (styles.css, .dialog-footer) show a divider only when content scrolls under
 * them.
 */
export function useMoreBelow(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      element.toggleAttribute(
        "data-more-below",
        element.scrollTop + element.clientHeight < element.scrollHeight - 1,
      );
    update();
    element.addEventListener("scroll", update, { passive: true });
    const sizes =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const watch = () => {
      sizes?.disconnect();
      sizes?.observe(element);
      for (const child of Array.from(element.children)) sizes?.observe(child);
      update();
    };
    watch();
    const children =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(watch);
    children?.observe(element, { childList: true });
    return () => {
      element.removeEventListener("scroll", update);
      sizes?.disconnect();
      children?.disconnect();
    };
  }, [ref]);
}
/**
 * Keeps Tab inside a modal container in every browser, wrapping at either end. A control that
 * uses Tab itself (and prevents its default) keeps it.
 */
export function trapTab(
  event: ReactKeyboardEvent<HTMLElement>,
  container: HTMLElement,
) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const items = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((item) => !item.hidden && item.getClientRects().length > 0);
  const first = items[0],
    last = items.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
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
  // The latest close handler and pending flag, for the native close event below.
  const latest = useRef({ onClose, pending });
  latest.current = { onClose, pending };
  const unmounting = useRef(false);
  useMoreBelow(ref);
  useEffect(() => {
    unmounting.current = false;
    const before = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    // A modal dialog makes the rest of the page inert and sits in the top layer, so the page
    // underneath neither moves nor takes focus. The lock notes the page's place first.
    const unlock = lockPageScroll();
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      unmounting.current = true;
      dialog.close();
      // Focus goes back to the control that opened the dialog, and the page stays where it was.
      if (before?.isConnected) focusInPlace(before);
      unlock();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-modal="true"
      className={`dialog ${className}`.trim()}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClose={() => {
        // A browser can close a modal dialog without a cancel event (Chrome does on a repeated
        // Escape). Keep React's state in step instead of leaving an invisible dialog open.
        if (unmounting.current) return;
        if (latest.current.pending) ref.current?.showModal();
        else latest.current.onClose();
      }}
      onKeyDown={(event) => trapTab(event, ref.current!)}
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

export interface ToastMessage {
  /** A new id shows the message again even when its text is the same. */
  id: number;
  tone: "green" | "red";
  /** Translated when shown, so the message follows a language switch made while it shows. */
  message: MessageKey;
}
/** How long a confirmation stays when the pointer and focus are elsewhere. */
const TOAST_MS = 8000;
/**
 * A short message floating at the bottom of the window, announced as a status (an error as an
 * alert). It never moves the page. A confirmation fades after a few seconds unless the pointer
 * or focus is on it; an error stays until it is dismissed.
 */
export function ToastRegion({
  toast,
  onDismiss,
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
}) {
  const t = useT();
  const [held, setHeld] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!toast || toast.tone === "red" || held) return;
    const timer = setTimeout(() => dismiss.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, held]);
  useEffect(() => setHeld(false), [toast?.id]);
  const body = toast && (
    <div
      className={`toast ${toast.tone}`}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {toast.tone === "green" ? (
        <CircleCheck size={18} aria-hidden="true" />
      ) : (
        <AlertCircle size={18} aria-hidden="true" />
      )}
      <p>{t(toast.message)}</p>
      <button
        type="button"
        className="toast-dismiss"
        aria-label={t("ui.dismiss")}
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
  return (
    <div className="toast-region">
      <div role="status">{toast?.tone === "green" && body}</div>
      <div role="alert">{toast?.tone === "red" && body}</div>
    </div>
  );
}
