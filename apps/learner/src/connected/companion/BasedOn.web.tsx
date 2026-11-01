import React from "react";
import { isolate } from "@course-core/i18n";
import type { ServerSnapshot } from "../../client/apiClient";
import type { CompanionContextUsed, CompanionMessage } from "../../client/companionClient";
import { plainExcerpt } from "../../client/companionClient";
import { Icon } from "../../components/icons/Icon.web";
import { hasRightToLeft, isolateRuns } from "../../components/markdown";
import { useI18n, type MessageKey, type Translate } from "../../i18n";

/*
 * "Based on" under a companion reply (final design §3.7): a chip in the action row that opens a
 * block saying, in plain words, what the reply was built from: the learner's question, what they
 * pointed at (with the lesson part it is in, a 28 px chip that shows it in the lesson), the video,
 * the earlier messages it used (each one can be left out of later answers), the rules it followed
 * and how many of the learner's answers it saw. Under a hint that stood in for an answer that was
 * not given (§3.12) a footnote chip takes the chip's place.
 */

const SELECTION_KINDS = new Set(["text", "formula", "log_entry", "code_line", "visual_node"]);
const selectionLabel = (kind: string, t: Translate) =>
  SELECTION_KINDS.has(kind) ? t(`basedOn.selectionKind.${kind}` as MessageKey) : t("basedOn.selectionKind.unknown");
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
/** A learner excerpt, cut at `max` characters with an ellipsis. */
export const clip = (text: string, max = 160, clipped = false) => `${text.slice(0, max).trimEnd()}${clipped || text.length > max ? "…" : ""}`;

/** The lesson part (1-based, as the lesson numbers its reading parts) a block is in, if known. */
export function partNumber(server: ServerSnapshot | undefined, episodeId: string | undefined | null, blockId: string | undefined | null) {
  if (!server || !episodeId || !blockId) return undefined;
  const episode = server.course.chapters.flatMap((chapter) => chapter.episodes).find((row) => row.id === episodeId);
  const reading = episode?.blocks.filter((block) => ["text", "visual", "media"].includes(block.type)) ?? [];
  const index = reading.findIndex((block) => block.id === blockId);
  return index >= 0 ? index + 1 : undefined;
}

/** The learner's question a reply answers. */
export function questionOf(message: CompanionMessage, messages: readonly CompanionMessage[]) {
  const asked = message.context_used?.answersMessageId;
  return (asked ? messages.find((row) => row.id === asked) : undefined) ??
    (message.job_id ? messages.find((row) => row.role === "learner" && row.job_id === message.job_id) : undefined);
}

/** The reply was an answer to a question the companion asked: the reply before the question asked one. */
function answeredAQuestion(question: CompanionMessage | undefined, messages: readonly CompanionMessage[]) {
  if (!question) return false;
  const before = messages.slice(0, messages.indexOf(question)).findLast((row) => row.role === "assistant");
  return before?.context.asksLearner === true;
}

export interface BasedOnContent {
  used: CompanionContextUsed;
  question?: CompanionMessage;
  /** The lesson part of what the learner pointed at. */
  part?: number;
}

/** What a reply was based on, if it recorded it. */
export function basedOnContent(message: CompanionMessage, messages: readonly CompanionMessage[], server?: ServerSnapshot): BasedOnContent | undefined {
  const used = message.context_used;
  if (!used) return;
  const question = questionOf(message, messages);
  const anchor = question?.context.selectedAnchor;
  const part = used.selection ? partNumber(server, used.episodeId, anchor?.blockId ?? used.blockId) : undefined;
  return { used, question, part };
}

/** The chip's label beside a wide panel: what the reply was mostly about, briefly. */
function summary(content: BasedOnContent, messages: readonly CompanionMessage[], t: Translate) {
  const { used, question, part } = content;
  const parts: string[] = [];
  const check = question?.context.attachedCheck;
  if (check) parts.push(t("basedOn.summary.question", { number: check.ordinal }));
  else if (part) parts.push(t("basedOn.summary.part", { number: part }));
  else if (used.media) parts.push(t("basedOn.summary.video"));
  else if (used.simulation || used.selection?.kind === "visual_node") parts.push(t("basedOn.summary.illustration"));
  if (question && question.content !== "[deleted]") {
    const excerpt = clip(plainExcerpt(question.content), 24);
    parts.push(t(answeredAQuestion(question, messages) ? "basedOn.summary.yourAnswer" : "basedOn.summary.yourQuestion", { excerpt }));
  }
  return parts.join(" · ");
}

/**
 * The "Based on" chip: "Based on" in a panel narrower than 480 px, a short summary wider (both are
 * in the page and the container query shows one, so the name is always the words shown).
 */
export function BasedOnChip({ content, messages, open, controls, onToggle }: {
  content: BasedOnContent;
  messages: readonly CompanionMessage[];
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const t = useI18n().t;
  const brief = summary(content, messages, t);
  return (
    <button type="button" className="cc-act-chip cc-act-based" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <span className="cc-act-chip-label cc-act-based-short">{t("basedOn.chip.short")}</span>
      <span className="cc-act-chip-label cc-act-based-long">{brief ? t("basedOn.chip.long", { summary: brief }) : t("basedOn.chip.short")}</span>
      <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
    </button>
  );
}

/** The footnote chip under a hint that stood in for an answer (§3.12), in Based on's place. */
export function WithheldChip({ open, controls, onToggle }: { open: boolean; controls: string; onToggle: () => void }) {
  const t = useI18n().t;
  return (
    <button type="button" className="cc-act-chip cc-act-footnote" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <Icon name="info" size={16} />
      <span className="cc-act-chip-label">{t("basedOn.withheld.chip")}</span>
      <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
    </button>
  );
}
/** The one line the footnote chip opens, under the row. */
export function WithheldLine({ id, open }: { id: string; open: boolean }) {
  const t = useI18n().t;
  return <p id={id} className="cc-act-footnote-more" hidden={!open}>{t("basedOn.withheld.more")}</p>;
}

/** The block a "Based on" chip opens. */
export function BasedOnBlock({ id, content, busy, onExclude, onShowPart }: {
  id: string;
  content: BasedOnContent;
  /** The id of a message whose use is being saved ("" for none). */
  busy: string;
  onExclude?: (messageId: string, excluded: boolean) => void;
  /** Shows a lesson part in the lesson. */
  onShowPart?: () => void;
}) {
  const i18n = useI18n(), t = i18n.t;
  const { used, question, part } = content;
  // A quoted excerpt keeps its own order: its left-to-right runs are isolated when it has Hebrew
  // in it, and in a left-to-right sentence a Hebrew excerpt is isolated as a whole (a
  // right-to-left sentence isolates its arguments itself).
  const quote = (excerpt: string) =>
    i18n.dir === "ltr" && hasRightToLeft(excerpt) ? isolate(isolateRuns(excerpt)) : isolateRuns(excerpt);
  const selection = used.selection;
  const pointer = selection && (() => {
    const kind = selectionLabel(selection.kind, t), excerpt = quote(plainExcerpt(selection.excerpt));
    if (!selection.lineStart) return t("basedOn.pointer", { kind, excerpt });
    return selection.lineEnd !== undefined && selection.lineEnd !== selection.lineStart
      ? t("basedOn.pointer.lines", { kind, excerpt, start: selection.lineStart, end: selection.lineEnd })
      : t("basedOn.pointer.line", { kind, excerpt, line: selection.lineStart });
  })();
  // Earlier messages it used, and the earlier questions it named in its summary (the learner's own).
  const earlier = [
    ...used.history.filter((row) => row.messageId !== used.answersMessageId)
      .map((row) => ({ messageId: row.messageId, role: row.role, excerpt: row.excerpt, clipped: row.clipped || row.excerpt.length >= 160, excluded: row.excluded })),
    ...(used.summary?.items ?? []).filter((item) => !used.history.some((row) => row.messageId === item.messageId))
      .map((item) => ({ messageId: item.messageId, role: "learner" as const, excerpt: item.excerpt, clipped: false, excluded: item.excluded })),
  ];
  const rules = [
    used.constraints.independentAssessmentActive && t("basedOn.rules.independent"),
    used.constraints.deadline && t("basedOn.rules.deadline", { date: i18n.date(used.constraints.deadline) }),
    !used.constraints.expansionAllowed && t("basedOn.rules.lessonOnly"),
  ].filter((rule): rule is string => Boolean(rule));
  return (
    <div id={id} role="region" aria-label={t("basedOn.region")} className="cc-act-based-block">
      {question && question.content !== "[deleted]" && (
        <p className="cc-act-based-row">
          <span className="cc-act-based-label">{t("basedOn.question")}</span>
          <span dir="auto">{t("basedOn.quote", { excerpt: quote(clip(plainExcerpt(question.content))) })}</span>
        </p>
      )}
      {(pointer || used.simulation) && (
        <p className="cc-act-based-row">
          <span className="cc-act-based-label">{t("basedOn.pointed")}</span>
          <span>{pointer ?? t("basedOn.illustration")}</span>
          {part && onShowPart && (
            <button type="button" className="cc-act-source" aria-label={t("basedOn.source.name", { number: part })} onClick={onShowPart}>
              <Icon name="book-open" size={16} />
              <span>{t("basedOn.source", { number: part })}</span>
            </button>
          )}
        </p>
      )}
      {used.media && (
        <p className="cc-act-based-row">
          <span className="cc-act-based-label">{t("basedOn.video")}</span>
          <span>{used.media.playbackSeconds !== null ? t("basedOn.video.at", { time: time(used.media.playbackSeconds) }) : t("basedOn.video.plain")}</span>
        </p>
      )}
      {earlier.length > 0 && (
        <div className="cc-act-based-section">
          <p className="cc-act-based-label">{t("basedOn.earlier")}</p>
          <ul className="cc-act-based-list">
            {earlier.map((row) => {
              const excerpt = quote(clip(plainExcerpt(row.excerpt), 160, row.clipped));
              const short = quote(clip(plainExcerpt(row.excerpt), 40));
              return (
                <li key={row.messageId} className={`cc-act-based-item${row.excluded ? " is-excluded" : ""}`}>
                  <span className="cc-act-based-text">{t(row.role === "learner" ? "basedOn.row.learner" : "basedOn.row.companion", { excerpt })}</span>
                  {onExclude && (
                    <button
                      type="button"
                      className="cc-act-text-button"
                      aria-label={t(row.excluded ? "basedOn.use.name" : "basedOn.skip.name", { excerpt: short })}
                      disabled={busy === row.messageId}
                      onClick={() => onExclude(row.messageId, !row.excluded)}
                    >
                      {t(row.excluded ? "basedOn.use" : "basedOn.skip")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {rules.length > 0 && (
        <div className="cc-act-based-section">
          <p className="cc-act-based-label">{t("basedOn.rules")}</p>
          {rules.map((rule) => <p key={rule} className="cc-act-based-rule">{rule}</p>)}
        </div>
      )}
      {used.evidenceCount > 0 && (
        <p className="cc-act-based-row">
          <span className="cc-act-based-label">{t("basedOn.answers")}</span>
          <span>{t("basedOn.answers.count", { count: used.evidenceCount })}</span>
        </p>
      )}
    </div>
  );
}
