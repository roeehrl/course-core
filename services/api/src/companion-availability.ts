import type { FastifyInstance } from 'fastify';
import type { Database } from './database.js';
import type { authService } from './auth.js';
import { loadEnrollment } from './repository.js';
import { armOffersRole, studyArmWithin } from './study.js';
import { pricedStatus } from './provider-costs.js';
import type { ProviderRuntime } from './provider-runtime.js';

/**
 * Whether the companion can answer in this enrollment now, as the learner app says it:
 * - `ready`: the supervisor bridge serves this workspace and the companion role is bound to a
 *   configured model that may be charged (the worker's own priced availability, provider-costs.ts);
 * - `not_set_up`: no companion job is turned on (no bridge, no binding, no credential or no price);
 *   a question is still saved and waits until it is;
 * - `not_offered`: the learner's research-study version has no companion.
 * Status only: never a model, provider or price.
 */
export type CompanionAvailability = 'ready' | 'not_set_up' | 'not_offered';
export interface CompanionAvailabilityOptions {
  /** The provider runtime of a workspace (its own providers, else the host's). */
  runtime: (workspaceId: string, client: Database) => Promise<ProviderRuntime>;
  /** Workspaces the supervisor bridge serves; undefined when no bridge runs. */
  bridgeWorkspaces?: readonly string[];
  /** Test hosts only: replaces the computed status of one enrollment (browser/start.ts). */
  override?: (enrollmentId: string) => CompanionAvailability | undefined;
}
export async function companionAvailability(db: Database, workspaceId: string, enrollmentId: string, options: CompanionAvailabilityOptions): Promise<CompanionAvailability> {
  const arm = await studyArmWithin(db, enrollmentId);
  if (arm && !armOffersRole(arm.behaviour, 'companion')) return 'not_offered';
  const override = options.override?.(enrollmentId);
  if (override) return override;
  if (!options.bridgeWorkspaces?.includes(workspaceId)) return 'not_set_up';
  const runtime = await options.runtime(workspaceId, db);
  return (await pricedStatus(db, workspaceId, runtime)).companion?.status === 'ready' ? 'ready' : 'not_set_up';
}
const params = { type: 'object', required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
export function registerCompanionAvailabilityRoute(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, options: CompanionAvailabilityOptions) {
  app.get('/api/enrollments/:enrollmentId/companion/availability', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const context = await loadEnrollment(db, actor, enrollmentId);
    return { status: await companionAvailability(db, context.enrollment.workspace_id, enrollmentId, options) };
  });
}
