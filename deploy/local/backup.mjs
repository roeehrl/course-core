import { execFile, spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfiguration, repositoryRoot } from './pilot.mjs';
import { PilotError, ensure, absolute, hash, ownerRecord, portFree, privateDirectory, privateFile, writePrivate } from './runtime.mjs';

const exec = promisify(execFile);
/** Never pass a URL containing a password on a command line; use the environment. */
function connection(databaseUrl) {
  const url = new URL(databaseUrl);
  ensure(!url.password, 'database_password_in_url_unsupported');
  return url;
}
const toolEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });
async function tool(pgBin, name, args, env = {}, code = name) {
  const binary = pgBin ? path.join(pgBin, name) : name;
  try {
    return (await exec(binary, args, { env: { ...toolEnvironment(), ...env }, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new PilotError(error.code === 'ENOENT' ? `${name}_missing` : `${code}_failed`);
  }
}
async function digestFile(file) { return hash(await readFile(file)); }

// Optional age encryption. Backups are encrypted to the public recipients in
// `backupAgeRecipients`; only the operator's identity file, passed at restore
// time, can decrypt them. The `age` CLI is required once recipients are set:
// a configured but missing binary fails before anything is dumped.
export const ENCRYPTED_SUFFIX = '.age';
async function requireAge(ageBin) { await tool(ageBin, 'age', ['--version']); }
async function encryptFile(ageBin, recipients, input, output) {
  await tool(ageBin, 'age', ['--encrypt', ...recipients.flatMap(r => ['--recipient', r]), '--output', output, input], {}, 'age_encrypt');
}
async function decryptFile(ageBin, identity, input, output) {
  await tool(ageBin, 'age', ['--decrypt', '--identity', identity, '--output', output, input], {}, 'age_decrypt');
}
/** pg_dump → age with no plaintext on disk; returns the plaintext size and digest. */
function dumpEncrypted(pgBin, ageBin, url, recipients, output) {
  return new Promise((resolve, reject) => {
    const env = toolEnvironment(), digest = createHash('sha256'); let bytes = 0, failure;
    const dump = spawn(pgBin ? path.join(pgBin, 'pg_dump') : 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', url.href], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const age = spawn(ageBin ? path.join(ageBin, 'age') : 'age', ['--encrypt', ...recipients.flatMap(r => ['--recipient', r]), '--output', output], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    const fail = code => { failure ??= code; dump.kill(); age.kill(); };
    age.stdin.on('error', () => fail('age_encrypt_failed'));
    dump.stdout.on('data', chunk => { digest.update(chunk); bytes += chunk.length; });
    dump.stdout.pipe(age.stdin);
    const done = (child, name, code) => new Promise(settle => {
      child.once('error', error => { fail(error.code === 'ENOENT' ? `${name}_missing` : `${code}_failed`); settle(); });
      child.once('close', status => { if (status !== 0) fail(`${code}_failed`); settle(); });
    });
    Promise.all([done(dump, 'pg_dump', 'pg_dump'), done(age, 'age', 'age_encrypt')])
      .then(() => failure ? reject(new PilotError(failure)) : resolve({ bytes, sha256: digest.digest('hex') }));
  });
}
/** An identity file holds a private key: it must be an owner-only regular file. */
async function identityFile(value) {
  const file = absolute(value);
  await privateFile(file, false, 65_536).catch(error => { throw new PilotError(error?.code === 'insecure_private_file' ? 'insecure_age_identity_file' : 'age_identity_unreadable'); });
  return file;
}
async function tableCounts(pgBin, url) {
  const tables = (await tool(pgBin, 'psql', [url.href, '-XAtc',
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"])).trim().split('\n').filter(Boolean);
  ensure(tables.every(name => /^[a-z_][a-z0-9_]{0,62}$/.test(name)), 'unexpected_table_name');
  if (!tables.length) return {};
  const sql = tables.map(name => `SELECT '${name}',count(*) FROM public."${name}"`).join(' UNION ALL ');
  const rows = (await tool(pgBin, 'psql', [url.href, '-XAtF', '\t', '-c', sql])).trim().split('\n');
  return Object.fromEntries(rows.map(line => { const [name, count] = line.split('\t'); return [name, Number(count)]; }));
}
/** Recompute every recorded file digest; any changed, missing or extra file fails. */
export async function verifyManifest(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  ensure([1, 2].includes(manifest.schemaVersion) && manifest.kind === 'course-core-pilot-backup' && Array.isArray(manifest.files), 'invalid_backup_manifest');
  // Schema 2 is an age-encrypted backup: every file is ciphertext and also records its plaintext digest.
  ensure(manifest.schemaVersion === 2
    ? manifest.encryption?.scheme === 'age' && Array.isArray(manifest.encryption.recipients) && manifest.files.every(f => f.name.endsWith(ENCRYPTED_SUFFIX)
      && Number.isSafeInteger(f.plaintext?.bytes) && /^[a-f0-9]{64}$/.test(f.plaintext?.sha256 ?? ''))
    : manifest.encryption === undefined, 'invalid_backup_manifest');
  const present = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))).filter(name => name !== 'manifest.json').sort();
  ensure(JSON.stringify(present) === JSON.stringify(manifest.files.map(f => f.name).sort()), 'backup_file_set_changed');
  for (const file of manifest.files) {
    const full = path.join(directory, file.name), info = await lstat(full);
    ensure(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077) && info.size === file.bytes, 'backup_file_changed');
    ensure(await digestFile(full) === file.sha256, 'backup_file_changed');
  }
  return manifest;
}
/** A consistent backup requires a stopped pilot: PostgreSQL and the Temporal
 * store are captured at the same quiescent point. */
export async function createBackup({ root, state, output, pgBin, ageBin }) {
  const loaded = await loadConfiguration(root, state);
  ensure(!(await ownerRecord(loaded.state)), 'pilot_running');
  ensure((await Promise.all(loaded.ports.map(portFree))).every(Boolean), 'service_port_in_use');
  const recipients = loaded.config.backupAgeRecipients;
  if (recipients.length) await requireAge(ageBin);
  const url = connection(loaded.config.migrationDatabaseUrl ?? loaded.config.databaseUrl);
  const parent = await privateDirectory(absolute(output), true);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const directory = path.join(parent, `backup-${stamp}-${randomBytes(3).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 });
  const files = [];
  const record = async (name, plaintext) => { const full = path.join(directory, name); await chmod(full, 0o600); const info = await lstat(full); files.push({ name, bytes: info.size, sha256: await digestFile(full), ...(plaintext ? { plaintext } : {}) }); };
  // Copy one file in, encrypting it when recipients are configured.
  const store = async (source, name) => {
    if (!recipients.length) { await copyFile(source, path.join(directory, name)); return record(name); }
    const bytes = await readFile(source);
    await encryptFile(ageBin, recipients, source, path.join(directory, name + ENCRYPTED_SUFFIX));
    return record(name + ENCRYPTED_SUFFIX, { bytes: bytes.length, sha256: hash(bytes) });
  };
  if (recipients.length) {
    const plaintext = await dumpEncrypted(pgBin, ageBin, url, recipients, path.join(directory, 'database.dump' + ENCRYPTED_SUFFIX));
    await record('database.dump' + ENCRYPTED_SUFFIX, plaintext);
  } else {
    await tool(pgBin, 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(directory, 'database.dump'), url.href]);
    await record('database.dump');
  }
  const counts = await tableCounts(pgBin, url);
  const server = (await tool(pgBin, 'psql', [url.href, '-XAtc', 'SHOW server_version'])).trim();
  const migrations = (await tool(pgBin, 'psql', [url.href, '-XAtc', 'SELECT name FROM schema_migrations ORDER BY name'])).trim().split('\n').filter(Boolean);
  for (const name of ['config.json', 'temporal.db', 'installation.json']) {
    try { await lstat(path.join(loaded.state, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await store(path.join(loaded.state, name), name);
  }
  // Provider credentials are sealed; the vault holds their key. Backups
  // therefore carry key custody and must stay private (owner-only, local).
  const vault = loaded.config.providerVaultDirectory;
  for (const entry of await readdir(vault, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await mkdir(path.join(directory, 'provider-vault'), { mode: 0o700, recursive: true });
    await store(path.join(vault, entry.name), path.join('provider-vault', entry.name));
  }
  const runtime = JSON.parse(await readFile(path.join(loaded.root, 'package.json'), 'utf8'));
  // The manifest itself stays readable so integrity checks and pruning work
  // without the identity. It holds versions, migration names, table names,
  // row counts and file sizes/digests, never row contents.
  const manifest = { schemaVersion: recipients.length ? 2 : 1, kind: 'course-core-pilot-backup', createdAt: new Date().toISOString(),
    coreVersion: runtime.version, postgresServerVersion: server, migrations, tableCounts: counts, files,
    ...(recipients.length ? { encryption: { scheme: 'age', recipients } } : {}),
    contains: ['learner records', 'operator configuration', 'sealed provider credentials and vault key'] };
  await writePrivate(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await verifyManifest(directory);
  return { status: 'created', directory, coreVersion: manifest.coreVersion, tables: Object.keys(counts).length,
    rows: Object.values(counts).reduce((a, b) => a + b, 0), files: files.length, encrypted: recipients.length > 0 };
}
/** Decrypt an encrypted backup into a new owner-only directory holding a plain
 * (schema 1) backup with its own manifest; every plaintext digest must match
 * what was recorded at creation. Used by restore drills and manual restores. */
export async function decryptBackup({ backup, identity, output, ageBin }) {
  const source = await realpath(absolute(backup));
  const manifest = await verifyManifest(source);
  ensure(manifest.schemaVersion === 2, 'backup_not_encrypted');
  ensure(identity, 'age_identity_required');
  const key = await identityFile(identity);
  await requireAge(ageBin);
  const parent = await privateDirectory(absolute(output), true);
  const directory = path.join(parent, `${path.basename(source)}-decrypted-${randomBytes(3).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    const files = [];
    for (const file of manifest.files) {
      const name = file.name.slice(0, -ENCRYPTED_SUFFIX.length), target = path.join(directory, name);
      await mkdir(path.dirname(target), { mode: 0o700, recursive: true });
      await decryptFile(ageBin, key, path.join(source, file.name), target);
      await chmod(target, 0o600);
      const info = await lstat(target), sha256 = await digestFile(target);
      ensure(info.size === file.plaintext.bytes && sha256 === file.plaintext.sha256, 'backup_plaintext_changed');
      files.push({ name, bytes: info.size, sha256 });
    }
    const { encryption: _encryption, ...rest } = manifest;
    await writePrivate(path.join(directory, 'manifest.json'), JSON.stringify({ ...rest, schemaVersion: 1, files, decryptedFrom: path.basename(source) }, null, 2) + '\n');
    await verifyManifest(directory);
    return { status: 'decrypted', directory, files: files.length };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
/** Restore drill: restore into a NEW disposable database on the same server,
 * compare row counts and migrations, check the Temporal store, then drop it. */
export async function verifyBackup({ root, state, backup, pgBin, ageBin, identity, keep = false }) {
  const original = await realpath(absolute(backup));
  const recorded = await verifyManifest(original);
  const loaded = await loadConfiguration(root, state);
  if (recorded.schemaVersion !== 2) return restoreDrill({ loaded, directory: original, manifest: recorded, pgBin, keep });
  // Decrypted copies go to a scratch directory inside the private pilot state,
  // which already holds the same data unencrypted, and are always removed.
  const scratch = await mkdtemp(path.join(loaded.state, '.restore-drill-'));
  try {
    await chmod(scratch, 0o700);
    const decrypted = await decryptBackup({ backup: original, identity, output: scratch, ageBin });
    const result = await restoreDrill({ loaded, directory: decrypted.directory, manifest: await verifyManifest(decrypted.directory), pgBin, keep });
    return { ...result, backup: original, encrypted: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
async function restoreDrill({ loaded, directory, manifest, pgBin, keep }) {
  const source = connection(loaded.config.migrationDatabaseUrl ?? loaded.config.databaseUrl);
  const name = `course_core_restore_${randomBytes(6).toString('hex')}`;
  const target = new URL(source.href); target.pathname = '/' + name;
  const admin = new URL(source.href); admin.pathname = '/postgres';
  ensure(target.pathname !== source.pathname, 'restore_target_is_source');
  await tool(pgBin, 'psql', [admin.href, '-XAtc', `CREATE DATABASE ${name}`]);
  try {
    await tool(pgBin, 'pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', target.href, path.join(directory, 'database.dump')]);
    const counts = await tableCounts(pgBin, target);
    ensure(JSON.stringify(counts) === JSON.stringify(manifest.tableCounts), 'restored_row_counts_differ');
    const migrations = (await tool(pgBin, 'psql', [target.href, '-XAtc', 'SELECT name FROM schema_migrations ORDER BY name'])).trim().split('\n').filter(Boolean);
    ensure(JSON.stringify(migrations) === JSON.stringify(manifest.migrations), 'restored_migrations_differ');
    let temporal = 'absent';
    if (manifest.files.some(f => f.name === 'temporal.db')) {
      const result = (await exec('sqlite3', [path.join(directory, 'temporal.db'), 'PRAGMA integrity_check;']).catch(() => ({ stdout: 'unavailable' }))).stdout.trim();
      ensure(result === 'ok', 'temporal_store_integrity_failed'); temporal = 'integrity_ok';
    }
    return { status: 'restore_verified', backup: directory, disposableDatabase: keep ? name : 'dropped', tables: Object.keys(counts).length,
      rows: Object.values(counts).reduce((a, b) => a + b, 0), migrations: migrations.length, temporal,
      providerVaultFiles: manifest.files.filter(f => f.name.startsWith('provider-vault/')).length };
  } finally {
    if (!keep) await tool(pgBin, 'psql', [admin.href, '-XAtc', `DROP DATABASE IF EXISTS ${name}`]).catch(() => undefined);
  }
}
/** Retention: keep the newest `keep` intact backups and delete older intact
 * ones. Anything unrecognised, changed or unreadable is left in place and
 * reported, so an operator decides; at least one backup is always kept. */
export async function pruneBackups({ output, keep }) {
  ensure(Number.isInteger(keep) && keep >= 1 && keep <= 1000, 'invalid_keep');
  const parent = absolute(output), info = await lstat(parent);
  ensure(info.isDirectory() && !info.isSymbolicLink(), 'backup_directory_missing');
  const intact = [], skipped = [];
  for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? 1 : -1))) {
    if (!/^backup-\d{17}-[a-f0-9]{6}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) { skipped.push(entry.name); continue; }
    try { await verifyManifest(path.join(parent, entry.name)); intact.push(entry.name); } catch { skipped.push(entry.name); }
  }
  const removed = intact.slice(keep);
  for (const name of removed) await rm(path.join(parent, name), { recursive: true, force: false });
  return { status: 'pruned', kept: intact.slice(0, keep), removed, skipped };
}
export function parseBackupArguments(args) {
  const mode = args[0]; ensure(['create', 'verify', 'prune', 'decrypt'].includes(mode), 'invalid_command');
  if (mode === 'prune') {
    ensure(args.length === 5 && args[1] === '--output' && args[3] === '--keep' && /^\d{1,4}$/.test(args[4] ?? ''), 'invalid_arguments');
    return { mode, output: absolute(args[2]), keep: Number(args[4]) };
  }
  const result = { mode, root: repositoryRoot, state: path.join(repositoryRoot, '.local/pilot') };
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    const key = { '--root': 'root', '--state': 'state', '--output': 'output', '--backup': 'backup', '--pg-bin': 'pgBin', '--age-bin': 'ageBin', '--age-identity': 'identity' }[flag];
    ensure(key && value && !Object.hasOwn(result, `given_${key}`), 'invalid_arguments');
    result[key] = absolute(value); result[`given_${key}`] = true;
  }
  for (const key of Object.keys(result)) if (key.startsWith('given_')) delete result[key];
  ensure(mode === 'create' ? Boolean(result.output) && !result.identity
    : mode === 'decrypt' ? Boolean(result.backup && result.output && result.identity) : Boolean(result.backup), 'invalid_arguments');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseBackupArguments(process.argv.slice(2));
  const run = { create: createBackup, prune: pruneBackups, verify: verifyBackup, decrypt: decryptBackup }[options.mode];
  run(options)
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ status: 'blocked', code: error instanceof PilotError ? error.code : 'backup_operation_failed' }) + '\n'); process.exitCode = 1; });
}
