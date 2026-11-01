import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../components/icons/Icon.web";
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
  /** `reply_ready`, read by the server when listed: the lesson's title in the course version the
   * learner follows now (null: that version no longer has the lesson, or the row names none). */
  lessonTitle?: string | null;
  /** `reply_ready`: the start of the learner's question (null once it was deleted or erased). */
  questionExcerpt?: string | null;
}
export interface LearnerNotificationPage {
  unread: number;
  items: LearnerNotification[];
  nextCursor: string | null;
}
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

/** Where a learner notification points: a course, optionally its companion and, for a reply, the
 * lesson, the part and the reply it is about (absent on older rows). */
export interface NotificationTarget {
  enrollmentId: string;
  companion: boolean;
  episodeId?: string;
  blockId?: string;
  replyMessageId?: string;
  /** The reply's lesson is no longer in the course: it opens on the course page. */
  lessonGone?: boolean;
}

const COURSE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const param = (item: Pick<LearnerNotification, "params"> | undefined, name: string, shape: RegExp) => {
  const value = item?.params[name];
  return typeof value === "string" && shape.test(value) ? value : undefined;
};

/** Where a learner notification points: only the learner's own course pages, and for a reply the
 * ids the server sent with it (anything else in its parameters is ignored). */
export function learnerNotificationTarget(
  link: string | null,
  item?: Pick<LearnerNotification, "kind" | "params" | "lessonTitle">,
): NotificationTarget | null {
  const match = link ? /^\/enrollments\/([0-9a-f-]{36})(\/companion)?$/.exec(link) : null;
  if (!match) return null;
  const target: NotificationTarget = { enrollmentId: match[1]!, companion: Boolean(match[2]) };
  if (!target.companion || item?.kind !== "reply_ready") return target;
  const episodeId = param(item, "episodeId", COURSE_ID),
    blockId = param(item, "blockId", COURSE_ID),
    replyMessageId = param(item, "replyMessageId", UUID);
  if (replyMessageId) target.replyMessageId = replyMessageId;
  if (!episodeId) return target;
  if (item.lessonTitle === null) return { ...target, lessonGone: true };
  return { ...target, episodeId, ...(blockId ? { blockId } : {}) };
}

/** The time of a notification: the time alone today, "Yesterday" the day before, the date and
 * time before that. */
function when(i18n: ReturnType<typeof useI18n>, value: string, now = new Date()) {
  const at = new Date(value),
    yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (at.toDateString() === now.toDateString()) return i18n.time(at, "short");
  if (at.toDateString() === yesterday.toDateString()) return i18n.t("notifications.row.yesterday");
  return i18n.dateTime(at);
}

/**
 * The learner's notifications (owner decision 8): the course was updated, a newer version is
 * offered, the companion answered while they were away. A bell in the header, with a dot while
 * something is new and the count in its name; the list is a disclosure like the course menu (final
 * design §4.8). Each row is one button: its icon,
 * what happened, a second line and a dot while it is new. A reply's row names its lesson and
 * quotes the question; opening it marks it read and goes to that lesson with the companion open at
 * the reply (openNotification.ts), or to the course page when the lesson left the course.
 */
export function LearnerNotifications({
  request,
  onOpen,
}: {
  request: Request;
  onOpen: (target: NotificationTarget) => void;
}) {
  const i18n = useI18n(),
    t = i18n.t;
  const [page, setPage] = useState<LearnerNotificationPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);

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
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setExpanded(false);
      // The bell is in the sticky header: focus goes back without scrolling the page.
      toggle.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);

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
  const markAll = async () => {
    await markRead();
    // "Mark all as read" goes once nothing is new: focus stays in the list, on its heading.
    heading.current?.focus({ preventScroll: true });
  };
  const text = (item: LearnerNotification) => {
    const from = String(item.params.fromVersion ?? ""),
      to = String(item.params.toVersion ?? "");
    if (item.kind === "course_updated") return t("notifications.kind.course_updated", { from, to });
    if (item.kind === "move_offer") return t("notifications.kind.move_offer", { to });
    if (item.kind === "move_forced") return t("notifications.kind.move_forced", { from, to });
    if (item.kind === "reply_ready")
      return item.lessonTitle ? t("notifications.reply.about", { lesson: item.lessonTitle }) : t("notifications.kind.reply_ready");
    return t("notifications.kind.unknown");
  };
  const open = (item: LearnerNotification, target: NotificationTarget) => {
    if (!item.read) void markRead([item.id]);
    setExpanded(false);
    onOpen(target);
  };
  const unread = page?.unread ?? 0;
  return (
    <div className="connected-notifications" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="connected-bell"
        aria-expanded={expanded}
        aria-controls={`${id}-panel`}
        aria-label={unread ? t("notifications.bell.labelUnread", { count: unread }) : t("notifications.bell.label")}
        onClick={() => {
          setExpanded((value) => !value);
          if (!expanded) void load();
        }}
      >
        {/* A 36 px disc in the 44 px target, with an `--accent` dot while something is new; the
            count is in the name. */}
        <span className="connected-bell-disc">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {unread > 0 && <span className="connected-bell-dot" aria-hidden="true" />}
        </span>
      </button>
      <section id={`${id}-panel`} className="connected-notifications-panel" aria-labelledby={`${id}-title`} hidden={!expanded}>
        <h2 ref={heading} id={`${id}-title`} className="connected-notifications-heading" tabIndex={-1}>
          {t("notifications.panel.title")}
        </h2>
        {failed && (
          <p className="connected-notifications-note" role="alert">
            {t("notifications.panel.error")}{" "}
            <button type="button" className="cc-note-retry" onClick={() => void load()}>
              {t("notifications.panel.retry")}
            </button>
          </p>
        )}
        {!page && !failed && <p className="connected-notifications-note">{t("notifications.panel.loading")}</p>}
        {page && page.items.length === 0 && <p className="connected-notifications-note">{t("notifications.panel.empty")}</p>}
        {page && page.items.length > 0 && (
          <ul className="cc-note-list">
            {page.items.map((item) => {
              const target = learnerNotificationTarget(item.link, item);
              const reply = item.kind === "reply_ready";
              const row = `${id}-${item.id}`;
              const lines = (
                <>
                  <span className="cc-note-icon">
                    <Icon name={reply ? "sparkle" : "bell"} size={20} />
                  </span>
                  <span className="cc-note-text">
                    {!item.read && (
                      <span id={`${row}-new`} className="cc-ui-sr-only">
                        {t("notifications.row.new")}
                      </span>
                    )}
                    <span id={`${row}-what`} className="cc-note-what" dir="auto">
                      {text(item)}
                    </span>
                    <span id={`${row}-meta`} className="cc-note-meta">
                      {reply && item.questionExcerpt ? (
                        t("notifications.row.excerpt", { question: item.questionExcerpt, time: when(i18n, item.updatedAt) })
                      ) : (
                        <time dateTime={item.updatedAt}>{when(i18n, item.updatedAt)}</time>
                      )}
                    </span>
                    {target?.lessonGone && (
                      <span id={`${row}-gone`} className="cc-note-meta">
                        {t("notifications.reply.lessonGone")}
                      </span>
                    )}
                  </span>
                  <span className="cc-note-dot" aria-hidden="true" />
                </>
              );
              const describedBy = [!item.read && "new", "what", "meta", target?.lessonGone && "gone"]
                .filter(Boolean)
                .map((part) => `${row}-${part}`)
                .join(" ");
              return (
                <li key={item.id} className={item.read ? "read" : "unread"}>
                  {target ? (
                    <button
                      type="button"
                      className="cc-note-row"
                      aria-label={reply ? t("notifications.row.openReply") : t("notifications.panel.open")}
                      aria-describedby={describedBy}
                      disabled={busy}
                      onClick={() => open(item, target)}
                    >
                      {lines}
                    </button>
                  ) : (
                    <div className="cc-note-row">{lines}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {unread > 0 && (
          <button type="button" className="cc-note-mark" disabled={busy} onClick={() => void markAll()}>
            {t("notifications.panel.markAll")}
          </button>
        )}
      </section>
    </div>
  );
}
