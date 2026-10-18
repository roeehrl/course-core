import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { privateDirectory, writePrivate } from './runtime.mjs';
import { createBackup, verifyBackup } from './backup.mjs';

const exec = promisify(execFile);
async function fixture(body) { const directory = await mkdtemp('/tmp/cc-bk-'); try { return await body(await privateDirectory(directory)); } finally { await rm(directory, { recursive: true, force: true }); } }

// Real PostgreSQL + pg_dump/pg_restore + sqlite3 restore drill. Requires an
// explicitly disposable loopback test server; it creates and drops its own DBs.
// This file is only run by `npm run test:backup-drill`; a missing server is a
// failure, never a skip, so CI cannot pass without exercising the restore.
const serverUrl = process.env.BACKUP_TEST_DATABASE_URL;
test('the backup drill has an explicitly disposable loopback PostgreSQL server', () => {
  assert.ok(serverUrl, 'BACKUP_TEST_DATABASE_URL is required: a loopback PostgreSQL 17 URL whose database name starts with course_core_test');
  const url = new URL(serverUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && /^\/course_core_test/.test(url.pathname), 'BACKUP_TEST_DATABASE_URL must be a loopback course_core_test* database');
  assert.equal(url.password, '', 'BACKUP_TEST_DATABASE_URL must not contain a password (the backup tool refuses it); use ~/.pgpass or trust auth');
});
test('a stopped pilot backs up and restores into a fresh database with identical rows', { skip: serverUrl ? false : 'BACKUP_TEST_DATABASE_URL missing (reported as a failure above)' }, () => fixture(async base => {
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
      temporalPort: 44411, temporalUiPort: 44412, serviceToken: randomBytes(32).toString('base64url'), workspaceIds: [], temporalTaskQueue: 'backup-test',
      additionalOrigins: ['https://pilot.tailnet.example'] }));
    await exec('sqlite3', [path.join(state, 'temporal.db'), 'CREATE TABLE t(x); INSERT INTO t VALUES (1);']); await chmod(path.join(state, 'temporal.db'), 0o600);
    const created = await createBackup({ root, state, output });
    assert.equal(created.status, 'created'); assert.equal(created.rows, 251); assert.equal(created.coreVersion, '9.9.9');
    const manifest = JSON.parse(await readFile(path.join(created.directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.tableCounts, { learner_rows: 250, schema_migrations: 1 });
    // The configuration, including optional keys such as additionalOrigins, is kept byte for byte.
    assert.equal(await readFile(path.join(created.directory, 'config.json'), 'utf8'), await readFile(path.join(state, 'config.json'), 'utf8'));
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
