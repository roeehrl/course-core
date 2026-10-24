import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type {
  CompanionContext,
  CompanionDraft,
  CompanionMessage,
  CompanionReceipt,
} from "../client/companionClient";
import {
  companionCouldNotAnswer,
  companionHasPending,
  companionJobLabel,
  companionState,
} from "../client/companionClient";
import { useOnline } from "../hooks/useOnline";
import { CourseApiError } from "../client/apiClient";
import { Badge, Button, Field, Notice, styles } from "./ui";
import { MarkdownContent } from "./MarkdownContent";
import {
  companionFocus,
  type CompanionFocusState,
} from "../client/companionFocus";
import type { CompanionContextUsed } from "../client/companionClient";
import { useLessonSelection } from "../hooks/useLessonSelection";
import { englishTranslator, useI18n, useT, type MessageKey, type Translate } from "../i18n";
export interface ConnectedCompanionProps {
  context: CompanionContext;
  messages: readonly CompanionMessage[];
  episodeTitles: Readonly<Record<string, string>>;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (content: string, consent?: true) => Promise<CompanionReceipt>;
  pending: boolean;
  loaded: boolean;
  error?: string;
  unavailable?: boolean;
  storageUnavailable?: boolean;
  /** Stop (or resume) using an earlier message of the learner as context. */
  onExcludeContext?: (messageId: string, excluded: boolean) => Promise<void>;
  /** Delete one of the learner's questions and its answer. */
  onDeleteMessage?: (messageId: string) => Promise<void>;
  /** Replies being written, streamed before Core has checked them. */
  drafts?: readonly CompanionDraft[];
  /** False while the event stream reconnects; a draft continues once it is back. */
  streamConnected?: boolean;
  /** Stop the reply being prepared for one question. */
  onCancelReply?: (messageId: string) => Promise<void>;
}
function useCompanionFocus() {
  const [focus, setFocus] = useState<CompanionFocusState>(companionFocus.get());
  useEffect(() => companionFocus.subscribe(setFocus), []);
  return focus;
}
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const SELECTION_KINDS = new Set(["text", "formula", "log_entry", "code_line", "visual_node"]);
const selectionLabel = (kind: string, t: Translate) =>
  SELECTION_KINDS.has(kind)
    ? t(`connectedCompanion.selectionKind.${kind}` as MessageKey)
    : t("connectedCompanion.selectionKind.unknown");
/** A learner excerpt, cut at 160 characters with an ellipsis. */
const clip = (text: string, clipped = false) =>
  `${text.slice(0, 160)}${clipped || text.length > 160 ? "…" : ""}`;
/** The lesson a message belongs to, named; the current one says so. Rows saved
 * before messages carried their lesson, and lessons no longer in this course
 * version, say that instead of guessing. */
export function lessonLabel(
  episodeId: string | undefined | null,
  currentEpisodeId: string | undefined,
  titles: Readonly<Record<string, string>>,
  t: Translate = englishTranslator().t,
): string {
  if (!episodeId) return t("connectedCompanion.lesson.notRecorded");
  const title = Object.hasOwn(titles, episodeId) ? titles[episodeId] : undefined;
  if (!title) return t("connectedCompanion.lesson.gone");
  return episodeId === currentEpisodeId ? t("connectedCompanion.lesson.current", { title }) : title;
}
export function ConnectedCompanion({
  context,
  messages,
  episodeTitles,
  draft,
  onDraftChange,
  onSend,
  pending,
  loaded,
  error,
  unavailable,
  storageUnavailable,
  onExcludeContext,
  onDeleteMessage,
  drafts = [],
  streamConnected = true,
  onCancelReply,
}: ConnectedCompanionProps) {
  const t = useT();
  const [stopping, setStopping] = useState(""), [stopError, setStopError] = useState("");
  async function stop(messageId: string) {
    if (!onCancelReply) return;
    setStopping(messageId);
    setStopError("");
    try {
      await onCancelReply(messageId);
    } catch {
      setStopError(t("connectedCompanion.error.stop"));
    } finally {
      setStopping("");
    }
  }
  const [confirmDelete, setConfirmDelete] = useState("");
  async function remove(messageId: string) {
    if (!onDeleteMessage) return;
    setCorrecting(messageId);
    setCorrectionError("");
    try {
      await onDeleteMessage(messageId);
      setConfirmDelete("");
    } catch {
      setCorrectionError(t("connectedCompanion.error.delete"));
    } finally {
      setCorrecting("");
    }
  }
  const focus = useCompanionFocus();
  useLessonSelection(true);
  const [correcting, setCorrecting] = useState(""),
    [correctionError, setCorrectionError] = useState("");
  async function correct(messageId: string, excluded: boolean) {
    if (!onExcludeContext) return;
    setCorrecting(messageId);
    setCorrectionError("");
    try {
      await onExcludeContext(messageId, excluded);
    } catch {
      setCorrectionError(t("connectedCompanion.error.correct"));
    } finally {
      setCorrecting("");
    }
  }
  const [consent, setConsent] = useState(false),
    [sendError, setSendError] = useState(""),
    [sent, setSent] = useState<string>();
  const current = useRef({ context, draft });
  current.current = { context, draft };
  const online = useOnline(),
    [heldOffline, setHeldOffline] = useState<{ consent?: true } | null>(null);
  const state = companionState(messages, { online, awaitingChoice: consent, drafts });
  // A question held while offline is sent once, when the browser is back online,
  // only if the learner is still in the same lesson with the same draft.
  const held = useRef<{ draft: string; episodeId?: string; consent?: true } | null>(null);
  useEffect(() => {
    if (!online || !held.current) return;
    const intent = held.current;
    held.current = null;
    setHeldOffline(null);
    if (
      intent.draft === current.current.draft &&
      intent.episodeId === current.current.context.episodeId &&
      intent.draft.trim()
    )
      void send(intent.consent);
  }, [online]);
  useEffect(() => {
    setConsent(false);
    setSendError("");
    setSent(undefined);
    // A selection belongs to the lesson it was made in.
    companionFocus.clear();
    held.current = null;
    setHeldOffline(null);
  }, [context.enrollmentId, context.episodeId]);
  async function send(allow?: true) {
    if (!online) {
      held.current = { draft, episodeId: context.episodeId, ...(allow ? { consent: allow } : {}) };
      setHeldOffline(allow ? { consent: allow } : {});
      return;
    }
    const submitted = current.current.draft,
      scope = context.episodeId;
    setSendError("");
    setSent(undefined);
    try {
      const receipt = await onSend(submitted, allow);
      if (!receipt?.messageId || receipt.state !== "queued")
        // i18n-ignore: internal signal, caught below and replaced with a translated message
        throw new Error("Unconfirmed companion response");
      if (current.current.context.episodeId !== scope) return;
      if (current.current.draft === submitted) onDraftChange("");
      setConsent(false);
      setSent(receipt.messageId);
    } catch (cause) {
      if (current.current.context.episodeId !== scope) return;
      if (
        cause instanceof CourseApiError &&
        cause.code === "ASSESSMENT_HELP_CONSENT_REQUIRED"
      )
        setConsent(true);
      setSendError(
        cause instanceof CourseApiError
          ? cause.message
          : t("connectedCompanion.error.send"),
      );
    }
  }
  const stateLabel = t(`connectedCompanion.state.${state}` as MessageKey);
  return (
    <View style={{ gap: 18 }}>
      <Badge label={t("connectedCompanion.badge")} tone="lilac" />
      <View accessibilityRole="none" style={{ gap: 4 }}>
        <Text
          role="status"
          aria-live="polite"
          accessibilityLabel={t("connectedCompanion.statusLabel", { state: stateLabel })}
          style={styles.small}
        >
          {t("connectedCompanion.status", { state: stateLabel })}
        </Text>
        {heldOffline && (
          <Text style={styles.small}>
            {t("connectedCompanion.heldOffline")}
          </Text>
        )}
      </View>
      <View style={{ gap: 5 }}>
        <Text style={styles.eyebrow}>{t("connectedCompanion.place")}</Text>
        <Text style={styles.heading}>
          {context.episodeTitle ?? t("connectedCompanion.roadmap")}
        </Text>
        {context.blockTitle && (
          <Text style={styles.small}>{context.blockTitle}</Text>
        )}
      </View>
      <Text style={styles.small}>
        {t("connectedCompanion.about")}
      </Text>
      {!loaded && <Text style={styles.small}>{t("connectedCompanion.loading")}</Text>}
      {error && <Notice error>{error}</Notice>}
      {loaded && !messages.length && (
        <Text style={styles.body}>
          {t("connectedCompanion.empty")}
        </Text>
      )}
      <View
        role="log"
        aria-live="polite"
        accessibilityLabel={t("connectedCompanion.log")}
        style={{ gap: 16 }}
      >
        {messages.map((message) => (
          <React.Fragment key={message.id}>
          <View
            style={[
              styles.card,
              {
                padding: 16,
                backgroundColor:
                  message.role === "learner" ? "#FFFFFF" : "#F2EDFB",
              },
            ]}
          >
            <Text style={styles.eyebrow}>
              {t(message.role === "learner" ? "connectedCompanion.role.learner" : "connectedCompanion.role.companion")}
            </Text>
            <Text style={styles.small}>
              {t(
                message.role === "assistant"
                  ? (message.context_used?.blockId ?? message.context.blockId)
                    ? "connectedCompanion.message.aboutMaterial"
                    : "connectedCompanion.message.about"
                  : (message.context_used?.blockId ?? message.context.blockId)
                    ? "connectedCompanion.message.fromMaterial"
                    : "connectedCompanion.message.from",
                {
                  lesson: lessonLabel(
                    message.context_used?.episodeId ?? message.context.episodeId,
                    context.episodeId,
                    episodeTitles,
                    t,
                  ),
                },
              )}
            </Text>
            <MarkdownContent
              markdown={
                message.content === "[deleted]"
                  ? message.role === "learner"
                    ? t("connectedCompanion.deleted.question")
                    : t("connectedCompanion.deleted.answer")
                  : message.content
              }
            />
            {companionJobLabel(message, t) && (
              <Text style={styles.small}>{companionJobLabel(message, t)}</Text>
            )}
            {companionCouldNotAnswer(message) && message.content !== "[deleted]" && (
              // Asking again is a new question: it goes back into the draft to send as usual.
              <Button label={t("connectedCompanion.askAgain")} kind="quiet" onPress={() => onDraftChange(message.content)} />
            )}
            {message.role === "learner" && message.excluded && (
              <Text style={styles.small}>
                {t("connectedCompanion.excluded")}
              </Text>
            )}
            {message.role === "learner" && message.content !== "[deleted]" && onDeleteMessage && (
              confirmDelete === message.id ? (
                <View style={{ gap: 6 }}>
                  <Text style={styles.small}>
                    {t("connectedCompanion.delete.confirm")}
                  </Text>
                  <Button label={t("connectedCompanion.delete.yes")} kind="primary" disabled={correcting === message.id} onPress={() => void remove(message.id)} />
                  <Button label={t("connectedCompanion.delete.no")} kind="quiet" onPress={() => setConfirmDelete("")} />
                </View>
              ) : (
                <Button label={t("connectedCompanion.delete.start")} kind="quiet" onPress={() => setConfirmDelete(message.id)} />
              )
            )}
            {message.role === "learner" && onCancelReply && message.job_id && message.content !== "[deleted]" &&
              companionHasPending([message]) &&
              !messages.some((row) => row.role === "assistant" && row.job_id === message.job_id) && (
              <Button
                label={t(stopping === message.id ? "connectedCompanion.stop.stopping" : "connectedCompanion.stop.start")}
                kind="quiet"
                disabled={stopping === message.id}
                onPress={() => void stop(message.id)}
              />
            )}
            {message.role === "assistant" && message.context_used && (
              <ContextUsed
                used={message.context_used}
                question={
                  messages.find(
                    (row) => row.id === message.context_used!.answersMessageId,
                  )?.content
                }
                busy={correcting}
                onExclude={onExcludeContext ? correct : undefined}
              />
            )}
          </View>
          {message.role === "learner" && (
            <DraftReply
              draft={drafts.find((row) => row.messageId === message.id &&
                !messages.some((m) => m.role === "assistant" && m.job_id === row.jobId))}
              connected={streamConnected}
            />
          )}
          </React.Fragment>
        ))}
      </View>
      {sent && (
        <Notice>
          {messages.some(
            (message) =>
              message.role === "assistant" &&
              message.job_id &&
              message.job_id ===
                messages.find((row) => row.id === sent)?.job_id,
          )
            ? t("connectedCompanion.sent.replied")
            : t("connectedCompanion.sent.waiting")}
        </Notice>
      )}
      {sendError && <Notice error>{sendError}</Notice>}
      {stopError && <Notice error>{stopError}</Notice>}
      {correctionError && <Notice error>{correctionError}</Notice>}
      {(focus.selection || focus.media) && (
        <View
          accessibilityLabel={t("connectedCompanion.attached")}
          style={[styles.card, { padding: 14, gap: 10, backgroundColor: "#F2EDFB" }]}
        >
          <Text style={styles.eyebrow}>{t("connectedCompanion.attached")}</Text>
          {focus.selection && (
            <View style={{ gap: 6 }}>
              <Text style={styles.small}>
                {focus.selection.kind === "code"
                  ? focus.selection.lineStart === focus.selection.lineEnd
                    ? t("connectedCompanion.selection.codeLine", { line: focus.selection.lineStart })
                    : t("connectedCompanion.selection.codeLines", { start: focus.selection.lineStart, end: focus.selection.lineEnd })
                  : focus.selection.kind === "visual_node"
                    ? t("connectedCompanion.selection.visual", { label: focus.selection.label })
                    : t("connectedCompanion.selection.text", { excerpt: clip(focus.selection.excerpt) })}
              </Text>
              <Button
                label={t("connectedCompanion.selection.remove")}
                kind="quiet"
                onPress={() => companionFocus.setSelection(undefined)}
              />
            </View>
          )}
          {focus.media && (
            <View style={{ gap: 6 }}>
              <Text style={styles.small}>
                {focus.media.playbackSeconds !== undefined
                  ? t("connectedCompanion.media.at", { label: focus.media.label, time: time(focus.media.playbackSeconds) })
                  : focus.media.label}
              </Text>
              <Button
                label={t("connectedCompanion.media.remove")}
                kind="quiet"
                onPress={() => companionFocus.setMedia(undefined)}
              />
            </View>
          )}
          <Text style={styles.small}>
            {t("connectedCompanion.attachedHelp")}
          </Text>
        </View>
      )}
      <Field
        label={t("connectedCompanion.draft.label")}
        multiline
        value={draft}
        onChangeText={onDraftChange}
        maxLength={4000}
        placeholder={t("connectedCompanion.draft.placeholder")}
        editable={!pending}
      />
      {!context.episodeId && (
        <Text style={styles.small}>
          {t("connectedCompanion.noLesson")}
        </Text>
      )}
      {unavailable && (
        <Text style={styles.small}>
          {t("connectedCompanion.unavailable")}
        </Text>
      )}
      {consent ? (
        <View
          style={[styles.card, { padding: 16, backgroundColor: "#FCF3DF" }]}
        >
          <Text accessibilityRole="header" style={styles.heading}>
            {t("connectedCompanion.consent.title")}
          </Text>
          <Text style={styles.body}>
            {t("connectedCompanion.consent.body")}
          </Text>
          <Button
            label={t("connectedCompanion.consent.keep")}
            disabled={pending}
            onPress={() => setConsent(false)}
          />
          <Button
            label={t("connectedCompanion.consent.switch")}
            kind="primary"
            disabled={pending || !draft.trim() || unavailable}
            onPress={() => void send(true)}
          />
        </View>
      ) : (
        <Button
          label={t(
            pending
              ? "connectedCompanion.send.saving"
              : !online
                ? heldOffline
                  ? "connectedCompanion.send.waiting"
                  : "connectedCompanion.send.offline"
                : "connectedCompanion.send.send",
          )}
          kind="primary"
          disabled={
            pending ||
            !draft.trim() ||
            !context.episodeId ||
            unavailable ||
            !!heldOffline
          }
          onPress={() => {
            if (context.independentChallengeIds.length) setConsent(true);
            else void send();
          }}
        />
      )}
      <Text style={styles.small}>
        {t(storageUnavailable ? "connectedCompanion.draft.tabOnly" : "connectedCompanion.draft.saved")}
      </Text>
    </View>
  );
}

/**
 * A reply the companion is still writing. Plain text (no formatting until the checked reply
 * replaces it), clearly labelled as not yet checked. The text itself is not a live region: a
 * screen reader is not interrupted at every word. The status line above announces "replying"
 * once, and the checked reply is announced once when it enters the conversation log.
 */
function DraftReply({ draft, connected }: { draft?: CompanionDraft; connected: boolean }) {
  const t = useT();
  if (!draft) return null;
  if (draft.state === "withdrawn" || draft.state === "cancelled") {
    if (draft.state === "withdrawn" && !draft.shown) return null;
    return (
      <Text style={styles.small} aria-live="off">
        {t(draft.state === "cancelled" ? "connectedCompanion.reply.stopped" : "connectedCompanion.reply.withdrawn")}
      </Text>
    );
  }
  if (!draft.text) return null;
  return (
    <View
      aria-live="off"
      aria-busy={draft.state === "streaming"}
      accessibilityLabel={t("connectedCompanion.reply.region")}
      style={[styles.card, { padding: 16, backgroundColor: "#F7F4FC", borderStyle: "dashed" }]}
    >
      <Text style={styles.eyebrow}>{t("connectedCompanion.role.companion")}</Text>
      <Text style={styles.small}>
        {t(draft.state === "streaming" ? "connectedCompanion.reply.writing" : "connectedCompanion.reply.checking")}
      </Text>
      <Text style={[styles.body, { writingDirection: "auto" } as object]}>{draft.text}</Text>
      {!connected && draft.state === "streaming" && (
        <Text style={styles.small}>{t("connectedCompanion.reply.reconnecting")}</Text>
      )}
    </View>
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
  const earlier = [
    ...used.history.filter((row) => row.messageId !== used.answersMessageId),
  ];
  const rule = used.constraints;
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={t(open ? "connectedCompanion.context.hide" : "connectedCompanion.context.show")}
        kind="quiet"
        selected={open}
        onPress={() => setOpen((value) => !value)}
      />
      {open && (
        <View style={{ gap: 8 }}>
          {question && (
            <Text style={styles.small}>
              {t("connectedCompanion.context.answering", { question: clip(question) })}
            </Text>
          )}
          {used.selection && (
            <Text style={styles.small}>
              {!used.selection.lineStart
                ? t("connectedCompanion.context.pointed", { kind: selectionLabel(used.selection.kind, t), excerpt: used.selection.excerpt })
                : used.selection.lineEnd !== used.selection.lineStart
                  ? t("connectedCompanion.context.pointedLines", {
                      kind: selectionLabel(used.selection.kind, t),
                      excerpt: used.selection.excerpt,
                      start: used.selection.lineStart,
                      end: used.selection.lineEnd ?? "",
                    })
                  : t("connectedCompanion.context.pointedLine", {
                      kind: selectionLabel(used.selection.kind, t),
                      excerpt: used.selection.excerpt,
                      line: used.selection.lineStart,
                    })}
            </Text>
          )}
          {used.media && (
            <Text style={styles.small}>
              {used.media.playbackSeconds !== null
                ? t("connectedCompanion.context.videoAt", { time: time(used.media.playbackSeconds) })
                : t("connectedCompanion.context.video")}
            </Text>
          )}
          {used.simulation && (
            <Text style={styles.small}>
              {t("connectedCompanion.context.simulation", { settings: used.simulation.settings })}
            </Text>
          )}
          <Text style={styles.small}>
            {t("connectedCompanion.context.earlier", { count: earlier.length })}
          </Text>
          {earlier.map((row) => (
            <View key={row.messageId} style={{ gap: 4 }}>
              <Text style={styles.small}>
                {t(row.excluded ? "connectedCompanion.context.rowExcluded" : "connectedCompanion.context.row", {
                  role: row.role === "learner" ? "learner" : "companion",
                  excerpt: `${row.excerpt}${row.clipped || row.excerpt.length >= 160 ? "…" : ""}`,
                })}
              </Text>
              {onExclude && row.role === "learner" && (
                <Button
                  label={
                    t(row.excluded
                      ? "connectedCompanion.context.useMessage"
                      : "connectedCompanion.context.skipMessage")
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
                  ? t("connectedCompanion.context.summaryOmitted", { count: used.summary.count, omitted: used.summary.omitted })
                  : t("connectedCompanion.context.summary", { count: used.summary.count })}
              </Text>
              {used.summary.items.map((item) => (
                <View key={item.messageId} style={{ gap: 4 }}>
                  <Text style={styles.small}>
                    {t(item.excluded ? "connectedCompanion.context.itemExcluded" : "connectedCompanion.context.item", { excerpt: item.excerpt })}
                  </Text>
                  {onExclude && (
                    <Button
                      label={
                        t(item.excluded
                          ? "connectedCompanion.context.useQuestion"
                          : "connectedCompanion.context.skipQuestion")
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
            {t("connectedCompanion.context.rules", {
              deadline: rule.deadline
                ? t("connectedCompanion.context.rules.deadline", { date: i18n.date(rule.deadline) })
                : t("connectedCompanion.context.rules.noDeadline"),
              independent: t(
                rule.independentAssessmentActive
                  ? "connectedCompanion.context.rules.independent"
                  : "connectedCompanion.context.rules.noIndependent",
              ),
              expansion: t(
                rule.expansionAllowed
                  ? "connectedCompanion.context.rules.expansion"
                  : "connectedCompanion.context.rules.noExpansion",
              ),
            })}
          </Text>
          <Text style={styles.small}>
            {t("connectedCompanion.context.evidence", { count: used.evidenceCount, revision: used.contextRevision })}
          </Text>
        </View>
      )}
    </View>
  );
}
