import { describe, expect, it } from "vitest";
import type { CompanionDraft, CompanionMessage } from "../src/client/companionClient";
import { cancelledBeforeSent, nextReplyChange, REPLY_MS, replyInProgress, replyView, type ReplyInput } from "../src/connected/companion/replyStates";
import { message } from "./companionFixtures";

/* Every row of the generation table (final design §3.5), from saved jobs, streamed drafts and the
 * page's own clock: nothing for 400 ms, the dots, 1 s, 8 s, 15 s and 45 s, checking after 1 s. */
const T0 = 1_000_000;
const q = (extra: Partial<CompanionMessage> = {}): CompanionMessage => ({ ...message, ...extra });
const draft = (extra: Partial<CompanionDraft> = {}): CompanionDraft => ({ jobId: "job", messageId: "m", text: "", state: "streaming", shown: false, ...extra });
const view = (input: Partial<ReplyInput> & { at: number }) =>
  replyView({ message: q({ job_state: "queued" }), answered: false, clock: { since: T0 }, connected: true, now: T0 + input.at, ...input });

describe("the reply row over time", () => {
  it("shows nothing for 400 ms, then the dots; at 8 s a second line", () => {
    expect(view({ at: 0 })).toEqual({ kind: "none" });
    expect(view({ at: REPLY_MS.preparing - 1 })).toEqual({ kind: "none" });
    expect(view({ at: REPLY_MS.preparing })).toEqual({ kind: "preparing", slow: false });
    expect(view({ at: REPLY_MS.slow - 1 })).toEqual({ kind: "preparing", slow: false });
    expect(view({ at: REPLY_MS.slow })).toEqual({ kind: "preparing", slow: true });
    // A dispatched call with no text yet is still preparing.
    expect(view({ at: 500, draft: draft() })).toEqual({ kind: "preparing", slow: false });
  });
  it("replaces the dots with text and a live caret; 15 s without a frame pauses it, 45 s may not finish", () => {
    const text = draft({ text: "Compare", shown: true });
    expect(view({ at: 600, draft: text, clock: { since: T0, lastFrame: T0 + 500 } })).toEqual({ kind: "streaming", text: "Compare", caret: "live" });
    expect(view({ at: 500 + REPLY_MS.paused, draft: text, clock: { since: T0, lastFrame: T0 + 500 } }))
      .toEqual({ kind: "streaming", text: "Compare", caret: "still", line: "paused" });
    expect(view({ at: 500 + REPLY_MS.stalled, draft: text, clock: { since: T0, lastFrame: T0 + 500 } }))
      .toEqual({ kind: "streaming", text: "Compare", caret: "still", line: "stalled" });
    expect(view({ at: 600, draft: text, connected: false, clock: { since: T0, lastFrame: T0 + 500 } }))
      .toEqual({ kind: "streaming", text: "Compare", caret: "still", line: "offline" });
  });
  it("says 'Checking the reply…' only after 1 s of checking, for a written reply, a counted check's reply and a verifying job", () => {
    const written = draft({ text: "Done.", state: "complete", shown: true });
    expect(view({ at: 5000, draft: written, clock: { since: T0, checkingSince: T0 + 4500 } })).toEqual({ kind: "streaming", text: "Done.", caret: false });
    expect(view({ at: 5500, draft: written, clock: { since: T0, checkingSince: T0 + 4500 } })).toEqual({ kind: "streaming", text: "Done.", caret: false, line: "checking" });
    // A counted check's reply never streams: preparing, then checking, then the whole reply.
    const counted = draft({ checking: true });
    expect(view({ at: 300, draft: counted, clock: { since: T0, checkingSince: T0 } })).toEqual({ kind: "none" });
    expect(view({ at: 600, draft: counted, clock: { since: T0, checkingSince: T0 } })).toEqual({ kind: "preparing", slow: false });
    expect(view({ at: REPLY_MS.checking, draft: counted, clock: { since: T0, checkingSince: T0 } })).toEqual({ kind: "checking" });
    expect(view({ at: 3000, message: q({ job_state: "verifying" }), clock: { since: T0, checkingSince: T0 + 2500 } })).toEqual({ kind: "preparing", slow: false });
    expect(view({ at: 3500, message: q({ job_state: "verifying" }), clock: { since: T0, checkingSince: T0 + 2500 } })).toEqual({ kind: "checking" });
  });
  it("nothing more once the reply is stored", () => {
    expect(view({ at: 9000, message: q({ job_state: "applied" }), answered: true })).toEqual({ kind: "none" });
  });
});

describe("how a reply ends", () => {
  it("no reply, stopped partway, removed by checks, and never sent", () => {
    expect(view({ at: 0, message: q({ job_stalled: true, job_state: "waiting" }) })).toEqual({ kind: "ended", reason: "noReply" });
    expect(view({ at: 0, message: q({ job_state: "dead" }) })).toEqual({ kind: "ended", reason: "noReply" });
    expect(view({ at: 0, message: q({ job_state: "failed", refusal_reason: "provider_stream_stalled" }) })).toEqual({ kind: "ended", reason: "partway" });
    expect(view({ at: 0, message: q({ job_state: "failed", job_reason: "verification_rejected" }) })).toEqual({ kind: "ended", reason: "removed" });
    expect(view({ at: 0, draft: draft({ state: "withdrawn", reason: "output_refused" }) })).toEqual({ kind: "ended", reason: "removed" });
    expect(view({ at: 0, draft: draft({ state: "withdrawn", reason: "provider_failed" }) })).toEqual({ kind: "ended", reason: "partway" });
    // Withheld for a counted check: Core's hint takes its place; nothing of the reply shows.
    expect(view({ at: 0, draft: draft({ state: "withdrawn", reason: "check_answer_withheld" }) })).toEqual({ kind: "checking" });
    expect(view({ at: 0, message: q({ job_state: "refused" }) })).toEqual({ kind: "notSent" });
  });
  it("held by a spending limit or a companion not set up: waiting to send, no reply row", () => {
    expect(view({ at: 9000, message: q({ job_state: "budget_wait", job_ceiling: "workspace" }) })).toEqual({ kind: "held" });
    expect(view({ at: 9000, message: q({ job_state: "queued", job_reason: "configuration_missing" }) })).toEqual({ kind: "held" });
    // Without a named limit it is an ordinary wait.
    expect(view({ at: 9000, message: q({ job_state: "budget_wait" }) })).toEqual({ kind: "preparing", slow: true });
  });
  it("the learner's Stop keeps the partial text (in memory) until a reload, then only the line", () => {
    const stop = { state: "stopped" as const, partial: "Compare the" };
    expect(view({ at: 0, draft: draft({ text: "Compare the", shown: true }), stop })).toEqual({ kind: "stopped", partial: "Compare the" });
    expect(view({ at: 0, message: q({ job_state: "cancelled", job_sent: true }), stop })).toEqual({ kind: "stopped", partial: "Compare the" });
    expect(view({ at: 0, message: q({ job_state: "cancelled", job_sent: true }) })).toEqual({ kind: "stopped" });
    expect(view({ at: 0, draft: draft({ state: "cancelled" }) })).toEqual({ kind: "stopped" });
    // A failed stop keeps the reply going and says so.
    expect(view({ at: 600, draft: draft({ text: "Compare", shown: true }), stop: { state: "failed", partial: "Compare" }, clock: { since: T0, lastFrame: T0 + 500 } }))
      .toEqual({ kind: "streaming", text: "Compare", caret: "live", stopFailed: true });
  });
  it("a question cancelled before its call was sent was never asked", () => {
    expect(cancelledBeforeSent(q({ job_state: "cancelled" }))).toBe(true);
    expect(cancelledBeforeSent(q({ job_state: "cancelled", job_sent: true }))).toBe(false);
    expect(cancelledBeforeSent(q({ job_state: "cancelled" }), draft())).toBe(false);
    expect(view({ at: 0, message: q({ job_state: "cancelled" }) })).toEqual({ kind: "none" });
  });
  it("is in progress (Stop applies) from acceptance until it settles", () => {
    const queued = q({ job_state: "queued" });
    expect(replyInProgress(queued, view({ at: 0 }))).toBe(true);
    expect(replyInProgress(queued, view({ at: 600, draft: draft({ text: "x", shown: true }) }))).toBe(true);
    expect(replyInProgress(q({ job_state: "applied" }), { kind: "none" })).toBe(false);
    expect(replyInProgress(queued, { kind: "held" })).toBe(false);
    expect(replyInProgress(queued, { kind: "stopped" }, { state: "stopped", partial: "" })).toBe(false);
  });
});

describe("when to look again", () => {
  it("wakes at the next threshold: 400 ms, 1 s, 8 s, then 15 s and 45 s after the last frame, 1 s into checking", () => {
    expect(nextReplyChange({ clock: { since: T0 }, now: T0 })).toBe(REPLY_MS.preparing);
    expect(nextReplyChange({ clock: { since: T0 }, now: T0 + 500 })).toBe(500);
    expect(nextReplyChange({ clock: { since: T0 }, now: T0 + 1500 })).toBe(REPLY_MS.slow - 1500);
    expect(nextReplyChange({ clock: { since: T0 }, now: T0 + 9000 })).toBeUndefined();
    const streaming = draft({ text: "x", shown: true });
    expect(nextReplyChange({ clock: { since: T0, lastFrame: T0 + 9000 }, now: T0 + 10_000, draft: streaming })).toBe(REPLY_MS.paused - 1000);
    expect(nextReplyChange({ clock: { since: T0, lastFrame: T0 + 9000 }, now: T0 + 25_000, draft: streaming })).toBe(REPLY_MS.stalled - 16_000);
    expect(nextReplyChange({ clock: { since: T0, checkingSince: T0 + 9000 }, now: T0 + 9500 })).toBe(500);
  });
});
