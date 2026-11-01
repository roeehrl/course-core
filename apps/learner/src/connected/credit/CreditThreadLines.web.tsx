import React, { useState } from "react";
import type { ServerSnapshot } from "../../client/apiClient";
import type { CompanionMessage } from "../../client/companionClient";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";
import { deferredQuestion, deferredSendable, useDeferredQuestion } from "./deferredQuestion";

/** A start-aligned thread line (final design §3.4): Practice icon, muted text, a rule to the end. */
function ThreadLine({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div role="note" className="cc-credit-thread-line">
      <Icon name="practice" size={16} className="cc-credit-thread-icon" />
      <span className="cc-credit-thread-text">{children}</span>
      {action}
      <span className="cc-credit-thread-rule" aria-hidden="true" />
    </div>
  );
}

/**
 * After a learner's turn that made questions practice: "Question 1 is now practice.", one line per
 * question, from the numbers stored with the message. Older messages, sent while a message made
 * every open check of the course practice, stored only the questions' ids: several are said as
 * "Your open checks in this course are now practice."; a single one without its number says nothing
 * rather than guess it.
 */
export function CreditLineAfter({ message }: { message: CompanionMessage }) {
  const t = useT();
  if (message.role !== "learner") return null;
  const downgraded = message.context.downgraded;
  if (downgraded?.length)
    return (
      <>
        {downgraded.map((row) => (
          <ThreadLine key={row.challengeId}>{t("creditThreadLines.downgraded", { ordinal: row.ordinal })}</ThreadLine>
        ))}
      </>
    );
  if ((message.context.downgradedChallengeIds?.length ?? 0) > 1) return <ThreadLine>{t("creditThreadLines.downgradedCourse")}</ThreadLine>;
  return null;
}

/**
 * Before the divider of the next lesson: the recap of the lesson being left, once it is finished
 * ("Lesson finished: 2 questions on your own, 1 as practice."), from the snapshot's counts.
 */
export function CreditLineBeforeDivider({ episodeId, server }: { episodeId: string; server?: ServerSnapshot }) {
  const t = useT();
  const lesson = server?.lessons.find((row) => row.id === episodeId);
  const counts = server?.checkSummaries?.[episodeId];
  if (!counts || !lesson || (lesson.status !== "completed" && lesson.status !== "placed") || counts.own + counts.practice === 0) return null;
  return (
    <ThreadLine>
      {counts.practice === 0
        ? t("creditThreadLines.recapOwn", { own: counts.own })
        : counts.own === 0
          ? t("creditThreadLines.recapPractice", { practice: counts.practice })
          : t("creditThreadLines.recap", { own: counts.own, practice: counts.practice })}
    </ThreadLine>
  );
}

/**
 * At the thread's end: a question saved for after the check in this lesson ("A question is saved
 * for after the check.") with "Send it now", enabled once none of the questions it was saved for
 * still counts. `onSend` sends the text as an ordinary message (it may still ask first, when
 * another counted question is open by then); the saved question is cleared once it is sent.
 */
export function CreditThreadEnd({
  onSend,
  server,
  episodeId,
}: {
  onSend?: (text: string) => Promise<boolean | void> | boolean | void;
  server?: ServerSnapshot;
  episodeId?: string;
}) {
  const t = useT();
  const saved = useDeferredQuestion(server?.enrollmentId, episodeId);
  const [sending, setSending] = useState(false);
  if (!saved || !server || !episodeId || !onSend) return null;
  const ready = deferredSendable(saved, server.activeChallenges);
  return (
    <ThreadLine
      action={
        <button
          type="button"
          className="cc-ui-text-button cc-credit-thread-action"
          disabled={!ready || sending}
          onClick={async () => {
            setSending(true);
            try {
              if ((await onSend(saved.text)) !== false) deferredQuestion.clear(server.enrollmentId, episodeId);
            } finally {
              setSending(false);
            }
          }}
        >
          {t("creditThreadLines.sendNow")}
        </button>
      }
    >
      {t("creditThreadLines.saved")}
    </ThreadLine>
  );
}
