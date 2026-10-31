// Operations for the Docker Compose deployment (compose.yaml here), one command each:
//   init | up | bootstrap | set-password | status | logs | backup | restore-drill | restore |
//   upgrade | ca-cert | down
// Run it with deploy/docker/core.sh, which uses the host's Node when it has one and otherwise
// runs this same file in the Course Core image. Results are one JSON line on stdout; failures
// are one JSON line on stderr with a fixed code. Secrets (the env file's passwords and tokens,
// owner passwords) are never printed, passed as arguments or put in the environment of a child.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, copyFile, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tableCountDifferences, verifyManifest } from '../local/backup.mjs';

export const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(DIRECTORY, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class OpsError extends Error {
  constructor(code, details) { super(code); this.code = code; this.details = details; }
}
const ensure = (value, code, details) => { if (!value) throw new OpsError(code, details); };

// ------------------------------------------------------------------------- env file

/** KEY=VALUE lines; comments and blank lines are kept as they are when the file is rewritten. */
export function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^'(.*)'$/, '$1');
  }
  return values;
}
/** Sets or adds keys, keeping every other line. Values are single-line and never printed. */
export function updateEnv(text, updates) {
  const lines = text.split('\n'), seen = new Set();
  const next = lines.map(line => {
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1];
    if (!key || !Object.hasOwn(updates, key)) return line;
    seen.add(key); return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) {
    // A commented example (`# KEY=`) is replaced in place; otherwise the key is appended.
    const index = next.findIndex(line => new RegExp(`^#\\s*${key}=`).test(line));
    if (index >= 0) next[index] = `${key}=${value}`; else { if (next.at(-1) === '') next.pop(); next.push(`${key}=${value}`, ''); }
  }
  for (const value of Object.values(updates)) ensure(!/[\n\r]/.test(String(value)), 'invalid_env_value');
  return next.join('\n');
}
/** Writes an owner-only file. An existing file is rewritten in place (same inode, so a bind-mounted
 * file system never serves a stale copy), with its mode forced to 0600 first. */
async function writeOwnerOnly(file, text) {
  let handle;
  try { handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW); await handle.chmod(0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; handle = await open(file, 'wx', 0o600); }
  try { await handle.truncate(0); await handle.write(text, 0, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await giveBack(file);
}
/** When run in the image by core.sh (as root), files it creates go back to the invoking user. */
async function giveBack(file) {
  const owner = /^(\d+):(\d+)$/.exec(process.env.COURSE_OPS_OWNER ?? '');
  if (owner && process.getuid?.() === 0) await chown(file, Number(owner[1]), Number(owner[2]));
}
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  ensure(info.isDirectory() && !info.isSymbolicLink(), 'not_a_directory', { path: directory });
  await chmod(directory, 0o700); await giveBack(directory);
  return directory;
}

// ------------------------------------------------------------------------- compose

export function settings(options = {}) {
  const envFile = path.resolve(options.envFile ?? process.env.COURSE_ENV_FILE ?? path.join(DIRECTORY, '.env'));
  return {
    envFile, composeFile: path.join(DIRECTORY, 'compose.yaml'), project: options.project ?? process.env.COMPOSE_PROJECT_NAME,
    backups: path.resolve(options.backups ?? path.join(DIRECTORY, 'backups')), state: path.join(DIRECTORY, '.ops'),
  };
}
/** Runs `docker compose` for this deployment. `input` is written to its stdin; output is captured
 * unless `inherit` is set. Never logs arguments or output. */
export function compose(config, args, { input, inherit = false, stdout, timeoutMs = 30 * 60_000, env = {} } = {}) {
  const argv = ['compose', '-f', config.composeFile, '--env-file', config.envFile, ...(config.project ? ['-p', config.project] : []), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { stdio: [inherit && input === undefined ? 'inherit' : 'pipe', inherit ? 'inherit' : stdout ? 'pipe' : 'pipe', inherit ? 'inherit' : 'pipe'], env: { ...process.env, ...env } });
    const out = [], err = []; let bytes = 0;
    child.stdout?.on('data', chunk => { if (stdout) stdout.write(chunk); else { bytes += chunk.length; if (bytes < 64 * 1024 * 1024) out.push(chunk); } });
    child.stderr?.on('data', chunk => { if (err.length < 256) err.push(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(new OpsError(error.code === 'ENOENT' ? 'docker_missing' : 'docker_failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') };
      if (stdout) stdout.end?.();
      resolve(result);
    });
    if (child.stdin) { child.stdin.on('error', () => {}); if (input !== undefined) { if (typeof input?.pipe === 'function') input.pipe(child.stdin); else child.stdin.end(input); } else if (!inherit) child.stdin.end(); }
  });
}
async function composeOk(config, args, options, code) {
  const result = await compose(config, args, options);
  ensure(result.code === 0, code, result.stderr ? { docker: lastLine(result.stderr) } : undefined);
  return result;
}
/** Docker's last line, for an operator; it never contains the env file's values. */
const lastLine = text => text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300);
const sql = async (config, statement, database = 'course_core') => (await composeOk(config,
  ['exec', '-T', 'db', 'psql', '-U', 'course', '-d', database, '-XAtq', '-v', 'ON_ERROR_STOP=1', '-F', '\t', '-c', statement], {}, 'database_query_failed')).stdout.toString('utf8').trim();

/** Service states from `compose ps`. */
export async function services(config) {
  const result = await composeOk(config, ['ps', '--all', '--format', 'json'], {}, 'compose_ps_failed');
  const text = result.stdout.toString('utf8').trim();
  const rows = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return Object.fromEntries(rows.map(row => [row.Service, { state: row.State, health: row.Health || null, exitCode: row.ExitCode }]));
}
export const LONG_RUNNING = ['db', 'sandbox-gate', 'api', 'proxy', 'temporal', 'worker', 'dispatcher'];
const HEALTH_CHECKED = new Set(['db', 'sandbox-gate', 'api', 'proxy', 'temporal']);
/** True when every long-running service runs (healthy where it has a check) and proxy-ca finished. */
export function healthy(states, required = LONG_RUNNING) {
  return required.every(name => states[name]?.state === 'running' && (!HEALTH_CHECKED.has(name) || states[name].health === 'healthy'))
    && (!required.includes('worker') || (states['proxy-ca']?.state === 'exited' && states['proxy-ca'].exitCode === 0));
}
/** Waits for the stack to be healthy. A first start compiles nothing but qualifies the sandbox;
 * a loaded machine can need minutes. */
export async function waitHealthy(config, { timeoutMs = 15 * 60_000, required = LONG_RUNNING } = {}) {
  const deadline = Date.now() + timeoutMs;
  let states = {};
  while (Date.now() < deadline) {
    states = await services(config).catch(() => ({}));
    if (healthy(states, required)) return states;
    if (states['proxy-ca']?.state === 'exited' && states['proxy-ca'].exitCode !== 0) break;
    await delay(3000);
  }
  throw new OpsError('stack_not_healthy', { services: Object.fromEntries(Object.entries(states).map(([name, s]) => [name, s.health ?? s.state])) });
}

// ------------------------------------------------------------------------- init and up

export async function init(config) {
  let text, created = false;
  try { text = await readFile(config.envFile, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = await readFile(path.join(DIRECTORY, '.env.example'), 'utf8'); created = true;
  }
  const values = parseEnv(text), generated = [];
  const updates = {};
  for (const key of ['POSTGRES_PASSWORD', 'SUPERVISOR_HOST_TOKEN']) if (!values[key]) { updates[key] = randomBytes(32).toString('hex'); generated.push(key); }
  if (created || generated.length) await writeOwnerOnly(config.envFile, updateEnv(text, updates));
  else {
    const info = await lstat(config.envFile);
    ensure(info.isFile() && !(info.mode & 0o077), 'env_file_not_private', { hint: `chmod 600 ${config.envFile}` });
  }
  const filesDirectory = path.resolve(DIRECTORY, parseEnv(await readFile(config.envFile, 'utf8')).COURSE_FILES_DIR || './course-files');
  await mkdir(filesDirectory, { recursive: true, mode: 0o755 }); await giveBack(filesDirectory);
  return { status: created ? 'env_created' : 'env_ready', envFile: config.envFile, generated, courseFiles: filesDirectory };
}
const env = async config => parseEnv(await readFile(config.envFile, 'utf8'));
/** A registry image (`ghcr.io/owner/course-core:v0.1.60`) is pulled; a local tag is built here. */
export const isRegistryImage = image => image.includes('/');

export async function up(config, { timeoutMs } = {}) {
  const prepared = await init(config);
  const image = (await env(config)).COURSE_CORE_IMAGE || 'course-core-selfhost:local';
  await composeOk(config, ['up', '-d', '--remove-orphans', ...(isRegistryImage(image) ? ['--pull', 'missing'] : ['--build'])], { inherit: true }, 'compose_up_failed');
  const states = await waitHealthy(config, { timeoutMs });
  return { status: 'running', envFile: prepared.envFile, generated: prepared.generated, image, services: Object.keys(states).length };
}

// ------------------------------------------------------------------------- accounts

/** Reads a password from the terminal without echo (twice), or one line from piped input. */
export async function readPassword(prompt, { input = process.stdin, output = process.stderr, confirm = true } = {}) {
  const line = async label => {
    if (!input.isTTY) {
      let text = '';
      for await (const chunk of input) { text += chunk; if (text.includes('\n')) break; }
      return text.split('\n')[0].replace(/\r$/, '');
    }
    output.write(`${label}: `);
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      let text = '';
      const typed = chunk => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') { input.setRawMode(false); input.pause(); input.off('data', typed); output.write('\n'); return resolve(text); }
          if (ch === '\u0003') { input.setRawMode(false); input.pause(); input.off('data', typed); output.write('\n'); return reject(new OpsError('cancelled')); }
          if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1); else text += ch;
        }
      };
      input.on('data', typed);
    });
  };
  const first = await line(prompt);
  if (confirm && input.isTTY) ensure(first === await line(`${prompt} again`), 'passwords_differ');
  ensure(first.length > 0, 'password_required');
  return first;
}

export async function bootstrap(config, [slug, login, displayName, ...rest], { password } = {}) {
  ensure(slug && login && displayName && rest.length === 0, 'invalid_arguments', { usage: 'bootstrap <workspace-slug> <login> "<Display name>"' });
  ensure((await services(config)).api?.health === 'healthy', 'api_not_running');
  const secret = password ?? await readPassword('Owner password');
  const result = await composeOk(config, ['exec', '-T', 'api', 'node', 'dist/bootstrap-cli.js', slug, login, displayName, '--password'], { input: `${secret}\n` }, 'bootstrap_failed');
  const receipt = JSON.parse(result.stdout.toString('utf8').trim().split('\n').at(-1));
  ensure(/^[0-9a-f-]{36}$/.test(receipt.workspaceId ?? ''), 'bootstrap_failed');
  // The supervisor serves this workspace from now on; the API and supervisor restart with it.
  const values = await env(config);
  const ids = (values.SUPERVISOR_WORKSPACE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!ids.includes(receipt.workspaceId)) {
    await writeOwnerOnly(config.envFile, updateEnv(await readFile(config.envFile, 'utf8'), { SUPERVISOR_WORKSPACE_IDS: [...ids, receipt.workspaceId].join(',') }));
    await composeOk(config, ['up', '-d', '--no-build', 'api', 'worker', 'dispatcher'], {}, 'compose_up_failed');
    await waitHealthy(config);
  }
  // A receipt without secrets, for tools that need the workspace (a course install script's --bootstrap).
  await privateDirectory(config.state);
  await writeOwnerOnly(path.join(config.state, 'bootstrap.json'), `${JSON.stringify({ workspaceId: receipt.workspaceId, loginName: receipt.loginName ?? null })}\n`);
  return { status: 'bootstrapped', workspaceId: receipt.workspaceId, loginName: receipt.loginName ?? null, receipt: path.join(config.state, 'bootstrap.json'),
    ...(receipt.oneTimeSignInUrl ? { oneTimeSignInUrl: receipt.oneTimeSignInUrl } : {}) };
}

export async function setPassword(config, args, { password } = {}) {
  const [slug, subject, ...flags] = args;
  ensure(slug && subject && flags.every((flag, i) => ['--login', '--temporary'].includes(flag) || flags[i - 1] === '--login'), 'invalid_arguments', { usage: 'set-password <workspace-slug> <subject> [--login <username>] [--temporary]' });
  const secret = password ?? await readPassword('New password');
  const result = await composeOk(config, ['exec', '-T', 'api', 'node', 'dist/set-password-cli.js', slug, subject, ...flags], { input: `${secret}\n` }, 'set_password_failed');
  return { status: 'password_set', ...JSON.parse(result.stdout.toString('utf8').trim().split('\n').at(-1) || '{}') };
}

// ------------------------------------------------------------------------- status, logs, ca

export async function status(config) {
  const states = await services(config);
  let health = null, version = null;
  if (states.api?.state === 'running') {
    const probe = await compose(config, ['exec', '-T', 'api', 'node', '-e',
      "fetch('http://127.0.0.1:4310/health').then(r=>r.json()).then(h=>console.log(JSON.stringify({status:h.status??null,version:require('/app/package.json').version})),()=>console.log('{}'))"]);
    try { ({ status: health, version } = JSON.parse(probe.stdout.toString('utf8').trim() || '{}')); } catch { /* unknown */ }
  }
  return { status: healthy(states) ? 'healthy' : 'degraded', api: health, version: version ?? null, image: (await env(config)).COURSE_CORE_IMAGE || 'course-core-selfhost:local',
    services: Object.fromEntries(Object.entries(states).map(([name, s]) => [name, s.health ?? s.state])) };
}

export async function logs(config, args) {
  const follow = args.includes('--follow') || args.includes('-f');
  const names = args.filter(arg => !arg.startsWith('-'));
  ensure(names.every(name => [...LONG_RUNNING, 'proxy-ca'].includes(name)), 'unknown_service');
  await compose(config, ['logs', '--no-color', '--tail', '200', ...(follow ? ['--follow'] : []), ...names], { inherit: true });
  return null;
}

/** The proxy's own root certificate (public; its key stays in the proxy volume). */
export async function caCert(config, args) {
  const output = path.resolve(args[0] ?? path.join(config.state, 'proxy-root.crt'));
  await privateDirectory(path.dirname(output));
  const result = await composeOk(config, ['exec', '-T', 'proxy', 'cat', '/data/caddy/pki/authorities/local/root.crt'], {}, 'proxy_certificate_missing');
  await writeFile(output, result.stdout, { mode: 0o644 }); await giveBack(output);
  return { status: 'written', file: output };
}

// ------------------------------------------------------------------------- backups

const stamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
async function digest(file) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
/** Row counts per public table, inside the exported snapshot when one is given. */
async function counts(config, snapshotId, database = 'course_core') {
  const inSnapshot = statement => snapshotId
    ? ['-c', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', '-c', `SET TRANSACTION SNAPSHOT '${snapshotId}'`, '-c', statement, '-c', 'COMMIT'] : ['-c', statement];
  const run = async statement => (await composeOk(config, ['exec', '-T', 'db', 'psql', '-U', 'course', '-d', database, '-XAtq', '-v', 'ON_ERROR_STOP=1', '-F', '\t', ...inSnapshot(statement)], {}, 'database_query_failed'))
    .stdout.toString('utf8').trim().split('\n').filter(Boolean);
  const tables = await run("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  ensure(tables.every(name => /^[a-z_][a-z0-9_]{0,62}$/.test(name)), 'unexpected_table_name');
  const rows = tables.length ? await run(tables.map(name => `SELECT '${name}',count(*) FROM public."${name}"`).join(' UNION ALL ') + ' ORDER BY 1') : [];
  const migrations = tables.includes('schema_migrations') ? await run('SELECT name FROM schema_migrations ORDER BY name') : [];
  return { tableCounts: Object.fromEntries(rows.map(line => { const [name, count] = line.split('\t'); return [name, Number(count)]; })), migrations };
}
/** Holds one REPEATABLE READ transaction in the database container and exports its snapshot, so the
 * dump and the counts read exactly the same data while the course keeps running. */
async function exportSnapshot(config) {
  const argv = ['compose', '-f', config.composeFile, '--env-file', config.envFile, ...(config.project ? ['-p', config.project] : []),
    'exec', '-T', 'db', 'psql', '-U', 'course', '-d', 'course_core', '-XAtq', '-v', 'ON_ERROR_STOP=1'];
  const child = spawn('docker', argv, { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
  child.stdin.on('error', () => {});
  child.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n');
  const id = await new Promise(resolve => {
    let text = ''; const timer = setTimeout(() => resolve(null), 60_000);
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(text.split('\n')[0].trim()); } });
    closed.then(() => { clearTimeout(timer); resolve(null); });
  });
  const release = async () => { child.stdin.end('COMMIT;\n'); const timer = setTimeout(() => child.kill(), 15_000); await closed; clearTimeout(timer); };
  if (!id || !/^[0-9A-F]{8}-[0-9A-F]{8}-\d{1,10}$/.test(id)) { await release(); throw new OpsError('snapshot_export_failed'); }
  return { id, release };
}
const NODE_TEMPORAL_COPY = "const s=require('node:sqlite');const db=new s.DatabaseSync('/data/temporal.db',{readOnly:true});s.backup(db,'/tmp/temporal-backup.db').then(()=>{db.close();process.stdout.write(require('fs').readFileSync('/tmp/temporal-backup.db'));require('fs').rmSync('/tmp/temporal-backup.db');},()=>process.exit(3))";
const NODE_VAULT_READ = "const fs=require('fs'),d='/data/provider-vault';let o={};try{for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isFile())o[e.name]=fs.readFileSync(d+'/'+e.name).toString('base64')}catch(e){if(e.code!=='ENOENT')process.exit(3)}process.stdout.write(JSON.stringify(o))";

/**
 * An online backup of the running stack: PostgreSQL from one exported snapshot (dump, row counts and
 * migrations read the same data), the Temporal store through SQLite's online backup, the sealed
 * provider vault and the env file. The manifest has the pilot's backup format (deploy/local/backup.mjs),
 * so the same integrity check applies. It contains learner records and secrets: keep it private.
 */
export async function backup(config, { output = config.backups, label = 'snapshot' } = {}) {
  ensure(['snapshot', 'pre-upgrade'].includes(label), 'invalid_arguments');
  const parent = await privateDirectory(output);
  const directory = path.join(parent, `${label}-${stamp()}-${randomBytes(3).toString('hex')}`);
  await privateDirectory(directory);
  const files = [];
  const record = async name => { const full = path.join(directory, name); await chmod(full, 0o600); await giveBack(full); const info = await lstat(full); files.push({ name, bytes: info.size, sha256: await digest(full) }); };
  try {
    const snapshot = await exportSnapshot(config);
    let state, server;
    try {
      const handle = await open(path.join(directory, 'database.dump'), 'wx', 0o600);
      const stream = handle.createWriteStream();
      const dumped = await compose(config, ['exec', '-T', 'db', 'pg_dump', '-U', 'course', '-d', 'course_core', '--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot.id}`], { stdout: stream });
      await new Promise(resolve => stream.once('close', resolve));
      ensure(dumped.code === 0, 'pg_dump_failed');
      await record('database.dump');
      state = await counts(config, snapshot.id);
      server = await sql(config, 'SHOW server_version');
    } finally { await snapshot.release(); }
    const states = await services(config);
    if (states.temporal?.state === 'running') {
      const copied = await compose(config, ['exec', '-T', 'temporal', 'node', '-e', NODE_TEMPORAL_COPY]);
      ensure(copied.code === 0 && copied.stdout.length > 0, 'temporal_store_copy_failed');
      await writeFile(path.join(directory, 'temporal.db'), copied.stdout, { mode: 0o600, flag: 'wx' }); await record('temporal.db');
    }
    const vault = await compose(config, [states.api?.state === 'running' ? 'exec' : 'run', ...(states.api?.state === 'running' ? [] : ['--rm', '--no-deps']), '-T', 'api', 'node', '-e', NODE_VAULT_READ]);
    ensure(vault.code === 0, 'provider_vault_copy_failed');
    const sealed = JSON.parse(vault.stdout.toString('utf8') || '{}');
    if (Object.keys(sealed).length) await privateDirectory(path.join(directory, 'provider-vault'));
    for (const [name, base64] of Object.entries(sealed)) {
      ensure(/^[A-Za-z0-9._-]{1,128}$/.test(name), 'unexpected_vault_file');
      await writeFile(path.join(directory, 'provider-vault', name), Buffer.from(base64, 'base64'), { mode: 0o600, flag: 'wx' }); await record(path.join('provider-vault', name));
    }
    await copyFile(config.envFile, path.join(directory, 'compose.env'), constants.COPYFILE_EXCL); await record('compose.env');
    const values = await env(config);
    const manifest = { schemaVersion: 1, kind: 'course-core-pilot-backup', deployment: 'docker-compose', consistency: 'online_snapshot', createdAt: new Date().toISOString(),
      coreVersion: await coreVersion(config), image: values.COURSE_CORE_IMAGE || 'course-core-selfhost:local', postgresServerVersion: server,
      migrations: state.migrations, tableCounts: state.tableCounts, files,
      contains: ['learner records', 'operator configuration and secrets', 'sealed provider credentials and vault key'] };
    await writeOwnerOnly(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyManifest(directory);
    await report(config, 'snapshot', 'succeeded', null, manifest);
    return { status: 'backup_created', directory, tables: Object.keys(state.tableCounts).length, rows: Object.values(state.tableCounts).reduce((a, b) => a + b, 0),
      files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    await report(config, 'snapshot', 'failed', error instanceof OpsError ? error.code : 'backup_operation_failed').catch(() => {});
    throw error;
  }
}
async function coreVersion(config) {
  const result = await compose(config, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'api', '-p', "require('/app/package.json').version"]);
  const version = result.stdout.toString('utf8').trim();
  return /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? version : null;
}
/** Records the run for the administration readiness page (platform_backup_reports). Best effort. */
async function report(config, kind, outcome, code, manifest) {
  const now = new Date().toISOString();
  const rows = manifest ? Object.values(manifest.tableCounts).reduce((a, b) => a + b, 0) : null;
  const value = text => (text === null || text === undefined ? 'NULL' : `'${text}'`);
  if (code !== null && !/^[a-z0-9_]{1,64}$/.test(code)) return false;
  const version = manifest?.coreVersion && /^[0-9A-Za-z.+-]{1,40}$/.test(manifest.coreVersion) ? manifest.coreVersion : null;
  const statement = `INSERT INTO platform_backup_reports(id,kind,outcome,code,started_at,finished_at,encrypted,core_version,tables,rows,bytes) VALUES (gen_random_uuid(),${value(kind)},${value(outcome)},${value(code)},'${now}','${now}',false,${value(version)},${manifest ? Object.keys(manifest.tableCounts).length : 'NULL'},${rows ?? 'NULL'},${manifest ? manifest.files.reduce((n, f) => n + f.bytes, 0) : 'NULL'})`;
  return sql(config, statement).then(() => true, () => false);
}

/** The newest intact backup in the backup directory. */
async function latestBackup(config) {
  const names = (await readdir(config.backups).catch(() => [])).filter(name => /^(?:snapshot|pre-upgrade)-\d{17}-[a-f0-9]{6}$/.test(name)).sort((a, b) => a.slice(a.indexOf('-')).localeCompare(b.slice(b.indexOf('-')))).reverse();
  for (const name of names) { try { await verifyManifest(path.join(config.backups, name)); return path.join(config.backups, name); } catch { /* next */ } }
  throw new OpsError('no_backup_found', { directory: config.backups });
}
async function readBackup(config, backupPath) {
  const directory = backupPath ? path.resolve(backupPath) : await latestBackup(config);
  const manifest = await verifyManifest(directory);
  ensure(manifest.schemaVersion === 1 && manifest.deployment === 'docker-compose', 'not_a_compose_backup');
  return { directory, manifest };
}
const pgRestore = (config, database, file) => open(file, 'r').then(async handle => {
  try { return await compose(config, ['exec', '-T', 'db', 'pg_restore', '-U', 'course', '--no-owner', '--no-privileges', '--exit-on-error', '-d', database], { input: handle.createReadStream() }); }
  finally { await handle.close().catch(() => {}); }
});

/** Restores a backup into a new disposable database next to the live one, compares row counts and
 * migrations, checks the Temporal store, then drops it. The running course is not touched. */
export async function restoreDrill(config, { backup: backupPath } = {}) {
  const started = Date.now();
  const { directory, manifest } = await readBackup(config, backupPath);
  const name = `course_core_restore_${randomBytes(6).toString('hex')}`;
  try {
    await sql(config, `CREATE DATABASE ${name}`, 'postgres');
    const restored = await pgRestore(config, name, path.join(directory, 'database.dump'));
    ensure(restored.code === 0, 'pg_restore_failed');
    const state = await counts(config, null, name);
    const differences = tableCountDifferences(manifest.tableCounts, state.tableCounts);
    ensure(!differences.length, 'restored_row_counts_differ', { tables: differences });
    ensure(JSON.stringify(state.migrations) === JSON.stringify(manifest.migrations), 'restored_migrations_differ');
    let temporal = 'absent';
    if (manifest.files.some(f => f.name === 'temporal.db')) {
      const handle = await open(path.join(directory, 'temporal.db'), 'r');
      let checked;
      try {
        checked = await compose(config, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'api', '-e',
          "const fs=require('fs');const f='/tmp/drill-temporal.db';fs.writeFileSync(f,fs.readFileSync(0));const db=new (require('node:sqlite').DatabaseSync)(f,{readOnly:true});console.log(db.prepare('PRAGMA integrity_check').get().integrity_check)"], { input: handle.createReadStream() });
      } finally { await handle.close().catch(() => {}); }
      ensure(checked.code === 0 && checked.stdout.toString('utf8').trim() === 'ok', 'temporal_store_integrity_failed');
      temporal = 'integrity_ok';
    }
    const result = { status: 'restore_verified', backup: directory, disposableDatabase: 'dropped', tables: Object.keys(state.tableCounts).length,
      rows: Object.values(state.tableCounts).reduce((a, b) => a + b, 0), migrations: state.migrations.length, temporal,
      providerVaultFiles: manifest.files.filter(f => f.name.startsWith('provider-vault/')).length, seconds: Math.round((Date.now() - started) / 1000) };
    await report(config, 'restore_drill', 'succeeded', null, manifest);
    return result;
  } catch (error) {
    await report(config, 'restore_drill', 'failed', error instanceof OpsError ? error.code : 'backup_operation_failed').catch(() => {});
    throw error;
  } finally {
    await sql(config, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, 'postgres').catch(() => {});
  }
}

/**
 * Replaces the live data with a backup: the database, the Temporal store and the provider vault.
 * The API, worker, dispatcher and Temporal are stopped first and started again afterwards.
 */
export async function restore(config, { backup: backupPath, confirmed = false, start = true } = {}) {
  ensure(confirmed, 'confirmation_required', { hint: 'restore --backup <dir> --yes replaces the live course data' });
  const { directory, manifest } = await readBackup(config, backupPath);
  await composeOk(config, ['stop', 'worker', 'dispatcher', 'api', 'temporal'], {}, 'compose_stop_failed');
  await composeOk(config, ['up', '-d', '--no-build', 'db'], {}, 'compose_up_failed');
  await waitHealthy(config, { required: ['db'], timeoutMs: 5 * 60_000 });
  await sql(config, 'DROP DATABASE IF EXISTS course_core WITH (FORCE)', 'postgres');
  await sql(config, 'CREATE DATABASE course_core OWNER course', 'postgres');
  const restored = await pgRestore(config, 'course_core', path.join(directory, 'database.dump'));
  ensure(restored.code === 0, 'pg_restore_failed');
  const state = await counts(config, null);
  ensure(!tableCountDifferences(manifest.tableCounts, state.tableCounts).length, 'restored_row_counts_differ');
  if (manifest.files.some(f => f.name === 'temporal.db')) {
    const handle = await open(path.join(directory, 'temporal.db'), 'r');
    try {
      const copied = await compose(config, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'temporal', '-c', 'rm -f /data/temporal.db-wal /data/temporal.db-shm && cat > /data/temporal.db'], { input: handle.createReadStream() });
      ensure(copied.code === 0, 'temporal_store_restore_failed');
    } finally { await handle.close().catch(() => {}); }
  }
  const vault = {};
  for (const file of manifest.files.filter(f => f.name.startsWith('provider-vault/'))) vault[file.name.slice('provider-vault/'.length)] = (await readFile(path.join(directory, file.name))).toString('base64');
  if (Object.keys(vault).length) {
    const written = await compose(config, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'api', '-e',
      "const fs=require('fs'),d='/data/provider-vault';const o=JSON.parse(fs.readFileSync(0,'utf8'));fs.mkdirSync(d,{recursive:true,mode:0o700});fs.chmodSync(d,0o700);for(const[n,b]of Object.entries(o)){if(!/^[A-Za-z0-9._-]{1,128}$/.test(n))process.exit(3);const t=d+'/.'+n+'.restore';fs.writeFileSync(t,Buffer.from(b,'base64'),{mode:0o600});fs.renameSync(t,d+'/'+n)}"], { input: JSON.stringify(vault) });
    ensure(written.code === 0, 'provider_vault_restore_failed');
  }
  if (start) {
    await composeOk(config, ['up', '-d', '--no-build'], {}, 'compose_up_failed');
    await waitHealthy(config);
  }
  return { status: 'restored', backup: directory, tables: Object.keys(state.tableCounts).length, rows: Object.values(state.tableCounts).reduce((a, b) => a + b, 0) };
}

// ------------------------------------------------------------------------- upgrade

const git = (args, options = {}) => new Promise(resolve => {
  const child = spawn('git', ['-C', ROOT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  child.once('error', () => resolve({ code: -1, stdout: '' }));
  child.once('close', code => resolve({ code, stdout: out.trim() }));
});
const imageExists = image => new Promise(resolve => {
  const child = spawn('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { stdio: 'ignore' });
  child.once('error', () => resolve(false)); child.once('close', code => resolve(code === 0));
});

/**
 * Upgrades to a release: a registry image tag (when COURSE_CORE_IMAGE names a registry image), or a
 * release tag of this clone, checked out and built. Before switching it stops the writers and takes
 * a backup. If the new release does not become healthy within the timeout, it restores that backup,
 * returns to the previous image (and commit) and starts it again: `rolled_back`.
 */
export async function upgrade(config, { tag, image: explicitImage, timeoutMs = 15 * 60_000 } = {}) {
  ensure(Boolean(tag) !== Boolean(explicitImage), 'invalid_arguments', { usage: 'upgrade <release-tag> | upgrade --image <image>' });
  ensure(!tag || /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag), 'invalid_release_tag');
  const values = await env(config);
  const previousImage = values.COURSE_CORE_IMAGE || 'course-core-selfhost:local';
  let target = explicitImage, checkout = null;
  if (tag && isRegistryImage(previousImage)) target = `${previousImage.replace(/:[^:/]+$/, '')}:${tag}`;
  else if (tag) {
    ensure((await git(['rev-parse', '--is-inside-work-tree'])).stdout === 'true', 'not_a_git_clone');
    ensure((await git(['status', '--porcelain', '--untracked-files=no'])).stdout === '', 'local_changes_present', { hint: 'commit or stash local edits; keep local settings in .env or compose.override.yaml' });
    await git(['fetch', '--tags', '--quiet', 'origin']);
    const commit = await git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
    ensure(commit.code === 0, 'release_tag_not_found', { tag });
    checkout = { previous: (await git(['rev-parse', 'HEAD'])).stdout, next: commit.stdout };
    target = `course-core-selfhost:${tag}`;
  }
  ensure(target !== previousImage || explicitImage, 'already_on_release');
  ensure(healthy(await services(config)), 'stack_not_healthy_before_upgrade', { hint: 'run status; an upgrade starts from a healthy stack' });
  ensure(await imageExists(previousImage), 'previous_image_missing');
  // Nothing writes while the pre-upgrade backup is taken, so rolling back loses nothing.
  await composeOk(config, ['stop', 'worker', 'dispatcher', 'api'], {}, 'compose_stop_failed');
  let saved;
  try { saved = await backup(config, { label: 'pre-upgrade' }); }
  catch (error) { await composeOk(config, ['up', '-d', '--no-build'], {}, 'compose_up_failed'); throw error; }
  const setImage = async image => writeOwnerOnly(config.envFile, updateEnv(await readFile(config.envFile, 'utf8'), { COURSE_CORE_IMAGE: image }));
  try {
    if (checkout) ensure((await git(['checkout', '--quiet', '--detach', checkout.next])).code === 0, 'checkout_failed');
    await setImage(target);
    const started = await compose(config, ['up', '-d', '--remove-orphans', ...(checkout ? ['--build'] : isRegistryImage(target) ? ['--pull', 'missing'] : ['--no-build'])], { inherit: true });
    ensure(started.code === 0, 'compose_up_failed');
    await waitHealthy(config, { timeoutMs });
    return { status: 'upgraded', from: previousImage, to: target, backup: saved.directory };
  } catch (error) {
    const reason = error instanceof OpsError ? error.code : 'upgrade_failed';
    if (checkout) await git(['checkout', '--quiet', '--detach', checkout.previous]);
    await setImage(previousImage);
    await restore(config, { backup: saved.directory, confirmed: true, start: false });
    await composeOk(config, ['up', '-d', '--no-build', '--remove-orphans'], {}, 'rollback_start_failed');
    await waitHealthy(config, { timeoutMs });
    throw new OpsError('upgrade_rolled_back', { reason, ...(error?.details ? { failure: error.details } : {}), restoredFrom: saved.directory, running: previousImage });
  }
}

export async function down(config) {
  await composeOk(config, ['down'], { inherit: true }, 'compose_down_failed');
  return { status: 'stopped' };
}

// ------------------------------------------------------------------------- command line

export const USAGE = `Usage: deploy/docker/core.sh <command>
  up                         create .env with generated secrets if missing, then build or pull and start
  bootstrap <slug> <login> "<Name>"   create the owner (the password is typed, never echoed)
  set-password <slug> <subject> [--login <username>] [--temporary]
  status                     service health and the running version
  logs [service...] [-f]     recent logs (all services by default)
  backup                     online backup into deploy/docker/backups
  restore-drill [--backup <dir>]   restore the newest (or given) backup into a scratch database and verify it
  restore --backup <dir> --yes     replace the live data with a backup
  upgrade <release-tag> | --image <image>   back up, switch, and roll back automatically on failure
  ca-cert [<file>]           write the proxy's root certificate (for https://localhost)
  down                       stop and remove the containers (volumes are kept)
Options: --env-file <file> (default deploy/docker/.env), --project <name>, --timeout-seconds <n>`;

export function parse(argv) {
  const options = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--env-file', '--project', '--backup', '--image', '--timeout-seconds', '--output'].includes(arg)) { ensure(argv[i + 1] !== undefined, 'invalid_arguments'); options[arg.slice(2)] = argv[++i]; }
    else if (arg === '--yes') options.yes = true;
    else positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { command, args, options } = parse(process.argv.slice(2));
  const config = settings({ envFile: options['env-file'], project: options.project, backups: options.output });
  const timeoutMs = options['timeout-seconds'] ? Number(options['timeout-seconds']) * 1000 : undefined;
  const run = {
    init: () => init(config), up: () => up(config, { timeoutMs }), bootstrap: () => bootstrap(config, args), 'set-password': () => setPassword(config, args),
    status: () => status(config), logs: () => logs(config, process.argv.slice(3)), backup: () => backup(config),
    'restore-drill': () => restoreDrill(config, { backup: options.backup }), restore: () => restore(config, { backup: options.backup, confirmed: options.yes }),
    upgrade: () => upgrade(config, { tag: args[0], image: options.image, ...(timeoutMs ? { timeoutMs } : {}) }), 'ca-cert': () => caCert(config, args), down: () => down(config),
  }[command];
  if (!run) { process.stderr.write(`${USAGE}\n`); process.exit(2); }
  run().then(result => { if (result) process.stdout.write(`${JSON.stringify(result)}\n`); }, error => {
    process.stderr.write(`${JSON.stringify({ status: 'blocked', code: error instanceof OpsError || (typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code)) ? error.code : 'operation_failed', ...(error?.details ? error.details : {}) })}\n`);
    process.exitCode = 1;
  });
}
