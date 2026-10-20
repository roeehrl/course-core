# Performance and memory budgets

`services/api/browser/budgets.spec.ts` checks the connected learner against
performance and memory budgets (requirements T01 and T02). It runs with the other
connected-browser tests:

- on Chromium at desktop, phone and tablet sizes (`npm run check:api`);
- on WebKit (desktop, iPhone, iPad) and Firefox through `playwright.engines.config.ts`.

It signs in a synthetic learner on the disposable test host, reloads the course list,
opens the fixture course, and then makes 12 round trips between the roadmap and the
first lesson. Every run attaches its measurements as `budgets.json` and prints them
in a `budgets {…}` log line.

## What is measured

| Measure | How |
| --- | --- |
| Cold course list | After a full reload, time from navigation start until the course card's heading is in the DOM. That heading needs the signed-in course list from the API, so the empty shell does not count |
| Roadmap → lesson | In the page, from the press of "Continue learning →" to the first animation frame where the lesson heading has replaced the roadmap. The lesson heading needs the lesson data |
| Lesson → roadmap | The same measurement for the roadmap button |
| JS heap (Chromium only) | `JSHeapUsedSize` from the DevTools protocol after a forced garbage collection: once after the first lesson opens, and again after the round trips |

The timings are measured inside the page, so Playwright's polling interval is not
included. They run over loopback against a local API and PostgreSQL. They measure
the app's own rendering and API round trips, not network latency to a remote host.

## Budgets

| Budget | Threshold | Measured locally | Product target |
| --- | --- | --- | --- |
| Cold course list | < 3,000 ms | 28–46 ms | — |
| Roadmap → lesson, median of 13 | < 500 ms (slowest < 1,500 ms) | 6–13 ms (slowest ≤ 20 ms) | < 200 ms navigation (T01) |
| Lesson → roadmap, median of 12 | < 500 ms (slowest < 1,500 ms) | 8–13 ms (slowest ≤ 23 ms) | < 200 ms navigation (T01) |
| JS heap after the round trips | < 64 MiB | 5.8 MiB | browser shell < 250 MB (T02) |
| JS heap growth over 12 round trips | < 8 MiB | 0.3–0.4 MiB | no leak |

The local figures come from an Apple-silicon Mac with other work running: Chrome at
all three sizes (three runs each) and WebKit at all three sizes. Firefox was not
installed locally; CI runs it.

The thresholds are deliberately generous: 10 to 100 times the measured values, and
looser than the product targets for navigation. A shared CI runner can be many times
slower than a workstation, and these checks must not become a flaky required
check. A failure therefore means a gross regression, such as a navigation that now
waits on a slow request or a component that leaks on every visit. A pass does not
show that the T01 latency targets are met for a real learner over a real network,
or that the whole browser process stays under 250 MB. The JS heap is only part of a
tab's memory.

## When a budget fails

Compare `budgets.json` from the failing run with a passing run on `main`. If the
change really needs more time or memory, raise the threshold in the spec and update
this table with the new measurements and the reason.
