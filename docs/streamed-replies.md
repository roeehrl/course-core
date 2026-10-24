# Streamed companion replies

A companion reply is shown to the learner while the model is still writing it, so the first
words appear in about a second instead of after the whole reply (requirement T01, first token in
3 s or less). What is stored, verified, charged and exported does not change: the learner first
sees an unchecked **draft**, and the stored reply replaces it once Core has verified and
applied it, exactly as before.

## Path of one reply

1. The learner sends a question. The commit of its outbox row raises a PostgreSQL notification
   (`course_outbox`, migration `115`), which wakes the dispatcher's long poll at once
   (bridge method `outbox.wait`). The dispatcher's interval (`SUPERVISOR_DISPATCH_INTERVAL_MS`,
   2 s) is now only the backstop for anything a notification missed.
2. The workflow calls the provider gateway as before. After admission, pricing, the token
   reservation check and the last fence (the point where the call may be sent), the gateway
   opens the job's draft and calls the model with streaming on: Google `streamGenerateContent`
   with `alt=sse`, Anthropic Messages with `stream: true` (`packages/providers`). An adapter
   without streaming answers as before and no draft text appears.
3. Text is released into the draft at safe boundaries (below) and pushed to the learner's open
   event stream as `companion-draft` events. Nothing polls for it.
4. When the model finishes, the gateway stores the answer and its receipt exactly as before; the
   receipt (reported usage, priced with the operator's price) still settles the cost. The draft
   is marked `complete`. Verification and application follow; the new learning event reaches
   the stream at commit (`course_events` notification), and the app shows the stored reply in
   place of the draft.

## What is checked before text is shown

The stored reply must be non-empty, at most 16,000 characters, finished normally by the provider
(Google `STOP`, Anthropic `end_turn`), not blocked or refused by the provider, and accepted by
Core's companion verifier. Of these, only the size bound can be checked on a growing prefix:

- **Checked on every release:** the released text never exceeds the stored bound
  (`COMPANION_REPLY_MAX_CHARACTERS`). A draft that would grow past it is withdrawn at once.
- **Checked per chunk by the adapters:** a Google chunk with a blocked rating or a blocking
  finish reason, or an Anthropic `error` event, ends the stream immediately.
- **Only possible on the whole answer:** the final finish reason (an Anthropic `refusal` or a
  token cap arrives in the last events), Core's own output refusals and the verifier.

Because those last checks cannot be made incrementally, **the design choice is: show text only at
safe boundaries, label it as not yet checked, and withdraw it when a whole-answer check refuses
it.** Text is released after a sentence or line end, or at a word boundary once 48 characters are
waiting (never inside a word or a character), so the learner never sees half a word that might
not be followed. A withdrawn draft disappears and the learner is told the reply did not pass the
checks and nothing of it was kept; they can ask again. The draft is plain text (no formatting)
until the checked reply replaces it.

## Privacy, erasure, export and limits

- A draft lives only in the memory of the API process that runs the gateway (`reply-drafts.ts`):
  never in PostgreSQL, logs, telemetry, notifications or Temporal history. The supervised-flow
  gate checks Temporal histories for the streamed text.
- Only the enrollment's own learner receives drafts; staff reading the event stream never do
  (the companion conversation is private to the learner).
- Bounds: 500 drafts per process, 16 followers per enrollment, a draft is dropped two minutes
  after it ends and ten minutes after it opened at the latest.
- **Erasure** drops every draft of the enrollment at once and refuses new ones; text arriving
  later from the model is discarded. **Export** is unchanged: drafts are never exported, the
  stored reply is. **Budgets and limits** are unchanged: streaming adds no call, and the same
  reservation, receipt and pricing rules apply.
- With several API processes behind a balancer, a learner whose event stream is served by a
  process other than the gateway's sees the stored reply only (as before streaming). The
  supported deployment runs one API process.

## Stopping and reconnecting

- **Stop:** `POST /api/enrollments/:id/companion/messages/:messageId/cancel` (the learner's own
  enrollment only). The draft stops at once, the job is cancelled like any host cancellation
  (reason `learner_cancelled`: its next step stops it and a wake-up reaches a running workflow)
  and nothing it produced is kept. The model call already sent runs to its end, bounded by its
  output and time limits, so its usage is settled from the provider's receipt instead of being
  charged at the reservation ceiling. A reply already shown cannot be stopped; the question can
  be deleted.
- **Reconnect:** the event stream resumes by `Last-Event-ID` as before, and a (re)connected
  stream first receives every current draft whole, so a draft continues after a dropped
  connection. While the stream is down the draft says it is reconnecting.

## Accessibility

The status line announces "Writing a reply" once (a polite live region). The draft itself is
not a live region (`aria-live="off"`, `aria-busy` while it grows), so a screen reader is not
interrupted at every word; the stored reply is announced once when it enters the conversation
log. The draft is labelled as a reply that is still being written and not yet checked.
