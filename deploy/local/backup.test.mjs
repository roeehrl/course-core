import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { privateDirectory, writePrivate, hash } from './runtime.mjs';
import { verifyManifest, parseBackupArguments, pruneBackups } from './backup.mjs';

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
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(parent)).sort(), [names[1], names[2], names[3], 'notes']);
  assert.deepEqual(parseBackupArguments(['prune', '--output', parent, '--keep', '3']), { mode: 'prune', output: parent, keep: 3 });
  assert.throws(() => parseBackupArguments(['prune', '--output', parent]), /invalid_arguments/);
}));
