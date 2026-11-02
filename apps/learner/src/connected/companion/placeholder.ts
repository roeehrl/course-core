import { englishTranslator, type Translate } from "../../i18n";

/** What is attached to the next message (an attachment chip in the composer). */
export type PlaceholderAttachment =
  | { kind: "check"; ordinal: number }
  | { kind: "text" }
  | { kind: "code" }
  | { kind: "video" }
  | { kind: "illustration" };

export interface PlaceholderInput {
  /** A lesson is open: questions can be sent from here. */
  inLesson: boolean;
  /** No messages yet. */
  emptyThread: boolean;
  /** The latest reply asks the learner something (turnState.ts). */
  yourTurn: boolean;
  /** A question of the learner's is waiting or being answered. */
  inProgress: boolean;
  attachment?: PlaceholderAttachment;
}

/**
 * The message box's placeholder follows the thread (final design §3.6, CMP-6), so it never asks
 * "what would you like to understand" after the companion asked the learner something. None ends
 * with a question mark.
 */
export function composerPlaceholder(input: PlaceholderInput, t: Translate = englishTranslator().t): string {
  if (!input.inLesson) return t("placeholder.outsideLesson");
  if (input.inProgress) return t("placeholder.inProgress");
  switch (input.attachment?.kind) {
    case "check":
      return t("placeholder.check", { number: input.attachment.ordinal });
    case "text":
      return t("placeholder.text");
    case "code":
      return t("placeholder.code");
    case "video":
      return t("placeholder.video");
    case "illustration":
      return t("placeholder.illustration");
  }
  if (input.yourTurn) return t("placeholder.yourAnswer");
  if (input.emptyThread) return t("placeholder.lesson");
  return t("placeholder.reply");
}
