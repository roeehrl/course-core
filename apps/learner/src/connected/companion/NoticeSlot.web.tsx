import React from "react";
import type { ServerSnapshot } from "../../client/apiClient";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";
import { CreditNotice } from "../credit/CreditNotice.web";
import { NoticeBanner } from "../ui/NoticeBanner.web";
import { companionBridge } from "./bridge";
import type { Notice } from "./notices";

export interface NoticeSlotProps {
  notice?: Notice;
  /** The id the item carries, for the message box's `aria-describedby`. */
  id: string;
  server?: ServerSnapshot;
  episodeId?: string;
  now: number;
  onDraftChoice?(keep: "shown" | "other"): void;
  onShowRecovered?(): void;
}

/**
 * The one item above the pill (final design §3.6, §3.13): a limitation banner (`--surface-2`,
 * radius 12, a 16 px icon, at most one text action and an optional ⓘ), or the credit line. When
 * every question a closed course allows is used, a block replaces the pill instead.
 */
export function NoticeSlot({ notice, id, server, episodeId, now, onDraftChoice, onShowRecovered }: NoticeSlotProps) {
  const t = useT();
  if (!notice) return null;
  const body = (() => {
    switch (notice.kind) {
      case "exhausted":
        return (
          <div className="cc-chat-exhausted">
            <Icon name="lock" size={16} />
            <p>{t("noticeSlot.exhausted")}</p>
          </div>
        );
      case "paused":
        return (
          <NoticeBanner
            icon="pause-circle"
            text={t(
              notice.ceiling === "workspace" ? "noticeSlot.paused.workspace"
              : notice.ceiling === "enrollment" ? "noticeSlot.paused.enrollment"
              : notice.ceiling === "artifact" ? "noticeSlot.paused.lesson" : "noticeSlot.paused.today",
            )}
            {...(notice.ceiling === "workspace"
              ? { info: { label: t("noticeSlot.more"), text: t("noticeSlot.paused.workspaceMore") } }
              : notice.ceiling === "daily"
                ? { info: { label: t("noticeSlot.more"), text: t("noticeSlot.paused.todayMore") } }
                : {})}
          />
        );
      case "notSetUp":
        return <NoticeBanner icon="info" text={t("noticeSlot.notSetUp")} />;
      case "lessonUnavailable":
        return <NoticeBanner icon="lock" text={t("noticeSlot.lessonUnavailable")} />;
      case "outsideLesson": {
        const next = notice.next;
        return (
          <NoticeBanner
            icon="book-open"
            text={t("noticeSlot.outsideLesson")}
            {...(next ? { action: { label: t("noticeSlot.goTo", { lesson: next.title }), onPress: () => void companionBridge.navigate({ to: "lesson", episodeId: next.episodeId }) } } : {})}
          />
        );
      }
      case "offline":
        return <NoticeBanner icon="wifi-off" text={t("noticeSlot.offline")} />;
      case "draftConflict":
        return (
          <div className="cc-ui-notice cc-chat-conflict" role="group" aria-label={t("noticeSlot.conflict")}>
            <Icon name="info" size={16} />
            <div className="cc-ui-notice-body">
              <p className="cc-ui-notice-text">{t("noticeSlot.conflict")}</p>
              <div className="cc-chat-conflict-actions">
                <button type="button" className="cc-ui-text-button" onClick={() => onDraftChoice?.("shown")}>
                  {t("noticeSlot.useThis")}
                </button>
                <button type="button" className="cc-ui-text-button" onClick={() => onDraftChoice?.("other")}>
                  {t("noticeSlot.useSaved")}
                </button>
              </div>
            </div>
          </div>
        );
      case "recovered":
        return (
          <NoticeBanner
            icon="rotate-ccw"
            text={t("noticeSlot.recovered")}
            {...(onShowRecovered ? { action: { label: t("noticeSlot.showIt"), onPress: onShowRecovered } } : {})}
          />
        );
      case "storage":
        return <NoticeBanner icon="info" text={t("noticeSlot.storage")} />;
      case "closed":
        return (
          <NoticeBanner
            icon="lock"
            text={t("noticeSlot.closed", { remaining: notice.remaining })}
            info={{
              label: t("noticeSlot.more"),
              text: notice.used !== undefined && notice.budget !== undefined
                ? t("noticeSlot.closedMoreUsed", { used: notice.used, budget: notice.budget })
                : t("noticeSlot.closedMore"),
            }}
          />
        );
      case "credit":
        return <CreditNotice server={server} episodeId={episodeId} now={now} placement="notice" />;
    }
  })();
  return (
    <div id={id} className="cc-chat-notice" data-notice={notice.kind}>
      {body}
    </div>
  );
}
