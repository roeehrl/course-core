import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../src/database.js';

/** Fixtures that exercise other features with a scripted model opt their workspace out of
 * the default price requirement, exactly as an operator can: unpriced calls then keep the
 * full per-job allowance as their charge. Priced behavior is covered by its own tests. */
export async function allowUnpricedPaidWork(db: Database | PoolClient, workspaceId: string) {
  const operator = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [operator, `test:${operator}`, 'Synthetic cost operator']);
  await db.query(`INSERT INTO workspace_cost_settings(workspace_id,require_priced_models,revision,changed_by) VALUES($1,false,1,$2)
    ON CONFLICT(workspace_id) DO UPDATE SET require_priced_models=false,revision=workspace_cost_settings.revision+1,changed_by=EXCLUDED.changed_by`, [workspaceId, operator]);
}
