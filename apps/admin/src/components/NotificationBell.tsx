import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import {
  notificationTarget,
  type NotificationPage,
  type NotificationsPort,
  type StaffNotification,
} from "../domain/notifications";
import { useFormatters, useI18n, type MessageKey } from "../i18n";
import { Button, focusInPlace } from "./ui";

/** How often the bell's count is refreshed while the page is open. */
const POLL_MS = 120_000;

export interface NotificationBellProps {
  port: NotificationsPort;
  workspaceId: string;
  /** Course titles by id, for naming the course a notification is about. */
  courseTitles: ReadonlyMap<string, string>;
  /** Opens the place to act: a view, on the given course or the current one. */
  onOpen: (target: { view: string; courseId: string | null }) => void;
}

/**
 * The staff notification center: a bell with the unread count in the top bar, opening a panel of
 * what needs attention now. Opening one marks it read and goes to the place to act.
 */
export function NotificationBell({
  port,
  workspaceId,
  courseTitles,
  onOpen,
}: NotificationBellProps) {
  const i18n = useI18n();
  const t = i18n.t;
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await port.list(workspaceId, signal ? { signal } : {});
        setPage(next);
        setFailed(false);
      } catch {
        if (!signal?.aborted) setFailed(true);
      }
    },
    [port, workspaceId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (!open) return;
    // The panel hangs from the sticky top bar: moving focus into it, or back to the bell, must
    // not scroll the page.
    focusInPlace(heading.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        focusInPlace(button.current);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const markRead = async (ids?: string[]) => {
    setBusy(true);
    try {
      setPage(await port.markRead(workspaceId, ids));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const unread = page?.unread ?? 0;
  const label =
    unread > 0
      ? t("notifications.bell.labelUnread", { count: unread })
      : t("notifications.bell.label");

  return (
    <div className="notification-center">
      <button
        ref={button}
        type="button"
        className="notification-bell"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
      >
        <Bell size={19} aria-hidden="true" />
        {unread > 0 && (
          <span className="notification-count" aria-hidden="true">
            {unread > 99 ? "99+" : i18n.number(unread)}
          </span>
        )}
      </button>
      {open && (
        <section
          id={panelId}
          className="notification-panel"
          role="dialog"
          aria-labelledby={`${panelId}-title`}
        >
          <div className="notification-panel-head">
            <h2 id={`${panelId}-title`} tabIndex={-1} ref={heading}>
              {t("notifications.panel.title")}
            </h2>
            <Button
              kind="quiet"
              aria-label={t("notifications.panel.close")}
              onClick={() => {
                setOpen(false);
                focusInPlace(button.current);
              }}
            >
              <X size={18} aria-hidden="true" />
            </Button>
          </div>
          <p className="notification-intro">{t("notifications.panel.intro")}</p>
          {failed && (
            <p className="notification-error" role="alert">
              {t("notifications.panel.error")}{" "}
              <Button kind="quiet" onClick={() => void load()}>
                {t("notifications.panel.retry")}
              </Button>
            </p>
          )}
          {!page && !failed && (
            <p aria-live="polite">{t("notifications.panel.loading")}</p>
          )}
          {page && page.items.length === 0 && (
            <p className="notification-empty">
              {t("notifications.panel.empty")}
            </p>
          )}
          {page && page.items.length > 0 && (
            <>
              <ul className="notification-list">
                {page.items.map((item) => (
                  <NotificationItem
                    key={item.id}
                    item={item}
                    courseTitles={courseTitles}
                    disabled={busy}
                    onOpen={() => {
                      const target = notificationTarget(item.link);
                      if (!item.read) void markRead([item.id]);
                      setOpen(false);
                      if (target) onOpen(target);
                    }}
                  />
                ))}
              </ul>
              {unread > 0 && (
                <Button
                  kind="secondary"
                  disabled={busy}
                  onClick={() => void markRead()}
                >
                  {t("notifications.panel.markAll")}
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function NotificationItem({
  item,
  courseTitles,
  disabled,
  onOpen,
}: {
  item: StaffNotification;
  courseTitles: ReadonlyMap<string, string>;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { title, body } = useNotificationText(item, courseTitles);
  const { when } = useFormatters();
  const i18n = useI18n();
  const t = i18n.t;
  return (
    <li className={item.read ? "read" : "unread"}>
      <div>
        <strong>
          {!item.read && (
            <span className="badge blue">
              {t("notifications.panel.unread")}
            </span>
          )}{" "}
          <span dir="auto">{title}</span>
        </strong>
        {body && <p dir="auto">{body}</p>}
        <small>
          {t("notifications.panel.updated", { when: when(item.updatedAt) })}
        </small>
      </div>
      {notificationTarget(item.link) && (
        <Button kind="secondary" disabled={disabled} onClick={onOpen}>
          {t("notifications.panel.open")}
        </Button>
      )}
    </li>
  );
}

/** A notification's title and body in the reader's language, from its kind and parameters. */
export function useNotificationText(
  item: StaffNotification,
  courseTitles: ReadonlyMap<string, string>,
) {
  const i18n = useI18n();
  const t = i18n.t;
  const p = item.params;
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  const course =
    (typeof p.courseId === "string" && courseTitles.get(p.courseId)) ||
    t("notifications.panel.thisCourse");
  switch (item.kind) {
    case "approvals_waiting":
      return {
        title: t("notifications.kind.approvals_waiting.title", {
          count: num(p.count),
        }),
        body: t("notifications.kind.approvals_waiting.body", { course }),
      };
    case "ai_check_needed": {
      const roleKey = `aiServices.role.${String(p.role)}.name` as MessageKey;
      const role = i18n.has(roleKey) ? t(roleKey) : String(p.role);
      return {
        title: t("notifications.kind.ai_check_needed.title", { role }),
        body:
          p.checkable === false
            ? t("notifications.kind.ai_check_needed.bodyUncheckable")
            : p.failed
              ? t("notifications.kind.ai_check_needed.bodyFailed")
              : t("notifications.kind.ai_check_needed.body"),
      };
    }
    case "jobs_failed":
      return {
        title: t("notifications.kind.jobs_failed.title", {
          count: num(p.count),
        }),
        body: t("notifications.kind.jobs_failed.body", { course }),
      };
    case "budget_near_limit":
      return {
        title: t("notifications.kind.budget_near_limit.title", {
          percent: num(p.percent),
        }),
        body: t("notifications.kind.budget_near_limit.body"),
      };
    case "help_paused": {
      // AI help held back by a spending limit: the workspace total, or learners' own limits.
      const scope = p.scope === "learner" ? "learner" : "workspace";
      const counts = { learners: num(p.learners), requests: num(p.requests) };
      return scope === "learner"
        ? {
            title: t("notifications.kind.help_paused.learner.title", counts),
            body: t("notifications.kind.help_paused.learner.body", counts),
          }
        : {
            title: t("notifications.kind.help_paused.workspace.title"),
            body: t("notifications.kind.help_paused.workspace.body", counts),
          };
    }
    case "questions_exhausted":
      return {
        title: t("notifications.kind.questions_exhausted.title", {
          learners: num(p.learners),
        }),
        body: t("notifications.kind.questions_exhausted.body", {
          course,
          lessons: num(p.lessons),
        }),
      };
    case "backups_overdue":
      return {
        title: t("notifications.kind.backups_overdue.title"),
        body: t("notifications.kind.backups_overdue.body", {
          minutes: num(p.minutes),
          target: num(p.targetMinutes),
        }),
      };
    default:
      return { title: t("notifications.kind.unknown.title"), body: null };
  }
}
