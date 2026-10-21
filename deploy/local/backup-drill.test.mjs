import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { privateDirectory, writePrivate } from './runtime.mjs';
import { createBackup, verifyBackup, decryptBackup } from './backup.mjs';

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
    // Recorded counts in a different key order (as a Parallel Append on the live
    // database returns them) still verify: only per-table values are compared.
    const manifestFile = path.join(created.directory, 'manifest.json');
    await writePrivate(manifestFile, JSON.stringify({ ...manifest, tableCounts: { schema_migrations: 1, learner_rows: 250 } }), true);
    assert.equal((await verifyBackup({ root, state, backup: created.directory })).status, 'restore_verified');
    // A genuinely different count names the table and both counts.
    await writePrivate(manifestFile, JSON.stringify({ ...manifest, tableCounts: { learner_rows: 251, schema_migrations: 1, dropped_table: 3 } }), true);
    const differ = await verifyBackup({ root, state, backup: created.directory }).then(() => assert.fail('counts differ'), e => e);
    assert.equal(differ.code, 'restored_row_counts_differ');
    assert.deepEqual(differ.details, { tables: [{ table: 'dropped_table', recorded: 3, restored: null }, { table: 'learner_rows', recorded: 251, restored: 250 }] });
    await writePrivate(manifestFile, JSON.stringify(manifest, null, 2) + '\n', true);
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

// Encrypted backups use the age CLI. CI installs it and sets BACKUP_REQUIRE_AGE=1,
// so a missing binary there is a failure; elsewhere the round trip is skipped
// with that reason. BACKUP_TEST_AGE_BIN may name the directory holding age/age-keygen.
const ageBin = process.env.BACKUP_TEST_AGE_BIN || undefined;
const ageTool = name => ageBin ? path.join(ageBin, name) : name;
const ageAvailable = await exec(ageTool('age'), ['--version']).then(() => true, () => false);
test('the age CLI is present when the encrypted round trip is required', { skip: process.env.BACKUP_REQUIRE_AGE === '1' ? false : 'BACKUP_REQUIRE_AGE is not set' }, () => {
  assert.ok(ageAvailable, 'BACKUP_REQUIRE_AGE=1 but the age CLI was not found');
});
async function keyPair(directory, name) {
  const identity = path.join(directory, `${name}.txt`);
  await exec(ageTool('age-keygen'), ['-o', identity]); await chmod(identity, 0o600);
  const recipient = (await exec(ageTool('age-keygen'), ['-y', identity])).stdout.trim();
  return { identity, recipient };
}
test('an age-encrypted backup holds no plaintext, restores only with the identity and rejects tampering',
  { skip: !serverUrl ? 'BACKUP_TEST_DATABASE_URL missing (reported as a failure above)' : !ageAvailable ? 'age CLI not installed (CI installs it and requires this test)' : false }, () => fixture(async base => {
  const url = new URL(serverUrl); assert(['127.0.0.1', 'localhost'].includes(url.hostname) && /^\/course_core_test/.test(url.pathname));
  const name = `course_core_test_bk_${randomBytes(4).toString('hex')}`, admin = new URL(url.href); admin.pathname = '/postgres';
  const db = new URL(url.href); db.pathname = '/' + name;
  const psql = (target, sql) => exec('psql', [target, '-XAtc', sql]);
  await psql(admin.href, `CREATE DATABASE ${name}`);
  try {
    const marker = `learner-secret-${randomBytes(6).toString('hex')}`;
    await psql(db.href, `CREATE TABLE schema_migrations(name text PRIMARY KEY); INSERT INTO schema_migrations VALUES('001_initial.sql'); CREATE TABLE learner_rows(id int, note text); INSERT INTO learner_rows SELECT g,'${marker} '||g FROM generate_series(1,120) g;`);
    const keys = await privateDirectory(path.join(base, 'keys'), true);
    const owner = await keyPair(keys, 'owner'), stranger = await keyPair(keys, 'stranger');
    const root = path.join(base, 'root'), state = await privateDirectory(path.join(base, 'state'), true), output = path.join(base, 'backups');
    for (const file of ['.local/bin/temporal', 'services/api/dist/main.js', 'services/supervisor/dist/src/cli.js', 'apps/learner/dist/index.html', 'apps/admin/dist/index.html']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), '', { mode: 0o755 });
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@course-core/repository', version: '9.9.9' }));
    const serviceToken = randomBytes(32).toString('base64url');
    await writePrivate(path.join(state, 'config.json'), JSON.stringify({ schemaVersion: 1, publicOrigin: 'http://127.0.0.1:44430', databaseUrl: db.href,
      temporalPort: 44431, temporalUiPort: 44432, serviceToken, workspaceIds: [], temporalTaskQueue: 'backup-age-test', backupAgeRecipients: [owner.recipient] }));
    await exec('sqlite3', [path.join(state, 'temporal.db'), 'CREATE TABLE t(x); INSERT INTO t VALUES (1);']); await chmod(path.join(state, 'temporal.db'), 0o600);
    await mkdir(path.join(state, 'provider-vault'), { mode: 0o700, recursive: true });
    await writePrivate(path.join(state, 'provider-vault', 'vault.key'), randomBytes(32).toString('hex'));

    const started = Date.now();
    const created = await createBackup({ root, state, output, ageBin });
    assert.equal(created.status, 'created'); assert.equal(created.encrypted, true); assert.equal(created.rows, 121);
    const files = (await readdir(created.directory, { recursive: true, withFileTypes: true })).filter(e => e.isFile())
      .map(e => path.relative(created.directory, path.join(e.parentPath, e.name))).sort();
    assert.deepEqual(files, ['config.json.age', 'database.dump.age', 'manifest.json', 'provider-vault/vault.key.age', 'temporal.db.age']);
    // Nothing readable leaks: no dump header, learner text, service token or SQLite header in any ciphertext.
    for (const file of files.filter(f => f.endsWith('.age'))) {
      const bytes = await readFile(path.join(created.directory, file));
      assert(bytes.subarray(0, 21).toString() === 'age-encryption.org/v1', file);
      for (const needle of ['PGDMP', marker, serviceToken, 'SQLite format']) assert(!bytes.includes(needle), `${file} contains ${needle}`);
    }
    const manifest = JSON.parse(await readFile(path.join(created.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2); assert.deepEqual(manifest.encryption, { scheme: 'age', recipients: [owner.recipient] });
    assert(!JSON.stringify(manifest).includes(marker) && !JSON.stringify(manifest).includes('AGE-SECRET'));

    const verified = await verifyBackup({ root, state, backup: created.directory, identity: owner.identity, ageBin });
    assert.equal(verified.status, 'restore_verified'); assert.equal(verified.encrypted, true); assert.equal(verified.rows, 121);
    assert.equal(verified.temporal, 'integrity_ok'); assert.equal(verified.providerVaultFiles, 1); assert.equal(verified.disposableDatabase, 'dropped');
    // Measured for the operator documentation: create + restore drill of a small database.
    console.log(`# encrypted backup + restore drill: ${Date.now() - started} ms`);
    assert.deepEqual((await readdir(state)).filter(n => n.startsWith('.restore-drill-')), []);

    // A manual restore starts from a decrypted plain copy; it verifies as an ordinary backup.
    const plain = await decryptBackup({ backup: created.directory, identity: owner.identity, output: path.join(base, 'plain'), ageBin });
    assert.equal(await readFile(path.join(plain.directory, 'config.json'), 'utf8'), await readFile(path.join(state, 'config.json'), 'utf8'));
    assert.equal((await verifyBackup({ root, state, backup: plain.directory })).status, 'restore_verified');

    // Wrong identity: age refuses, and no decrypted scratch copy is left behind.
    await assert.rejects(verifyBackup({ root, state, backup: created.directory, identity: stranger.identity, ageBin }), /age_decrypt_failed/);
    await assert.rejects(verifyBackup({ root, state, backup: created.directory, ageBin }), /age_identity_required/);
    assert.deepEqual((await readdir(state)).filter(n => n.startsWith('.restore-drill-')), []);

    // Tampered ciphertext: the manifest digest catches it first ...
    const dump = path.join(created.directory, 'database.dump.age'), original = await readFile(dump);
    const flipped = Buffer.from(original); flipped[flipped.length - 20] ^= 0x01;
    await writeFile(dump, flipped, { mode: 0o600 });
    await assert.rejects(verifyBackup({ root, state, backup: created.directory, identity: owner.identity, ageBin }), /backup_file_changed/);
    // ... and if an attacker also rewrites the manifest digest, age's authentication still refuses it.
    const { createHash } = await import('node:crypto');
    manifest.files.find(f => f.name === 'database.dump.age').sha256 = createHash('sha256').update(flipped).digest('hex');
    await rm(path.join(created.directory, 'manifest.json'));
    await writePrivate(path.join(created.directory, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyBackup({ root, state, backup: created.directory, identity: owner.identity, ageBin }), /age_decrypt_failed/);
    assert.deepEqual((await readdir(state)).filter(n => n.startsWith('.restore-drill-')), []);
  } finally {
    await psql(admin.href, `DROP DATABASE IF EXISTS ${name}`);
  }
}));
