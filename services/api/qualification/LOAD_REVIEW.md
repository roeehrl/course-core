# Load and resource review

`npx tsx qualification/load-flow.ts` drives concurrent learners through the real
HTTP API and PostgreSQL 17: sign-in, enrollment, reading, two independent
answers and gated completion (15 requests per learner). It needs an explicit
disposable `TEST_DATABASE_URL` and creates and drops its own schema.
`LOAD_LEVELS` sets the concurrency steps; `LOAD_EXTRA_EPISODES` (default 60)
pads the course to a realistic size, since per-request work scales with it.

## Results (2026-10-14, one API process, pool max 8, Apple M5 Max, local PostgreSQL 17)

62-episode course, all learners started at once. Failures were 0 in every run;
peak database connections stayed at the pool bound (8, plus the sampler).

| Build | Learners | Requests/s | GET enrollment p50 / p95 | Answer p50 / p95 |
|---|---|---|---|---|
| Before | 50 | 190 | — | — |
| Before | 200 | 201 | 1127 / 1363 ms | 1144 / 1383 ms |
| Release cache | 200 | 353 | 608 / 772 ms | 620 / 789 ms |
| + batch policy reads | 50 | 661 | 72 / 96 ms | 78 / 102 ms |
| + batch policy reads | 200 | 784 | 265 / 318 ms | 278 / 328 ms |

Peak process RSS was 523–654 MiB including the load generator in the same
process. A two-episode course reached about 2,100 requests/s at 200 learners.

## What changed

- Published releases are immutable in the database, so their bundles are read,
  digest-verified and parsed once per process (`src/release-cache.ts`). Cached
  bundles are deeply frozen; the full API suite passes with them frozen, so no
  request path mutates a shared course.
- The learner view checked read access once per episode, and each check
  re-validated the whole policy state. `checkActions` validates once per request
  and returns results identical to `checkAction` (tested in the policy package).

## Limits of this review

This measures one process on one fast laptop with a co-located database and no
network latency. It is not a capacity guarantee for another host. Adapted
enrollments (personal plans) were not part of this run; they now build their
delivered course once per adaptation state and reuse it, while the state digest,
bindings and policy reservations are still checked on every request (see
`test/adaptation-scaling.integration.test.ts`). Provider-backed supervision and code sandboxes are
bounded separately and were not exercised.

## Long session

`npm run test:long-session` (`qualification/long-session-flow.ts`, run with
`--expose-gc`) keeps one signed-in learner for `LONG_SESSION_ROUNDS` rounds
(default 600; nightly 3000): session checks, reads with periodic idempotent
replays, and many event streams ended by client aborts and by a short server
lifetime. It fails on any failed request, a duplicated or skipped streamed event,
a leaked per-account stream slot (or a missing 429 past the limit), database
pool growth or waiting clients, access after sign-out, or heap growth above
`LONG_SESSION_HEAP_BUDGET_MIB` (default 48) between a warmed-up baseline and the
end. Like the load flow it measures one host; it is not a capacity guarantee.
Both run nightly (`.github/workflows/nightly.yml`), not in pull-request CI.
