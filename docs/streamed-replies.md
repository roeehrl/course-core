# Streamed companion replies

A companion reply is shown to the learner while the model is still writing it, so the first
words appear in about a second instead of after the whole reply (requirement T01, first token in
3 s or less). What is stored, verified, charged and exported does not change: the learner first
sees the **draft** as it grows, and the stored reply replaces it once Core has verified and
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
3. Opening the draft is the dispatch signal: an empty `companion-draft` frame (`offset` 0, no
   text, state `streaming`) goes to the learner's open event stream at once, before the model has
   written anything. Text is then released into the draft at safe boundaries (below) and pushed
   the same way. Nothing polls for it.
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

A question about the answer to one of the course's graded checks is the exception: its reply
streams into a hidden buffer in the gateway, so the first-byte and idle bounds still end a stalled
call at once, but no text of it is relayed, because Core's graded-check verifier and judge can only
judge the whole reply. Its draft is a *checking* draft: every frame carries `checking: true` and an
empty text, and the learner's app shows the preparing line and, once the check has taken more than
a second, "Checking the reply…" ("התשובה בבדיקה…"), with Stop. The learner sees the reply once the gateway has checked it; a reply that gave a check's answer
away (or could not be judged) is withheld, its draft is withdrawn with reason
`check_answer_withheld`, and Core's coaching message is stored instead
([companion-check-integrity.md](companion-check-integrity.md)).

Because those last checks cannot be made incrementally, **the design choice is: show text only at
safe boundaries, and withdraw it when a whole-answer check refuses it.** The draft carries no "not
yet checked" label (learner AI redesign, §3.5): it reads like the reply it will become, and when
the provider has finished and Core verifies it for more than a second, a line under it says
"Checking the reply…". Text is released after a sentence or line end, or at a word boundary once
48 characters are waiting (never inside a word or a character), so the learner never sees half a
word that might not be followed. A withdrawn draft is replaced in place by one line, "This reply
was removed because it didn't pass the course's checks." (or "The reply stopped partway." when
the provider stopped), with "Ask again"; nothing of it is kept. The app draws the draft with the
same Markdown renderer as the stored reply, closing or holding back what is not finished yet, and
draws arriving text at most every 50 ms, with a caret after the last character.

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
  supported deployment runs one API process. The end of a reply's story does not depend on draft
  frames: the check of a reply in check-coaching mode ending (`companion.reply.checked`), a
  companion job failing or getting no answer (`companion.job.changed`) and an applied reply
  (`supervisor.applied`) are learning events, written in the same transaction, and reach every
  process's streams at commit. After a draft ends or a check finishes, the app reads the
  conversation every 2 s for 20 s while the stored reply is due, then only at the 30 s safety read.

## Stopping and reconnecting

- **Stop:** `POST /api/enrollments/:id/companion/messages/:messageId/cancel` (the learner's own
  enrollment only). This is the same route, with the same meaning, as stopping a question that
  is still queued (the round button before its call was sent): an undelivered request is withdrawn, the job is
  cancelled like any host cancellation (reason `learner_cancelled`: its next step stops it and a
  wake-up reaches a running workflow), a draft being shown stops at once, and nothing the job
  produced is kept. The question stays and reads as cancelled (event
  `companion.question.cancelled`). The model call already sent is aborted at once: the gateway
  sees the committed cancellation and closes the provider connection, and the call is settled
  at the usage the provider reported up to the stop, or stays uncertain for the owner when it
  reported none ([provider-stalls.md](provider-stalls.md)). A reply already shown cannot be stopped
  (`MESSAGE_ALREADY_ANSWERED`), nor one already cancelled (`MESSAGE_NOT_PENDING`); the question
  can be deleted.
- **Checks:** a streamed answer is assembled and judged by the same checks as a whole one
  (`candidate`/`tutoringText` for Google, `anthropicMessage`/`anthropicTutoring` for Anthropic),
  with the same thinking setting and output limit, so a reply cut short at the output limit is
  delivered marked when it has enough visible text, and a refused or incomplete reply that the
  provider finished is settled at its reported usage like any refused answer.
- **Reconnect:** the event stream resumes by `Last-Event-ID` as before, and a (re)connected
  stream first receives every current draft whole, so a draft continues after a dropped
  connection. While the stream is down the reply row says "Connection lost. The reply continues
  when you're back online."

## What the learner is offered, and what it costs

All of a reply's states live in its reply row under the question and in the composer's one round
Send/Stop button (learner AI redesign, final design §3.5); nothing is said in a header, and
nothing under the question except a send that waits, failed or was refused:

| State | Shown | Controls |
| --- | --- | --- |
| Saved, no call sent yet | the question only; after 400 ms "Preparing a reply…" with three dots | Stop (the round button): the question is cancelled before it is asked and its text goes back to the box (costs nothing) |
| Call sent (the draft opened, or the saved job runs) | the dots, then the text in their place, growing, with a caret | Stop (the round button, or Esc in the box) |
| No text for 8 s | a second line: "Still working on it. You can keep reading or stop it." | Stop |
| No new text for 15 s / 45 s | "Reply paused." / "Reply paused. It may not finish." | Stop; "Ask again" at 45 s |
| Written, being checked for more than 1 s | "Checking the reply…" under the text | Stop |
| Stopped by the learner after its call was sent | the text that was on screen, muted, and "You stopped this reply. This part wasn't checked, so it won't be saved." | Ask again |
| The same after a reload | "You stopped this reply." | Ask again |
| Held by a spending limit or a companion not yet set up | "Waiting to send" under the question; the reason (the course's limit, the learner's own allowance, or today's) in the notice above the composer, saying staff know | Cancel (puts the text back in the box) |

**The learner's partial text (owner decision Q10).** When the learner presses Stop, the app keeps
the text that was on screen at that moment in the page's memory and shows it muted, with "This
part wasn't checked, so it won't be saved." It is never sent, stored, exported or read again:
the server clears the draft as before, the conversation read has no reply for the question, and
after a reload only "You stopped this reply." remains. A reply about a counted check never streams
text, so no answer to one can be shown this way.

The switch to Stop needs no signal: the round button is Stop from the moment the question is
accepted. Whether stopping cancels a question before it is asked or stops its reply comes from the
dispatch frame itself (and a read of the conversation it triggers), so it is right within a second
of the call being sent, not at the next safety read. While a question waits to start without a
draft, the conversation is read at the 5 s fallback pace, so a lost signal also shows within
seconds. The conversation read reports `job_sent` (a call for the question was started: reserved
and sent, settled or still unknown) and, for a held question, `job_ceiling` (`workspace`,
`enrollment`, `daily` or `artifact`). Cancelling keeps its meaning: a call already sent is settled
from its receipt, never resent.

On send the thread anchors the new question 16 px below its top and keeps room under it, so the
reply grows downward from a fixed point and nothing scrolls while text arrives; a reply that runs
past the bottom shows "Jump to latest" with a dot instead of moving the view. Only the thread
scrolls, never the page, and reduced motion is honoured.

A question cancelled or stopped before it was answered is not context for later answers ("Context
used" does not list it), and "Context used" shows its excerpts as plain words, without Markdown or
TeX marks.

A question held by a spending limit also tells staff at once: the transaction that stops the job
at the limit writes a `help_paused` notification for every staff member who can change limits
(one for the workspace total, one for learners' own limits, counting learners and held requests of the
last day), and the staff bell keeps it while the condition holds. A held question is not resumed
when a limit is raised; the learner asks again.

## Accessibility

The conversation is a `role="log"` that is never a live region, and the reply being written is
`aria-busy` while it grows, so a screen reader is not interrupted at every word. One hidden status
region per conversation says each change once: "Companion is replying" after a second without
text, "Still working on it…" at 8 s, "The reply may not finish. You can ask again." at 45 s,
"Reply stopped" after the learner's Stop, and "Companion replied: …" with the stored reply's
plain text (or a pointer to heading navigation for one over 600 characters).
