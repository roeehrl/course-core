import {
  CancellationScope, isCancellation, proxyActivities, sleep, ApplicationFailure, ActivityCancellationType, CancelledFailure,
  condition, defineSignal, setHandler, startChild, continueAsNew, workflowInfo, getExternalWorkflowHandle, ParentClosePolicy, patched,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { Activities } from '../activities.js';
import {
  runRefSchema, summarize, supervisionSignalSchema, SUPERVISION_SIGNAL, JOB_PREPARED_SIGNAL, enrollmentInputSchema, workflowId,
  jobCancellationSignalSchema, JOB_CANCELLATION_SIGNAL,
  CROSS_COURSE_WAKE_SIGNAL, ENROLLMENT_OBSERVED_SIGNAL, crossCourseWakeSchema, enrollmentObservedSchema, learnerCoordinatorInputSchema,
  learnerCoordinatorWorkflowId,
  type EnrollmentInput, type EnrollmentSummary, type JobCancellationSignal, type RunRef, type Summary, type SupervisionSignal, type Transition,
  type CrossCoursePlan, type CrossCourseWake, type EnrollmentObserved, type LearnerCoordinatorInput, type LearnerCoordinatorSummary,
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

// Cross-course host calls: short, idempotent, no provider. Same bounds as `control`.
const coordination = proxyActivities<Activities>({
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
      /** One checkpoint until it continues; a stop ends the job with that summary. */
      const runCheckpoint = async (cp: (typeof spec.checkpoints)[number]): Promise<Summary | undefined> => {
        for (let attempt = 0; attempt < cp.maxAttempts; attempt++) {
          const result = await unlessHeld(() => activities.executeCheckpoint(ref, cp.id));
          checkCancellation();
          if (result.effect === 'stop') return summarize(result.snapshot);
          if (result.effect === 'continue') return undefined;
          if (result.effect !== 'retry') throw ApplicationFailure.nonRetryable('invalid_activity_effect', 'InvalidContract');
          // A rate-limited non-start may name when the provider will accept it again.
          const retried = result.snapshot.operations.find(o => o.checkpointId === cp.id)?.outcome;
          const hint = retried?.status === 'not_started' ? retried.retryAfterMs ?? 0 : 0;
          await sleep(Math.max(Math.min(1_000 * 2 ** attempt, 8_000), hint));
        }
        return undefined;
      };
      for (let index = 0; index < spec.checkpoints.length;) {
        const cp = spec.checkpoints[index]!;
        const group = cp.group === undefined ? [cp] : spec.checkpoints.filter(c => c.group === cp.group);
        index += group.length;
        if (group.length === 1) {
          const stopped = await runCheckpoint(cp);
          if (stopped) return stopped;
          continue;
        }
        // Alternative builders run side by side (design §4). The first that stops the job cancels its
        // siblings; their calls settle as uncertain and nothing they made can be applied late.
        let stopped: Summary | undefined;
        const builders = new CancellationScope();
        await builders.run(() => Promise.all(group.map(member => runCheckpoint(member).then(result => {
          if (result && !stopped) { stopped = result; builders.cancel(); }
        }, error => { if (!(stopped && isCancellation(error))) throw error; }))));
        checkCancellation();
        if (stopped) return stopped;
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

/** Marks histories in which enrollment coordinators report ended jobs to the learner's coordinator. */
export const CROSS_COURSE_OBSERVE_PATCH = 'cross-course-observe-v1';
/** Host wake-up of a learner's coordinator (consent granted or revoked, new evidence, erasure). */
export const crossCourseWake = defineSignal<[CrossCourseWake]>(CROSS_COURSE_WAKE_SIGNAL);
/** An enrollment coordinator reporting that one of its jobs ended. */
export const enrollmentObserved = defineSignal<[EnrollmentObserved]>(ENROLLMENT_OBSERVED_SIGNAL);
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
  /** Advisory wake-up of the learner's coordinator. Histories recorded before this existed replay without it. */
  const observed = async () => {
    if (!patched(CROSS_COURSE_OBSERVE_PATCH)) return;
    try {
      const { learnerId } = await coordination.observeEnrollment(input.workspaceId, input.enrollmentId);
      if (!learnerId) return;
      const signal: EnrollmentObserved = { schemaVersion: 1, learnerId, workspaceId: input.workspaceId, enrollmentId: input.enrollmentId };
      // A closed coordinator needs nothing: the host queued its own wake-up while answering.
      await getExternalWorkflowHandle(learnerCoordinatorWorkflowId(learnerId)).signal(enrollmentObserved, signal).catch(() => undefined);
    } catch { /* A wake-up only: the host's own evidence wake-ups still reach the coordinator. */ }
  };
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
        // After the job ends, tell the learner's cross-course coordinator (only when the host reports an
        // opt-in covering this enrollment). The coordinator waits for this before continuing as new.
        running.set(id, child.result().then(() => undefined, () => undefined).then(observed)
          .finally(() => { running.delete(id); jobOf.delete(id); }));
        if (control.revision > 0) void child.signal(supervisionControl, { schemaVersion: 1, enrollmentId: input.enrollmentId,
          state: control.state, revision: control.revision }).catch(() => undefined);
      } catch (error) {
        // Already started (a redelivered event, or started before this coordinator existed): it runs on its own.
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    }
  }
}

/** History bound for a learner's coordinator; it continues as new before reaching it. */
export const LEARNER_HISTORY_LIMIT = 2_000;
/** Wait after a host outage before planning again (a revocation ends the wait at once). */
export const PLAN_RETRY_MS = 60_000;

/**
 * One learner's cross-course coordinator. It exists only while the learner has opted in to sharing
 * between at least one pair of their enrollments, and it decides nothing itself: each pass asks the
 * host, which checks the opt-in, the staff-authored concept mapping and the learner's own evidence,
 * verifies each suggestion and stores it for the learner to confirm or dismiss. Nothing here grants
 * mastery, evidence or a gate. Signals only mark the learner "dirty"; passes are coalesced, the
 * learner's daily allowance is the host's, and state is bounded (a revision, a flag, counters).
 * A revocation cancels a pass under way and ends the run; the host refuses the pass anyway.
 */
export async function learnerCoordinator(raw: LearnerCoordinatorInput): Promise<LearnerCoordinatorSummary> {
  const parsed = learnerCoordinatorInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable('invalid_learner_input', 'InvalidContract');
  const input = parsed.data;
  let revision = input.consentRevision, dirty = input.dirty, revoked = false, planned = input.planned, passesThisRun = 0;
  let pass: CancellationScope | undefined;
  setHandler(crossCourseWake, rawSignal => {
    const signal = crossCourseWakeSchema.safeParse(rawSignal);
    // A malformed, foreign or older signal is ignored rather than failing the coordinator.
    if (!signal.success || signal.data.learnerId !== input.learnerId || signal.data.consentRevision < revision) return;
    revision = signal.data.consentRevision;
    revoked = !signal.data.active;
    if (revoked) pass?.cancel(); else dirty = true;
  });
  setHandler(enrollmentObserved, rawSignal => {
    const signal = enrollmentObservedSchema.safeParse(rawSignal);
    if (signal.success && signal.data.learnerId === input.learnerId) dirty = true;
  });
  const shouldContinue = () => passesThisRun >= input.maxPlansPerRun || workflowInfo().continueAsNewSuggested
    || workflowInfo().historyLength >= LEARNER_HISTORY_LIMIT;
  // Never plan for a learner without an opt-in, even when a late signal opened this run.
  const consent = await coordination.crossCourseConsent(input.learnerId);
  revision = Math.max(revision, consent.consentRevision);
  if (!consent.active || revoked) return { planned, reason: revoked ? 'consent_revoked' : 'no_consent' };
  for (;;) {
    const woke = await condition(() => revoked || dirty || shouldContinue(), input.idleMs);
    if (revoked) return { planned, reason: 'consent_revoked' };
    if (!woke) return { planned, reason: 'idle' };
    if (shouldContinue()) return continueAsNew<typeof learnerCoordinator>({ ...input, consentRevision: revision, dirty, planned });
    dirty = false;
    passesThisRun++;
    let result: CrossCoursePlan;
    try {
      result = await CancellationScope.cancellable(async () => {
        pass = CancellationScope.current();
        return coordination.planCrossCourse(input.learnerId, revision);
      });
    } catch (error) {
      if (revoked && isCancellation(error)) return { planned, reason: 'consent_revoked' };
      // Host unavailable after the activity's own retries: try again later, unless revoked meanwhile.
      dirty = true;
      await condition(() => revoked, PLAN_RETRY_MS);
      continue;
    } finally { pass = undefined; }
    revision = Math.max(revision, result.consentRevision);
    if (result.status === 'no_consent') return { planned, reason: 'consent_revoked' };
    planned += result.created;
    if (result.status === 'budget_wait') {
      await condition(() => revoked, Math.min(result.retryAfterMs ?? PLAN_RETRY_MS, input.maxBudgetWaitMs));
      dirty = true;
      continue;
    }
    // Coalesce: signals arriving in the quiet period become one later pass.
    if (input.coalesceMs > 0) await condition(() => revoked, input.coalesceMs);
  }
}
