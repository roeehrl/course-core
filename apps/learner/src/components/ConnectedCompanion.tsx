import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type {
  CompanionContext,
  CompanionMessage,
  CompanionReceipt,
} from "../client/companionClient";
import {
  companionCouldNotAnswer,
  companionJobLabel,
  companionState,
  companionStateLabel,
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
}
function useCompanionFocus() {
  const [focus, setFocus] = useState<CompanionFocusState>(companionFocus.get());
  useEffect(() => companionFocus.subscribe(setFocus), []);
  return focus;
}
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const selectionLabel: Record<string, string> = {
  text: "Lesson text",
  formula: "Formula or code example",
  log_entry: "Result feedback",
  code_line: "Your code",
  visual_node: "Part of the illustration",
};
/** The lesson a message belongs to, named; the current one says so. Rows saved
 * before messages carried their lesson, and lessons no longer in this course
 * version, say that instead of guessing. */
export function lessonLabel(
  episodeId: string | undefined | null,
  currentEpisodeId: string | undefined,
  titles: Readonly<Record<string, string>>,
): string {
  if (!episodeId) return "Lesson not recorded";
  const title = Object.hasOwn(titles, episodeId) ? titles[episodeId] : undefined;
  if (!title) return "A lesson no longer in this course";
  return episodeId === currentEpisodeId ? `${title} (this lesson)` : title;
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
}: ConnectedCompanionProps) {
  const [confirmDelete, setConfirmDelete] = useState("");
  async function remove(messageId: string) {
    if (!onDeleteMessage) return;
    setCorrecting(messageId);
    setCorrectionError("");
    try {
      await onDeleteMessage(messageId);
      setConfirmDelete("");
    } catch {
      setCorrectionError("The question could not be deleted. Refresh the conversation and try again.");
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
      setCorrectionError(
        "That change could not be saved. Refresh the conversation and try again.",
      );
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
  const state = companionState(messages, { online, awaitingChoice: consent });
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
          : "Your message could not be confirmed. Your draft is preserved; retry the saved request before sending again.",
      );
    }
  }
  return (
    <View style={{ gap: 18 }}>
      <Badge label="Your saved conversation" tone="lilac" />
      <View accessibilityRole="none" style={{ gap: 4 }}>
        <Text
          role="status"
          aria-live="polite"
          accessibilityLabel={`Companion status: ${companionStateLabel[state]}`}
          style={styles.small}
        >
          Companion: {companionStateLabel[state]}
        </Text>
        {heldOffline && (
          <Text style={styles.small}>
            Your question is held on this device and will be sent when you are
            back online, if you are still in this lesson.
          </Text>
        )}
      </View>
      <View style={{ gap: 5 }}>
        <Text style={styles.eyebrow}>Following your place</Text>
        <Text style={styles.heading}>
          {context.episodeTitle ?? "Course roadmap"}
        </Text>
        {context.blockTitle && (
          <Text style={styles.small}>{context.blockTitle}</Text>
        )}
      </View>
      <Text style={styles.small}>
        Messages are saved to your course account. A reply appears here only
        when the companion service returns one. Asking for help never grants
        course credit.
      </Text>
      {!loaded && <Text style={styles.small}>Loading your conversation…</Text>}
      {error && <Notice error>{error}</Notice>}
      {loaded && !messages.length && (
        <Text style={styles.body}>
          A question, a connection, a point to revisit. Keep it here as you
          learn.
        </Text>
      )}
      <View
        role="log"
        aria-live="polite"
        accessibilityLabel="Saved companion messages"
        style={{ gap: 16 }}
      >
        {messages.map((message) => (
          <View
            key={message.id}
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
              {message.role === "learner" ? "You" : "Companion"}
            </Text>
            <Text style={styles.small}>
              {message.role === "assistant" ? "About" : "From"}:{" "}
              {lessonLabel(
                message.context_used?.episodeId ?? message.context.episodeId,
                context.episodeId,
                episodeTitles,
              )}
              {(message.context_used?.blockId ?? message.context.blockId)
                ? " · lesson material"
                : ""}
            </Text>
            <MarkdownContent
              markdown={
                message.content === "[deleted]"
                  ? message.role === "learner"
                    ? "You deleted this question."
                    : "Removed with the question you deleted."
                  : message.content
              }
            />
            {companionJobLabel(message) && (
              <Text style={styles.small}>{companionJobLabel(message)}</Text>
            )}
            {companionCouldNotAnswer(message) && message.content !== "[deleted]" && (
              // Asking again is a new question: it goes back into the draft to send as usual.
              <Button label="Ask this question again" kind="quiet" onPress={() => onDraftChange(message.content)} />
            )}
            {message.role === "learner" && message.excluded && (
              <Text style={styles.small}>
                Not used as context for later answers.
              </Text>
            )}
            {message.role === "learner" && message.content !== "[deleted]" && onDeleteMessage && (
              confirmDelete === message.id ? (
                <View style={{ gap: 6 }}>
                  <Text style={styles.small}>
                    Delete this question and its answer? Suggestions based on it are revoked. This cannot be undone.
                  </Text>
                  <Button label="Delete question" kind="primary" disabled={correcting === message.id} onPress={() => void remove(message.id)} />
                  <Button label="Keep question" kind="quiet" onPress={() => setConfirmDelete("")} />
                </View>
              ) : (
                <Button label="Delete this question" kind="quiet" onPress={() => setConfirmDelete(message.id)} />
              )
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
        ))}
      </View>
      {sent && (
        <Notice>
          Message saved.{" "}
          {messages.some(
            (message) =>
              message.role === "assistant" &&
              message.job_id &&
              message.job_id ===
                messages.find((row) => row.id === sent)?.job_id,
          )
            ? "A reply has arrived."
            : "Waiting for the companion service to reply."}
        </Notice>
      )}
      {sendError && <Notice error>{sendError}</Notice>}
      {correctionError && <Notice error>{correctionError}</Notice>}
      {(focus.selection || focus.media) && (
        <View
          accessibilityLabel="Attached to your next message"
          style={[styles.card, { padding: 14, gap: 10, backgroundColor: "#F2EDFB" }]}
        >
          <Text style={styles.eyebrow}>Attached to your next message</Text>
          {focus.selection && (
            <View style={{ gap: 6 }}>
              <Text style={styles.small}>
                {focus.selection.kind === "code"
                  ? `Your code, line${focus.selection.lineStart === focus.selection.lineEnd ? ` ${focus.selection.lineStart}` : `s ${focus.selection.lineStart}–${focus.selection.lineEnd}`}`
                  : focus.selection.kind === "visual_node"
                    ? `Part of the illustration: ${focus.selection.label}`
                    : `Selected: “${focus.selection.excerpt.slice(0, 160)}${focus.selection.excerpt.length > 160 ? "…" : ""}”`}
              </Text>
              <Button
                label="Remove selection"
                kind="quiet"
                onPress={() => companionFocus.setSelection(undefined)}
              />
            </View>
          )}
          {focus.media && (
            <View style={{ gap: 6 }}>
              <Text style={styles.small}>
                {focus.media.label}
                {focus.media.playbackSeconds !== undefined
                  ? ` at ${time(focus.media.playbackSeconds)}`
                  : ""}
              </Text>
              <Button
                label="Remove video"
                kind="quiet"
                onPress={() => companionFocus.setMedia(undefined)}
              />
            </View>
          )}
          <Text style={styles.small}>
            Your companion sees this with your message. Select other text in
            the lesson to change it.
          </Text>
        </View>
      )}
      <Field
        label="Message to your companion"
        multiline
        value={draft}
        onChangeText={onDraftChange}
        maxLength={4000}
        placeholder="What would you like to understand?"
        editable={!pending}
      />
      {!context.episodeId && (
        <Text style={styles.small}>
          Open a lesson before sending. You can keep drafting here.
        </Text>
      )}
      {unavailable && (
        <Text style={styles.small}>
          This lesson is not currently available for new requests. Your draft is
          preserved.
        </Text>
      )}
      {consent ? (
        <View
          style={[styles.card, { padding: 16, backgroundColor: "#FCF3DF" }]}
        >
          <Text accessibilityRole="header" style={styles.heading}>
            Keep this check independent?
          </Text>
          <Text style={styles.body}>
            Sending a question will switch every active independent check in
            this course to practice before help is requested. Those attempts
            will no longer earn independent credit. A new check may be needed
            later.
          </Text>
          <Button
            label="Keep independent attempt"
            disabled={pending}
            onPress={() => setConsent(false)}
          />
          <Button
            label="Switch to practice & send"
            kind="primary"
            disabled={pending || !draft.trim() || unavailable}
            onPress={() => void send(true)}
          />
        </View>
      ) : (
        <Button
          label={
            pending
              ? "Saving…"
              : !online
                ? heldOffline
                  ? "Waiting for connection…"
                  : "Send when back online"
                : "Send message"
          }
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
        {storageUnavailable
          ? "Draft kept in this tab only because browser storage is unavailable."
          : "Draft saved on this device. It is sent only when you choose Send."}
      </Text>
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
  const [open, setOpen] = useState(false);
  const earlier = [
    ...used.history.filter((row) => row.messageId !== used.answersMessageId),
  ];
  const rule = used.constraints;
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={`${open ? "Hide" : "Show"} context used`}
        kind="quiet"
        selected={open}
        onPress={() => setOpen((value) => !value)}
      />
      {open && (
        <View style={{ gap: 8 }}>
          {question && (
            <Text style={styles.small}>
              Answering: “{question.slice(0, 160)}
              {question.length > 160 ? "…" : ""}”
            </Text>
          )}
          {used.selection && (
            <Text style={styles.small}>
              You pointed at ({selectionLabel[used.selection.kind] ?? "a selection"}): “
              {used.selection.excerpt}”
              {used.selection.lineStart
                ? ` (line ${used.selection.lineStart}${used.selection.lineEnd !== used.selection.lineStart ? `–${used.selection.lineEnd}` : ""})`
                : ""}
            </Text>
          )}
          {used.media && (
            <Text style={styles.small}>
              Course video
              {used.media.playbackSeconds !== null
                ? ` at ${time(used.media.playbackSeconds)}`
                : ""}
            </Text>
          )}
          {used.simulation && (
            <Text style={styles.small}>
              The illustration as you had set it ({used.simulation.settings}{" "}
              settings).
            </Text>
          )}
          <Text style={styles.small}>
            {earlier.length
              ? `${earlier.length} earlier ${earlier.length === 1 ? "message" : "messages"} from this lesson:`
              : "No earlier messages from this lesson."}
          </Text>
          {earlier.map((row) => (
            <View key={row.messageId} style={{ gap: 4 }}>
              <Text style={styles.small}>
                {row.role === "learner" ? "You" : "Companion"}: “{row.excerpt}
                {row.clipped || row.excerpt.length >= 160 ? "…" : ""}”
                {row.excluded ? " · not used again" : ""}
              </Text>
              {onExclude && row.role === "learner" && (
                <Button
                  label={
                    row.excluded
                      ? "Use this message again"
                      : "Don’t use this message again"
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
                {used.summary.count} earlier{" "}
                {used.summary.count === 1 ? "question" : "questions"} named
                briefly
                {used.summary.omitted
                  ? ` (${used.summary.omitted} not shown)`
                  : ""}
                :
              </Text>
              {used.summary.items.map((item) => (
                <View key={item.messageId} style={{ gap: 4 }}>
                  <Text style={styles.small}>
                    “{item.excerpt}”{item.excluded ? " · not used again" : ""}
                  </Text>
                  {onExclude && (
                    <Button
                      label={
                        item.excluded
                          ? "Use this question again"
                          : "Don’t use this question again"
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
            Rules it followed: {rule.deadline
              ? `deadline ${new Date(rule.deadline).toLocaleDateString()}`
              : "no deadline"}
            {" · "}
            {rule.independentAssessmentActive
              ? "an independent check was open"
              : "no independent check open"}
            {" · "}
            {rule.expansionAllowed
              ? "extra practice allowed"
              : "no extra practice beyond the lesson"}
            .
          </Text>
          <Text style={styles.small}>
            Evidence it could see: {used.evidenceCount}{" "}
            {used.evidenceCount === 1 ? "result" : "results"}. Context version{" "}
            {used.contextRevision}.
          </Text>
        </View>
      )}
    </View>
  );
}
