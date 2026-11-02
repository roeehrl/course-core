import React, { useCallback, useEffect, useRef, useState } from "react";
import { CourseApiError, type CourseApi, type ServerSnapshot } from "../../client/apiClient";
import type { CompanionContext, CompanionReceipt, ContextualCompanionClient } from "../../client/companionClient";
import { CompanionDock } from "../../components/CompanionDock";
import { ConnectedCompanion } from "../../components/ConnectedCompanion";
import type { VisualInteractionContext } from "../../components/VisualBlock";
import type { CompanionLayout } from "../../domain/companionLayout";
import { useCompanionConversation } from "../../hooks/useCompanionConversation";
import { englishTranslator, type Translate } from "../../i18n";
import type { createConnectedDraftStore } from "../drafts";
import { AskFromLesson } from "./AskFromLesson.web";
import { companionBridge } from "./bridge";
import { useCompanionOpenValue } from "./openState";
import { useCompanionActivity } from "./unread";

import type { ClosedAllowance } from "./Conversation.web";

export type { ClosedAllowance } from "./Conversation.web";

/** What the companion says about a closed course's read-only question allowance (final design
 * §3.13): "Course closed · 3 questions left" above the composer while questions are left, and the
 * block that replaces the composer once every one is used. */
export function closedHelpText(allowance: ClosedAllowance, exhausted: boolean, t: Translate = englishTranslator().t) {
  if (exhausted) return t("noticeSlot.exhausted");
  return t("noticeSlot.closed", { remaining: allowance.remaining });
}

type Episode = { id: string; title: string };
type Transact = <T>(action: () => Promise<T>) => Promise<T>;

export interface CompanionRegionProps {
  server: ServerSnapshot;
  account: { id: string };
  api: CourseApi;
  chat: ContextualCompanionClient;
  drafts: ReturnType<typeof createConnectedDraftStore>;
  draftKey: string;
  context: CompanionContext;
  titles: Readonly<Record<string, string>>;
  episode?: Episode;
  layout: CompanionLayout;
  headerSlot: HTMLElement | null;
  pending: boolean;
  now: number;
  /** The host's request lock: sets the page's error and notice. */
  transact: Transact;
  /** The same lock, without the page's error or notice; it waits for a request in flight. */
  transactQuiet: Transact;
  refresh: (enrollmentId: string) => Promise<ServerSnapshot>;
  /** The interactive part's state to send with a question about it, or none. */
  visualContext: () => VisualInteractionContext | undefined;
  setServer: React.Dispatch<React.SetStateAction<ServerSnapshot | undefined>>;
  setError: (message: string) => void;
  setQuestionsExhausted: (value: { budget?: number } | undefined) => void;
  reloadPolicy: () => void;
  storageUnavailable: boolean;
  unavailable: boolean;
  closedAllowance?: ClosedAllowance;
  helpExhausted: boolean;
  onUnansweredChange: (count: number) => void;
}

/**
 * The companion's region of the page: the dock (beside the lesson or a sheet) with the
 * conversation and its composer, and asking from the lesson. It sends questions through the
 * host's quiet request lock (what happens to a question is said with the question, never in the
 * page's notice, and an unrelated request in flight never blocks a send) and reads whether a
 * companion job can answer here. While it is mounted the companion is available to the rest of
 * the page (bridge.ts).
 */
export function CompanionRegion({
  server,
  api,
  chat,
  drafts,
  draftKey,
  context,
  titles,
  episode,
  layout,
  headerSlot,
  pending,
  now,
  transact,
  transactQuiet,
  refresh,
  visualContext,
  setServer,
  setQuestionsExhausted,
  reloadPolicy,
  storageUnavailable,
  unavailable,
  closedAllowance,
  helpExhausted,
  onUnansweredChange,
}: CompanionRegionProps) {
  const open = useCompanionOpenValue("open");
  useEffect(() => {
    companionBridge.setAvailable(true);
    return () => companionBridge.setAvailable(false);
  }, []);
  // Whether a companion job can answer here now, from the server; read again when the companion
  // is opened, so a job turned on meanwhile shows.
  const [companionReady, setCompanionReady] = useState<{ enrollmentId: string; status: "ready" | "not_set_up" | "not_offered" | "unknown" }>();
  const availabilityEnrollment = server.enrollmentId;
  useEffect(() => {
    const controller = new AbortController();
    api.request<{ status: "ready" | "not_set_up" | "not_offered" }>(
      `/api/enrollments/${encodeURIComponent(availabilityEnrollment)}/companion/availability`, "GET", undefined, { signal: controller.signal },
    ).then(
      (result) => !controller.signal.aborted && setCompanionReady({ enrollmentId: availabilityEnrollment, status: result.status }),
      // Never "Available" on a guess: a failed read says it could not be checked.
      () => !controller.signal.aborted && setCompanionReady({ enrollmentId: availabilityEnrollment, status: "unknown" }),
    );
    return () => controller.abort();
  }, [api, availabilityEnrollment, open]);
  const availability = companionReady?.enrollmentId === server.enrollmentId && companionReady?.status !== "not_offered" ? companionReady?.status : undefined;
  // The newest snapshot this region knows. A question's commands wait for each other (the quiet
  // lock): a Stop pressed while its question is being sent runs once the send has moved the
  // revision on, before the page has drawn the new snapshot, so it takes the revision from here.
  const newest = useRef(server);
  if (server.enrollmentId !== newest.current.enrollmentId || server.revision >= newest.current.revision) newest.current = server;
  const learn = (snapshot: ServerSnapshot | undefined) => {
    if (snapshot && snapshot.enrollmentId === newest.current.enrollmentId && snapshot.revision >= newest.current.revision) newest.current = snapshot;
  };
  async function sendCompanion(content: string, consent?: true): Promise<CompanionReceipt> {
    try {
      return await sendCompanionNow(content, consent);
    } catch (cause) {
      if (cause instanceof CourseApiError && cause.code === "HELP_BUDGET_EXHAUSTED") {
        const budget = cause.details?.budget;
        setQuestionsExhausted({ budget: typeof budget === "number" ? budget : undefined });
        reloadPolicy();
      }
      throw cause;
    }
  }
  async function sendCompanionNow(content: string, consent?: true): Promise<CompanionReceipt> {
    // i18n-ignore: programming guard, the companion is only offered inside a lesson
    if (!episode) throw new Error("Open a lesson first");
    const interactiveContext = visualContext();
    return transactQuiet(async () => {
      const send = () =>
        chat.send(newest.current, {
          episodeId: episode.id,
          ...(context.blockId ? { blockId: context.blockId } : {}),
          content,
          ...(interactiveContext ? { interactiveContext } : {}),
          ...(consent === true ? { allowAssessmentAssistance: true as const } : {}),
        });
      let result: CompanionReceipt;
      try {
        result = await send();
      } catch (cause) {
        if (!(cause instanceof CourseApiError) || cause.code !== "STALE_REVISION") throw cause;
        // The course moved on before this page drew it (a check started a moment ago): nothing was
        // saved. It is read again and the question goes once more, against what is there now; a
        // counted question now open makes the server ask for the learner's choice first (§3.11),
        // which the conversation shows in place of a failure.
        learn(await refresh(server.enrollmentId));
        result = await send();
      }
      // A queued receipt is authoritative even if the subsequent snapshot GET fails.
      // Reflect only the explicit assistance downgrade; never infer a passed check.
      setServer((current) =>
        current?.enrollmentId === server.enrollmentId
          ? {
              ...current,
              revision: Math.max(current.revision, result.revision),
              activeChallenges: current.activeChallenges.map((item) =>
                result.downgradedChallengeIds.includes(item.challengeId) ? { ...item, independentEligible: false } : item,
              ),
            }
          : current,
      );
      // The message is saved: a progress read that fails now is retried by the page's next read,
      // and the conversation reads itself over its event stream.
      learn({ ...newest.current, revision: Math.max(newest.current.revision, result.revision) });
      learn(await refresh(server.enrollmentId).catch(() => undefined));
      return result;
    });
  }
  const draft = drafts.read(draftKey),
    companionConflict = Boolean(drafts.conflict(draftKey) && drafts.version(draftKey));
  // "Try again" and "Refresh" read the conversation from the start (a new read and stream).
  const [generation, setGeneration] = useState(0);
  const reread = useCallback(() => setGeneration((value) => value + 1), []);
  const next = server.nextEpisodeId ? { episodeId: server.nextEpisodeId, title: titles[server.nextEpisodeId] ?? "" } : undefined;
  return (
    <>
      <AskFromLesson episodeId={episode?.id} />
      <CompanionDock layout={layout} headerSlot={headerSlot}>
        <LiveConversation key={generation} client={chat} enrollmentId={server.enrollmentId} open={open} revision={server.revision} onUnansweredChange={onUnansweredChange}>
          {(conversation) => (
            <ConnectedCompanion
              context={context}
              messages={conversation.messages}
              episodeTitles={titles}
              draft={draft}
              onDraftChange={(value) => drafts.write(draftKey, value)}
              onSend={sendCompanion}
              onExcludeContext={
                chat.excludeContext
                  ? (messageId, excluded) =>
                      transact(async () => {
                        await chat.excludeContext!(server, messageId, excluded);
                        await refresh(server.enrollmentId);
                      })
                  : undefined
              }
              drafts={conversation.drafts}
              streamConnected={conversation.streamConnected}
              availability={availability}
              onCancelQuestion={
                chat.cancelQuestion
                  ? (messageId) =>
                      transactQuiet(async () => {
                        const result = await chat.cancelQuestion!(newest.current, messageId);
                        learn({ ...newest.current, revision: Math.max(newest.current.revision, result.revision) });
                        learn(await refresh(server.enrollmentId).catch(() => undefined));
                      })
                  : undefined
              }
              onDeleteMessage={
                chat.deleteMessage
                  ? (messageId) =>
                      transact(async () => {
                        await chat.deleteMessage!(server, messageId);
                        await refresh(server.enrollmentId);
                      })
                  : undefined
              }
              pending={pending}
              loaded={conversation.loaded}
              error={conversation.error}
              storageUnavailable={storageUnavailable}
              unavailable={unavailable}
              server={server}
              api={api}
              now={now}
              layout={layout}
              onRefresh={reread}
              {...(closedAllowance ? { closed: { allowance: closedAllowance, exhausted: helpExhausted } } : {})}
              draftConflict={companionConflict}
              onDraftChoice={(keep) => drafts.resolve(draftKey, keep)}
              {...(next?.title ? { nextLesson: next } : {})}
            />
          )}
        </LiveConversation>
      </CompanionDock>
    </>
  );
}

/**
 * Holds the companion conversation (useCompanionConversation) and renders the companion from
 * it. Its updates re-render this subtree only; the page hears the one count it acts on, and
 * setting an unchanged count re-renders nothing.
 */
function LiveConversation({
  client,
  enrollmentId,
  open,
  revision,
  onUnansweredChange,
  children,
}: {
  client: ContextualCompanionClient;
  enrollmentId: string;
  open: boolean;
  revision: number;
  onUnansweredChange(count: number): void;
  children(conversation: ReturnType<typeof useCompanionConversation>): React.ReactNode;
}) {
  const conversation = useCompanionConversation(client, enrollmentId, open, revision);
  useCompanionActivity(conversation.messages, open, enrollmentId);
  const unanswered = conversation.messages.filter(
    (message) => message.role === "learner" && ["refused", "failed", "cancelled"].includes(message.job_state ?? ""),
  ).length;
  useEffect(() => onUnansweredChange(unanswered), [unanswered, onUnansweredChange]);
  // Another enrollment's conversation starts from none.
  useEffect(() => () => onUnansweredChange(0), [onUnansweredChange]);
  return <>{children(conversation)}</>;
}
