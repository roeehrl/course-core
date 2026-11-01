import type { CompanionMessage } from "../../client/companionClient";

/** After a learner's turn: what it did to the open question's credit. Not shown yet. */
export function CreditLineAfter(_props: { message: CompanionMessage }): null {
  return null;
}
/** Before a lesson divider: the credit of the lesson being left. Not shown yet. */
export function CreditLineBeforeDivider(_props: { episodeId: string }): null {
  return null;
}
/** At the thread's end: credit to be decided before the next send. Not shown yet. */
export function CreditThreadEnd(_props: { onSend?: () => void }): null {
  return null;
}
