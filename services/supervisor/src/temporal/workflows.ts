import {
  CancellationScope, isCancellation, proxyActivities, sleep, ApplicationFailure, ActivityCancellationType, CancelledFailure,
  condition, defineSignal, setHandler,
} from '@temporalio/workflow';
import type { Activities } from '../activities.js';
import {
  runRefSchema, summarize, supervisionSignalSchema, SUPERVISION_SIGNAL,
  type RunRef, type Summary, type SupervisionSignal, type Transition,
} from '../contracts.js';

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '160 seconds', scheduleToCloseTimeout: '8 minutes', heartbeatTimeout: '15 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3, initialInterval: '1 second', maximumInterval: '5 seconds' },
});
// Non-provider activities don't heartbeat; finite retries + timeouts still apply.
const control = proxyActivities<Activities>({
  startToCloseTimeout: '15 seconds', scheduleToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, initialInterval: '1 second', maximumInterval: '5 seconds' },
});

/** Staff pause/stop/resume wake-up. The host's stored state stays authoritative: a held job asks
 * the host again on every signal and at least this often without one. */
export const supervisionControl = defineSignal<[SupervisionSignal]>(SUPERVISION_SIGNAL);
export const HOLD_POLL_MS = 15_000;

/** One bounded generation. Waiting jobs resume only via a host-authorized new dispatch generation. */
export async function supervisorJob(raw: RunRef): Promise<Summary> {
  const parsed = runRefSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable('invalid_job_reference', 'InvalidContract');
  const ref = parsed.data;
  let seen = 0, stopRequested = false;
  let running: CancellationScope | undefined;
  setHandler(supervisionControl, raw => {
    const signal = supervisionSignalSchema.safeParse(raw);
    // A malformed or foreign signal is ignored rather than failing the workflow task.
    if (!signal.success || signal.data.enrollmentId !== ref.enrollmentId || signal.data.revision <= seen) return;
    seen = signal.data.revision;
    if (signal.data.state === 'stopped') { stopRequested = true; running?.cancel(); }
  });
  /** Repeats a step the host answered with `hold` until the pause ends. Never counts as an attempt. */
  const unlessHeld = async (step: () => Promise<Transition>): Promise<Transition> => {
    for (;;) {
      const result = await step();
      if (result.effect !== 'hold') return result;
      const before = seen;
      await condition(() => seen !== before, HOLD_POLL_MS);
    }
  };
  let expired = false;
  try {
    const spec = await control.loadJob(ref);
    const remaining = spec.deadlineAtMs - Date.now();
    if (remaining <= 0) return summarize((await control.haltJob(ref, 'deadline_exceeded')).snapshot);
    return await CancellationScope.withTimeout(remaining, async () => {
      running = CancellationScope.current();
      if (stopRequested) running.cancel();
      const checkCancellation = () => {
        // An activity may catch cancellation to persist its uncertain outcome and then return
        // successfully. Cancellation scopes are cooperative, so don't accept that return as success.
        if (CancellationScope.current().consideredCancelled) throw new CancelledFailure('supervisor_cancelled');
      };
      for (const cp of spec.checkpoints) {
        for (let attempt = 0; attempt < cp.maxAttempts; attempt++) {
          const result = await unlessHeld(() => activities.executeCheckpoint(ref, cp.id));
          checkCancellation();
          if (result.effect === 'stop') return summarize(result.snapshot);
          if (result.effect === 'continue') break;
          if (result.effect !== 'retry') throw ApplicationFailure.nonRetryable('invalid_activity_effect', 'InvalidContract');
          // A rate-limited non-start may name when the provider will accept it again.
          const retried = result.snapshot.operations.find(o => o.checkpointId === cp.id)?.outcome;
          const hint = retried?.status === 'not_started' ? retried.retryAfterMs ?? 0 : 0;
          await sleep(Math.max(Math.min(1_000 * 2 ** attempt, 8_000), hint));
        }
      }
      const verified = await control.verifyJob(ref);
      checkCancellation();
      if (verified.effect === 'stop') return summarize(verified.snapshot);
      const applied = await unlessHeld(() => control.applyJob(ref));
      checkCancellation();
      return summarize(applied.snapshot);
    }).catch(error => { expired = Date.now() >= spec.deadlineAtMs; throw error; });
  } catch (error) {
    const reason = stopRequested && isCancellation(error) ? 'supervision_stopped'
      : expired ? 'deadline_exceeded' : isCancellation(error) ? 'cancel_requested' : 'activity_exhausted';
    return CancellationScope.nonCancellable(async () => {
      // If host persistence remains unavailable, fail visibly rather than invent a recorded terminal state.
      return summarize((await control.haltJob(ref, reason)).snapshot);
    });
  }
}
