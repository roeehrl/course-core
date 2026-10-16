import {
  CancellationScope, isCancellation, proxyActivities, sleep, ApplicationFailure, ActivityCancellationType, CancelledFailure,
  condition, defineSignal, setHandler, startChild, continueAsNew, workflowInfo, getExternalWorkflowHandle, ParentClosePolicy,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { Activities } from '../activities.js';
import {
  runRefSchema, summarize, supervisionSignalSchema, SUPERVISION_SIGNAL, JOB_PREPARED_SIGNAL, enrollmentInputSchema, workflowId,
  jobCancellationSignalSchema, JOB_CANCELLATION_SIGNAL,
  type EnrollmentInput, type EnrollmentSummary, type JobCancellationSignal, type RunRef, type Summary, type SupervisionSignal, type Transition,
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
/** Host-recorded cancellation of one job (data erasure, provider change). A wake-up like
 * `supervisionControl`: the job's next host step stops it whether or not this arrives. */
export const jobCancellation = defineSignal<[JobCancellationSignal]>(JOB_CANCELLATION_SIGNAL);

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
  let cancelRequested = false;
  setHandler(jobCancellation, raw => {
    const signal = jobCancellationSignalSchema.safeParse(raw);
    if (!signal.success || signal.data.enrollmentId !== ref.enrollmentId || signal.data.jobId !== ref.jobId) return;
    // Cancels an activity's provider call, a retry sleep or a held wait at once; the cleanup halts
    // with `cancel_requested`, which the host has already recorded.
    cancelRequested = true; running?.cancel();
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
      if (stopRequested || cancelRequested) running.cancel();
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

/** A prepared job (any generation) for this enrollment, to run as a child workflow. */
export const jobPrepared = defineSignal<[RunRef]>(JOB_PREPARED_SIGNAL);
/** History is bounded by continue-as-new: after this many events the coordinator drains its
 * children and continues with its queue and control state. */
export const ENROLLMENT_HISTORY_LIMIT = 2_000;

/**
 * The enrollment's coordinator. It receives prepared jobs and staff controls as signals, runs
 * each job as a `supervisorJob` child (at most `maxConcurrent` at a time), forwards control
 * signals to the children it is running, and continues as new before its history grows large.
 * It never decides what a job may do: every job still asks the host at each step. It closes
 * after `idleMs` without work; the dispatcher's next signal-with-start opens it again.
 */
export async function enrollmentSupervisor(raw: EnrollmentInput): Promise<EnrollmentSummary> {
  const parsed = enrollmentInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable('invalid_enrollment_input', 'InvalidContract');
  const input = parsed.data;
  const pending: RunRef[] = [...input.pending];
  const queued = new Set(pending.map(workflowId));
  const running = new Map<string, Promise<void>>();
  const jobOf = new Map<string, string>();
  let control = input.control, startedThisRun = 0;
  setHandler(jobPrepared, rawRef => {
    const ref = runRefSchema.safeParse(rawRef);
    // A foreign or malformed job is ignored rather than failing the coordinator.
    if (!ref.success || ref.data.enrollmentId !== input.enrollmentId || ref.data.workspaceId !== input.workspaceId) return;
    const id = workflowId(ref.data);
    if (queued.has(id) || running.has(id) || pending.length >= 256) return;
    queued.add(id); pending.push(ref.data);
  });
  setHandler(supervisionControl, rawSignal => {
    const signal = supervisionSignalSchema.safeParse(rawSignal);
    if (!signal.success || signal.data.enrollmentId !== input.enrollmentId || signal.data.revision <= control.revision) return;
    control = { state: signal.data.state, revision: signal.data.revision };
    // Advisory: each child also obeys the stored control at its next step.
    for (const id of running.keys()) void getExternalWorkflowHandle(id).signal(supervisionControl, signal.data).catch(() => undefined);
  });
  setHandler(jobCancellation, rawSignal => {
    const signal = jobCancellationSignalSchema.safeParse(rawSignal);
    if (!signal.success || signal.data.enrollmentId !== input.enrollmentId) return;
    // A queued job is never started; a running child is told directly (the dispatcher also signals it).
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.jobId === signal.data.jobId) { queued.delete(workflowId(pending[i]!)); pending.splice(i, 1); }
    for (const [id, jobId] of jobOf) if (jobId === signal.data.jobId && running.has(id))
      void getExternalWorkflowHandle(id).signal(jobCancellation, signal.data).catch(() => undefined);
  });
  const shouldContinue = () => startedThisRun >= input.maxJobsPerRun || workflowInfo().continueAsNewSuggested
    || workflowInfo().historyLength >= ENROLLMENT_HISTORY_LIMIT;
  for (;;) {
    const woke = await condition(() => (!shouldContinue() && pending.length > 0 && running.size < input.maxConcurrent)
      || (shouldContinue() && running.size === 0), input.idleMs);
    if (!woke) {
      if (pending.length === 0 && running.size === 0) return { started: input.started + startedThisRun, reason: 'idle' };
      continue;
    }
    if (shouldContinue() && running.size === 0) {
      return continueAsNew<typeof enrollmentSupervisor>({ ...input, pending, control, started: input.started + startedThisRun });
    }
    while (!shouldContinue() && pending.length > 0 && running.size < input.maxConcurrent) {
      const ref = pending.shift()!, id = workflowId(ref);
      queued.delete(id);
      try {
        const child = await startChild(supervisorJob, { workflowId: id, args: [ref], parentClosePolicy: ParentClosePolicy.ABANDON,
          workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowExecutionTimeout: '24 hours', retry: { maximumAttempts: 1 } });
        startedThisRun++;
        jobOf.set(id, ref.jobId);
        running.set(id, child.result().then(() => undefined, () => undefined).finally(() => { running.delete(id); jobOf.delete(id); }));
        if (control.revision > 0) void child.signal(supervisionControl, { schemaVersion: 1, enrollmentId: input.enrollmentId,
          state: control.state, revision: control.revision }).catch(() => undefined);
      } catch (error) {
        // Already started (a redelivered event, or started before this coordinator existed): it runs on its own.
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    }
  }
}
