import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { type RunRef, SUPERVISION_SIGNAL, supervisionSignalSchema, workflowId } from '../contracts.js';
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
