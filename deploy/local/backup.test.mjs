import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { privateDirectory, writePrivate, hash } from './runtime.mjs';
import { verifyManifest, createBackup, verifyBackup, parseBackupArguments } from './backup.mjs';

const exec = promisify(execFile);
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

// Real PostgreSQL + pg_dump/pg_restore + sqlite3 restore drill. Requires an
// explicitly disposable loopback test server; it creates and drops its own DBs.
const serverUrl = process.env.BACKUP_TEST_DATABASE_URL;
test('a stopped pilot backs up and restores into a fresh database with identical rows', { skip: serverUrl ? false : 'BACKUP_TEST_DATABASE_URL not set' }, () => fixture(async base => {
  const url = new URL(serverUrl); assert(['127.0.0.1', 'localhost'].includes(url.hostname) && /^\/course_core_test/.test(url.pathname));
  const name = `course_core_test_bk_${randomBytes(4).toString('hex')}`, admin = new URL(url.href); admin.pathname = '/postgres';
  const db = new URL(url.href); db.pathname = '/' + name;
  const psql = (target, sql) => exec('psql', [target, '-XAtc', sql]);
  await psql(admin.href, `CREATE DATABASE ${name}`);
  try {
    await psql(db.href, "CREATE TABLE schema_migrations(name text PRIMARY KEY); INSERT INTO schema_migrations VALUES('001_initial.sql'); CREATE TABLE learner_rows(id int, note text); INSERT INTO learner_rows SELECT g,'row '||g FROM generate_series(1,250) g;");
    const root = path.join(base, 'root'), state = await privateDirectory(path.join(base, 'state'), true), output = path.join(base, 'backups');
    for (const file of ['.local/bin/temporal', 'services/api/dist/main.js', 'services/supervisor/dist/src/cli.js', 'apps/learner/dist/index.html', 'apps/admin/dist/index.html']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), '', { mode: 0o755 });
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@course-core/repository', version: '9.9.9' }));
    await writePrivate(path.join(state, 'config.json'), JSON.stringify({ schemaVersion: 1, publicOrigin: 'http://127.0.0.1:44410', databaseUrl: db.href,
      temporalPort: 44411, temporalUiPort: 44412, serviceToken: randomBytes(32).toString('base64url'), workspaceIds: [], temporalTaskQueue: 'backup-test' }));
    await exec('sqlite3', [path.join(state, 'temporal.db'), 'CREATE TABLE t(x); INSERT INTO t VALUES (1);']); await chmod(path.join(state, 'temporal.db'), 0o600);
    const created = await createBackup({ root, state, output });
    assert.equal(created.status, 'created'); assert.equal(created.rows, 251); assert.equal(created.coreVersion, '9.9.9');
    const manifest = JSON.parse(await readFile(path.join(created.directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.tableCounts, { learner_rows: 250, schema_migrations: 1 });
    const verified = await verifyBackup({ root, state, backup: created.directory });
    assert.equal(verified.status, 'restore_verified'); assert.equal(verified.rows, 251); assert.equal(verified.temporal, 'integrity_ok'); assert.equal(verified.disposableDatabase, 'dropped');
    // A live owner record (running pilot) blocks a backup outright.
    await writePrivate(path.join(state, 'owner.json'), JSON.stringify({ schemaVersion: 2 }));
    await assert.rejects(createBackup({ root, state, output }));
    await rm(path.join(state, 'owner.json'));
    // A changed dump cannot be restored as if it were the recorded backup.
    await writeFile(path.join(created.directory, 'database.dump'), 'tampered', { mode: 0o600 });
    await assert.rejects(verifyBackup({ root, state, backup: created.directory }), /backup_file_changed/);
  } finally {
    await psql(admin.href, `DROP DATABASE IF EXISTS ${name}`);
  }
}));
