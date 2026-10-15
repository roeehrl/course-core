import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type {
  CompanionContext,
  CompanionMessage,
  CompanionReceipt,
} from "../client/companionClient";
import { companionJobLabel } from "../client/companionClient";
import { CourseApiError } from "../client/apiClient";
import { Badge, Button, Field, Notice, styles } from "./ui";
import { MarkdownContent } from "./MarkdownContent";
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
}: ConnectedCompanionProps) {
  const [consent, setConsent] = useState(false),
    [sendError, setSendError] = useState(""),
    [sent, setSent] = useState<string>();
  const current = useRef({ context, draft });
  current.current = { context, draft };
  useEffect(() => {
    setConsent(false);
    setSendError("");
    setSent(undefined);
  }, [context.enrollmentId, context.episodeId]);
  async function send(allow?: true) {
    const submitted = draft,
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
              From:{" "}
              {episodeTitles[message.context.episodeId ?? ""] ??
                "Earlier lesson"}
              {message.context.blockId ? " · lesson material" : ""}
            </Text>
            <MarkdownContent markdown={message.content} />
            {companionJobLabel(message) && (
              <Text style={styles.small}>{companionJobLabel(message)}</Text>
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
          label={pending ? "Saving…" : "Send message"}
          kind="primary"
          disabled={
            pending || !draft.trim() || !context.episodeId || unavailable
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
