import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** How long a request runs before the connection banner says the server is slow. */
export const SLOW_REQUEST_MS = 6000;
/** True once `busy` has stayed true for `afterMs`; false again as soon as it ends. */
export function useSlow(busy: boolean, afterMs = SLOW_REQUEST_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!busy) return;
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [busy, afterMs]);
  return busy && slow;
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

/** For the stylesheet, while the status shows: the room it takes at the bottom of the window.
 * The sticky answer actions stick that much higher, above it (as a floating button rises for a
 * snackbar), and the learning column gains as much room at its end. */
const STATUS_OFFSET = "--connected-status-offset";
/** The gap between the status and what rises above it. */
const STATUS_GAP_PX = 16;
const ANSWER_ACTIONS = ".connected-answer-actions";

/** The element that scrolls `element`: the learning pane on compact screens, else the page. */
function scrollerOf(element: Element): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** The learning pane on a phone, and the page: what the status's room changes the end of. */
function scrollers(): Element[] {
  const pane = document.querySelector(".connected-main");
  return [...(pane ? [pane] : []), document.scrollingElement ?? document.documentElement];
}
const atEnd = (scroller: Element) =>
  scroller.scrollHeight > scroller.clientHeight + 1 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2;

/**
 * Sets the status's room, keeping the answer actions clear of the question: a sticky answer bar
 * that the extra room would lift over the content above it scrolls that content up with it
 * instead, so the options stay fully visible and tappable above the bar. A pane or page the
 * learner had scrolled to its end stays at its end, so its last buttons (the lesson's next step)
 * rise above the status instead of disappearing behind or under it.
 */
function makeRoom(root: HTMLElement, value: string) {
  const bars = Array.from(document.querySelectorAll(ANSWER_ACTIONS));
  const before = bars.map((bar) => bar.getBoundingClientRect().top);
  const ended = scrollers().filter(atEnd);
  root.style.setProperty(STATUS_OFFSET, value);
  bars.forEach((bar, index) => {
    const lifted = before[index]! - bar.getBoundingClientRect().top;
    if (lifted > 0.5) scrollerOf(bar).scrollBy({ top: lifted, behavior: "instant" });
  });
  for (const scroller of ended) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
}

/** The connection status and the state of a request that is saved on this
 * device but not yet confirmed by the server. It sits at the bottom of the
 * window (see connected.css), takes room there instead of covering the lesson,
 * and never moves the page. */
export function ConnectionStatus({
  online,
  pendingAction,
  pending,
  slow = false,
  onRetry,
}: {
  online: boolean;
  /** A request has been running for longer than SLOW_REQUEST_MS. */
  slow?: boolean;
  /** The action of a saved, unconfirmed request, if there is one. */
  pendingAction?: string | null;
  pending: boolean;
  onRetry: () => void;
}) {
  const waiting = pendingAction !== undefined && pendingAction !== null;
  const i18n = useI18n();
  const shown = !online || waiting || slow;
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!shown || !element) return;
    const root = document.documentElement;
    let room = "";
    const update = () => {
      const next = `${Math.ceil(element.getBoundingClientRect().height) + STATUS_GAP_PX}px`;
      if (next === room) return;
      room = next;
      makeRoom(root, next);
    };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(STATUS_OFFSET);
    };
  }, [shown]);
  if (!shown) return null;
  const action = pendingActionKind(pendingAction ?? undefined);
  const strong = (children: React.ReactNode, key: string) => <strong key={key}>{children}</strong>;
  return (
    <div
      ref={box}
      className={`connected-connection ${online ? "" : "is-offline"}`}
      role="status"
    >
      {(!online || waiting) && (
        <p>
          {!online && <strong>{i18n.t("connectivity.offline")} </strong>}
          {waiting
            ? i18n.rich(online ? "connectivity.pending.online" : "connectivity.pending.offline", { action }, { strong })
            : i18n.t("connectivity.offlineDrafts")}
        </p>
      )}
      {slow && online && <p>{i18n.t("connectivity.slow")}</p>}
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
