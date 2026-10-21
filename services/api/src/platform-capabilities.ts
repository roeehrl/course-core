import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { requireCondition } from './errors.js';
import { loadEnrollment } from './repository.js';

const TARGETS = ['web_desktop', 'web_mobile', 'ios_phone', 'ipados_tablet', 'android_phone', 'android_tablet'] as const;
const INPUT_MODES = ['touch', 'pointer', 'keyboard', 'stylus', 'screen_reader'] as const;
const token = { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,127}$' };
const version = { type: 'string', pattern: '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$' };
const list = (max: number, items: object = token) => ({ type: 'array', maxItems: max, uniqueItems: true, items });
/** Distinct reports kept per enrollment; a learner rarely uses more than a few device classes. */
export const MAX_PLATFORM_SNAPSHOTS = 24;

export interface PlatformCapabilitiesReport {
  target: (typeof TARGETS)[number];
  appVersion: string;
  sdkVersion: string;
  layoutClass: 'compact' | 'medium' | 'expanded';
  inputModes: (typeof INPUT_MODES)[number][];
  capabilities: string[];
  rendererIds: string[];
  nativeModules: string[];
}

/** The digest of a report with its lists in a canonical order, so the same device reports one snapshot. */
export function platformCapabilitiesDigest(report: PlatformCapabilitiesReport) {
  const canonical = {
    target: report.target, appVersion: report.appVersion, sdkVersion: report.sdkVersion, layoutClass: report.layoutClass,
    inputModes: [...report.inputModes].sort(), capabilities: [...report.capabilities].sort(),
    rendererIds: [...report.rendererIds].sort(), nativeModules: [...report.nativeModules].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * POST /api/enrollments/:enrollmentId/platform-capabilities (requirement M02).
 *
 * The learner's app reports what it can do (the SDK PlatformCapabilities record): its
 * target, app and SDK versions, window class, input modes, capabilities, renderers and
 * native modules. Each distinct report is kept once per enrollment as a
 * platform_capability_snapshots row; reporting it again only updates when it was last seen.
 * A report is a description of the device, never an authorization: activities still resolve
 * against what the course and the installed runtime allow. Only the enrollment's own learner
 * may report, and at most MAX_PLATFORM_SNAPSHOTS distinct reports are kept.
 */
export function registerPlatformCapabilityRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  app.post('/api/enrollments/:enrollmentId/platform-capabilities', {
    bodyLimit: 8192,
    schema: {
      params: { type: 'object', properties: { enrollmentId: { type: 'string', format: 'uuid' } }, required: ['enrollmentId'] },
      body: {
        type: 'object', additionalProperties: false,
        required: ['target', 'appVersion', 'sdkVersion', 'layoutClass', 'inputModes', 'capabilities', 'rendererIds', 'nativeModules'],
        properties: {
          target: { enum: TARGETS },
          appVersion: version,
          sdkVersion: version,
          layoutClass: { enum: ['compact', 'medium', 'expanded'] },
          inputModes: list(INPUT_MODES.length, { enum: INPUT_MODES }),
          capabilities: list(32),
          rendererIds: list(16),
          nativeModules: list(16),
        },
      },
    },
  }, async request => {
    const actor = await auth.authenticate(request);
    const { enrollmentId } = request.params as { enrollmentId: string };
    const report = request.body as PlatformCapabilitiesReport;
    const digest = platformCapabilitiesDigest(report);
    return transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, true);
      const seen = (await client.query<{ id: string }>(
        'UPDATE platform_capability_snapshots SET last_reported_at=clock_timestamp(),report_count=report_count+1 WHERE enrollment_id=$1 AND digest=$2 RETURNING id',
        [enrollmentId, digest])).rows[0];
      if (seen) return { recorded: true, duplicate: true, snapshotId: seen.id };
      const count = (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM platform_capability_snapshots WHERE enrollment_id=$1', [enrollmentId])).rows[0]!.n;
      requireCondition(count < MAX_PLATFORM_SNAPSHOTS, 'PLATFORM_SNAPSHOT_LIMIT', 429);
      const id = randomUUID();
      await client.query(`INSERT INTO platform_capability_snapshots(id,enrollment_id,workspace_id,digest,target,app_version,sdk_version,layout_class,
          input_modes,capabilities,renderer_ids,native_modules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, enrollmentId, context.enrollment.workspace_id, digest, report.target, report.appVersion, report.sdkVersion, report.layoutClass,
          JSON.stringify(report.inputModes), JSON.stringify(report.capabilities), JSON.stringify(report.rendererIds), JSON.stringify(report.nativeModules)]);
      return { recorded: true, duplicate: false, snapshotId: id };
    });
  });
}
