import type { CompanionMessage } from "../../client/companionClient";

/**
 * Whose turn it is in the conversation (final design §3.3, G2): after a reply that asks the
 * learner something, the question is set in weight 600 with a "Your turn" tag, the placeholder
 * becomes "Your answer…" and the answer chips appear.
 *
 * Core decides whether a reply asks (`context.asksLearner`, services/api/src/companion-turn.ts) and
 * writes the key only when it does. Rows stored before that have no key, so the same rule runs
 * here on the stored text; for a row the server judged, it gives the server's answer.
 */

/** The server's rule (companion-turn.ts `replyAsksLearner`), for rows stored without the flag:
 * the last non-empty paragraph outside code ends with `?` or `؟`, ignoring closing quotes,
 * brackets and emphasis marks; Core's coaching for a withheld answer always asks. */
export function replyAsksLearner(text: string, { withheld = false }: { withheld?: boolean } = {}): boolean {
  if (withheld) return true;
  const prose = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "\n")
    .replace(/^(?: {4}|\t)[^\n]*$/gm, "");
  const paragraphs = prose.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return false;
  const end = last.replace(/[\s"'”’»)\]}*_`>]+$/u, "");
  return /[?؟]$/u.test(end);
}

const deleted = (message: CompanionMessage) => message.content === "[deleted]" || message.content === "[erased]";

/** Whether a companion reply ends by asking the learner something: the server's flag, or the
 * same rule on the text of a row stored before the flag existed. */
export function asksLearner(message: CompanionMessage): boolean {
  if (message.role !== "assistant" || deleted(message)) return false;
  if (typeof message.context.asksLearner === "boolean") return message.context.asksLearner;
  return replyAsksLearner(message.content, { withheld: typeof message.context.checkAnswerWithheld === "string" && !!message.context.checkAnswerWithheld });
}

/** A reply that is Core's hint standing in for one that gave a counted check's answer away. */
export const isWithheldHint = (message: CompanionMessage) =>
  message.role === "assistant" && !deleted(message) && typeof message.context.checkAnswerWithheld === "string" && !!message.context.checkAnswerWithheld;

/** How many replies in a row, up to the latest, asked the learner something (TUT-3: after three,
 * "Show me how" is offered). A learner's answers between them do not break the run. */
export function questionTurnsInARow(messages: readonly CompanionMessage[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || deleted(message)) continue;
    if (!asksLearner(message)) break;
    count++;
  }
  return count;
}

export interface TurnState {
  /** The newest settled reply, when it is the last message (nothing was sent after it). */
  latestReplyId?: string;
  /** That reply asks the learner something: their turn. */
  yourTurn: boolean;
  /** That reply is a hint in place of a counted check's answer. */
  withheldHint: boolean;
  /** Three or more question turns in a row. */
  showMeHow: boolean;
}

/** The turn after the saved messages, given whether a question of the learner's is still waiting
 * or being answered (then it is nobody's turn to answer a question). */
export function turnState(messages: readonly CompanionMessage[], { inProgress = false }: { inProgress?: boolean } = {}): TurnState {
  const last = messages.at(-1);
  if (inProgress || !last || last.role !== "assistant" || deleted(last))
    return { yourTurn: false, withheldHint: false, showMeHow: false };
  const yourTurn = asksLearner(last);
  return {
    latestReplyId: last.id,
    yourTurn,
    withheldHint: isWithheldHint(last),
    showMeHow: yourTurn && questionTurnsInARow(messages) >= 3,
  };
}
