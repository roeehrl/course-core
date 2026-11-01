import React from "react";
import { Chip } from "../ui/Chip.web";
import { MetaLine } from "../ui/MetaLine.web";
import { PillButton } from "../ui/PillButton.web";
import { StatusLine } from "../ui/StatusLine.web";
import { englishTranslator, useI18n, useT, type Translate } from "../../i18n";

/** Messages further apart than this get a date line between them (final design §3.4). */
export const DATE_GAP_MS = 60 * 60 * 1000;

/** The lesson a message belongs to, by the course's own titles. Rows saved before messages
 * carried their lesson, and lessons no longer in this course version, say that instead of
 * guessing. (`current` is kept for callers of the earlier signature; the thread names every lesson
 * the same way.) */
export function lessonLabel(
  episodeId: string | undefined | null,
  _current: string | undefined,
  titles: Readonly<Record<string, string>>,
  t: Translate = englishTranslator().t,
): string {
  if (!episodeId) return t("threadLines.lesson.notRecorded");
  const title = Object.hasOwn(titles, episodeId) ? titles[episodeId] : undefined;
  return title || t("threadLines.lesson.gone");
}

const day = (value: number) => {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** "Today 14:05", "Yesterday" or "Mon 3 Nov", in the learner's language. */
export function useDateLabel() {
  const i18n = useI18n();
  return (iso: string, now: number) => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    const days = Math.round((day(now) - day(at)) / 86_400_000);
    if (days === 0) return i18n.t("threadLines.today", { time: i18n.time(at) });
    if (days === 1) return i18n.t("threadLines.yesterday");
    return i18n.date(at, { weekday: "short", day: "numeric", month: "short" });
  };
}

/** A date line, start-aligned with a rule to the inline end. */
export function DateDivider({ iso, now }: { iso: string; now: number }) {
  const label = useDateLabel()(iso, now);
  if (!label) return null;
  return (
    <MetaLine rule className="cc-chat-divider">
      <time dateTime={iso}>{label}</time>
    </MetaLine>
  );
}

/** The lesson the next questions were asked in (`book-open`, the title isolated). */
export function LessonDivider({ label, known }: { label: string; known: boolean }) {
  return (
    <MetaLine rule icon="book-open" className="cc-chat-divider">
      {known ? <bdi>{label}</bdi> : label}
    </MetaLine>
  );
}

/** A deleted question and its reply, as one line. */
export function DeletedLine() {
  const t = useT();
  return <MetaLine icon="trash-2" className="cc-chat-system">{t("threadLines.deleted")}</MetaLine>;
}

/** The course moved to a newer version between two messages. */
export function VersionLine() {
  const t = useT();
  return <MetaLine rule icon="info" className="cc-chat-divider">{t("threadLines.version")}</MetaLine>;
}

/** A reply that reached its length limit, with "Continue" on the latest one (it sends). */
export function LengthLimit({ onContinue }: { onContinue?: () => void }) {
  const t = useT();
  return (
    <div className="cc-chat-footnote">
      <MetaLine>{t("threadLines.lengthLimit")}</MetaLine>
      {onContinue && <Chip label={t("threadLines.continue")} size={28} onPress={onContinue} />}
    </div>
  );
}

/** The message "Continue" sends. */
export const continueText = (t: Translate) => t("threadLines.continueMessage");

/** The conversation could not be read again: one line at the top with "Try again" (§3.2). */
export function RefreshFailed({ onRetry }: { onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="cc-chat-refresh">
      <StatusLine tone="error" text={t("threadLines.refreshFailed")} />
      {onRetry && <PillButton size={32} startIcon="rotate-ccw" label={t("threadLines.tryAgain")} onPress={onRetry} />}
    </div>
  );
}

/** Loading the conversation, after 400 ms: three still bars, named for screen readers. */
export function LoadingSkeleton() {
  const t = useT();
  return (
    <div className="cc-chat-skeleton" role="img" aria-label={t("threadLines.loading")}>
      <span />
      <span />
      <span />
    </div>
  );
}
