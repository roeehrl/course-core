import { useSyncExternalStore } from "react";
import type { CompanionFeedback, CompanionVote } from "../../client/companionClient";

/**
 * What the live conversation (useCompanionConversation) offers the actions on its messages, per
 * enrollment: reading earlier messages, voting on a reply, and taking in a change saved elsewhere
 * (a deleted question, a message no longer used) on the messages already read. The conversation
 * hook is its only writer; the action slots (EarlierMessages, ReplyActions, BubbleActions) read it
 * by the enrollment, so the components between them pass nothing through.
 */
export interface ConversationActions {
  /** Older messages than the ones shown can be read. */
  earlier: boolean;
  /** Earlier messages are being read. */
  loading: boolean;
  /** The last read of earlier messages failed. */
  failed: boolean;
  /** Reads the page before the oldest message shown and puts it at the top. */
  loadEarlier(): Promise<void>;
  /** Saves the learner's vote, comment or report on a reply; resolves with what was saved. Absent
   * when the client cannot (the demo). */
  vote?: (messageId: string, input: CompanionVote) => Promise<CompanionFeedback>;
  /** A change saved through another route, applied to the messages already read. */
  changed(change: { deleted: string } | { excluded: string; value: boolean }): void;
}

const NONE: ConversationActions = Object.freeze({
  earlier: false,
  loading: false,
  failed: false,
  loadEarlier: async () => {},
  changed: () => {},
});
const published = new Map<string, ConversationActions>();
const listeners = new Set<() => void>();

export const conversationActions = {
  /** The conversation of `enrollmentId` offers these actions (null: it is gone). */
  publish(enrollmentId: string, actions: ConversationActions | null) {
    if (actions) published.set(enrollmentId, actions);
    else published.delete(enrollmentId);
    for (const listener of listeners) listener();
  },
  get: (enrollmentId: string): ConversationActions => published.get(enrollmentId) ?? NONE,
  /** A change saved for a message whose conversation the caller does not know (message ids are
   * unique, so the others ignore it). */
  changedEverywhere(change: Parameters<ConversationActions["changed"]>[0]) {
    for (const actions of published.values()) actions.changed(change);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

/** The actions the conversation of `enrollmentId` offers now; nothing while none is open. */
export function useConversationActions(enrollmentId: string): ConversationActions {
  return useSyncExternalStore(
    conversationActions.subscribe,
    () => conversationActions.get(enrollmentId),
    () => NONE,
  );
}
