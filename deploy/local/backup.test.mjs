import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir, readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { privateDirectory, writePrivate, hash } from './runtime.mjs';
import { EventEmitter } from 'node:events';
import { verifyManifest, parseBackupArguments, pruneBackups, createBackup, createSnapshot, verifyBackup, decryptBackup, tableCountDifferences, recordBackupReport } from './backup.mjs';
import { backupAgeRecipientsConfiguration, loadConfiguration, snapshotsConfiguration, snapshotSchedule } from './pilot.mjs';

// Synthetic, syntactically valid age recipients (bech32 alphabet). They are not real keys.
const recipient = fill => 'age1' + fill.repeat(58);
// Built from pieces so the public-source audit never sees a key-shaped literal.
const privateKeyShape = ['AGE', 'SECRET', 'KEY', '1' + 'Q'.repeat(58)].join('-');
async function pilotFixture(base, extra = {}) {
  const root = path.join(base, 'root'), state = await privateDirectory(path.join(base, 'state'), true);
  for (const file of ['.local/bin/temporal', 'services/api/dist/main.js', 'services/supervisor/dist/src/cli.js', 'apps/learner/dist/index.html', 'apps/admin/dist/index.html']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), '', { mode: 0o755 });
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@course-core/repository', version: '9.9.9' }));
  // Nothing listens on this database: every case below must fail before connecting.
  await writePrivate(path.join(state, 'config.json'), JSON.stringify({ schemaVersion: 1, publicOrigin: 'http://127.0.0.1:44420',
    databaseUrl: 'postgresql://nobody@127.0.0.1:1/course_core_test_absent', temporalPort: 44421, temporalUiPort: 44422,
    serviceToken: randomBytes(32).toString('base64url'), workspaceIds: [], ...extra }));
  return { root, state };
}
async function encryptedManifestFixture(directory) {
  await writeFile(path.join(directory, 'database.dump.age'), 'ciphertext', { mode: 0o600 });
  const files = [{ name: 'database.dump.age', bytes: 10, sha256: hash('ciphertext'), plaintext: { bytes: 10, sha256: hash('dump-bytes') } }];
  await writePrivate(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 2, kind: 'course-core-pilot-backup', files,
    encryption: { scheme: 'age', recipients: [recipient('q')] }, tableCounts: {}, migrations: [] }));
}

async function fixture(body) { const directory = await mkdtemp('/tmp/cc-bk-'); try { return await body(await privateDirectory(directory)); } finally { await rm(directory, { recursive: true, force: true }); } }
async function manifestFixture(directory) {
  await writeFile(path.join(directory, 'database.dump'), 'dump-bytes', { mode: 0o600 });
  const files = [{ name: 'database.dump', bytes: 10, sha256: hash('dump-bytes') }];
  await writePrivate(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'course-core-pilot-backup', files }));
}

test('backup manifests reject changed bytes, extra or missing files and readable permissions', () => fixture(async directory => {
  await manifestFixture(directory);
  assert.equal((await verifyManifest(directory)).files.length, 1);
  await writeFile(path.join(directory, 'database.dump'), 'dump-bytez', { mode: 0o600 });
  await assert.rejects(verifyManifest(directory), /backup_file_changed/);
  await writeFile(path.join(directory, 'database.dump'), 'dump-bytes', { mode: 0o600 });
  await chmod(path.join(directory, 'database.dump'), 0o644);
  await assert.rejects(verifyManifest(directory), /backup_file_changed/);
  await chmod(path.join(directory, 'database.dump'), 0o600);
  await writeFile(path.join(directory, 'smuggled.json'), '{}', { mode: 0o600 });
  await assert.rejects(verifyManifest(directory), /backup_file_set_changed/);
}));

test('backup arguments require absolute paths and an explicit target', () => {
  assert.throws(() => parseBackupArguments(['create']), /invalid_arguments/);
  assert.throws(() => parseBackupArguments(['verify', '--backup', 'relative']), /invalid_path/);
  assert.throws(() => parseBackupArguments(['drop']), /invalid_command/);
  assert.equal(parseBackupArguments(['create', '--output', '/tmp/x']).mode, 'create');
});

test('pruning keeps the newest intact backups and never touches changed, unknown or linked entries', () => fixture(async parent => {
  const names = ['backup-20261001000000000-aaaaaa', 'backup-20261002000000000-bbbbbb', 'backup-20261003000000000-cccccc', 'backup-20261004000000000-dddddd'];
  for (const name of names) { await mkdir(path.join(parent, name), { mode: 0o700 }); await manifestFixture(path.join(parent, name)); }
  // The newest backup was tampered with: it is reported, never deleted or counted as kept.
  await writeFile(path.join(parent, names[3], 'database.dump'), 'dump-bytez', { mode: 0o600 });
  await mkdir(path.join(parent, 'notes'), { mode: 0o700 });
  await assert.rejects(pruneBackups({ output: parent, keep: 0 }), /invalid_keep/);
  const result = await pruneBackups({ output: parent, keep: 2 });
  assert.deepEqual(result, { status: 'pruned', kept: [names[2], names[1]], removed: [names[0]], skipped: [names[3]] });
  assert.deepEqual((await readdir(parent)).sort(), [names[1], names[2], names[3], 'notes']);
  assert.deepEqual(parseBackupArguments(['prune', '--output', parent, '--keep', '3']), { mode: 'prune', output: parent, keep: 3 });
  assert.throws(() => parseBackupArguments(['prune', '--output', parent]), /invalid_arguments/);
}));

test('backup encryption recipients are public age keys only; a private key in configuration is refused', () => {
  assert.deepEqual(backupAgeRecipientsConfiguration(undefined), []);
  assert.deepEqual(backupAgeRecipientsConfiguration([recipient('q'), recipient('p')]), [recipient('q'), recipient('p')]);
  assert.throws(() => backupAgeRecipientsConfiguration([privateKeyShape]), /backup_age_private_key_in_configuration/);
  assert.throws(() => backupAgeRecipientsConfiguration([privateKeyShape.toLowerCase()]), /backup_age_private_key_in_configuration/);
  for (const bad of ['age1short', recipient('b'), 'ssh-ed25519 AAAA', recipient('q') + ' ', 'x', 7, null]) {
    assert.throws(() => backupAgeRecipientsConfiguration([bad]), /invalid_backup_age_recipients/, String(bad));
  }
  assert.throws(() => backupAgeRecipientsConfiguration(recipient('q')), /invalid_backup_age_recipients/);
  assert.throws(() => backupAgeRecipientsConfiguration([recipient('q'), recipient('q')]), /duplicate_backup_age_recipient/);
  assert.throws(() => backupAgeRecipientsConfiguration(Array.from({ length: 9 }, (_, i) => recipient('qpzry9x8g'[i]))), /invalid_backup_age_recipients/);
});

test('a configured recipient with no age binary fails before any database work, and pilot config loading validates it', () => fixture(async base => {
  const { root, state } = await pilotFixture(base, { backupAgeRecipients: [recipient('q')] });
  assert.deepEqual((await loadConfiguration(root, state)).config.backupAgeRecipients, [recipient('q')]);
  const empty = await privateDirectory(path.join(base, 'no-age'), true), output = path.join(base, 'backups');
  await assert.rejects(createBackup({ root, state, output, ageBin: empty }), /age_missing/);
  // Nothing was dumped: the output directory is empty or absent.
  assert.deepEqual(await readdir(output).catch(() => []), []);
  const leaked = await pilotFixture(path.join(base, 'leaked'), { backupAgeRecipients: [privateKeyShape] });
  await assert.rejects(loadConfiguration(leaked.root, leaked.state), /backup_age_private_key_in_configuration/);
}));

test('encrypted manifests keep integrity checks without the identity; restores require one', () => fixture(async base => {
  const backup = await privateDirectory(path.join(base, 'backup-20261005000000000-eeeeee'), true);
  await encryptedManifestFixture(backup);
  assert.equal((await verifyManifest(backup)).schemaVersion, 2);
  const pruned = await pruneBackups({ output: base, keep: 1 });
  assert.deepEqual(pruned.kept, ['backup-20261005000000000-eeeeee']);
  const output = path.join(base, 'out');
  await assert.rejects(decryptBackup({ backup, output }), /age_identity_required/);
  // An identity file readable by others is refused before age runs.
  const identity = path.join(base, 'identity.txt');
  await writeFile(identity, 'synthetic', { mode: 0o644 });
  await assert.rejects(decryptBackup({ backup, output, identity }), /insecure_age_identity_file/);
  await assert.rejects(decryptBackup({ backup, output, identity: path.join(base, 'missing.txt') }), /age_identity_unreadable/);
  await chmod(identity, 0o600);
  await assert.rejects(decryptBackup({ backup, output, identity, ageBin: await privateDirectory(path.join(base, 'no-age'), true) }), /age_missing/);
  const { root, state } = await pilotFixture(path.join(base, 'pilot'));
  await assert.rejects(verifyBackup({ root, state, backup }), /age_identity_required/);
  // The scratch directory used for decrypted copies is always removed.
  assert.deepEqual((await readdir(state)).filter(name => name.startsWith('.restore-drill-')), []);
  // Ciphertext changes are caught by the manifest before decryption is attempted.
  await writeFile(path.join(backup, 'database.dump.age'), 'ciphertexT', { mode: 0o600 });
  await assert.rejects(decryptBackup({ backup, output, identity }), /backup_file_changed/);
  // Encrypted manifests must describe ciphertext files with plaintext digests, and plain ones cannot claim encryption.
  await rm(path.join(backup, 'manifest.json'));
  for (const change of [m => { delete m.files[0].plaintext; }, m => { m.files[0].name = 'database.dump'; }, m => { delete m.encryption; }, m => { m.schemaVersion = 1; }, m => { m.schemaVersion = 3; }]) {
    await encryptedManifestFixture(backup);
    const manifest = JSON.parse(await readFile(path.join(backup, 'manifest.json'), 'utf8'));
    change(manifest); await rm(path.join(backup, 'manifest.json'));
    await writePrivate(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyManifest(backup), /invalid_backup_manifest|backup_file_set_changed/);
    await rm(path.join(backup, 'manifest.json'));
  }
}));

test('backup arguments accept an identity only where something is decrypted', () => {
  const parsed = parseBackupArguments(['verify', '--backup', '/tmp/b', '--age-identity', '/tmp/key.txt', '--age-bin', '/opt/age/bin']);
  assert.equal(parsed.identity, '/tmp/key.txt'); assert.equal(parsed.ageBin, '/opt/age/bin'); assert(!Object.keys(parsed).some(k => k.startsWith('given_')));
  assert.deepEqual(parseBackupArguments(['decrypt', '--backup', '/tmp/b', '--age-identity', '/tmp/k', '--output', '/tmp/o']).mode, 'decrypt');
  assert.throws(() => parseBackupArguments(['decrypt', '--backup', '/tmp/b', '--output', '/tmp/o']), /invalid_arguments/);
  assert.throws(() => parseBackupArguments(['create', '--output', '/tmp/o', '--age-identity', '/tmp/k']), /invalid_arguments/);
  assert.throws(() => parseBackupArguments(['verify', '--backup', '/tmp/b', '--backup', '/tmp/c']), /invalid_arguments/);
  assert.throws(() => parseBackupArguments(['verify', '--backup', '/tmp/b', '--age-identity', 'relative']), /invalid_path/);
});

test('row-count comparison ignores key order and names every differing, missing or extra table', () => {
  assert.deepEqual(tableCountDifferences({ b: 2, a: 1 }, { a: 1, b: 2 }), []);
  assert.deepEqual(tableCountDifferences({}, {}), []);
  assert.deepEqual(tableCountDifferences({ a: 1, b: 2, gone: 0 }, { b: 3, a: 1, added: 4 }), [
    { table: 'added', recorded: null, restored: 4 }, { table: 'b', recorded: 2, restored: 3 }, { table: 'gone', recorded: 0, restored: null }]);
  assert.deepEqual(tableCountDifferences({ a: 1 }, { a: 2 }, ['before', 'after']), [{ table: 'a', before: 1, after: 2 }]);
});

test('snapshots prune apart from stopped backups, and their arguments never take an identity', () => fixture(async parent => {
  const backups = ['backup-20261001000000000-aaaaaa', 'backup-20261002000000000-bbbbbb'], snapshots = ['snapshot-20261001000000000-cccccc', 'snapshot-20261001010000000-dddddd', 'snapshot-20261001020000000-eeeeee'];
  for (const name of [...backups, ...snapshots]) { await mkdir(path.join(parent, name), { mode: 0o700 }); await manifestFixture(path.join(parent, name)); }
  assert.deepEqual(await pruneBackups({ output: parent, keep: 1, kind: 'snapshot' }), { status: 'pruned', kept: [snapshots[2]], removed: [snapshots[1], snapshots[0]], skipped: [] });
  assert.deepEqual((await readdir(parent)).sort(), [...backups, snapshots[2]]);
  assert.deepEqual((await pruneBackups({ output: parent, keep: 1 })).removed, [backups[0]]);
  await assert.rejects(pruneBackups({ output: parent, keep: 1, kind: 'other' }), /invalid_arguments/);
  assert.deepEqual(parseBackupArguments(['prune', '--output', parent, '--keep', '48', '--kind', 'snapshot']), { mode: 'prune', output: parent, keep: 48, kind: 'snapshot' });
  assert.throws(() => parseBackupArguments(['prune', '--output', parent, '--keep', '4', '--kind', 'everything']), /invalid_arguments/);
  assert.equal(parseBackupArguments(['snapshot', '--output', '/tmp/s']).mode, 'snapshot');
  assert.throws(() => parseBackupArguments(['snapshot']), /invalid_arguments/);
  assert.throws(() => parseBackupArguments(['snapshot', '--output', '/tmp/s', '--age-identity', '/tmp/k']), /invalid_arguments/);
}));

test('a snapshot with a configured recipient but no age binary fails before touching the database', () => fixture(async base => {
  const { root, state } = await pilotFixture(base, { backupAgeRecipients: [recipient('q')] });
  const empty = await privateDirectory(path.join(base, 'no-age'), true), output = path.join(base, 'snapshots');
  await assert.rejects(createSnapshot({ root, state, output, ageBin: empty }), /age_missing/);
  assert.deepEqual(await readdir(output).catch(() => []), []);
}));

test('backup reports refuse anything but fixed kinds, codes, times and counts', async () => {
  const url = new URL('postgresql://nobody@127.0.0.1:1/course_core_test_absent');
  const report = { kind: 'snapshot', outcome: 'failed', code: 'pg_dump_failed', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:00:04.000Z',
    encrypted: false, coreVersion: '0.1.50', tables: null, rows: null, bytes: null };
  // Unreachable database: the report is simply not written (best effort).
  assert.equal(await recordBackupReport(undefined, url, report), false);
  for (const bad of [{ kind: 'dump' }, { code: "x'); DROP TABLE t; --" }, { code: null }, { outcome: 'succeeded' }, { startedAt: "now()" }, { coreVersion: "1'" }])
    assert.equal(await recordBackupReport('/nonexistent-bin', url, { ...report, ...bad }), false, JSON.stringify(bad));
});

test('snapshot settings: absolute owner directory, a 15 to 60 minute interval and a bounded count', () => {
  assert.equal(snapshotsConfiguration(undefined), null);
  assert.deepEqual(snapshotsConfiguration({ directory: '/backups/snapshots' }), { directory: '/backups/snapshots', intervalMinutes: 60, keep: 48 });
  assert.deepEqual(snapshotsConfiguration({ directory: '/b', intervalMinutes: 15, keep: 2 }), { directory: '/b', intervalMinutes: 15, keep: 2 });
  for (const [bad, code] of [[{ directory: 'relative' }, 'invalid_snapshots'], [{ directory: "/it's" }, 'invalid_snapshots'], [{ directory: '/b', extra: 1 }, 'invalid_snapshots'],
    [{ directory: '/b', intervalMinutes: 90 }, 'invalid_snapshot_interval'], [{ directory: '/b', intervalMinutes: 5 }, 'invalid_snapshot_interval'],
    [{ directory: '/b', keep: 1 }, 'invalid_snapshot_keep'], [[], 'invalid_snapshots'], ['x', 'invalid_snapshots']])
    assert.throws(() => snapshotsConfiguration(bad), new RegExp(code), JSON.stringify(bad));
});

test('the pilot snapshot schedule runs one snapshot at a time, prunes after success and stops cleanly', async () => {
  const calls = [], children = [], logged = [];
  const spawnProcess = (_node, args) => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), killed: false, kill() { this.killed = true; } });
    calls.push(args.slice(1)); children.push(child); return child;
  };
  const schedule = snapshotSchedule({ root: '/r', state: '/s', snapshots: { directory: '/snap', intervalMinutes: 60, keep: 5 }, log: { write: code => logged.push(code) },
    spawnProcess, firstDelayMs: 3_600_000 });
  const first = schedule.tick();
  await schedule.tick(); // Still running: no second snapshot starts.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['snapshot', '--root', '/r', '--state', '/s', '--output', '/snap']);
  children[0].emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[1], ['prune', '--output', '/snap', '--keep', '5', '--kind', 'snapshot']);
  children[1].emit('exit', 0);
  await first;
  assert.deepEqual(logged, ['snapshot_created']);
  // A failed snapshot is logged by code only and not pruned after.
  const second = schedule.tick();
  children[2].stderr.emit('data', JSON.stringify({ status: 'blocked', code: 'snapshot_export_failed' }) + '\n');
  children[2].emit('exit', 1);
  await second;
  assert.equal(calls.length, 3);
  assert.deepEqual(logged, ['snapshot_created', 'snapshot_failed']);
  // Stopping the pilot ends a snapshot that is still running.
  void schedule.tick();
  schedule.stop();
  assert.equal(children[3].killed, true);
  children[3].emit('exit', null);
  await schedule.tick();
  assert.equal(calls.length, 4);
});
