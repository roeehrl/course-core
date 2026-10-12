import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { type RunRef, workflowId } from '../contracts.js';
import type { WorkflowStarter } from '../outbox.js';

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
