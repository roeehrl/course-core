import { spawn } from 'node:child_process';
import { BlockList } from 'node:net';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { PilotError, ensure, absolute, privateDirectory, privateFile, privateJson, writePrivate, mutex, ownerRecord, sameOwner,
  control, controlPath, controlServer, socketInfo, portFree, portOwnedBy, recoverStale, RotatingLog, delay, uid, hash } from './runtime.mjs';
import { verifyTemporalCli } from './temporal-cli.mjs';

export const repositoryRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export function parseArguments(args, modes = ['start', 'stop', 'status', 'recover']) {
  const mode = args[0]; ensure(modes.includes(mode), 'invalid_command');
  const result = { mode, root: repositoryRoot, state: path.join(repositoryRoot, '.local/pilot') };
  for (let i = 1; i < args.length; i += 2) {
    ensure(['--root', '--state', '--agents-directory'].includes(args[i]) && args[i + 1], 'invalid_arguments');
    const key = args[i] === '--agents-directory' ? 'agentsDirectory' : args[i].slice(2);
    ensure(!Object.hasOwn(result, `given_${key}`), 'duplicate_argument'); result[key] = absolute(args[i + 1]); result[`given_${key}`] = true;
  }
  return result;
}
function integer(value, fallback, min, max) { const n = value ?? fallback; ensure(Number.isInteger(n) && n >= min && n <= max, 'invalid_resource_limit'); return n; }
export async function loadConfiguration(rootInput, stateInput) {
  const root = await realpath(absolute(rootInput)), state = await privateDirectory(stateInput);
  const config = (await privateJson(path.join(state, 'config.json'))).value;
  ensure(config && !Array.isArray(config) && Object.keys(config).every(key => ['schemaVersion', 'publicOrigin', 'databaseUrl', 'temporalPort', 'temporalUiPort',
    'serviceToken', 'workspaceIds', 'codeFixtureFiles', 'teachingVerifierFiles', 'providerConfigFile', 'providerCredentials', 'resources', 'temporalTaskQueue','adaptationAdapters','providerVaultDirectory','migrationDatabaseUrl','sessionHours','loginCodes','telemetry','additionalOrigins','coursePackageDirectories','allowInsecureOrigins','backupAgeRecipients','temporalCliSha256','snapshots','courseSuppliedCodeFixtures','mediaTools'].includes(key)), 'invalid_configuration');
  let origin, database;
  try { origin = new URL(config.publicOrigin); database = new URL(config.databaseUrl); } catch { throw new PilotError('invalid_configuration'); }
  ensure(config.schemaVersion === 1 && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)
    && origin.origin === config.publicOrigin && origin.port && Number(origin.port) >= 1024
    && ['postgres:', 'postgresql:'].includes(database.protocol) && database.pathname.length > 1
    && (['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !database.hostname && database.searchParams.get('host')?.startsWith('/'))
    && /^[A-Za-z0-9_-]{32,128}$/.test(config.serviceToken ?? '') && Array.isArray(config.workspaceIds)
    && config.workspaceIds.length <= 100 && config.workspaceIds.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)), 'invalid_configuration');
  const ports = [Number(origin.port), config.temporalPort, config.temporalUiPort];
  ensure(ports.every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) && new Set(ports).size === 3, 'invalid_service_ports');
  if (!config.temporalTaskQueue) {
    // Existing durable workflows may use an earlier queue name. Guessing or
    // silently deriving a different queue can strand them after a restart.
    let existing=false;try{existing=(await lstat(path.join(state,'temporal.db'))).size>0;}catch(error){if(error.code!=='ENOENT')throw error;}
    ensure(!existing,'existing_temporal_queue_required');
    config.temporalTaskQueue=`course-core-pilot-${hash(state).slice(0,24)}`;
  }
  ensure(typeof config.temporalTaskQueue==='string' && /^[A-Za-z0-9._:-]{1,128}$/.test(config.temporalTaskQueue),'invalid_temporal_queue');
  const resources = config.resources ?? {};
  ensure(resources && !Array.isArray(resources) && Object.keys(resources).every(key => ['workerConcurrency', 'dispatchIntervalMs', 'logBytes', 'logBackups','apiHeapMiB','workerHeapMiB','dispatcherHeapMiB','temporalMemoryMiB'].includes(key)), 'invalid_resource_limit');
  config.resources = {
    workerConcurrency: integer(resources.workerConcurrency, 2, 1, 4), dispatchIntervalMs: integer(resources.dispatchIntervalMs, 2000, 1000, 60000),
    logBytes: integer(resources.logBytes, 1_048_576, 1024, 16_777_216), logBackups: integer(resources.logBackups, 3, 1, 8),
    apiHeapMiB:integer(resources.apiHeapMiB,512,128,2048), workerHeapMiB:integer(resources.workerHeapMiB,384,128,2048),
    dispatcherHeapMiB:integer(resources.dispatcherHeapMiB,128,64,512), temporalMemoryMiB:integer(resources.temporalMemoryMiB,384,128,1024),
  };
  ensure(Array.isArray(config.codeFixtureFiles ?? []) && (config.codeFixtureFiles ?? []).length <= 20, 'invalid_fixture_configuration');
  config.codeFixtureFiles = await Promise.all((config.codeFixtureFiles ?? []).map(async value => {
    ensure(typeof value === 'string' && value.length < 4096 && !/[\x00-\x1f]/.test(value), 'invalid_fixture_configuration');
    const resolved = path.resolve(root, value); await privateFile(resolved, false, 1_048_576); return resolved;
  }));
  ensure((config.teachingVerifierFiles===undefined||Array.isArray(config.teachingVerifierFiles))&&(config.teachingVerifierFiles??[]).length<=20,'invalid_teaching_verifier_configuration');
  config.teachingVerifierFiles=await Promise.all((config.teachingVerifierFiles??[]).map(async value=>{ensure(typeof value==='string'&&value.length<4096&&!/[\x00-\x1f]/.test(value),'invalid_teaching_verifier_configuration');const resolved=path.resolve(root,value);await privateFile(resolved,false,262144);return resolved;}));
  ensure(new Set(config.teachingVerifierFiles).size===config.teachingVerifierFiles.length,'duplicate_teaching_verifier_file');
  if (config.providerConfigFile) {
    ensure(typeof config.providerConfigFile === 'string' && !/[\x00-\x1f]/.test(config.providerConfigFile), 'invalid_provider_configuration');
    config.providerConfigFile = path.resolve(root, config.providerConfigFile); await privateFile(config.providerConfigFile, false, 100_000);
  }
  if (config.migrationDatabaseUrl !== undefined) {
    // Optional owner connection for migrations; the services then run as the
    // least-privilege role named in databaseUrl.
    let migration;
    try { migration = new URL(config.migrationDatabaseUrl); } catch { throw new PilotError('invalid_configuration'); }
    ensure(['postgres:', 'postgresql:'].includes(migration.protocol) && migration.pathname === database.pathname && new URL(config.databaseUrl).username && migration.username !== new URL(config.databaseUrl).username, 'invalid_configuration');
  }
  config.providerVaultDirectory=config.providerVaultDirectory??path.join(state,'provider-vault');
  ensure(typeof config.providerVaultDirectory==='string'&&path.isAbsolute(config.providerVaultDirectory),'invalid_provider_vault_directory');
  config.providerVaultDirectory=await privateDirectory(config.providerVaultDirectory,true);
  const credentials = config.providerCredentials ?? {};
  ensure(credentials && typeof credentials === 'object' && !Array.isArray(credentials) && Object.keys(credentials).length <= 20
    && Object.entries(credentials).every(([key, value]) => /^(?:GOOGLE_API_KEY|COURSE_PROVIDER_[A-Z0-9_]+_API_KEY)$/.test(key)
      && typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0')), 'invalid_credential_binding');
  config.providerCredentials = credentials;
  // Sign-in sessions: hours (fractions allowed), default 12, at most 30 days.
  if (config.sessionHours !== undefined) ensure(typeof config.sessionHours === 'number' && Number.isFinite(config.sessionHours) && config.sessionHours > 0
    && config.sessionHours <= 720 && Number.isSafeInteger(config.sessionHours * 3600_000), 'invalid_session_lifetime');
  // One-time sign-in codes stay off unless explicitly enabled; passwords are the default.
  ensure(config.loginCodes === undefined || typeof config.loginCodes === 'boolean', 'invalid_login_codes');
  config.telemetry = telemetryConfiguration(config.telemetry);
  config.allowInsecureOrigins = allowInsecureOriginsConfiguration(config.allowInsecureOrigins);
  ensure(config.courseSuppliedCodeFixtures === undefined || typeof config.courseSuppliedCodeFixtures === 'boolean', 'invalid_course_supplied_configuration');
  config.additionalOrigins = additionalOriginsConfiguration(config.additionalOrigins, config.publicOrigin, config.allowInsecureOrigins);
  config.coursePackageDirectories = coursePackageDirectoriesConfiguration(config.coursePackageDirectories);
  config.backupAgeRecipients = backupAgeRecipientsConfiguration(config.backupAgeRecipients);
  config.snapshots = snapshotsConfiguration(config.snapshots);
  config.mediaTools = await mediaToolsConfiguration(config.mediaTools);
  for (const directory of config.coursePackageDirectories) await existingDirectory(directory);
  const adapters=config.adaptationAdapters??[];
  ensure(Array.isArray(adapters)&&adapters.length<=4&&new Set(adapters).size===adapters.length&&adapters.every(id=>['bounded-numeric-v1','authored-bank-v1','authored-code-bank-v1','authored-teaching-bank-v1'].includes(id)),'invalid_adaptation_adapter_selection');
  config.adaptationAdapters=adapters;
  ensure(config.temporalCliSha256 === undefined || (typeof config.temporalCliSha256 === 'string' && /^[a-f0-9]{64}$/.test(config.temporalCliSha256)), 'invalid_temporal_cli_sha256');
  for (const file of ['.local/bin/temporal', 'services/api/dist/main.js', 'services/supervisor/dist/src/cli.js', 'apps/learner/dist/index.html', 'apps/admin/dist/index.html']) {
    await access(path.join(root, file), constants.R_OK);
  }
  await access(path.join(root, '.local/bin/temporal'), constants.X_OK); controlPath(state);
  return { root, state, config, ports };
}
/** `mediaTools` keys and the API variables the media pipeline reads (services/api clip-export.ts, media-pixels.ts). */
export const MEDIA_TOOL_ENVIRONMENT = Object.freeze({ ffmpeg: 'CLIP_FFMPEG_PATH', ffprobe: 'CLIP_FFPROBE_PATH', rasterizer: 'CLIP_RASTERIZER_PATH' });
/** Optional `mediaTools` key: host programs for exact clips and the frame check, each an
 * absolute path to an existing executable file. `ffmpeg` is required once the key is present;
 * `ffprobe` defaults (in the API) to an `ffprobe` beside ffmpeg; exact clips also need
 * `rasterizer` (an rsvg-convert-compatible program). Only the API receives them. Absent: off. */
export async function mediaToolsConfiguration(value) {
  if (value === undefined) return null;
  const keys = Object.keys(MEDIA_TOOL_ENVIRONMENT);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every(key => keys.includes(key)))
    refuse('invalid_media_tools', `mediaTools is an object with only ${keys.join(', ')}`);
  if (typeof value.ffmpeg !== 'string') refuse('invalid_media_tools', 'mediaTools.ffmpeg is required: the absolute path to ffmpeg');
  const tools = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    const file = value[key];
    if (typeof file !== 'string' || file.length >= 4096 || /[\x00-\x1f]/.test(file) || !path.isAbsolute(file) || path.normalize(file) !== file)
      refuse('invalid_media_tools', `mediaTools.${key} must be an absolute, normalized path`);
    let info;
    try { info = await stat(file); } catch { refuse('media_tool_missing', `mediaTools.${key} does not exist on this host`); }
    if (!info.isFile()) refuse('media_tool_missing', `mediaTools.${key} is not a file`);
    try { await access(file, constants.X_OK); } catch { refuse('media_tool_not_executable', `mediaTools.${key} is not executable by the pilot user`); }
    tools[key] = file;
  }
  return tools;
}
/** Optional `snapshots` key: online snapshots taken while the pilot runs (backup.mjs snapshot),
 * which bound data loss to `intervalMinutes` (the 1 hour RPO needs 60 or less). `directory` is an
 * absolute, owner-only folder; the newest `keep` intact snapshots are kept. Absent: off. */
export function snapshotsConfiguration(value) {
  if (value === undefined) return null;
  ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['directory', 'intervalMinutes', 'keep'].includes(key)), 'invalid_snapshots');
  ensure(typeof value.directory === 'string' && path.isAbsolute(value.directory) && value.directory.length < 1024 && !/[\x00-\x1f']/.test(value.directory), 'invalid_snapshots');
  const intervalMinutes = value.intervalMinutes ?? 60, keep = value.keep ?? 48;
  ensure(Number.isInteger(intervalMinutes) && intervalMinutes >= 15 && intervalMinutes <= 60, 'invalid_snapshot_interval');
  ensure(Number.isInteger(keep) && keep >= 2 && keep <= 1000, 'invalid_snapshot_keep');
  return { directory: path.normalize(value.directory), intervalMinutes, keep };
}
/**
 * Takes an online snapshot every `intervalMinutes` while the pilot runs, then prunes old ones.
 * Each run is a separate `backup.mjs` process, never two at once, with a bounded duration; the
 * services log records only whether it worked (the database records the failure code and timings
 * for the readiness page). The first snapshot starts shortly after the services are ready.
 */
export function snapshotSchedule({ root, state, snapshots, log, spawnProcess = spawn, firstDelayMs = 60_000, timeoutMs = 30 * 60_000 }) {
  let timer, running = null, stopped = false;
  const backupScript = fileURLToPath(new URL('./backup.mjs', import.meta.url));
  const runOnce = (args) => new Promise(resolve => {
    const child = spawnProcess(process.execPath, [backupScript, ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr?.on('data', chunk => { if (error.length < 4096) error += chunk; });
    const limit = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    running = child;
    child.once('error', () => { clearTimeout(limit); resolve({ ok: false, code: 'snapshot_spawn_failed' }); });
    child.once('exit', status => {
      clearTimeout(limit); running = null;
      let code = null; try { code = JSON.parse(error.trim().split('\n').at(-1) ?? '{}').code ?? null; } catch { /* not JSON */ }
      resolve({ ok: status === 0, code: status === 0 ? null : typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'snapshot_failed' });
    });
  });
  async function tick() {
    if (stopped || running) return;
    const created = await runOnce(['snapshot', '--root', root, '--state', state, '--output', snapshots.directory]);
    log.write(created.ok ? 'snapshot_created' : 'snapshot_failed');
    if (created.ok && !stopped) {
      const pruned = await runOnce(['prune', '--output', snapshots.directory, '--keep', String(snapshots.keep), '--kind', 'snapshot']);
      if (!pruned.ok) log.write('snapshot_prune_failed');
    }
  }
  const first = setTimeout(() => { void tick(); timer = setInterval(() => void tick(), snapshots.intervalMinutes * 60_000); timer.unref?.(); }, firstDelayMs);
  first.unref?.();
  return {
    tick,
    stop() { stopped = true; clearTimeout(first); if (timer) clearInterval(timer); running?.kill('SIGTERM'); },
  };
}
export const MAX_ADDITIONAL_ORIGINS = 8;
export const MAX_BACKUP_AGE_RECIPIENTS = 8;
/** Optional `backupAgeRecipients` key: age X25519 public keys (`age1…`). Absent or
 * empty means backups are not encrypted. Only public keys belong here; an age
 * identity (private key) is refused outright and is supplied at restore time. */
export function backupAgeRecipientsConfiguration(value) {
  if (value === undefined) return [];
  ensure(Array.isArray(value) && value.length <= MAX_BACKUP_AGE_RECIPIENTS, 'invalid_backup_age_recipients');
  for (const item of value) {
    ensure(typeof item === 'string', 'invalid_backup_age_recipients');
    ensure(!/AGE-SECRET-KEY-/i.test(item), 'backup_age_private_key_in_configuration');
    ensure(/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(item), 'invalid_backup_age_recipients');
  }
  ensure(new Set(value).size === value.length, 'duplicate_backup_age_recipient');
  return [...value];
}
// Addresses Tailscale assigns to tailnet nodes.
const tailscaleAddresses = new BlockList();
tailscaleAddresses.addSubnet('100.64.0.0', 10, 'ipv4'); tailscaleAddresses.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
function tailscaleAddress(hostname) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return tailscaleAddresses.check(hostname, 'ipv4');
  const v6 = /^\[([0-9a-f:]+)\]$/.exec(hostname)?.[1];
  try { return v6 !== undefined && v6.startsWith('fd7a:115c:a1e0:') && tailscaleAddresses.check(v6, 'ipv6'); } catch { return false; }
}
/** Optional `allowInsecureOrigins` key, the operator's switch for the insecure-address
 * check (ALLOW_INSECURE_ORIGINS). Absent or false: the check is on, as by default. */
export function allowInsecureOriginsConfiguration(value) {
  ensure(value === undefined || typeof value === 'boolean', 'invalid_allow_insecure_origins');
  return value === true;
}
/** A plain-http origin whose host is not a literal Tailscale address (a LAN address or a
 * host name): its traffic, sign-in included, crosses the network unencrypted. */
export function insecureOrigin(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && !tailscaleAddress(url.hostname); } catch { return false; }
}
const INSECURE_ORIGIN_CHECK = 'node deploy/local/pilot.mjs security insecure-origin-check';
function refuse(code, hint) { const error = new PilotError(code); error.hint = hint; throw error; }
/** One extra origin the API trusts besides publicOrigin, exactly as a browser sends it
 * (no credentials, path, wildcard, default port or upper case): https, or http to a
 * literal Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) with an explicit port,
 * as reached through `tailscale serve --tcp` (raw TCP forwarding; `--http` answers only
 * the MagicDNS name). Tailnet traffic is WireGuard-encrypted, but
 * such a page is not a browser secure context (no Secure cookies, no passkeys). Every
 * other http origin is refused unless the operator turned the insecure-address check off
 * (`allowInsecure`); it still needs an explicit port. It never changes where the API
 * listens (always 127.0.0.1). */
export function additionalOrigin(value, allowInsecure = false) {
  let url;
  try { url = new URL(value); } catch { throw new PilotError('invalid_additional_origin'); }
  ensure(typeof value === 'string' && value.length <= 255 && !value.includes('*') && !url.username && !url.password
    && (url.protocol === 'https:' || url.protocol === 'http:' && url.port)
    && url.hostname && url.origin === value, 'invalid_additional_origin');
  if (insecureOrigin(value) && !allowInsecure) refuse('insecure_origin_refused',
    `Plain-http origins outside Tailscale are refused while the insecure-address check is on. Turn the insecure-address check off with: ${INSECURE_ORIGIN_CHECK} off --state <dir>`);
  return value;
}
/** Optional `additionalOrigins` key: absent means none, so older configs are unchanged. */
export function additionalOriginsConfiguration(value, publicOrigin, allowInsecure = false) {
  if (value === undefined) return [];
  ensure(Array.isArray(value) && value.length <= MAX_ADDITIONAL_ORIGINS, 'invalid_additional_origins');
  const origins = value.map(item => additionalOrigin(item, allowInsecure));
  ensure(new Set([publicOrigin, ...origins]).size === origins.length + 1, 'duplicate_additional_origin');
  return origins;
}
/** `origins add|remove|list --state <dir> [<origin>]`: edits config.json atomically,
 * keeping every other key and the file's mode. Takes effect on the next start. */
export function parseOriginsArguments(args) {
  ensure(args[0] === 'origins' && ['add', 'remove', 'list'].includes(args[1]), 'invalid_command');
  const result = { action: args[1], state: path.join(repositoryRoot, '.local/pilot') };
  let given = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--state') { ensure(!given && args[i + 1], 'invalid_arguments'); result.state = absolute(args[++i]); given = true; }
    else { ensure(result.origin === undefined && !args[i].startsWith('--'), 'invalid_arguments'); result.origin = args[i]; }
  }
  ensure(result.action === 'list' ? result.origin === undefined : result.origin !== undefined, 'invalid_arguments');
  return result;
}
async function editConfiguration(stateInput, edit) {
  const state = await privateDirectory(stateInput), file = path.join(state, 'config.json');
  return mutex(state, 'config.lock', async () => {
    const { value: config, info, text } = await privateJson(file);
    ensure(config && typeof config === 'object' && !Array.isArray(config) && typeof config.publicOrigin === 'string', 'invalid_configuration');
    const save = async () => {
      const indent = /^\{\r?\n(\t| +)"/.exec(text)?.[1];
      await writePrivate(file, JSON.stringify(config, null, indent) + (text.endsWith('\n') ? '\n' : ''), true, info.mode & 0o777);
    };
    return edit(config, save);
  });
}
export async function manageOrigins({ action, state, origin }) {
  return editConfiguration(state, async (config, save) => {
    const allowInsecure = allowInsecureOriginsConfiguration(config.allowInsecureOrigins);
    // Listing and removing read the list leniently, so an origin the switch no longer
    // allows can still be seen and taken out; adding checks against the switch.
    const current = additionalOriginsConfiguration(config.additionalOrigins, config.publicOrigin, true);
    const summary = list => ({ publicOrigin: config.publicOrigin, additionalOrigins: list, allowInsecureOrigins: allowInsecure });
    if (action === 'list') return { status: 'ok', ...summary(current) };
    additionalOrigin(origin, action === 'remove' || allowInsecure);
    const next = action === 'add' ? (current.includes(origin) ? current : [...current, origin]) : current.filter(item => item !== origin);
    if (next.length === current.length) return { status: 'unchanged', ...summary(current) };
    additionalOriginsConfiguration(next, config.publicOrigin, action === 'remove' || allowInsecure);
    // Removing the last origin removes the key, so older launchers accept the file again.
    if (next.length) config.additionalOrigins = next; else delete config.additionalOrigins;
    await save();
    return { status: 'updated', ...summary(next), restartRequired: true };
  });
}
/** `security insecure-origin-check on|off|status --state <dir>`: the operator's switch for
 * the insecure-address check, named by the check's state. On (the default) refuses
 * plain-http origins outside Tailscale; off lets `origins add` trust them. Takes effect on
 * the next start. The deprecated `security insecure-origins on|off|status` (0.1.46) names
 * whether insecure origins are allowed, so its on is the check's off; it still works and
 * is reported as `deprecated` with the equivalent new form. */
export function parseSecurityArguments(args) {
  ensure(args[0] === 'security' && ['insecure-origin-check', 'insecure-origins'].includes(args[1]) && ['on', 'off', 'status'].includes(args[2]), 'invalid_command');
  const legacy = args[1] === 'insecure-origins';
  const check = legacy ? { on: 'off', off: 'on', status: 'status' }[args[2]] : args[2];
  const result = { check, state: path.join(repositoryRoot, '.local/pilot') };
  if (legacy) result.deprecated = `deprecated: "security insecure-origins ${args[2]}" is now "${INSECURE_ORIGIN_CHECK} ${check} --state <dir>" (same effect)`;
  let given = false;
  for (let i = 3; i < args.length; i++) {
    ensure(args[i] === '--state' && !given && args[i + 1], 'invalid_arguments'); result.state = absolute(args[++i]); given = true;
  }
  return result;
}
export async function manageSecurity({ check, state }) {
  return editConfiguration(state, async (config, save) => {
    const allowed = allowInsecureOriginsConfiguration(config.allowInsecureOrigins);
    const origins = additionalOriginsConfiguration(config.additionalOrigins, config.publicOrigin, true);
    const insecure = origins.filter(insecureOrigin);
    const summary = value => ({ allowInsecureOrigins: value, insecureOriginChecks: value ? 'off' : 'on', insecureOrigins: insecure });
    if (check === 'status') return { status: 'ok', ...summary(allowed) };
    ensure(check === 'on' || check === 'off', 'invalid_command');
    const allow = check === 'off'; // the check off allows insecure origins
    if (allow === allowed) return { status: 'unchanged', ...summary(allowed) };
    if (!allow && insecure.length) refuse('insecure_origins_configured',
      `Remove the plain-http origins outside Tailscale first (${insecure.join(', ')}) with: node deploy/local/pilot.mjs origins remove --state <dir> <origin>, then turn the insecure-address check on with: ${INSECURE_ORIGIN_CHECK} on --state <dir>`);
    // Turning the check on removes the key, so older launchers accept the file again.
    if (allow) config.allowInsecureOrigins = true; else delete config.allowInsecureOrigins;
    await save();
    return { status: 'updated', ...summary(allow), restartRequired: true };
  });
}
export const MAX_COURSE_PACKAGE_DIRECTORIES = 16;
/** One host directory administration may install or update course packages from: an absolute,
 * normalized path (not the filesystem root). The API confines every package path to these. */
export function coursePackageDirectory(value) {
  ensure(typeof value === 'string' && value.length < 4096 && !/[\x00-\x1f]/.test(value) && path.isAbsolute(value)
    && path.resolve(value) === value && path.parse(value).root !== value, 'invalid_course_package_directory');
  return value;
}
/** Optional `coursePackageDirectories` key: absent means none (no host-folder package sources). */
export function coursePackageDirectoriesConfiguration(value) {
  if (value === undefined) return [];
  ensure(Array.isArray(value) && value.length <= MAX_COURSE_PACKAGE_DIRECTORIES, 'invalid_course_package_directories');
  const directories = value.map(coursePackageDirectory);
  ensure(new Set(directories).size === directories.length, 'duplicate_course_package_directory');
  return directories;
}
async function existingDirectory(directory) {
  let info;
  try { info = await lstat(directory); } catch { throw new PilotError('course_package_directory_missing'); }
  ensure(info.isDirectory(), 'course_package_directory_missing');
}
/** `package-directories add|remove|list --state <dir> [<directory>]`, like `origins`. */
export function parsePackageDirectoriesArguments(args) {
  ensure(args[0] === 'package-directories' && ['add', 'remove', 'list'].includes(args[1]), 'invalid_command');
  const result = { action: args[1], state: path.join(repositoryRoot, '.local/pilot') };
  let given = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--state') { ensure(!given && args[i + 1], 'invalid_arguments'); result.state = absolute(args[++i]); given = true; }
    else { ensure(result.directory === undefined && !args[i].startsWith('--'), 'invalid_arguments'); result.directory = args[i]; }
  }
  ensure(result.action === 'list' ? result.directory === undefined : result.directory !== undefined, 'invalid_arguments');
  return result;
}
export async function managePackageDirectories({ action, state: stateInput, directory }) {
  const state = await privateDirectory(stateInput), file = path.join(state, 'config.json');
  return mutex(state, 'config.lock', async () => {
    const { value: config, info, text } = await privateJson(file);
    ensure(config && typeof config === 'object' && !Array.isArray(config), 'invalid_configuration');
    const current = coursePackageDirectoriesConfiguration(config.coursePackageDirectories);
    if (action === 'list') return { status: 'ok', coursePackageDirectories: current };
    coursePackageDirectory(directory);
    if (action === 'add') await existingDirectory(directory);
    const next = action === 'add' ? (current.includes(directory) ? current : [...current, directory]) : current.filter(item => item !== directory);
    if (next.length === current.length && (action === 'remove' || current.includes(directory))) return { status: 'unchanged', coursePackageDirectories: current };
    coursePackageDirectoriesConfiguration(next);
    if (next.length) config.coursePackageDirectories = next; else delete config.coursePackageDirectories;
    const indent = /^\{\r?\n(\t| +)"/.exec(text)?.[1];
    await writePrivate(file, JSON.stringify(config, null, indent) + (text.endsWith('\n') ? '\n' : ''), true, info.mode & 0o777);
    return { status: 'updated', coursePackageDirectories: next, restartRequired: true };
  });
}
// Optional OpenTelemetry export (absent = off). The endpoint may be any OTLP/HTTP JSON
// receiver, such as a local collector or Langfuse's OTLP endpoint; headers carry its key.
export function telemetryConfiguration(value) {
  if (value === undefined) return null;
  ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['otlpEndpoint', 'otlpHeaders', 'metrics'].includes(key)), 'invalid_telemetry_configuration');
  let url;
  try { url = new URL(value.otlpEndpoint); } catch { throw new PilotError('invalid_telemetry_configuration'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  ensure(typeof value.otlpEndpoint === 'string' && value.otlpEndpoint.length <= 2048 && !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || url.protocol === 'http:' && loopback), 'invalid_telemetry_configuration');
  const headers = value.otlpHeaders ?? {};
  ensure(headers && typeof headers === 'object' && !Array.isArray(headers) && Object.keys(headers).length <= 16
    && Object.entries(headers).every(([name, header]) => /^[A-Za-z0-9-]{1,64}$/.test(name) && typeof header === 'string' && header.length > 0
      && header.length <= 4096 && !/[\x00-\x1f\x7f]/.test(header)), 'invalid_telemetry_configuration');
  ensure(value.metrics === undefined || typeof value.metrics === 'boolean', 'invalid_telemetry_configuration');
  return { otlpEndpoint: value.otlpEndpoint, otlpHeaders: { ...headers }, metrics: value.metrics !== false };
}
/** Standard OTEL_* variables for a Core service; empty when telemetry is not configured. */
export function telemetryEnvironment(telemetry) {
  if (!telemetry) return {};
  const headers = Object.entries(telemetry.otlpHeaders).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join(',');
  return { OTEL_EXPORTER_OTLP_ENDPOINT: telemetry.otlpEndpoint, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    ...(headers ? { OTEL_EXPORTER_OTLP_HEADERS: headers } : {}), ...(telemetry.metrics ? {} : { OTEL_METRICS_EXPORTER: 'none' }) };
}
function managedIdentity() {
  const label = process.env.CORE_PILOT_MANAGED_LABEL, installationId = process.env.CORE_PILOT_INSTALLATION_ID;
  if (!label && !installationId) return null;
  ensure(/^com\.coursecore\.pilot\.[a-f0-9]{16}\.[a-f0-9]{32}$/.test(label ?? '') && /^[a-f0-9-]{36}$/.test(installationId ?? ''), 'invalid_manager_identity');
  return { label, installationId };
}
export function servicePlan(root, state, config, instanceId) {
  const environment = { PATH: [...new Set([path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'])].join(path.delimiter),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), LANG: 'en_US.UTF-8' };
  const api = { ...environment, DATABASE_URL: config.databaseUrl, PUBLIC_ORIGIN: config.publicOrigin, API_HOST: '127.0.0.1', PORT: String(new URL(config.publicOrigin).port), CORE_INSTANCE_ID: instanceId,
    LEARNER_WEB_DIR: path.join(root, 'apps/learner/dist'), ADMIN_WEB_DIR: path.join(root, 'apps/admin/dist'),
    SUPERVISOR_HOST_TOKEN: config.serviceToken, SUPERVISOR_WORKSPACE_IDS: config.workspaceIds.join(','), CODE_FIXTURE_FILES: JSON.stringify(config.codeFixtureFiles), TEACHING_VERIFIER_FILES: JSON.stringify(config.teachingVerifierFiles??[]),
    SANDBOX_STORAGE_DIR: path.join(state, 'sandboxes'), ...(config.migrationDatabaseUrl ? { MIGRATION_DATABASE_URL: config.migrationDatabaseUrl } : {}), ...(config.providerConfigFile ? { PROVIDER_CONFIG_FILE: config.providerConfigFile } : {}), ...config.providerCredentials };
  api.ADAPTATION_ADAPTERS=JSON.stringify(config.adaptationAdapters??[]);
  api.AUTH_LOGIN_CODES=config.loginCodes===true?'enabled':'disabled';
  if(config.sessionHours!==undefined)api.SESSION_HOURS=String(config.sessionHours);
  if(config.additionalOrigins?.length)api.ADDITIONAL_ORIGINS=config.additionalOrigins.join(',');
  if(config.coursePackageDirectories?.length)api.COURSE_PACKAGE_DIRECTORIES=JSON.stringify(config.coursePackageDirectories);
  if(config.courseSuppliedCodeFixtures===true)api.COURSE_SUPPLIED_CODE_FIXTURES='on';
  api.ALLOW_INSECURE_ORIGINS=config.allowInsecureOrigins===true?'true':'false';
  api.PROVIDER_VAULT_DIRECTORY=config.providerVaultDirectory;
  for (const [key, name] of Object.entries(MEDIA_TOOL_ENVIRONMENT)) if (config.mediaTools?.[key]) api[name] = config.mediaTools[key];
  Object.assign(api, telemetryEnvironment(config.telemetry));
  const worker = { ...environment, SUPERVISOR_TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`, SUPERVISOR_TEMPORAL_NAMESPACE: 'default',
    SUPERVISOR_TEMPORAL_TASK_QUEUE: config.temporalTaskQueue, SUPERVISOR_TEMPORAL_TLS: 'false', SUPERVISOR_HOST_URL: config.publicOrigin,
    SUPERVISOR_HOST_TOKEN: config.serviceToken, SUPERVISOR_PROVIDER_URL: config.publicOrigin, SUPERVISOR_PROVIDER_TOKEN: config.serviceToken,
    SUPERVISOR_ACTIVITY_CONCURRENCY: String(config.resources.workerConcurrency), SUPERVISOR_DISPATCH_INTERVAL_MS: String(config.resources.dispatchIntervalMs),
    ...telemetryEnvironment(config.telemetry) };
  return [
    { name: 'temporal', binary: path.join(root, '.local/bin/temporal'), args: ['server', 'start-dev', '--ip', '127.0.0.1', '--port', String(config.temporalPort), '--ui-port', String(config.temporalUiPort), '--db-filename', path.join(state, 'temporal.db')], env: {...environment,GOMEMLIMIT:`${config.resources.temporalMemoryMiB}MiB`,GOMAXPROCS:'2'}, cwd: root },
    { name: 'api', binary: process.execPath, args: [`--max-old-space-size=${config.resources.apiHeapMiB}`,'dist/main.js'], env: api, cwd: path.join(root, 'services/api') },
    { name: 'worker', binary: process.execPath, args: [`--max-old-space-size=${config.resources.workerHeapMiB}`,'dist/src/cli.js', 'worker'], env: worker, cwd: path.join(root, 'services/supervisor') },
    { name: 'dispatcher', binary: process.execPath, args: [`--max-old-space-size=${config.resources.dispatcherHeapMiB}`,'dist/src/cli.js', 'dispatch-loop'], env: worker, cwd: path.join(root, 'services/supervisor') },
  ];
}
export async function runPilot({ root: rootInput = repositoryRoot, state: stateInput = path.join(repositoryRoot, '.local/pilot') } = {}) {
  ensure(process.versions.node.split('.')[0] === '26', 'node_26_required'); process.umask(0o077);
  const { root, state, config, ports } = await loadConfiguration(rootInput, stateInput);
  // Refuse to run a Temporal CLI that is not a pinned known-good build (or the one explicitly configured).
  await verifyTemporalCli(path.join(root, '.local/bin/temporal'), config.temporalCliSha256);
  let stopping = false, ready = false, failure = false, stopPromise, spawning, controlHandle;
  const children = new Map(), output = new Map();
  const owner = { schemaVersion: 2, kind: 'course-core-local-pilot', state, root, uid: uid(), instanceId: randomUUID(), pid: process.pid,
    startedAt: new Date().toISOString(), controlToken: randomBytes(32).toString('hex'), ports, children: {}, pending: null, phase: 'starting', socket: null, managedBy: managedIdentity() };
  const report = () => ({ status: stopping ? 'stopping' : ready ? 'running' : 'starting', instanceId: owner.instanceId, pid: owner.pid, origin: config.publicOrigin,
    managedBy: owner.managedBy, services: Object.fromEntries([...children].map(([name, child]) => [name, { pid: child.pid, exited: child.exitCode !== null || child.signalCode !== null }])), providerAcceptance: 'not_verified' });
  const log = new RotatingLog(state, { bytes: config.resources.logBytes, backups: config.resources.logBackups });
  let serial = Promise.resolve();
  const persist = () => { const text = JSON.stringify(owner); serial = serial.then(async () => { await sameOwner(state, owner.instanceId); await writePrivate(path.join(state, 'owner.json'), text, true); }); return serial; };
  let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
  function meter() {
    for (const [key, bytes] of output) { if (bytes) { const [service, stream] = key.split(':'); log.write('child_output_discarded', { service, stream, bytes }); output.set(key, 0); } }
  }
  let ticker, snapshots;
  async function stop(reason = 'requested') {
    if (stopPromise) return stopPromise;
    stopping = true; if (reason !== 'requested' && reason !== 'signal') failure = true;
    stopPromise = (async () => {
      if (ticker) clearInterval(ticker);
      snapshots?.stop();
      await spawning?.catch(() => {});
      owner.phase = 'stopping'; await persist().catch(() => { failure = true; });
      log.write('stopping');
      let stopped = true;
      for (const name of ['dispatcher', 'worker', 'api', 'temporal']) {
        const child = children.get(name);
        if (!child?.pid || child.exitCode !== null || child.signalCode !== null) continue;
        log.write('child_stop_requested', { service: name });
        // Only live ChildProcess handles spawned by this process are ever signalled.
        child.kill('SIGTERM');
        const finished = await new Promise(resolve => {
          let settled = false;
          const finish = value => { if (!settled) { settled = true; clearTimeout(force); clearTimeout(bound); resolve(value); } };
          const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, name === 'worker' ? 25_000 : 10_000);
          const bound = setTimeout(() => finish(false), name === 'worker' ? 30_000 : 15_000);
          child.once('exit', () => finish(true)); if (child.exitCode !== null || child.signalCode !== null) finish(true);
        });
        if (!finished) stopped = false;
      }
      await controlHandle?.close().catch(() => { stopped = false; }); meter();
      if (!(await Promise.all(ports.map(portFree))).every(Boolean)) stopped = false;
      try {
        if (!stopped) throw new PilotError('children_not_confirmed_stopped');
        await mutex(state, 'transition.lock', async () => {
          await sameOwner(state, owner.instanceId);
          // Closing our Unix server normally unlinks its socket. Never unlink a replacement.
          const socket = await socketInfo(state);
          if (socket) { ensure(socket.ino === owner.socket?.ino && socket.dev === owner.socket?.dev, 'socket_identity_changed'); await unlink(controlPath(state)); }
          await unlink(path.join(state, 'owner.json')); await rmdir(path.join(state, 'run.lock'));
        });
      } catch {
        failure = true; owner.phase = 'cleanup_required'; await persist().catch(() => {}); log.write('cleanup_requires_review');
      }
      log.write('stopped'); await log.flush().catch(() => { failure = true; });
      process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
      resolveDone({ exitCode: failure ? 1 : 0, status: failure ? 'failed' : 'stopped' });
    })();
    return stopPromise;
  }
  const onSignal = () => { void stop('signal'); };
  await mutex(state, 'transition.lock', async () => {
    await recoverStale(state);
    ensure((await Promise.all(ports.map(portFree))).every(Boolean), 'service_port_in_use');
    await mkdir(path.join(state, 'run.lock'), { mode: 0o700 });
    await writePrivate(path.join(state, 'owner.json'), JSON.stringify(owner));
    controlHandle = controlServer(owner, report, stop);
    await new Promise((resolve, reject) => { controlHandle.server.once('error', reject); controlHandle.server.listen(controlPath(state), resolve); });
    await chmod(controlPath(state), 0o600); owner.socket = await socketInfo(state); await persist();
  });
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  ticker = setInterval(meter, 1000); ticker.unref(); log.write('starting');
  const launch = async spec => {
    ensure(!stopping, 'startup_cancelled'); owner.pending = spec.name; await persist(); ensure(!stopping, 'startup_cancelled');
    let child;
    try { child = spawn(spec.binary, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false }); }
    catch { owner.pending = null; await persist(); throw new PilotError('child_spawn_failed'); }
    children.set(spec.name, child);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => { const key = `${spec.name}:${stream}`; output.set(key, Math.min(Number.MAX_SAFE_INTEGER, (output.get(key) ?? 0) + bytes.length)); });
    child.once('error', () => { if (!stopping) void stop('child_error'); });
    child.once('exit', (code, signal) => {
      log.write('child_exited', { service: spec.name, exitCode: code, signal: ['SIGTERM', 'SIGKILL', 'SIGINT', null].includes(signal) ? signal : null });
      if (!stopping) void stop('child_exit');
    });
    if (child.pid) owner.children[spec.name] = child.pid;
    else { await new Promise(resolve => child.once('error', resolve)); }
    owner.pending = null; await persist(); ensure(child.pid && !stopping, 'child_spawn_failed'); log.write('child_started', { service: spec.name });
    return child;
  };
  async function start(spec) { spawning = launch(spec); try { return await spawning; } finally { spawning = undefined; } }
  async function healthy(url, child, port, instanceId) {
    const until = Date.now() + 30_000;
    while (!stopping && Date.now() < until) {
      try {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1000) });
        if (response.ok && (!instanceId || (await response.json()).instanceId === instanceId) && await portOwnedBy(port, child.pid)) return;
      } catch { /* bounded startup, never log raw response/errors */ }
      await delay(200);
    }
    throw new PilotError('service_readiness_failed');
  }
  try {
    const plan = servicePlan(root, state, config, owner.instanceId);
    const temporal = await start(plan[0]); await healthy(`http://127.0.0.1:${config.temporalUiPort}`, temporal, config.temporalUiPort);
    ensure(await portOwnedBy(config.temporalPort, temporal.pid), 'temporal_port_not_owned');
    const api = await start(plan[1]); await healthy(`${config.publicOrigin}/health`, api, ports[0], owner.instanceId);
    await start(plan[2]); await start(plan[3]);
    ensure(!stopping, 'startup_cancelled'); ready = true; owner.phase = 'running'; await persist(); log.write('ready');
    if (config.snapshots) {
      await privateDirectory(config.snapshots.directory, true);
      snapshots = snapshotSchedule({ root, state, snapshots: config.snapshots, log });
    }
    process.stdout.write(JSON.stringify(report()) + '\n');
  } catch { await stop('startup_failed'); }
  return done;
}
export async function main(args = process.argv.slice(2)) {
  if (args[0] === 'origins') return manageOrigins(parseOriginsArguments(args));
  if (args[0] === 'package-directories') return managePackageDirectories(parsePackageDirectoriesArguments(args));
  if (args[0] === 'security') {
    const { deprecated, ...parsed } = parseSecurityArguments(args);
    if (deprecated) process.stderr.write(`${deprecated}\n`);
    return manageSecurity(parsed);
  }
  const parsed = parseArguments(args);
  if (parsed.mode === 'start') { const result = await runPilot(parsed); process.exitCode = result.exitCode; return result; }
  if (parsed.mode === 'recover') {
    const state = await privateDirectory(parsed.state);
    const recovered = await mutex(state, 'transition.lock', () => recoverStale(state)); return { status: recovered ? 'recovered' : 'not_running' };
  }
  return control(parsed.state, parsed.mode);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { if (process.argv[2] !== 'start') process.stdout.write(JSON.stringify(result) + '\n'); }).catch(error => {
    process.stderr.write(JSON.stringify({ status: 'blocked', code: error instanceof PilotError ? error.code : 'pilot_operation_failed', ...(error instanceof PilotError && error.hint ? { hint: error.hint } : {}) }) + '\n'); process.exitCode = 1;
  });
}
