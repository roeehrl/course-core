import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { TOOL_FAMILIES, type ToolFamily } from './supervisor-tool-catalog.js';

type Sql = Database | PoolClient;

/**
 * How far the supervisor may act on its own after a learner's course-scoped opt-in (design §4
 * autonomy, requirement Q08). A workspace ceiling: a strategy's own SDK autonomy level can only
 * lower it, never raise it.
 * - recommend_only: the trigger table records what it would do; Core starts no teaching action.
 * - propose_only: Core starts teaching actions, but a plan that would change the learner's teaching
 *   is refused at verification; only proposals the learner reviews (model suggestions, research) go on.
 * - apply_verified_personal: verified personal changes apply after opt-in (the default).
 */
export const AUTONOMY_LEVELS = ['recommend_only', 'propose_only', 'apply_verified_personal'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export interface SupervisionSettings { autonomyLevel: AutonomyLevel; permittedToolFamilies: ToolFamily[]; revision: number }
export const DEFAULT_SUPERVISION_SETTINGS: Readonly<SupervisionSettings> = Object.freeze({
  autonomyLevel: 'apply_verified_personal', permittedToolFamilies: [...TOOL_FAMILIES], revision: 0,
});

/** The workspace's settings (defaults when none were saved). Unknown stored families are dropped. */
export async function supervisionSettingsWithin(client: Sql, workspaceId: string): Promise<SupervisionSettings> {
  const row = (await client.query<{ autonomy_level: AutonomyLevel; permitted_tool_families: string[]; revision: number }>(
    'SELECT autonomy_level,permitted_tool_families,revision FROM supervision_settings WHERE workspace_id=$1', [workspaceId])).rows[0];
  if (!row) return { ...DEFAULT_SUPERVISION_SETTINGS, permittedToolFamilies: [...DEFAULT_SUPERVISION_SETTINGS.permittedToolFamilies] };
  return { autonomyLevel: row.autonomy_level,
    permittedToolFamilies: row.permitted_tool_families.filter((f): f is ToolFamily => (TOOL_FAMILIES as readonly string[]).includes(f)),
    revision: row.revision };
}
