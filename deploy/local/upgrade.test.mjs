import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PilotError } from './runtime.mjs';
import { upgradePilot } from './upgrade.mjs';

const exec = promisify(execFile);
const upgradeScript = path.join(import.meta.dirname, 'upgrade.mjs');

// A simulated pilot: which runtime root owns the state, and a log of every
// operation the upgrade performed. No process, database or port is touched.
async function fixture(body) {
  const base = await mkdtemp(path.join(tmpdir(), 'cc-upgrade-'));
  try {
    const from = path.join(base, 'from'), to = path.join(base, 'to'), state = path.join(base, 'state'), backups = path.join(base, 'backups');
    for (const root of [from, to]) await mkdir(root);
    await writeFile(path.join(to, 'package.json'), JSON.stringify({ version: '9.9.10' }));
    return await body({ from, to, state, backups });
  } finally { await rm(base, { recursive: true, force: true }); }
}
function pilot({ running = 'from', failAt = {}, healthy = true } = {}) {
  const sim = { running, calls: [] };
  const fail = step => { if (failAt[step]) throw failAt[step]; };
  sim.deps = {
    timeoutMs: 1,
    loadConfiguration: async (root, state) => ({ state, config: { backupAgeRecipients: [], publicOrigin: 'http://127.0.0.1:1' } }),
    verifyTemporalCli: async () => {},
    ownerRecord: async () => sim.running ? { root: sim.running } : null,
    control: async (_state, action) => { sim.calls.push(`control:${action}`); if (action === 'stop') sim.running = null; return { status: 'ok' }; },
    waitFor: async (_state, wanted) => (wanted === 'running') === Boolean(sim.running),
    healthy: async () => healthy,
    createBackup: async () => { sim.calls.push('backup'); fail('backup'); return { status: 'created', directory: '/backups/backup-1' }; },
    verifyBackup: async () => { sim.calls.push('drill'); fail('drill'); return { status: 'restore_verified', rows: 7, tables: 2 }; },
    launch: async root => {
      const which = path.basename(root); sim.calls.push(`launch:${which}`);
      fail(`launch:${which}`); if (!failAt[`start:${which}`]) sim.running = which;
    },
  };
  return sim;
}
const drillFailure = () => Object.assign(new PilotError('restored_row_counts_differ'),
  { details: { tables: [{ table: 'learner_rows', recorded: 250, restored: 249 }] } });

test('a successful upgrade stops, backs up, drills and starts only the new runtime', () => fixture(async options => {
  const sim = pilot();
  const result = await upgradePilot(options, sim.deps);
  assert.equal(result.status, 'upgraded'); assert.equal(result.version, '9.9.10'); assert.equal(result.backup, '/backups/backup-1');
  assert.deepEqual(result.steps, ['stopped', 'backed_up', 'restore_verified', 'started_new_runtime']);
  assert.deepEqual(sim.calls, ['control:stop', 'backup', 'drill', 'launch:to']);
  assert.equal(sim.running, 'to');
}));

test('a failed restore drill relaunches the previous runtime and reports the reason, tables and backup', () => fixture(async options => {
  const sim = pilot({ failAt: { drill: drillFailure() } });
  const error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  assert.equal(error.code, 'upgrade_failed_previous_runtime_restarted');
  assert.equal(error.reason, 'restored_row_counts_differ');
  assert.equal(error.lastCompletedStep, 'backed_up');
  assert.equal(error.backup, '/backups/backup-1');
  assert.deepEqual(error.details, { tables: [{ table: 'learner_rows', recorded: 250, restored: 249 }] });
  // The new runtime never ran; the previous one owns the state again.
  assert.deepEqual(sim.calls, ['control:stop', 'backup', 'drill', 'launch:from']);
  assert.equal(sim.running, 'from');
}));

test('a failed backup relaunches the previous runtime and reports no backup path', () => fixture(async options => {
  const sim = pilot({ failAt: { backup: new PilotError('pg_dump_failed') } });
  const error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  assert.equal(error.code, 'upgrade_failed_previous_runtime_restarted'); assert.equal(error.reason, 'pg_dump_failed');
  assert.equal(error.lastCompletedStep, 'stopped'); assert.equal(error.backup, undefined);
  assert.deepEqual(sim.calls, ['control:stop', 'backup', 'launch:from']); assert.equal(sim.running, 'from');
}));

test('an unexpected (non-pilot) error is still rolled back with a generic reason', () => fixture(async options => {
  const sim = pilot({ failAt: { drill: new TypeError('boom') } });
  const error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  assert.equal(error.code, 'upgrade_failed_previous_runtime_restarted'); assert.equal(error.reason, 'upgrade_operation_failed');
  assert.equal(sim.running, 'from');
}));

test('a new runtime that cannot be launched, or never becomes healthy, is replaced by the previous one', () => fixture(async options => {
  let sim = pilot({ failAt: { 'launch:to': new Error('spawn failed') } });
  let error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  assert.equal(error.code, 'upgrade_failed_previous_runtime_restarted'); assert.equal(error.lastCompletedStep, 'restore_verified');
  assert.equal(error.backup, '/backups/backup-1'); assert.deepEqual(sim.calls.slice(-2), ['launch:to', 'launch:from']); assert.equal(sim.running, 'from');

  sim = pilot({ healthy: false });
  error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  assert.equal(error.code, 'upgrade_failed_previous_runtime_restarted'); assert.equal(error.reason, 'new_runtime_not_healthy');
  assert.deepEqual(sim.calls, ['control:stop', 'backup', 'drill', 'launch:to', 'control:stop', 'launch:from']); assert.equal(sim.running, 'from');
}));

test('when the previous runtime cannot be restarted the report says so and keeps the backup path', () => fixture(async options => {
  let sim = pilot({ failAt: { drill: drillFailure(), 'start:from': true } });
  let error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  // Nothing new ran, so the database is untouched: no restore is needed, only a manual start.
  assert.equal(error.code, 'upgrade_failed_previous_runtime_not_restarted'); assert.equal(error.reason, 'restored_row_counts_differ');
  assert.equal(error.backup, '/backups/backup-1'); assert.equal(sim.running, null);

  sim = pilot({ healthy: false, failAt: { 'start:from': true } });
  error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  assert.equal(error.code, 'upgrade_failed_restore_from_backup'); assert.equal(error.backup, '/backups/backup-1');
}));

test('a pilot that was already stopped is left stopped when the drill fails', () => fixture(async options => {
  const sim = pilot({ running: null, failAt: { drill: drillFailure() } });
  const error = await upgradePilot(options, sim.deps).then(() => assert.fail('upgrade must fail'), e => e);
  assert.equal(error.code, 'upgrade_failed_pilot_left_stopped'); assert.equal(error.reason, 'restored_row_counts_differ');
  assert.deepEqual(sim.calls, ['backup', 'drill']); assert.equal(sim.running, null);
}));

test('nothing is stopped when the upgrade is refused up front', () => fixture(async options => {
  const sim = pilot();
  await assert.rejects(upgradePilot({ ...options, to: options.from }, sim.deps), /same_runtime_root/);
  sim.deps.verifyTemporalCli = async () => { throw new PilotError('temporal_cli_unverified'); };
  await assert.rejects(upgradePilot(options, sim.deps), /temporal_cli_unverified/);
  assert.deepEqual(sim.calls, []); assert.equal(sim.running, 'from');
}));

test('the command line reports a blocked upgrade as one JSON line with its code', async () => {
  const run = await exec(process.execPath, [upgradeScript, '--from', '/nonexistent-a'], { encoding: 'utf8' }).then(() => assert.fail('must exit 1'), e => e);
  assert.equal(run.code, 1);
  assert.deepEqual(JSON.parse(run.stderr), { status: 'blocked', code: 'invalid_arguments' });
});
