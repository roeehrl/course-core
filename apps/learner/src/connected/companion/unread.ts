import { useEffect } from "react";
import type { CompanionMessage } from "../../client/companionClient";
import { companionBridge } from "./bridge";

/**
 * Publishes the companion's unread replies to the bridge (`unread`, `firstUnreadId`,
 * `replyAbout`), for the trigger and the lesson. Nothing is tracked yet: it publishes none.
 */
export function useCompanionActivity(_messages: readonly CompanionMessage[], _open: boolean, _enrollmentId: string) {
  useEffect(() => {
    companionBridge.updateActivity({ unread: 0, firstUnreadId: undefined, replyAbout: {} });
  }, []);
}
