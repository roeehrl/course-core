import { spawn } from 'node:child_process';
import { open, readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfiguration } from './pilot.mjs';
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
/** Stop → consistent backup → restore drill → start the new pinned runtime →
 * health. If the new runtime does not become healthy, it is stopped and the
 * previous runtime is started again on the same untouched state. */
export async function upgradePilot({ from, to, state, backups, pgBin }) {
  const fromRoot = await realpath(absolute(from)), toRoot = await realpath(absolute(to));
  ensure(fromRoot !== toRoot, 'same_runtime_root');
  const next = await loadConfiguration(toRoot, state); await loadConfiguration(fromRoot, state);
  const version = JSON.parse(await readFile(path.join(toRoot, 'package.json'), 'utf8')).version;
  const log = path.join(next.state, 'upgrade.log');
  const steps = [];
  if (await ownerRecord(next.state)) {
    await control(next.state, 'stop'); ensure(await waitFor(next.state, 'not_running', 120_000), 'pilot_did_not_stop');
  }
  steps.push('stopped');
  const backup = await createBackup({ root: fromRoot, state: next.state, output: backups, pgBin }); steps.push('backed_up');
  const drill = await verifyBackup({ root: fromRoot, state: next.state, backup: backup.directory, pgBin }); steps.push('restore_verified');
  await launch(toRoot, next.state, log);
  if (await waitFor(next.state, 'running', 120_000) && await healthy(next.config.publicOrigin)) {
    steps.push('started_new_runtime');
    return { status: 'upgraded', version, backup: backup.directory, restoreDrill: { rows: drill.rows, tables: drill.tables }, steps, providerAcceptance: 'not_verified' };
  }
  // Roll back: the database migrated forward only if the new API started; the
  // backup above is the recovery point if that happened.
  if (await ownerRecord(next.state)) { await control(next.state, 'stop').catch(() => {}); await waitFor(next.state, 'not_running', 120_000); }
  await launch(fromRoot, next.state, log);
  const restored = await waitFor(next.state, 'running', 120_000);
  throw Object.assign(new PilotError(restored ? 'upgrade_failed_previous_runtime_restarted' : 'upgrade_failed_restore_from_backup'), { backup: backup.directory });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fail = error => { process.stderr.write(JSON.stringify({ status: 'blocked', code: error instanceof PilotError ? error.code : 'upgrade_operation_failed', ...(error?.backup ? { backup: error.backup } : {}) }) + '\n'); process.exitCode = 1; };
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      ensure(['--from', '--to', '--state', '--backups', '--pg-bin'].includes(args[i]) && args[i + 1], 'invalid_arguments');
      options[args[i].slice(2).replace('pg-bin', 'pgBin')] = absolute(args[i + 1]);
    }
    ensure(options.from && options.to && options.state && options.backups, 'invalid_arguments');
    upgradePilot(options).then(r => process.stdout.write(JSON.stringify(r) + '\n')).catch(fail);
  } catch (error) { fail(error); }
}
