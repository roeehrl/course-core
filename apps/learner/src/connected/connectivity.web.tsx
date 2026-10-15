import React, { useEffect, useState } from "react";
import type { DraftVersion } from "./drafts";

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

const actionNames: Record<string, string> = {
  answers: "your answer",
  read: "marking a part read",
  complete: "finishing the lesson",
  companion: "your companion message",
  challenges: "starting a check",
  profile: "your profile",
  solution: "your request for the explanation",
};
export function pendingActionName(action: string | undefined) {
  if (!action) return "your last change";
  return (
    actionNames[action] ??
    (action.startsWith("reviews/")
      ? "your reply to the reviewer"
      : "your last change")
  );
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
  if (online && !waiting) return null;
  const name = pendingActionName(pendingAction ?? undefined);
  return (
    <div
      className={`connected-connection ${online ? "" : "is-offline"}`}
      role="status"
    >
      <p>
        {!online && <strong>You’re offline. </strong>}
        {waiting ? (
          <>
            <strong>Not recorded yet:</strong> {name} is saved on this device
            {online
              ? " and waiting for the server."
              : " and is sent when you reconnect."}
          </>
        ) : (
          "Drafts stay on this device; anything you send waits until you reconnect."
        )}
      </p>
      {waiting && online && (
        <button
          type="button"
          className="connected-connection-retry"
          disabled={pending}
          onClick={onRetry}
        >
          Send saved request now
        </button>
      )}
    </div>
  );
}

function when(version: DraftVersion) {
  return version.updatedAt > 0
    ? new Date(version.updatedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "earlier";
}

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
  return (
    <section
      className="connected-draft-conflict"
      aria-label={`Two versions of ${label}`}
    >
      <p>
        <strong>{label} was also changed in another tab or window.</strong> Both
        versions are kept until you choose.
      </p>
      <details>
        <summary>Show the other version (saved {when(other)})</summary>
        <pre>{other.value || "(empty)"}</pre>
      </details>
      <div className="connected-draft-conflict-actions">
        <button type="button" onClick={onKeepShown}>
          Keep the version shown here
        </button>
        <button type="button" onClick={onUseOther}>
          Use the other version
        </button>
      </div>
      <p className="connected-muted">
        The version shown here was saved {when(shown)}.
      </p>
    </section>
  );
}
