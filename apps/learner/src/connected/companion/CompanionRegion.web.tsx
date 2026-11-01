import React, { useEffect, useState } from "react";
import { CourseApiError, type CourseApi, type ServerSnapshot } from "../../client/apiClient";
import type { CompanionContext, CompanionReceipt, ContextualCompanionClient } from "../../client/companionClient";
import { CompanionDock } from "../../components/CompanionDock";
import { ConnectedCompanion } from "../../components/ConnectedCompanion";
import type { VisualInteractionContext } from "../../components/VisualBlock";
import type { CompanionLayout } from "../../domain/companionLayout";
import { useCompanionConversation } from "../../hooks/useCompanionConversation";
import { englishTranslator, useT, type Translate } from "../../i18n";
import { DraftConflict } from "../connectivity.web";
import type { createConnectedDraftStore } from "../drafts";
import { AskFromLesson } from "./AskFromLesson.web";
import { companionBridge } from "./bridge";
import { useCompanionOpenValue } from "./openState";
import { useCompanionActivity } from "./unread";

/** A closed (completed or capped) course's remaining read-only questions. */
export type ClosedAllowance = { budget?: number; used?: number; remaining: number };

/** What the companion says about a closed course's read-only question allowance. */
export function closedHelpText(allowance: ClosedAllowance, exhausted: boolean, t: Translate = englishTranslator().t) {
  if (exhausted) return t("companionRegion.closedHelp.exhausted");
  return allowance.used !== undefined && allowance.budget !== undefined
    ? t("companionRegion.closedHelp.remainingOfBudget", {
        remaining: allowance.remaining,
        used: allowance.used,
        budget: allowance.budget,
      })
    : t("companionRegion.closedHelp.remaining", { remaining: allowance.remaining });
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
 * The companion's region of the page: the dock (beside the lesson or a sheet), a draft that
 * changed in another tab, a closed course's remaining questions, the saved conversation and the
 * composer, and asking from the lesson. It sends questions through the host's request lock and
 * reads whether a companion job can answer here. While it is mounted the companion is available
 * to the rest of the page (bridge.ts).
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
  refresh,
  visualContext,
  setServer,
  setError,
  setQuestionsExhausted,
  reloadPolicy,
  storageUnavailable,
  unavailable,
  closedAllowance,
  helpExhausted,
  onUnansweredChange,
}: CompanionRegionProps) {
  const t = useT();
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
    return transact(async () => {
      const result = await chat.send(server, {
        episodeId: episode.id,
        ...(context.blockId ? { blockId: context.blockId } : {}),
        content,
        ...(interactiveContext ? { interactiveContext } : {}),
        ...(consent === true ? { allowAssessmentAssistance: true as const } : {}),
      });
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
      try {
        await refresh(server.enrollmentId);
      } catch {
        setError(t("companionRegion.error.queuedRefreshFailed"));
      }
      return result;
    });
  }
  const draft = drafts.read(draftKey),
    companionConflict = drafts.conflict(draftKey);
  return (
    <>
      <AskFromLesson episodeId={episode?.id} />
      <CompanionDock layout={layout} headerSlot={headerSlot}>
        {companionConflict && drafts.version(draftKey) && (
          <DraftConflict
            label={t("companionRegion.draft.message")}
            shown={drafts.version(draftKey)!}
            other={companionConflict}
            onKeepShown={() => drafts.resolve(draftKey, "shown")}
            onUseOther={() => drafts.resolve(draftKey, "other")}
          />
        )}
        {closedAllowance && (
          <p className={`connected-closed-help ${helpExhausted ? "is-exhausted" : ""}`} role="status">
            {closedHelpText(closedAllowance, helpExhausted, t)}
          </p>
        )}
        <LiveConversation client={chat} enrollmentId={server.enrollmentId} open={open} revision={server.revision} onUnansweredChange={onUnansweredChange}>
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
                      transact(async () => {
                        await chat.cancelQuestion!(server, messageId);
                        await refresh(server.enrollmentId);
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
