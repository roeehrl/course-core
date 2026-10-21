import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FORBIDDEN_CAPABILITIES, SDK_VERSION, targetsForPlatforms } from '@course-core/sdk';
import type { authService } from './auth.js';
import { workspaceRole } from './course-access.js';
import { repositoryCoreVersion, supportedSdkRange } from './course-package-routes.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import type { RuntimeExtension } from './publication.js';
import { digestJson } from './repository.js';

/**
 * What this Core has installed, in the SDK's `HostInventory` shape (hostInventoryFormat 1), so an
 * author can run `course compat --host host-inventory.json` and see, before packing, the problems
 * the install preview would report on this host: the Core version, the SDK it validates with and
 * the range of SDKs it accepts packages from, the renderers with the render features each serves,
 * the installed extensions with their exact build, and the capabilities it can grant.
 *
 * It names installed builds and capability names only: no workspace data, provider keys, model
 * settings, host paths or file contents. Reviewed prior builds that Core still serves are listed
 * under `servedPriorBuilds` (outside the SDK shape, which the SDK ignores), because an inventory
 * entry is matched by extension ID and names the installed build.
 */
export interface HostInventory {
  hostInventoryFormat: 1;
  coreVersion: string;
  sdk: { version: string; supported: { min: string; maxExclusive: string } };
  renderers: { rendererId: string; version: string; features: string[]; targets: string[] }[];
  platformAdapters: { id: string; version: string; target: string }[];
  extensions: { id: string; version: string; integrity: string }[];
  capabilities: string[];
  servedPriorBuilds: { id: string; version: string; integrity: string; features?: string[] }[];
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

export function hostInventory(installed: readonly RuntimeExtension[], coreVersion = repositoryCoreVersion()): HostInventory {
  const extensions = [...installed].sort((a, b) => a.id.localeCompare(b.id));
  return {
    hostInventoryFormat: 1,
    coreVersion,
    sdk: { version: SDK_VERSION, supported: supportedSdkRange() },
    renderers: extensions.filter(extension => extension.renderFeatures).map(extension => ({
      rendererId: extension.id, version: extension.version,
      features: sorted(extension.renderFeatures!({ version: extension.version, integrity: extension.integrity })),
      targets: sorted(targetsForPlatforms(extension.platforms as Parameters<typeof targetsForPlatforms>[0])),
    })),
    // The web host has no native platform adapters; native apps are deferred.
    platformAdapters: [],
    extensions: extensions.map(({ id, version, integrity }) => ({ id, version, integrity })),
    capabilities: sorted(extensions.flatMap(extension => extension.capabilities).filter(capability => !FORBIDDEN_CAPABILITIES.has(capability))),
    servedPriorBuilds: extensions.flatMap(extension => (extension.acceptedPriorBuilds ?? []).map(prior => ({
      id: extension.id, version: prior.version, integrity: prior.integrity,
      ...(extension.renderFeatures ? { features: sorted(extension.renderFeatures(prior)) } : {}),
    }))),
  };
}

type Auth = ReturnType<typeof authService>;
const workspaceParams = z.strictObject({ workspaceId: z.uuid() });

/** GET the inventory as a file (owners and admins). The download is recorded in the audit log with its digest. */
export function registerHostInventoryRoutes(app: FastifyInstance, db: Database, auth: Auth, installed: readonly RuntimeExtension[]) {
  app.get('/api/admin/workspaces/:workspaceId/host-inventory', async (request, reply) => {
    const actor = await auth.authenticate(request);
    const parsed = workspaceParams.safeParse(request.params);
    requireCondition(parsed.success, 'INVALID_REQUEST');
    const { workspaceId } = parsed.data;
    const inventory = hostInventory(installed);
    const body = JSON.stringify(inventory, null, 2) + '\n', digest = digestJson(inventory);
    await transaction(db, async client => {
      await workspaceRole(client, actor, workspaceId, ['owner', 'admin']);
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'host_inventory.exported',
        payload: { coreVersion: inventory.coreVersion, sdkVersion: inventory.sdk.version, extensions: inventory.extensions.length, digest },
        idempotencyKey: `host-inventory:${randomUUID()}` });
    });
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="host-inventory-${inventory.coreVersion}.json"`);
    reply.header('X-Export-Digest', digest);
    return reply.send(body);
  });
}
