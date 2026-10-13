import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfiguration, repositoryRoot } from './pilot.mjs';
import { PilotError, ensure, absolute, hash, ownerRecord, portFree, privateDirectory, writePrivate } from './runtime.mjs';

const exec = promisify(execFile);
/** Never pass a URL containing a password on a command line; use the environment. */
function connection(databaseUrl) {
  const url = new URL(databaseUrl);
  ensure(!url.password, 'database_password_in_url_unsupported');
  return url;
}
async function tool(pgBin, name, args, env = {}) {
  const binary = pgBin ? path.join(pgBin, name) : name;
  try {
    return (await exec(binary, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new PilotError(error.code === 'ENOENT' ? `${name}_missing` : `${name}_failed`);
  }
}
async function digestFile(file) { return hash(await readFile(file)); }
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
  ensure(manifest.schemaVersion === 1 && manifest.kind === 'course-core-pilot-backup' && Array.isArray(manifest.files), 'invalid_backup_manifest');
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
export async function createBackup({ root, state, output, pgBin }) {
  const loaded = await loadConfiguration(root, state);
  ensure(!(await ownerRecord(loaded.state)), 'pilot_running');
  ensure((await Promise.all(loaded.ports.map(portFree))).every(Boolean), 'service_port_in_use');
  const url = connection(loaded.config.databaseUrl);
  const parent = await privateDirectory(absolute(output), true);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const directory = path.join(parent, `backup-${stamp}-${randomBytes(3).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 });
  const files = [];
  const record = async name => { const full = path.join(directory, name); await chmod(full, 0o600); const info = await lstat(full); files.push({ name, bytes: info.size, sha256: await digestFile(full) }); };
  await tool(pgBin, 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(directory, 'database.dump'), url.href]);
  await record('database.dump');
  const counts = await tableCounts(pgBin, url);
  const server = (await tool(pgBin, 'psql', [url.href, '-XAtc', 'SHOW server_version'])).trim();
  const migrations = (await tool(pgBin, 'psql', [url.href, '-XAtc', 'SELECT name FROM schema_migrations ORDER BY name'])).trim().split('\n').filter(Boolean);
  for (const name of ['config.json', 'temporal.db', 'installation.json']) {
    try { await lstat(path.join(loaded.state, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await copyFile(path.join(loaded.state, name), path.join(directory, name)); await record(name);
  }
  // Provider credentials are sealed; the vault holds their key. Backups
  // therefore carry key custody and must stay private (owner-only, local).
  const vault = loaded.config.providerVaultDirectory;
  for (const entry of await readdir(vault, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await mkdir(path.join(directory, 'provider-vault'), { mode: 0o700, recursive: true });
    const name = path.join('provider-vault', entry.name);
    await copyFile(path.join(vault, entry.name), path.join(directory, name)); await record(name);
  }
  const runtime = JSON.parse(await readFile(path.join(loaded.root, 'package.json'), 'utf8'));
  const manifest = { schemaVersion: 1, kind: 'course-core-pilot-backup', createdAt: new Date().toISOString(),
    coreVersion: runtime.version, postgresServerVersion: server, migrations, tableCounts: counts, files,
    contains: ['learner records', 'operator configuration', 'sealed provider credentials and vault key'] };
  await writePrivate(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await verifyManifest(directory);
  return { status: 'created', directory, coreVersion: manifest.coreVersion, tables: Object.keys(counts).length,
    rows: Object.values(counts).reduce((a, b) => a + b, 0), files: files.length };
}
/** Restore drill: restore into a NEW disposable database on the same server,
 * compare row counts and migrations, check the Temporal store, then drop it. */
export async function verifyBackup({ root, state, backup, pgBin, keep = false }) {
  const directory = await realpath(absolute(backup));
  const manifest = await verifyManifest(directory);
  const loaded = await loadConfiguration(root, state), source = connection(loaded.config.databaseUrl);
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
export function parseBackupArguments(args) {
  const mode = args[0]; ensure(['create', 'verify'].includes(mode), 'invalid_command');
  const result = { mode, root: repositoryRoot, state: path.join(repositoryRoot, '.local/pilot') };
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    ensure(['--root', '--state', '--output', '--backup', '--pg-bin'].includes(flag) && value, 'invalid_arguments');
    result[flag.slice(2).replace('pg-bin', 'pgBin')] = absolute(value);
  }
  ensure(mode === 'create' ? Boolean(result.output) : Boolean(result.backup), 'invalid_arguments');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseBackupArguments(process.argv.slice(2));
  (options.mode === 'create' ? createBackup(options) : verifyBackup(options))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ status: 'blocked', code: error instanceof PilotError ? error.code : 'backup_operation_failed' }) + '\n'); process.exitCode = 1; });
}
