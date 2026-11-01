import React, { useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { PillButton } from "../ui/PillButton.web";
import { StatusLine } from "../ui/StatusLine.web";
import { useConversationActions } from "./conversationActions";
import type { ReplyActionsConversation } from "./ReplyActions.web";

/** The scrolling box `node` is in: the companion's pane, or the page. */
function scroller(node: HTMLElement): HTMLElement {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
/** The first message at least partly in view under `root`'s thread, and where it is now. */
function visibleMessage(root: HTMLElement) {
  const thread = root.closest('[role="log"]') ?? root.parentElement;
  const box = scroller(root);
  const top = box === document.scrollingElement ? 0 : box.getBoundingClientRect().top;
  for (const node of thread?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > top + 1) return { node, top: rect.top, box };
  }
  return undefined;
}

/**
 * At the top of the thread when more messages exist than the conversation read (final design §3.4,
 * §3.8 item 7): "Show earlier messages" reads the page before the oldest one shown and puts it
 * above, keeping the message in view where it was (MSG-15). If the page could not be read, it says
 * so and the button tries again.
 */
export function EarlierMessages({ conversation }: { conversation: ReplyActionsConversation }) {
  const t = useT();
  const actions = useConversationActions(conversation.enrollmentId);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ node: HTMLElement; top: number; box: HTMLElement; read: boolean } | null>(null);
  // After every render (the thread renders the older messages in the same commit as this): the
  // message that was in view goes back to where it was before the page above it was added.
  useLayoutEffect(() => {
    const held = anchor.current;
    if (!held) return;
    if (!held.node.isConnected) {
      anchor.current = null;
      return;
    }
    const moved = held.node.getBoundingClientRect().top - held.top;
    // Instant even where the box scrolls smoothly (a smooth scroll would show the jump).
    if (Math.abs(moved) >= 1) (held.box === document.scrollingElement ? window : held.box).scrollBy({ top: moved, behavior: "instant" });
    // Held until the read has ended (its rows are in the thread by then, or it failed).
    if (held.read) anchor.current = null;
  });
  if (!actions.earlier && !actions.failed) return null;
  return (
    <div ref={root} className="cc-act-earlier">
      {actions.failed && <StatusLine tone="error" text={t("earlierMessages.failed")} />}
      <PillButton
        size={32}
        label={t("earlierMessages.show")}
        disabled={actions.loading}
        onPress={() => {
          const held = root.current && visibleMessage(root.current);
          anchor.current = held ? { ...held, read: false } : null;
          void actions.loadEarlier().finally(() => {
            if (anchor.current && held && anchor.current.node === held.node) anchor.current.read = true;
          });
        }}
      />
    </div>
  );
}
