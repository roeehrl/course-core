import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { type RunRef, SUPERVISION_SIGNAL, JOB_PREPARED_SIGNAL, enrollmentWorkflowId, runRefSchema, supervisionSignalSchema, workflowId } from '../contracts.js';
import type { ControlSignaller, WorkflowStarter } from '../outbox.js';

export function temporalStarter(client: Client, taskQueue: string): WorkflowStarter {
  return {
    async start(ref: RunRef, id: string) {
      if (id !== workflowId(ref)) throw new Error('workflow_identity_mismatch');
      try {
        await client.workflow.start('supervisorJob', {
          workflowId: id, taskQueue, args: [ref],
          workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL',
          workflowExecutionTimeout: '24 hours', retry: { maximumAttempts: 1 },
        });
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
      await client.workflow.signalWithStart('enrollmentSupervisor', {
        workflowId: enrollmentWorkflowId(ref.workspaceId, ref.enrollmentId), taskQueue,
        args: [{ schemaVersion: 1, workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId }],
        signal: JOB_PREPARED_SIGNAL, signalArgs: [ref],
        workflowIdConflictPolicy: 'USE_EXISTING', retry: { maximumAttempts: 1 },
      });
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
