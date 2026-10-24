# Performance and memory budgets

`services/api/browser/budgets.spec.ts` checks the connected learner against
performance and memory budgets (requirements T01 and T02). It runs with the other
connected-browser tests:

- on Chromium at desktop, phone and tablet sizes (`npm run check:api`);
- on WebKit (desktop, iPhone, iPad) and Firefox through `playwright.engines.config.ts`.

It signs in a synthetic learner on the disposable test host, reloads the course list,
opens the fixture course, and then makes 12 round trips between the roadmap and the
first lesson. It then answers five checks across both lessons: one warm-up answer and
four measured ones (see [How feedback is judged](#how-feedback-is-judged)). Every run
attaches its measurements as `budgets.json` and prints them in a `budgets {…}` log line.

## What is measured

| Measure | How |
| --- | --- |
| Cold course list | After a full reload, time from navigation start until the course card's heading is in the DOM. That heading needs the signed-in course list from the API, so the empty shell does not count |
| Roadmap → lesson | In the page, from the press of "Continue learning →" to the first animation frame where the lesson heading has replaced the roadmap. The lesson heading needs the lesson data |
| Lesson → roadmap | The same measurement for the roadmap button |
| Answer feedback | From the press of "Check answer" to the first animation frame where that answer's result text (for example "Correct. 4 is below 9.") is on the page. The result needs the graded answer from the API |
| Command acknowledgement | From the press of a lesson command ("Mark this part read", "Start the next check →") to `responseEnd` of that command's POST in Resource Timing, so the server's acknowledgement has fully arrived |
| JS heap (Chromium only) | `JSHeapUsedSize` from the DevTools protocol after a forced garbage collection: once after the first lesson opens, and again after the round trips |

The timings are measured inside the page, so Playwright's polling interval is not
included. They run over loopback against a local API and PostgreSQL. They measure
the app's own rendering and API round trips, not network latency to a remote host.

## Budgets

The navigation, feedback and acknowledgement budgets are the T01 product targets
themselves. First-token time (3 s) for AI answers is measured separately, below.

### First token from the companion (T01, 3 s)

Companion replies stream ([streamed-replies.md](streamed-replies.md)): the learner sees the first
words of a reply as a draft while the model writes, and the checked reply replaces it. "First
token" is the first streamed text on the learner's event stream. `services/api/qualification/supervised-flow.ts`
measures it end to end (`firstTokenMs`, check `streamed_reply_first_token_under_3s`) with nothing
called by hand: the learner's real HTTP question, the dispatcher's own loop (woken at commit,
2 s backstop poll), real Temporal, the HTTP provider gateway, a stub model that streams over
loopback HTTP after `QUALIFICATION_FIRST_TOKEN_MS` (default 600 ms, allowed 300–800 ms), and the
learner's real SSE event stream. The gate fails at 3,000 ms or more.

| Part | How it is bounded now | Before streaming |
| --- | --- | --- |
| Dispatcher picks the question up | woken by a PostgreSQL notification at commit (`outbox.wait` long poll); the 2 s interval is only a backstop | 0 to 2 s poll |
| Core's pipeline to the model call | workflow start, availability, claim, gateway admission | part of `firstReplyPipelineMs` |
| The model's own time to its first token | stub: 300–800 ms; live provider: not measured | — |
| Text reaching the learner | pushed on the open event stream when released at a safe boundary | 0 to 1 s poll, after verification |

Measured locally (2026-10-24, loaded Apple-silicon Mac):

| Stub first token | `firstTokenMs` (question sent → first text on the learner's stream) | `streamedReplyMs` (→ stored reply readable) |
| --- | --- | --- |
| 300 ms | 394 ms | 722 ms |
| 600 ms (default) | 673 ms | 972 ms |
| 800 ms | 864 ms | 1,154 ms |

So Core adds about 65–95 ms before the model's own first token, and the 3 s target leaves the
model about 2.5 s. `firstReplyPipelineMs` (391 ms, budget 1,500 ms) still measures Core's
non-streaming pipeline from dispatch to a readable stored reply with a provider that answers at
once. A live measurement with a real model needs the owner's provider and is not part of this
gate.

| Budget | Threshold | Measured locally (2026-10-21) | Product target |
| --- | --- | --- | --- |
| Cold course list | < 3,000 ms | 32–78 ms | — |
| Roadmap → lesson, median of 13 | < 200 ms (slowest < 600 ms) | 7–12 ms (slowest ≤ 20 ms) | < 200 ms navigation (T01) |
| Lesson → roadmap, median of 12 | < 200 ms (slowest < 600 ms) | 8–14 ms (slowest ≤ 20 ms) | < 200 ms navigation (T01) |
| Answer feedback, median of 4 after a warm-up | < 300 ms (slowest < 900 ms) | 35–47 ms (slowest ≤ 62 ms, 2026-10-24) | < 300 ms feedback (T01) |
| Command acknowledgement, each of 3 | < 500 ms | 6–27 ms | < 500 ms acknowledgement (T01) |
| JS heap after the round trips | < 64 MiB | 6.6 MiB | browser shell < 250 MB (T02) |
| JS heap growth over 12 round trips | < 8 MiB | 0.4 MiB | no leak |

The local figures come from an Apple-silicon Mac with other work running: Chrome at
desktop, phone and tablet sizes and WebKit at all three sizes. Firefox was not
installed locally; CI runs it.

The measured values are 10 to 40 times below the targets, so a shared CI runner that
is several times slower still passes; a failure means a real regression against the
product target, such as a navigation that now waits on a slow request. A pass shows
the targets are met on loopback, not for a real learner over a real network. The JS
heap is only part of a tab's memory, and the load and heap thresholds stay loose
regression guards.

## How feedback is judged

Feedback used to be asserted on each of two answers, so one sample decided the result. The
first answer is the first time the page runs the answer path: the grading receipt, the result
notice and the reloads a new course revision starts. On a busy CI runner that single cold
sample occasionally exceeded 300 ms on WebKit (690 ms once, PR #208) while the answers after it
took 30–60 ms. One sample cannot tell a slow machine from a slow app.

The rule is now the same as for the navigations:

1. **One warm-up answer is not judged.** The first check is answered wrongly on purpose, which
   also makes the lesson offer its second check and a fresh one. Its time is recorded as
   `warmUpFeedbackMs` in `budgets.json`.
2. **Four measured answers** follow: the second check and the fresh check of the first lesson,
   then both checks of the second lesson.
3. **The median of the four must be under 300 ms** (the T01 target, unchanged), and **the slowest
   under 900 ms** (three times the target, the same hard cap as the navigations). A regression
   that slows every answer moves the median and fails; one starved frame on a shared runner
   does not, unless it is far beyond the target.

Command acknowledgement is still asserted on every command (< 500 ms each).

## When a budget fails

Compare `budgets.json` from the failing run with a passing run on `main`. If the
change really needs more time or memory, raise the threshold in the spec and update
this table with the new measurements and the reason.
