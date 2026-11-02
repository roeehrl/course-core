import React from "react";
import { Conversation, type ConversationProps } from "../connected/companion/Conversation.web";

export { lessonLabel } from "../connected/companion/ThreadLines.web";

export type ConnectedCompanionProps = ConversationProps;

/**
 * The companion's conversation as the app's public component (src/index.ts): the thread, the
 * reply states and the composer of the final design (connected/companion/Conversation.web.tsx).
 */
export function ConnectedCompanion(props: ConnectedCompanionProps) {
  return <Conversation {...props} />;
}
