import type { CompanionDraft, CompanionMessage } from "./companionClient";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/** The companion's overall state, from saved messages and the browser: offline, waiting for the
 * learner, preparing or checking a reply, still working on a question that is waiting for the
 * service, queued, not set up, or idle. There is no status line any more (final design §3.2); the
 * state gives the collapsed sheet its one line while a reply is on its way. A question that is
 * waiting never makes the whole companion unavailable: past messages stay readable and the
 * learner can stop it or ask something else. Never derived from provider text. */
export type CompanionState =
  | "offline"
  | "waiting_for_you"
  | "replying"
  | "building"
  | "checking"
  | "paused"
  | "still_working"
  | "queued"
  | "unavailable"
  | "available";
/** Job states of a question whose reply is held up (service busy, budget, uncertain call). */
const WAITING_STATES = ["waiting", "budget_wait", "blocked", "deferred"];
/** Job states while the reply is being built: the provider call is out. */
const RUNNING_STATES = ["running", "leased", "processing", "analyzing", "building", "evaluating"];
/** Job states while a written reply is checked before it is stored. */
const CHECKING_STATES = ["verifying", "ready"];
/** Spending limits a held question can name (supervisor-bridge.ts BudgetCeiling). */
const CEILINGS = ["workspace", "enrollment", "daily", "artifact"];
/** Help is paused for this question: a spending limit holds it back. */
export const companionHeldByLimit = (message: CompanionMessage) =>
  message.role === "learner" && message.job_state === "budget_wait" && CEILINGS.includes(message.job_ceiling ?? "");
/** Withheld reasons (companion-check-integrity.ts WITHHELD_REASONS) for a reply that could not be
 * checked, as opposed to one that gave an answer away. */
const UNVERIFIED_REASONS = ["check_judge_unavailable", "check_keys_unavailable"];
/** What a stored hint says about the reply it replaced: it gave away a check's answer, or it could
 * not be checked. Undefined for an ordinary reply. */
export function companionWithheldNote(message: CompanionMessage): "answer" | "unverified" | undefined {
  const reason = message.role === "assistant" && message.content !== "[deleted]" ? message.context.checkAnswerWithheld : undefined;
  if (typeof reason !== "string" || !reason) return;
  return UNVERIFIED_REASONS.includes(reason) ? "unverified" : "answer";
}
/** The reply being written for one question, if the event stream brought one (and it is not yet
 * replaced by the stored reply). */
export function companionDraftFor(
  message: CompanionMessage,
  messages: readonly CompanionMessage[],
  drafts: readonly CompanionDraft[] = [],
): CompanionDraft | undefined {
  if (message.role !== "learner") return;
  return drafts.find((draft) => draft.messageId === message.id &&
    !messages.some((m) => m.role === "assistant" && m.job_id === draft.jobId));
}
/**
 * Whether the reply to a question is under way: its call was sent. That is known from the stream
 * the moment the gateway sends the call (a draft opens, before any text), or from the saved job
 * (running, or a call recorded as started). Then the learner is offered Stop, not "Stop waiting".
 */
export function companionReplyStarted(message: CompanionMessage, draft?: CompanionDraft): boolean {
  if (message.role !== "learner" || message.content === "[deleted]" || !companionHasPending([message])) return false;
  if (draft) return draft.state === "streaming" || draft.state === "complete";
  return RUNNING_STATES.includes(message.job_state ?? "") || CHECKING_STATES.includes(message.job_state ?? "");
}
export function companionState(
  messages: readonly CompanionMessage[],
  input: { online: boolean; awaitingChoice: boolean; drafts?: readonly CompanionDraft[] },
): CompanionState {
  if (!input.online) return "offline";
  if (input.awaitingChoice) return "waiting_for_you";
  // A reply is being written where the learner can see it (its call was sent; the first text may
  // not have arrived yet): one status, not one per word.
  const live = input.drafts?.filter((draft) => draft.state === "streaming" &&
    !messages.some((m) => m.role === "assistant" && m.job_id === draft.jobId) &&
    messages.some((m) => m.id === draft.messageId && companionHasPending([m]))) ?? [];
  // A reply about a graded check is written out of sight and checked before it is shown.
  if (live.some((draft) => !draft.checking)) return "replying";
  if (live.length) return "checking";
  // A question whose reply was withdrawn or stopped on the stream is over for the learner even
  // before its saved job says so: the status does not keep saying a reply is being built.
  const open = messages.filter((message) => {
    if (message.role !== "learner" || !companionHasPending([message])) return false;
    const draft = companionDraftFor(message, messages, input.drafts);
    return draft?.state !== "withdrawn" && draft?.state !== "cancelled";
  });
  if (open.some((m) => RUNNING_STATES.includes(m.job_state ?? "")))
    return "building";
  if (open.some((m) => CHECKING_STATES.includes(m.job_state ?? "")))
    return "checking";
  // A spending limit holds a question: help is paused, said plainly.
  if (open.some(companionHeldByLimit)) return "paused";
  // Only a missing service configuration makes the companion unavailable.
  if (
    open.some(
      (m) =>
        m.job_reason === "configuration_missing" ||
        m.job_state === "configuration_pending",
    )
  )
    return "unavailable";
  if (open.some((m) => WAITING_STATES.includes(m.job_state ?? "")))
    return "still_working";
  if (open.length) return "queued";
  return "available";
}
/** The companion's overall state as one short sentence, in the translator's locale ("Companion"
 * when idle: availability is never shown as a state of its own, §3.13). */
export function companionStateText(state: CompanionState, t: Translate = englishTranslator().t): string {
  return t(`companionStates.state.${state}` as MessageKey);
}
/** Only known public outcomes are worded; provider error and reason text is never shown.
 * `draft` is the reply being written for this question (companionDraftFor), which is newer than
 * the saved job: a draft that opened means the call was sent.
 *
 * One short sentence per outcome (final design §3.5), so a question never says two things at
 * once: a reply that stopped part way reads as that, not also as removed by the checks; a reply
 * the learner stopped reads as stopped. Undefined while nothing needs saying: a question that was
 * sent and waits, one whose reply is being written (the reply row shows that), and one answered
 * (there is no "Answered" label; the reply is the answer). A question held by a spending limit or
 * a companion not yet set up waits to be sent; the notice above the composer says why. */
export function companionJobLabel(
  message: CompanionMessage,
  t: Translate = englishTranslator().t,
  draft?: CompanionDraft,
): string | undefined {
  if (message.role !== "learner") return;
  if (message.job_reason === "configuration_missing") return t("companionStates.job.held");
  // Saved outcomes that are final come first: they are newer than any draft the stream sent.
  if (message.job_stalled === true) return t("companionStates.job.noReply");
  if (message.refusal_reason === "provider_stream_stalled") return t("companionStates.job.partway");
  // Core closed the call because the question was cancelled (the learner's Stop, staff, erasure).
  if (message.refusal_reason === "provider_stream_stopped") return t("companionStates.job.stopped");
  if (companionCouldNotAnswer(message)) return t("companionStates.job.removed");
  if (draft && companionHasPending([message])) {
    if (draft.state === "streaming" && !draft.checking) return;
    if (draft.state === "streaming" || draft.state === "complete") return t("companionStates.job.checking");
    // Stopped by the learner: the call had been sent.
    if (draft.state === "cancelled") return t("companionStates.job.stopped");
    // Withheld for a counted check: Core's hint takes its place, so the reply is still being
    // checked until the hint is stored (§3.12; the question itself carries no label).
    if (draft.reason === "check_answer_withheld" || draft.reason === "check_unverified") return t("companionStates.job.checking");
    return t(draft.reason === "provider_failed" ? "companionStates.job.partway" : "companionStates.job.removed");
  }
  if (companionHeldByLimit(message)) return t("companionStates.job.held");
  switch (message.job_state) {
    case "verifying":
    case "ready":
      return t("companionStates.job.checking");
    case "cancelled":
      // Stopped after its call was sent (a draft that opened proves it); one cancelled before
      // anything was sent was never asked, and its text went back to the message box.
      return message.job_sent || draft ? t("companionStates.job.stopped") : undefined;
    case "refused":
      // Never prepared into a job (refused or quarantined before any call).
      return t("companionStates.job.notSent");
    case "failed":
    case "dead":
    case "dead_letter":
      return t("companionStates.job.noReply");
    case "configuration_pending":
      return t("companionStates.job.held");
    default:
      return;
  }
}
/** The reply was produced but refused by Core's checks before it could be shown (a definite end,
 * not a delay): the learner can ask again. A reply that stopped part way, or that Core stopped
 * because the question was cancelled, is not a refusal (companionReplyStalled, the Stop). */
export function companionCouldNotAnswer(message: CompanionMessage): boolean {
  return message.role === "learner" && message.job_state === "failed" &&
    message.refusal_reason !== "provider_stream_stalled" && message.refusal_reason !== "provider_stream_stopped" &&
    (message.job_reason === "verification_rejected" || Boolean(message.refusal_reason));
}
/** The AI service did not answer the question in time: no reply came at all, or the reply
 * stopped coming part way (Core kept nothing of it). Not the companion refusing it. */
export function companionReplyStalled(message: CompanionMessage): boolean {
  return message.role === "learner" && (message.job_stalled === true || message.refusal_reason === "provider_stream_stalled");
}
/** No reply will come for this question (it stalled, failed, or was refused or not answered):
 * the learner sees why and can ask it again. */
export function companionReplyUnavailable(message: CompanionMessage): boolean {
  return message.role === "learner" && message.content !== "[deleted]" && (message.job_stalled === true ||
    ["failed", "refused", "dead", "dead_letter"].includes(message.job_state ?? ""));
}
/** A question that ended without an answer the learner can use: Core refused the reply, no reply
 * will come (it stalled, failed or was refused), or the question was cancelled or its reply
 * stopped. Its reply row offers "Ask again", which puts its text back in the message box to send as
 * a new question. */
export function companionCanAskAgain(message: CompanionMessage, draft?: CompanionDraft): boolean {
  if (message.role !== "learner" || message.content === "[deleted]") return false;
  return companionCouldNotAnswer(message) || companionReplyUnavailable(message) || message.job_state === "cancelled" || draft?.state === "cancelled";
}
/** A pending question whose call was not sent yet (queued or held up): stopping it cancels it
 * before it is asked, and its text goes back to the message box. Once its reply is under way (a
 * draft opened, or the job is running or checking), Stop stops the reply instead. */
export function companionCanCancel(message: CompanionMessage, draft?: CompanionDraft): boolean {
  return message.role === "learner" && message.content !== "[deleted]" && companionHasPending([message]) && !draft &&
    !companionReplyStarted(message);
}
export function companionHasPending(
  messages: readonly CompanionMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "learner" &&
      // A stalled question is over: nothing more will come for it.
      message.job_stalled !== true &&
      ![
        "applied",
        "refused",
        "cancelled",
        "completed",
        "succeeded",
        "done",
        "failed",
        "dead",
        "dead_letter",
      ].includes(message.job_state ?? ""),
  );
}
