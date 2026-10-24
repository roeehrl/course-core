import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";

/** How often the count is refreshed while the page is open. */
const POLL_MS = 120_000;

export interface LearnerNotification {
  id: string;
  kind: string;
  params: Record<string, string | number | boolean | null>;
  link: string | null;
  enrollmentId: string | null;
  createdAt: string;
  updatedAt: string;
  read: boolean;
}
export interface LearnerNotificationPage {
  unread: number;
  items: LearnerNotification[];
  nextCursor: string | null;
}
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

/** Where a learner notification points: a course, optionally its companion. */
export function learnerNotificationTarget(link: string | null): { enrollmentId: string; companion: boolean } | null {
  const match = link ? /^\/enrollments\/([0-9a-f-]{36})(\/companion)?$/.exec(link) : null;
  return match ? { enrollmentId: match[1]!, companion: Boolean(match[2]) } : null;
}

/**
 * The learner's notifications (owner decision 8): the course was updated, a newer version is
 * offered, the companion answered while they were away. A bell with the count in the header; the
 * list is a disclosure like the course menu. Opening one marks it read and goes to the course.
 */
export function LearnerNotifications({
  request,
  onOpen,
}: {
  request: Request;
  onOpen: (target: { enrollmentId: string; companion: boolean }) => void;
}) {
  const i18n = useI18n(),
    t = i18n.t;
  const [page, setPage] = useState<LearnerNotificationPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null),
    toggle = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setPage(await request<LearnerNotificationPage>("/api/me/notifications"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [request]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const markRead = async (ids?: string[]) => {
    setBusy(true);
    try {
      setPage(await request<LearnerNotificationPage>("/api/me/notifications/read", "POST", ids ? { ids } : { all: true }));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const text = (item: LearnerNotification) => {
    const from = String(item.params.fromVersion ?? ""),
      to = String(item.params.toVersion ?? "");
    if (item.kind === "course_updated") return t("notifications.kind.course_updated", { from, to });
    if (item.kind === "move_offer") return t("notifications.kind.move_offer", { to });
    if (item.kind === "reply_ready") return t("notifications.kind.reply_ready");
    return t("notifications.kind.unknown");
  };
  const unread = page?.unread ?? 0;
  return (
    <div className="connected-notifications" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="connected-bell"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-label={unread ? t("notifications.bell.labelUnread", { count: unread }) : t("notifications.bell.label")}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="connected-bell-count" aria-hidden="true">
            {unread > 99 ? "99+" : i18n.number(unread)}
          </span>
        )}
      </button>
      <div id={`${id}-panel`} className="connected-notifications-panel" hidden={!open}>
        <h2 className="connected-notifications-heading">{t("notifications.panel.title")}</h2>
        {failed && (
          <p className="connected-notifications-note" role="alert">
            {t("notifications.panel.error")}{" "}
            <button type="button" onClick={() => void load()}>
              {t("notifications.panel.retry")}
            </button>
          </p>
        )}
        {!page && !failed && <p className="connected-notifications-note">{t("notifications.panel.loading")}</p>}
        {page && page.items.length === 0 && <p className="connected-notifications-note">{t("notifications.panel.empty")}</p>}
        {page && page.items.length > 0 && (
          <ul>
            {page.items.map((item) => {
              const target = learnerNotificationTarget(item.link);
              return (
                <li key={item.id} className={item.read ? "read" : "unread"}>
                  <p dir="auto">
                    {!item.read && <strong>{t("notifications.panel.new")} · </strong>}
                    {text(item)}
                  </p>
                  <small>{i18n.dateTime(item.updatedAt)}</small>
                  {target && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!item.read) void markRead([item.id]);
                        setOpen(false);
                        onOpen(target);
                      }}
                    >
                      {t("notifications.panel.open")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {unread > 0 && (
          <button type="button" disabled={busy} onClick={() => void markRead()}>
            {t("notifications.panel.markAll")}
          </button>
        )}
      </div>
    </div>
  );
}
