import React from "react";
import { useT } from "../../i18n";
import { ChipRow, starterChips } from "./ReplyChips.web";

/**
 * A conversation with no messages yet (final design §3.10), at the bottom of the thread just above
 * the composer, start-aligned: where the learner is, "Ask anything about this lesson", the policy
 * line and starter chips that fill the box. Outside a lesson it says where the conversation lives;
 * the notice above the composer says how to ask.
 */
export function EmptyState({
  lesson,
  part,
  inLesson,
  onFill,
  folded,
  showChips,
}: {
  lesson?: string;
  part?: string;
  inLesson: boolean;
  onFill(text: string): void;
  folded?: boolean;
  /** Starter chips disappear once the learner types. */
  showChips: boolean;
}) {
  const t = useT();
  if (!inLesson)
    return (
      <section className="cc-chat-empty" aria-labelledby="cc-chat-empty-title">
        <h3 id="cc-chat-empty-title" className="cc-chat-empty-title">{t("emptyState.outside")}</h3>
      </section>
    );
  return (
    <section className="cc-chat-empty" aria-labelledby="cc-chat-empty-title">
      {lesson && (
        <p className="cc-chat-empty-context">
          {part ? t("emptyState.context", { lesson, part }) : <bdi>{lesson}</bdi>}
        </p>
      )}
      <h3 id="cc-chat-empty-title" className="cc-chat-empty-title">{t("emptyState.title")}</h3>
      <p className="cc-chat-empty-policy">{t("emptyState.policy")}</p>
      {showChips && <ChipRow chips={starterChips(t)} onSend={onFill} onFill={onFill} folded={folded} label={t("emptyState.starters")} />}
    </section>
  );
}
