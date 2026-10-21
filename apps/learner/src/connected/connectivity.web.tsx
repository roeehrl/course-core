import React, { useEffect, useState } from "react";
import type { DraftVersion } from "./drafts";
import { englishTranslator, useI18n, useT, type MessageKey, type Translate } from "../i18n";

/** Whether the browser reports a network connection. "Online" is only a hint:
 * a request can still fail, and nothing counts until the server confirms it. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** Calls `onReturn` when the page becomes visible again after being hidden
 * (another tab, app switch, phone lock), with how long it was away. */
export function usePageReturn(onReturn: (awayMs: number) => void) {
  const callback = React.useRef(onReturn);
  callback.current = onReturn;
  useEffect(() => {
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : 0;
    const change = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt) {
        const away = Date.now() - hiddenAt;
        hiddenAt = 0;
        callback.current(away);
      }
    };
    // A page restored from the back/forward cache is a return as well.
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) callback.current(Number.POSITIVE_INFINITY);
    };
    document.addEventListener("visibilitychange", change);
    window.addEventListener("pageshow", shown);
    return () => {
      document.removeEventListener("visibilitychange", change);
      window.removeEventListener("pageshow", shown);
    };
  }, []);
}

const PENDING_ACTIONS = new Set(["answers", "read", "complete", "companion", "challenges", "profile", "solution"]);
/** The kind of saved request, as the connection messages name it. */
export function pendingActionKind(action: string | undefined) {
  if (!action) return "other";
  if (PENDING_ACTIONS.has(action)) return action;
  return action.startsWith("reviews/") ? "reviewReply" : "other";
}
export function pendingActionName(action: string | undefined, t: Translate = englishTranslator().t) {
  return t(`connectivity.action.${pendingActionKind(action)}` as MessageKey);
}

/** The connection banner and the state of a request that is saved on this
 * device but not yet confirmed by the server. */
export function ConnectionStatus({
  online,
  pendingAction,
  pending,
  onRetry,
}: {
  online: boolean;
  /** The action of a saved, unconfirmed request, if there is one. */
  pendingAction?: string | null;
  pending: boolean;
  onRetry: () => void;
}) {
  const waiting = pendingAction !== undefined && pendingAction !== null;
  const i18n = useI18n();
  if (online && !waiting) return null;
  const action = pendingActionKind(pendingAction ?? undefined);
  const strong = (children: React.ReactNode, key: string) => <strong key={key}>{children}</strong>;
  return (
    <div
      className={`connected-connection ${online ? "" : "is-offline"}`}
      role="status"
    >
      <p>
        {!online && <strong>{i18n.t("connectivity.offline")} </strong>}
        {waiting
          ? i18n.rich(online ? "connectivity.pending.online" : "connectivity.pending.offline", { action }, { strong })
          : i18n.t("connectivity.offlineDrafts")}
      </p>
      {waiting && online && (
        <button
          type="button"
          className="connected-connection-retry"
          disabled={pending}
          onClick={onRetry}
        >
          {i18n.t("connectivity.retry")}
        </button>
      )}
    </div>
  );
}

const savedTime = (i18n: ReturnType<typeof useI18n>, version: DraftVersion) =>
  i18n.dateTime(version.updatedAt, { hour: "numeric", minute: "2-digit" });

/** Two tabs or windows changed the same draft: both versions are kept until the
 * learner chooses one. */
export function DraftConflict({
  label,
  shown,
  other,
  onKeepShown,
  onUseOther,
}: {
  label: string;
  shown: DraftVersion;
  other: DraftVersion;
  onKeepShown: () => void;
  onUseOther: () => void;
}) {
  const i18n = useI18n(),
    t = useT();
  return (
    <section
      className="connected-draft-conflict"
      aria-label={t("connectivity.conflict.label", { label })}
    >
      <p>
        <strong>{t("connectivity.conflict.changed", { label })}</strong>{" "}
        {t("connectivity.conflict.kept")}
      </p>
      <details>
        <summary>
          {other.updatedAt > 0
            ? t("connectivity.conflict.showOther", { time: savedTime(i18n, other) })
            : t("connectivity.conflict.showOtherEarlier")}
        </summary>
        <pre dir="auto">{other.value || t("connectivity.conflict.empty")}</pre>
      </details>
      <div className="connected-draft-conflict-actions">
        <button type="button" onClick={onKeepShown}>
          {t("connectivity.conflict.keepShown")}
        </button>
        <button type="button" onClick={onUseOther}>
          {t("connectivity.conflict.useOther")}
        </button>
      </div>
      <p className="connected-muted">
        {shown.updatedAt > 0
          ? t("connectivity.conflict.shownSaved", { time: savedTime(i18n, shown) })
          : t("connectivity.conflict.shownSavedEarlier")}
      </p>
    </section>
  );
}
