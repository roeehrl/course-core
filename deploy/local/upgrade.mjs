import { spawn } from 'node:child_process';
import { open, readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfiguration } from './pilot.mjs';
import { verifyTemporalCli } from './temporal-cli.mjs';
import { createBackup, verifyBackup } from './backup.mjs';
import { PilotError, ensure, absolute, control, delay, ownerRecord } from './runtime.mjs';

/** Starts a pilot launcher detached from this process, owned by its own runtime root. */
async function launch(root, state, logFile) {
  const out = await open(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'deploy/local/pilot.mjs'), 'start', '--root', root, '--state', state],
    { cwd: root, detached: true, stdio: ['ignore', out.fd, out.fd], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) } });
  child.unref(); await out.close();
}
async function waitFor(state, wanted, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await control(state, 'status').then(r => r.status).catch(() => 'unavailable');
    if (status === wanted) return true;
    await delay(1000);
  }
  return false;
}
async function healthy(origin) {
  try { const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) }); return r.ok && (await r.json()).status === 'ok'; } catch { return false; }
}
/** Whether the runtime at `root` knows a config.json key. Older releases reject unknown keys, so
 * the rollback launch of such a release would fail on configuration added for the new one. */
async function acceptsConfigurationKey(root, key) {
  try { return (await readFile(path.join(root, 'deploy/local/pilot.mjs'), 'utf8')).includes(`'${key}'`); } catch { return false; }
}
const runtime = { loadConfiguration, acceptsConfigurationKey, verifyTemporalCli, createBackup, verifyBackup, launch, waitFor, healthy, control, ownerRecord, timeoutMs: 120_000 };
const reasonOf = error => error instanceof PilotError ? error.code : 'upgrade_operation_failed';
/** Stop → consistent backup → restore drill → start the new pinned runtime →
 * health. Any failure after the pilot was stopped (backup, restore drill,
 * launch or health of the new runtime) stops whatever the upgrade started and
 * starts the previous runtime again on the same state, then reports the
 * reason. `deps` replaces the process, database and control operations in tests. */
export async function upgradePilot({ from, to, state, backups, pgBin, ageBin, identity }, deps = {}) {
  const run = { ...runtime, ...deps };
  const fromRoot = await realpath(absolute(from)), toRoot = await realpath(absolute(to));
  ensure(fromRoot !== toRoot, 'same_runtime_root');
  const next = await run.loadConfiguration(toRoot, state), previous = await run.loadConfiguration(fromRoot, state);
  // An encrypted backup can only be drilled with the identity; refuse before stopping anything.
  ensure(!previous.config.backupAgeRecipients.length || identity, 'age_identity_required');
  // A `mediaTools` key the previous runtime does not know would block the rollback; refuse first.
  ensure(!next.config.mediaTools || await run.acceptsConfigurationKey(fromRoot, 'mediaTools'), 'media_tools_unsupported_by_previous_runtime');
  // Before stopping anything: the new root's Temporal CLI must be a pinned or explicitly configured build.
  await run.verifyTemporalCli(path.join(toRoot, '.local/bin/temporal'), next.config.temporalCliSha256);
  const version = JSON.parse(await readFile(path.join(toRoot, 'package.json'), 'utf8')).version;
  const log = path.join(next.state, 'upgrade.log');
  const steps = [];
  const wasRunning = Boolean(await run.ownerRecord(next.state));
  if (wasRunning) {
    await run.control(next.state, 'stop'); ensure(await run.waitFor(next.state, 'not_running', run.timeoutMs), 'pilot_did_not_stop');
  }
  steps.push('stopped');
  let backup, drill, reason, details, launchedNew = false;
  try {
    backup = await run.createBackup({ root: fromRoot, state: next.state, output: backups, pgBin, ageBin }); steps.push('backed_up');
    drill = await run.verifyBackup({ root: fromRoot, state: next.state, backup: backup.directory, pgBin, ageBin, identity }); steps.push('restore_verified');
    launchedNew = true;
    await run.launch(toRoot, next.state, log);
    if (await run.waitFor(next.state, 'running', run.timeoutMs) && await run.healthy(next.config.publicOrigin)) {
      steps.push('started_new_runtime');
      return { status: 'upgraded', version, backup: backup.directory, restoreDrill: { rows: drill.rows, tables: drill.tables }, steps, providerAcceptance: 'not_verified' };
    }
    reason = 'new_runtime_not_healthy';
  } catch (error) {
    reason = reasonOf(error); details = error?.details;
  }
  // Roll back. Before the new runtime was launched the database is untouched;
  // after it, the database migrated forward only if the new API started, and
  // the backup above is the recovery point if that happened.
  const failed = (code, extra = {}) => Object.assign(new PilotError(code), { reason, lastCompletedStep: steps.at(-1), backup: backup?.directory, ...(details ? { details } : {}), ...extra });
  if (launchedNew && await run.ownerRecord(next.state)) {
    await run.control(next.state, 'stop').catch(() => {});
    if (!await run.waitFor(next.state, 'not_running', run.timeoutMs)) throw failed('upgrade_failed_new_runtime_not_stopped');
  }
  // A pilot that was already stopped is left stopped when nothing new ran.
  if (!wasRunning && !launchedNew) throw failed('upgrade_failed_pilot_left_stopped');
  let restored = false;
  try { await run.launch(fromRoot, next.state, log); restored = await run.waitFor(next.state, 'running', run.timeoutMs); } catch { restored = false; }
  throw failed(restored ? 'upgrade_failed_previous_runtime_restarted'
    : launchedNew ? 'upgrade_failed_restore_from_backup' : 'upgrade_failed_previous_runtime_not_restarted');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fail = error => {
    const { reason, lastCompletedStep, backup, details } = error ?? {};
    process.stderr.write(JSON.stringify({ status: 'blocked', code: reasonOf(error), ...(reason ? { reason } : {}), ...(lastCompletedStep ? { lastCompletedStep } : {}),
      ...(backup ? { backup } : {}), ...(details ?? {}) }) + '\n');
    process.exitCode = 1;
  };
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--from': 'from', '--to': 'to', '--state': 'state', '--backups': 'backups', '--pg-bin': 'pgBin', '--age-bin': 'ageBin', '--age-identity': 'identity' }[args[i]];
      ensure(key && args[i + 1] && !Object.hasOwn(options, key), 'invalid_arguments');
      options[key] = absolute(args[i + 1]);
    }
    ensure(options.from && options.to && options.state && options.backups, 'invalid_arguments');
    upgradePilot(options).then(r => process.stdout.write(JSON.stringify(r) + '\n')).catch(fail);
  } catch (error) { fail(error); }
}
