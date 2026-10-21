import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { sha256 } from './course-package.js';
import type { HostRequirementFile } from './course-package-routes.js';
import { remoteFetchMode, type RemoteFetchMode } from './course-package-source.js';
import { packageDirectories } from './course-package-directory.js';
import { createDatabase } from './database.js';
import { migrate } from './migrations.js';
import {composeAdaptation} from './adaptation-composition.js';
import { createServer } from './server.js';
import { parseLoginCodes, parseSessionHours } from './auth.js';
import { parseAdditionalOrigins, parseAllowInsecureOrigins } from './origins.js';
import { parseTrustedProxies } from './client-address.js';
import { composeProviders, unconfiguredProviders } from './provider-composition.js';
import { DockerSandbox, QUALIFIED_IMAGES } from '@course-core/sandbox';
import {isolatedTeachingVerifier,readIsolatedTeachingDefinition} from './isolated-teaching-verifier.js';
import { codeEvaluator } from './code-evaluator.js';
import type { RuntimeExtension } from './publication.js';
import { declarativeActivityRuntime } from './activity-runtime.js';
import { declarativeActivityEvaluator } from './declarative-evaluator.js';
import { svgRenderer } from './svg-renderer.js';
import { reviewedRubricEvaluator } from './rubric-evaluator.js';
import {localCredentialVault} from './key-vault.js';
import {WorkspaceProviders} from './provider-setup.js';
import { grantRuntimeAccess, assertRuntimePrivileges } from './db-roles.js';
import { nextWakeupDelay, scanWakeups } from './wakeups.js';
import { purgeEndedSessions } from './session-purge.js';
import { instrumentSandbox, startTelemetry, TelemetryConfigurationError } from './telemetry.js';
import { createMediaJobService, workspaceMediaResolver } from './media-jobs.js';
import { startMediaScheduler, type MediaScheduler } from './media-scheduler.js';
import { clipToolchainFromEnvironment } from './clip-export.js';
import { artifactStoreFromEnvironment, sweepArtifactObjects } from './artifact-store.js';
import { pythonRunnerFromEnvironment } from './python-runner.js';

// Optional OpenTelemetry export: off unless standard OTEL_* variables configure an endpoint.
let observability: Awaited<ReturnType<typeof startTelemetry>>;
try { observability = await startTelemetry({ serviceName: 'course-core-api' }); }
catch (error) { if (error instanceof TelemetryConfigurationError) throw new Error(`Invalid telemetry setting ${error.field}.`); throw error; }
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'http://localhost:4310');
const host = process.env.API_HOST ?? '127.0.0.1';
if (origin.origin !== origin.toString().replace(/\/$/, '') || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be an origin without credentials or a path.');
const loopbackOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopbackOrigin && ['127.0.0.1', '::1'].includes(host))) {
  throw new Error('Remote deployments require HTTPS. Plain HTTP is allowed only for loopback development.');
}
// Optional further exact https origins (for example a tailnet HTTPS proxy to this loopback
// listener). They never change where the API listens; PUBLIC_ORIGIN stays the primary origin.
// ALLOW_INSECURE_ORIGINS=true (operator choice, off by default) also lets them be any exact
// http origin rather than only a literal Tailscale address.
const allowInsecureOrigins = parseAllowInsecureOrigins(process.env.ALLOW_INSECURE_ORIGINS);
let additionalOrigins: string[];
try { additionalOrigins = parseAdditionalOrigins(process.env.ADDITIONAL_ORIGINS, origin.origin, { allowInsecure: allowInsecureOrigins }); }
catch (error) { throw new Error(`ADDITIONAL_ORIGINS: ${(error as Error).message}`); }
// TRUSTED_PROXIES (off by default): exact addresses of reverse proxies whose X-Forwarded-For
// names the client for sign-in and agent-key throttling. Never a range or "trust everything".
let trustedProxies: string[];
try { trustedProxies = parseTrustedProxies(process.env.TRUSTED_PROXIES); }
catch (error) { throw new Error(`TRUSTED_PROXIES: ${(error as Error).message}`); }
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
// Validate auth settings before connecting: a typo must not silently enable codes.
const sessionHours = parseSessionHours(process.env.SESSION_HOURS);
const loginCodes = parseLoginCodes(process.env.AUTH_LOGIN_CODES);
const db = createDatabase(connectionString);
const migrationConnection = process.env.MIGRATION_DATABASE_URL;
if (migrationConnection) {
  // Owner connection migrates and grants; the server itself runs DML-only.
  const owner = createDatabase(migrationConnection);
  try {
    await migrate(owner, fileURLToPath(new URL('../migrations', import.meta.url)));
    const role = decodeURIComponent(new URL(connectionString).username);
    if (!role) throw new Error('DATABASE_URL must name its runtime role when MIGRATION_DATABASE_URL is set.');
    await grantRuntimeAccess(owner, role);
  } finally { await owner.end(); }
  await assertRuntimePrivileges(db);
} else await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
let providers = unconfiguredProviders();
if (process.env.PROVIDER_CONFIG_FILE) {
  let configuration: unknown;
  try {
    const text = await readFile(process.env.PROVIDER_CONFIG_FILE, 'utf8');
    if (text.length > 100000) throw new Error();
    configuration = JSON.parse(text);
  } catch { throw new Error('Provider configuration could not be read as bounded JSON.'); }
  providers = composeProviders(configuration, name => process.env[name]);
}
const workspaceIds = (process.env.SUPERVISOR_WORKSPACE_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const installedExtensions: RuntimeExtension[] = [await svgRenderer(), reviewedRubricEvaluator(), declarativeActivityRuntime(), declarativeActivityEvaluator()];
// Names and digests of the host's configured fixture/verifier files, compared with a course
// package's host requirements. Host paths are never reported.
const hostFiles: HostRequirementFile[] = [];
// Course-package installs from GitHub release URLs: "github" (default) or "off".
const remoteFetch: RemoteFetchMode = remoteFetchMode(process.env.COURSE_PACKAGE_REMOTE_FETCH);
// Host folders course updates may read packages from (pilot `coursePackageDirectories`).
const coursePackageDirectories = packageDirectories(process.env.COURSE_PACKAGE_DIRECTORIES);
// How often due automatic course updates run (each course has its own interval; default 5 minutes).
const courseUpdateTickMs = Number(process.env.COURSE_UPDATE_TICK_MS ?? 300_000);
const courseVersionMoveTickMs = Number(process.env.COURSE_VERSION_MOVE_TICK_MS ?? 60_000);
if (!Number.isInteger(courseVersionMoveTickMs) || courseVersionMoveTickMs < 10_000) throw new Error('COURSE_VERSION_MOVE_TICK_MS must be an integer of at least 10000.');
if (!Number.isInteger(courseUpdateTickMs) || courseUpdateTickMs < 60_000) throw new Error('COURSE_UPDATE_TICK_MS must be an integer of at least 60000.');
let sandbox: DockerSandbox | undefined;
if (process.env.CODE_FIXTURE_FILES || process.env.TEACHING_VERIFIER_FILES) {
  let files: unknown;
  try { files = JSON.parse(process.env.CODE_FIXTURE_FILES ?? '[]'); } catch { throw new Error('CODE_FIXTURE_FILES must be a JSON array of trusted server file paths.'); }
  if (!Array.isArray(files) || files.length > 20 || !files.every(file => typeof file === 'string' && file.length < 4096)) throw new Error('Invalid code fixture file list.');
  const image = process.env.COURSE_SANDBOX_IMAGE ?? QUALIFIED_IMAGES[process.arch as keyof typeof QUALIFIED_IMAGES];
  if (!image) throw new Error('An explicitly pinned sandbox image is required on this platform.');
  sandbox = instrumentSandbox(new DockerSandbox({ image, storageDirectory: process.env.SANDBOX_STORAGE_DIR ?? fileURLToPath(new URL('../.local/sandboxes', import.meta.url)) }));
  for (const file of files) { const bytes = await readFile(file); hostFiles.push({ name: basename(file), sha256: sha256(bytes) }); installedExtensions.push(await codeEvaluator(bytes, sandbox)); }
  let teachingFiles:unknown;try{teachingFiles=JSON.parse(process.env.TEACHING_VERIFIER_FILES??'[]');}catch{throw new Error('Invalid teaching verifier file list.');}
  if(!Array.isArray(teachingFiles)||teachingFiles.length>20||!teachingFiles.every(file=>typeof file==='string'&&file.length<4096))throw new Error('Invalid teaching verifier file list.');
  for(const file of teachingFiles){hostFiles.push({name:basename(file),sha256:sha256(await readFile(file))});installedExtensions.push(await isolatedTeachingVerifier(await readIsolatedTeachingDefinition(file),sandbox));}
  if (new Set(installedExtensions.map(extension => extension.id)).size !== installedExtensions.length) throw new Error('Duplicate installed extension ID.');
}
// Optional object storage for large artifacts; off unless COURSE_ARTIFACT_STORE=s3. Checked before serving.
const artifactStore = artifactStoreFromEnvironment();
if (artifactStore) {
  try { await artifactStore.objects.check(); }
  catch (error) { throw new Error(`The artifact object store is not reachable (${(error as { code?: string }).code ?? 'OBJECT_STORE_UNAVAILABLE'}).`); }
}
const workspaceProviders = process.env.PROVIDER_VAULT_DIRECTORY ? new WorkspaceProviders(db, await localCredentialVault(process.env.PROVIDER_VAULT_DIRECTORY), {}, providers) : undefined;
// Exact clips and compositions need an rsvg-convert compatible rasterizer and ffmpeg (clip-export.ts).
const clipToolchain = clipToolchainFromEnvironment(process.env);
const app = await createServer(db, { origin: origin.origin, secureCookies: origin.protocol === 'https:', additionalOrigins, allowInsecureOrigins, loginCodes, trustedProxies,
  ...(sessionHours !== undefined ? { sessionHours } : {}),
  adaptation:composeAdaptation(JSON.parse(process.env.ADAPTATION_ADAPTERS??'[]'),installedExtensions),
  ...(process.env.CORE_INSTANCE_ID ? { instanceId: process.env.CORE_INSTANCE_ID } : {}),
  ...(process.env.LEARNER_WEB_DIR ? { learnerDirectory: process.env.LEARNER_WEB_DIR } : {}),
  ...(process.env.ADMIN_WEB_DIR ? { adminDirectory: process.env.ADMIN_WEB_DIR } : {}),
  providers,
  ...(workspaceProviders ? { workspaceProviders } : {}),
  media: { options: { clipToolchain } },
  installedExtensions,
  artifactStore,
  coursePackages: { hostFiles, remoteFetch }, coursePackageDirectories, courseUpdateTickMs, courseVersionMoveTickMs,
  pythonRunner: pythonRunnerFromEnvironment(process.env),
  ...(sandbox ? { sandbox } : {}),
  ...(process.env.SUPERVISOR_HOST_TOKEN ? { supervisor: { serviceToken: process.env.SUPERVISOR_HOST_TOKEN, workspaceIds } } : {}),
});
await app.listen({ port, host });
if (allowInsecureOrigins) process.stderr.write(`${JSON.stringify({ event: 'origins.insecure_allowed', origins: additionalOrigins.filter((value) => value.startsWith('http:')) })}\n`);
// Boundary wake-ups for the supervisor from durable per-deadline timers. The worker sleeps
// until the next timer, queued re-plan or retention check is due (at most WAKEUP_INTERVAL_MS),
// so its work follows what is due, not the number of active enrollments. Never authoritative.
const wakeupMs = Number(process.env.WAKEUP_INTERVAL_MS ?? 60_000);
if (Number.isInteger(wakeupMs) && wakeupMs >= 10_000) {
  // Failures are recorded in wakeup_failures and logged as stable codes only (no payloads or learner content).
  const report = (fields: Record<string, string>) => process.stderr.write(`${JSON.stringify({ event: 'wakeup.failure', ...fields })}\n`);
  const tick = async () => {
    let delay = wakeupMs;
    try {
      const result = await scanWakeups(db, { onFailure: failure => report({ ...failure }) });
      delay = result.wrapped ? await nextWakeupDelay(db, { maxMs: wakeupMs }) : 1_000;
    } catch (error) { const code = (error as { code?: unknown })?.code; report({ stage: 'scan', code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'INTERNAL_ERROR' }); }
    setTimeout(() => void tick(), delay).unref();
  };
  void tick();
}
// Generated-media jobs: durable wake-ups at each job's stored due time (media-scheduler.ts), leased
// and bounded; stored provider operations are polled, never resubmitted. Exact clips and
// compositions run here too when the clip toolchain is configured.
const mediaMaxSleepMs = Number(process.env.MEDIA_SCHEDULER_MAX_SLEEP_MS ?? 300_000);
let mediaScheduler: MediaScheduler | null = null;
if (workspaceProviders || clipToolchain) {
  const media = createMediaJobService(db, workspaceProviders ? workspaceMediaResolver(workspaceProviders) : undefined, { clipToolchain });
  // Failures are retried at the next due time; logged as a stable code only, never provider data, scripts or learner content.
  mediaScheduler = startMediaScheduler(db, media, { maxSleepMs: mediaMaxSleepMs,
    onError: code => process.stderr.write(`${JSON.stringify({ event: 'media.failure', code })}\n`) });
}
// Objects let go of (erasure) or never claimed are deleted from the store; failures retry next sweep.
const sweepMs = Number(process.env.ARTIFACT_SWEEP_INTERVAL_MS ?? 60_000);
if (artifactStore && Number.isInteger(sweepMs) && sweepMs >= 5_000) {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try {
      const swept = await sweepArtifactObjects(db, artifactStore);
      if (swept.failed) process.stderr.write(`${JSON.stringify({ event: 'artifact_objects.sweep_failure', failed: swept.failed })}\n`);
    } catch { process.stderr.write(`${JSON.stringify({ event: 'artifact_objects.sweep_failure', code: 'INTERNAL_ERROR' })}\n`); }
    finally { running = false; }
  };
  setInterval(() => void tick(), sweepMs).unref();
}
// Ended sign-in sessions are deleted a week after they end (session-purge.ts); failures retry next run.
const sessionPurgeMs = Number(process.env.SESSION_PURGE_INTERVAL_MS ?? 3_600_000);
if (Number.isInteger(sessionPurgeMs) && sessionPurgeMs >= 60_000) {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await purgeEndedSessions(db); }
    catch (error) { const code = (error as { code?: unknown })?.code; process.stderr.write(`${JSON.stringify({ event: 'sessions.purge_failure', code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'INTERNAL_ERROR' })}\n`); }
    finally { running = false; }
  };
  setInterval(() => void tick(), sessionPurgeMs).unref();
  void tick();
}
process.stdout.write(`Course API listening on ${host}:${port}\n`);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await mediaScheduler?.stop(); await app.close(); await db.end(); await observability.shutdown();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
