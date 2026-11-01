import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useT } from "../../i18n";
import { JumpToLatest } from "./JumpToLatest.web";
import { REPLY_MS } from "./replyStates";
import { LoadingSkeleton, RefreshFailed } from "./ThreadLines.web";
import { useOnShown, useThreadScroll, type ThreadScroll } from "./useThreadScroll";

export interface ThreadHandle extends Omit<ThreadScroll, "jumpVisible" | "jumpDot"> {
  element(): HTMLElement | null;
}

export interface ThreadProps {
  loaded: boolean;
  /** The conversation could not be read again. */
  failed: boolean;
  onRetry?: () => void;
  /** Called each time the thread becomes visible (the companion opens). */
  onShown?: () => void;
  children: React.ReactNode;
}

/**
 * The conversation's log (final design §3.8 item 5): the only scroller in the companion,
 * focusable, `role="log"` named "Saved companion messages", never a live region (replies are
 * announced once by the status region instead). It shows three still bars while the first read
 * takes longer than 400 ms, a line with "Try again" when a read failed, the turns, and Jump to
 * latest just above the composer zone.
 */
export const Thread = forwardRef<ThreadHandle, ThreadProps>(function Thread({ loaded, failed, onRetry, onShown, children }, ref) {
  const t = useT();
  const log = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null), spacer = useRef<HTMLDivElement>(null);
  const scroll = useThreadScroll(log, end, spacer);
  useImperativeHandle(ref, () => ({ ...scroll, element: () => log.current }), [scroll]);
  useOnShown(log, () => onShown?.());
  // Loading: nothing for 400 ms, then the bars.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (loaded) return setSlow(false);
    const timer = setTimeout(() => setSlow(true), REPLY_MS.preparing);
    return () => clearTimeout(timer);
  }, [loaded]);
  return (
    <div className="cc-chat-thread-wrap">
      <div
        ref={log}
        className="cc-chat-thread"
        role="log"
        aria-live="off"
        aria-label={t("connectedCompanion.log")}
        tabIndex={0}
      >
        <div className="cc-chat-thread-content">
          {failed && <RefreshFailed {...(onRetry ? { onRetry } : {})} />}
          {!loaded && slow && <LoadingSkeleton />}
          {children}
          <div ref={end} className="cc-chat-end" aria-hidden="true" />
          <div ref={spacer} className="cc-chat-spacer" aria-hidden="true" />
        </div>
      </div>
      <JumpToLatest visible={scroll.jumpVisible} dot={scroll.jumpDot} onJump={scroll.jump} />
    </div>
  );
});
