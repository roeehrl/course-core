import React, { useState } from "react";
import { Text, View } from "react-native";
import { isolate } from "@course-core/i18n";
import type { CompanionContext, CompanionContextUsed, CompanionMessage } from "../../client/companionClient";
import { plainExcerpt } from "../../client/companionClient";
import { Button, styles } from "../../components/ui";
import { hasRightToLeft, isolateRuns } from "../../components/markdown";
import { useI18n, type MessageKey, type Translate } from "../../i18n";

/** What the conversation knows that a reply's actions may need. */
export interface ReplyActionsConversation {
  enrollmentId: string;
  episodeTitles: Readonly<Record<string, string>>;
}
export interface ReplyActionsProps {
  /** The settled companion reply. */
  message: CompanionMessage;
  messages: readonly CompanionMessage[];
  conversation: ReplyActionsConversation;
  /** This is the newest reply in the conversation. */
  latest: boolean;
  context: CompanionContext;
  /** The id of a message whose context change is being saved ("" for none). */
  busy: string;
  /** Stop (or resume) using one of the learner's earlier messages as context. */
  onExclude?: (messageId: string, excluded: boolean) => void;
}

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const SELECTION_KINDS = new Set(["text", "formula", "log_entry", "code_line", "visual_node"]);
const selectionLabel = (kind: string, t: Translate) =>
  SELECTION_KINDS.has(kind) ? t(`replyActions.selectionKind.${kind}` as MessageKey) : t("replyActions.selectionKind.unknown");
/** A learner excerpt, cut at 160 characters with an ellipsis. */
const clip = (text: string, clipped = false) => `${text.slice(0, 160)}${clipped || text.length > 160 ? "…" : ""}`;

/** The actions under a settled companion reply: today, what the reply was built from. */
export function ReplyActions({ message, messages, busy, onExclude }: ReplyActionsProps) {
  if (message.role !== "assistant" || !message.context_used) return null;
  return (
    <ContextUsed
      used={message.context_used}
      question={messages.find((row) => row.id === message.context_used!.answersMessageId)?.content}
      busy={busy}
      onExclude={onExclude}
    />
  );
}

/** What an answer was built from, and the learner's correction of it. */
function ContextUsed({
  used,
  question,
  busy,
  onExclude,
}: {
  used: CompanionContextUsed;
  question?: string;
  busy: string;
  onExclude?: (messageId: string, excluded: boolean) => void;
}) {
  const i18n = useI18n(), t = i18n.t;
  const [open, setOpen] = useState(false);
  // A quoted excerpt keeps its own order: its left-to-right runs are isolated when it has Hebrew
  // in it, and in a left-to-right sentence a Hebrew excerpt is isolated as a whole (a
  // right-to-left sentence isolates its arguments itself).
  const quote = (excerpt: string) =>
    i18n.dir === "ltr" && hasRightToLeft(excerpt) ? isolate(isolateRuns(excerpt)) : isolateRuns(excerpt);
  const earlier = [
    ...used.history.filter((row) => row.messageId !== used.answersMessageId),
  ];
  const rule = used.constraints;
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={t(open ? "replyActions.context.hide" : "replyActions.context.show")}
        kind="quiet"
        selected={open}
        onPress={() => setOpen((value) => !value)}
      />
      {open && (
        <View style={{ gap: 8 }}>
          {question && (
            <Text style={styles.small}>
              {t("replyActions.context.answering", { question: quote(clip(plainExcerpt(question), question.length > 160)) })}
            </Text>
          )}
          {used.selection && (
            <Text style={styles.small}>
              {!used.selection.lineStart
                ? t("replyActions.context.pointed", { kind: selectionLabel(used.selection.kind, t), excerpt: quote(plainExcerpt(used.selection.excerpt)) })
                : used.selection.lineEnd !== used.selection.lineStart
                  ? t("replyActions.context.pointedLines", {
                      kind: selectionLabel(used.selection.kind, t),
                      excerpt: quote(plainExcerpt(used.selection.excerpt)),
                      start: used.selection.lineStart,
                      end: used.selection.lineEnd ?? "",
                    })
                  : t("replyActions.context.pointedLine", {
                      kind: selectionLabel(used.selection.kind, t),
                      excerpt: quote(plainExcerpt(used.selection.excerpt)),
                      line: used.selection.lineStart,
                    })}
            </Text>
          )}
          {used.media && (
            <Text style={styles.small}>
              {used.media.playbackSeconds !== null
                ? t("replyActions.context.videoAt", { time: time(used.media.playbackSeconds) })
                : t("replyActions.context.video")}
            </Text>
          )}
          {used.simulation && (
            <Text style={styles.small}>
              {t("replyActions.context.simulation", { settings: used.simulation.settings })}
            </Text>
          )}
          <Text style={styles.small}>
            {t("replyActions.context.earlier", { count: earlier.length })}
          </Text>
          {earlier.map((row) => (
            <View key={row.messageId} style={{ gap: 4 }}>
              <Text style={styles.small}>
                {t(row.excluded ? "replyActions.context.rowExcluded" : "replyActions.context.row", {
                  role: row.role === "learner" ? "learner" : "companion",
                  excerpt: `${quote(plainExcerpt(row.excerpt))}${row.clipped || row.excerpt.length >= 160 ? "…" : ""}`,
                })}
              </Text>
              {onExclude && row.role === "learner" && (
                <Button
                  label={
                    t(row.excluded
                      ? "replyActions.context.useMessage"
                      : "replyActions.context.skipMessage")
                  }
                  kind="quiet"
                  disabled={busy === row.messageId}
                  onPress={() => onExclude(row.messageId, !row.excluded)}
                />
              )}
            </View>
          ))}
          {used.summary && (
            <View style={{ gap: 4 }}>
              <Text style={styles.small}>
                {used.summary.omitted
                  ? t("replyActions.context.summaryOmitted", { count: used.summary.count, omitted: used.summary.omitted })
                  : t("replyActions.context.summary", { count: used.summary.count })}
              </Text>
              {used.summary.items.map((item) => (
                <View key={item.messageId} style={{ gap: 4 }}>
                  <Text style={styles.small}>
                    {t(item.excluded ? "replyActions.context.itemExcluded" : "replyActions.context.item", { excerpt: quote(plainExcerpt(item.excerpt)) })}
                  </Text>
                  {onExclude && (
                    <Button
                      label={
                        t(item.excluded
                          ? "replyActions.context.useQuestion"
                          : "replyActions.context.skipQuestion")
                      }
                      kind="quiet"
                      disabled={busy === item.messageId}
                      onPress={() => onExclude(item.messageId, !item.excluded)}
                    />
                  )}
                </View>
              ))}
            </View>
          )}
          <Text style={styles.small}>
            {t("replyActions.context.rules", {
              deadline: rule.deadline
                ? t("replyActions.context.rules.deadline", { date: i18n.date(rule.deadline) })
                : t("replyActions.context.rules.noDeadline"),
              independent: t(
                rule.independentAssessmentActive
                  ? "replyActions.context.rules.independent"
                  : "replyActions.context.rules.noIndependent",
              ),
              expansion: t(
                rule.expansionAllowed
                  ? "replyActions.context.rules.expansion"
                  : "replyActions.context.rules.noExpansion",
              ),
            })}
          </Text>
          <Text style={styles.small}>
            {t("replyActions.context.evidence", { count: used.evidenceCount, revision: used.contextRevision })}
          </Text>
        </View>
      )}
    </View>
  );
}
