import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { type RunRef, SUPERVISION_SIGNAL, JOB_PREPARED_SIGNAL, JOB_CANCELLATION_SIGNAL, jobCancellationSignalSchema, enrollmentWorkflowId, runRefSchema, supervisionSignalSchema, workflowId,
  CROSS_COURSE_WAKE_SIGNAL, crossCourseWakeSchema, learnerCoordinatorWorkflowId } from '../contracts.js';
import type { CancellationSignaller, ControlSignaller, CrossCourseSignaller, WorkflowStarter } from '../outbox.js';
import { telemetry } from '../telemetry.js';

/** A client span around a workflow start. With `workflowTraceInterceptor` installed on the client,
 * the start carries this span's context, so the workflow and its activities join the same trace. */
const startSpan = <T>(workflow: 'supervisorJob' | 'enrollmentSupervisor' | 'learnerCoordinator', body: () => Promise<T>) =>
  telemetry().span('supervisor.workflow.start', { 'course.supervisor.workflow': workflow }, body, { kind: 'client' });

export function temporalStarter(client: Client, taskQueue: string): WorkflowStarter {
  return {
    async start(ref: RunRef, id: string) {
      if (id !== workflowId(ref)) throw new Error('workflow_identity_mismatch');
      try {
        await startSpan('supervisorJob', () => client.workflow.start('supervisorJob', {
          workflowId: id, taskQueue, args: [ref],
          workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL',
          workflowExecutionTimeout: '24 hours', retry: { maximumAttempts: 1 },
        }));
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    },
  };
}
/** Hands each prepared job to its enrollment's coordinator, opening the coordinator if needed.
 * The signal is durable once this resolves; the coordinator starts the job as a child workflow
 * under the same job workflow ID, so a redelivered event cannot start it twice. */
export function enrollmentStarter(client: Client, taskQueue: string): WorkflowStarter {
  return {
    async start(raw: RunRef, id: string) {
      const ref = runRefSchema.parse(raw);
      if (id !== workflowId(ref)) throw new Error('workflow_identity_mismatch');
      await startSpan('enrollmentSupervisor', () => client.workflow.signalWithStart('enrollmentSupervisor', {
        workflowId: enrollmentWorkflowId(ref.workspaceId, ref.enrollmentId), taskQueue,
        args: [{ schemaVersion: 1, workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId }],
        signal: JOB_PREPARED_SIGNAL, signalArgs: [ref],
        workflowIdConflictPolicy: 'USE_EXISTING', retry: { maximumAttempts: 1 },
      }));
    },
  };
}
/** Signals a running workflow. A finished or unknown workflow needs no wake-up. */
export function temporalSignaller(client: Client): ControlSignaller {
  return {
    async signal(id, raw) {
      const signal = supervisionSignalSchema.parse(raw);
      try { await client.workflow.getHandle(id).signal(SUPERVISION_SIGNAL, signal); return 'delivered'; }
      catch (error) {
        if (error instanceof WorkflowNotFoundError) return 'closed';
        throw error;
      }
    },
  };
}
/** Signals one job (or its coordinator) to stop now. A finished or unknown workflow needs nothing. */
export function temporalCancellationSignaller(client: Client): CancellationSignaller {
  return {
    async cancel(id, raw) {
      const signal = jobCancellationSignalSchema.parse(raw);
      try { await client.workflow.getHandle(id).signal(JOB_CANCELLATION_SIGNAL, signal); return 'delivered'; }
      catch (error) {
        if (error instanceof WorkflowNotFoundError) return 'closed';
        throw error;
      }
    },
  };
}
/** Wakes a learner's coordinator. An active wake-up opens it with signal-with-start (one per learner);
 * an inactive one (no opt-in left) only signals a running coordinator and never starts one. */
export function crossCourseSignaller(client: Client, taskQueue: string): CrossCourseSignaller {
  return {
    async wake(raw) {
      const signal = crossCourseWakeSchema.parse(raw), id = learnerCoordinatorWorkflowId(signal.learnerId);
      if (!signal.active) {
        try { await client.workflow.getHandle(id).signal(CROSS_COURSE_WAKE_SIGNAL, signal); return 'delivered'; }
        catch (error) {
          if (error instanceof WorkflowNotFoundError) return 'closed';
          throw error;
        }
      }
      await startSpan('learnerCoordinator', () => client.workflow.signalWithStart('learnerCoordinator', {
        workflowId: id, taskQueue,
        args: [{ schemaVersion: 1, learnerId: signal.learnerId, consentRevision: signal.consentRevision }],
        signal: CROSS_COURSE_WAKE_SIGNAL, signalArgs: [signal],
        workflowIdConflictPolicy: 'USE_EXISTING', retry: { maximumAttempts: 1 },
      }));
      return 'delivered';
    },
  };
}
