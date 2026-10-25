# Stalled and stopped AI calls: bounds, settlement and the owner's decision

A supervised AI call (a companion reply, a supervisor plan, research, a reviewer note) can fail
to finish in three ways: the provider never answers, the answer stops coming part way, or Core
stops it because its job was cancelled (the learner's Stop, staff, erasure). This page says how
long Core waits, what it charges in each case and why, and how a workspace owner settles a call
whose cost Core cannot know. It answers live findings B-2, B-4 and U2 of the Core 0.1.57
companion re-test.

## How long Core waits

Every role call has a 60 s bound (`agent-strategies.ts`). Below it (`provider-runtime.ts`
`RESPONSE_BOUNDS`, `packages/providers` `stream`):

| Bound | Default | Ends as | Applies to |
| --- | --- | --- | --- |
| First byte: from sending until the reply's first chunk | 20 s | `NO_RESPONSE` | streamed replies (the companion) |
| Idle: between two chunks once the reply began | 20 s | `STREAM_STALLED` | streamed replies |
| Call | 60 s | `TIMEOUT` | every call |

A whole (non-streamed) reply's first byte is its finished response, so whole replies get no
first-byte bound by default. A role may set its own: `roles.<role>.firstByteTimeoutMs` and
`roles.<role>.streamIdleTimeoutMs` (5,000–55,000 ms) in the provider configuration (the host file
or a workspace's AI services setup). A role whose model thinks for long before its first visible
text needs a longer first-byte bound. The adapter's own attempt timeout still caps both.

In the 0.1.57 run (B-2) a streamed Google call got no HTTP response at all for 60 s. With these
bounds the call ends after 20 s instead, and the learner is told (below).

## What each ending costs, and why

What the providers say they bill (checked 2026-10-25):

- **Google (Gemini API).** The billing FAQ: "If your request fails with a 400 or 500 error, you
  won't be charged for the tokens used." It says nothing about requests the client abandons. A
  Google developer-forum answer (not official) says tokens already generated before a client
  disconnect are charged. Streamed chunks carry cumulative `usageMetadata`, so the last chunk
  received is the usage up to that point.
- **Anthropic (Claude API).** The help centre article "How will I be billed for Claude API use"
  says failed requests are generally not charged, but that a call is charged when the client
  disconnects or times out in the middle of a call that was on track to succeed. A stream
  reports the output count only in its final `message_delta`, so a stream stopped earlier has an
  unknown output count.

Neither provider documents what a request that was sent but never answered costs, so Core does
not guess. Its rule (`provider-gateway.ts`):

| What happened | Outcome | Charged |
| --- | --- | --- |
| The connection never opened (name lookup, refused, TLS failure, connect timeout): no byte of the request could have been accepted | not started, retryable | nothing; the reservation is released and the job asks again on its next attempt |
| Sent, and nothing came back before the first-byte bound | uncertain | the whole reservation stays held until the owner decides |
| The reply began and then stopped (Stop, stall, call bound) after the provider reported its usage up to that point | settled | that reported usage at the price in force; the rest of the reservation is released |
| The reply began and then stopped before any usable usage report (always so for Anthropic) | uncertain | the whole reservation stays held until the owner decides |

A stopped or stalled reply settled at its reported usage is recorded as a refusal
(`provider_stream_stopped` or `provider_stream_stalled`, reason code only); nothing of the reply
is kept or shown. The provider may also bill a few tokens that were in flight after the last
chunk Core read; Core's ledger is its own record, not an invoice.

## Asking again once, automatically

A companion question whose call got no reply at all (`NO_RESPONSE`) is asked once more, in the
same transaction that records the uncertain call (`supervisor-bridge.ts`
`retryStalledCompanionWithin`), when that is safe:

- nothing of the first call reached the learner, so nothing can be shown or stored twice;
- the first call stays uncertain and keeps its reservation, so the second call needs its own:
  Core asks again only while the learner's remaining budget (every ceiling) covers one more call;
- only once per question, and never for a deleted, answered or cancelled one.

The stalled job ends (cancelled; its call stays uncertain), the question is unlinked from it and
a system `companion.retry_requested` event prepares a new job for the same question. The learner
sees the question queued again. A call that was sent and stalled part way, or that the learner
stopped, is never asked again by Core.

## Stop ends the provider call

The learner's Stop (`POST …/companion/messages/:messageId/cancel`) records the job's cancellation
and commits it before anything else. The gateway (`provider-gateway.ts`) watches the job while
its call is out and aborts the provider request as soon as the cancellation is visible:

- at the commit itself (the `course_outbox` wake-up a cancellation raises);
- on a one-second poll of the job's cancellation flag, as a backstop;
- when the worker's request to the gateway closes. Temporal cancels the running activity, whose
  abort signal closes that request (the workflow/activity path). A worker that only went away
  (a restart) without a recorded cancellation does not stop the call: it finishes and its
  receipt is reconciled.

Aborting closes the provider connection at once. The call is then settled by the table above.

## The owner settles a call whose cost stayed unknown

An uncertain call keeps its whole reservation counted against the workspace and learner limits.
Once nothing can settle it any more (its gateway receipt is final and uncertain, or none was
recorded and 10 minutes have passed), it is listed in **AI services → Spending → Calls with an
unknown cost** with what happened. A workspace owner or administrator checks the provider's own
usage page and decides, with a short note of what was checked:

- **$0** (no charge was made): the reservation is released to the budgets through the job's own
  settle transition, so the job's accounting, the budgets and the ledger stay equal. A job still
  waiting for that call ends.
- **The amount held** (the provider charged, or it cannot be told): it stays charged and is no
  longer held.

The ledger row is then closed, still `uncertain` (the provider's outcome is still unknown). The
decision, the amounts, the note and who decided are stored (`provider_spend_resolutions`,
migration 121) and written to the workspace audit log (`provider.spend_settled`). A decision is
final; a repeat of the same request returns it, and any other request on that call is refused.
API: `GET /api/admin/workspaces/:id/provider-spend/uncertain` and
`POST …/provider-spend/uncertain/:ledgerId/settle` (`{ idempotencyKey, decision: "zero" |
"reservation", expectedReservedMicroUsd, reason }`), owners and administrators only.

An older Core recorded B-2's call as `CANCELLED` with no HTTP status; it is listed as "no reply"
and can be settled the same way.

## What the learner sees

A question whose call ended with no reply and that nothing can still settle reads **Reply
unavailable · the AI service didn't answer in time** (he: **התשובה לא זמינה · שירות ה-AI לא ענה
בזמן**) instead of "Still working" forever. A question that failed or was refused reads "Reply
unavailable" too. Each offers **Ask this question again**, which puts the question back in the
draft; sending it is a new question.

## Limits

- Whether a provider billed a call that got no reply is not knowable from what Core received;
  the owner's decision is the record.
- An Anthropic stream stopped before its last event always stays uncertain (its output count
  comes only at the end).
- The gateway watches cancellations of the jobs it runs itself; another API process's
  cancellation reaches it through the database wake-up or the poll.
