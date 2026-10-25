import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/migrations.js';

/**
 * Disposable PostgreSQL databases for the API integration tests.
 *
 * Applying every migration is one large transaction (thousands of relation locks)
 * under a database-wide advisory lock. Doing that once per test file queued the
 * files behind each other, and running it (or DROP SCHEMA ... CASCADE) for many
 * files at once exhausts the server's shared lock table. Instead, the global setup
 * applies the production `migrate()` once to a per-run template database, and each
 * test file gets its own copy made with `CREATE DATABASE ... TEMPLATE`, which takes
 * no per-object locks. A copy is dropped as a whole database, which takes none
 * either. The global setup keeps a few copies ready ahead of demand, created one at
 * a time, so a file usually only has to claim one (an atomic rename).
 *
 * A file never drops its own copy. DROP DATABASE requests an immediate checkpoint of
 * the whole server and waits for it, so it costs as much as flushing every dirty
 * page of every database there, including the other files running at the same time.
 * Waiting for that in each file's afterAll took seconds per file on a loaded machine
 * and was where the API suite's hook timeouts came from. A finished file renames its
 * copy to a retired name instead (no checkpoint), and the global setup drops retired
 * copies in the background, up to 16 at once so that one checkpoint serves them all.
 *
 * Every database here is named `<base>__<run>_<kind>` and carries `cloneComment`;
 * cleanup never touches a database without both.
 */

export const migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));
/** Schema migrated in the template; each copy renames it to the test's schema. */
export const templateSchema = 'course_template';
/** Marks databases this harness created, so only those are ever cleaned up. */
export const cloneComment = 'course-core disposable API test database';
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const maxBaseLength = 40;
/** Databases dropped together (one connection each), so they share a checkpoint. */
const dropBatch = 16;

export interface TemplateRun {
  /** `<base>__<run>`: every database of this run starts with it. */
  prefix: string;
  /** Migrated template, which accepts no connections. */
  template: string;
  /** Copies waiting to be claimed are named `<ready><hex>`. */
  ready: string;
  /** Copies their files are done with, waiting for the background drop, are named `<retired><hex>`. */
  retired: string;
}

/** Validates TEST_DATABASE_URL as a disposable loopback test database. */
export function baseDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): URL {
  if (!environment.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required: these tests exercise real PostgreSQL; no mock fallback.');
  if (environment.DATABASE_URL) throw new Error('Unset application DATABASE_URL; API tests use only TEST_DATABASE_URL.');
  let url: URL;
  try { url = new URL(environment.TEST_DATABASE_URL); } catch { throw new Error('TEST_DATABASE_URL is not a valid database URL (value redacted).'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/(?:course_core_ci|course_core_test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw new Error('Use a disposable loopback TEST_DATABASE_URL (course_core_ci or course_core_test[_suffix]) without overrides.');
  if (url.pathname.length - 1 > maxBaseLength) throw new Error(`The TEST_DATABASE_URL database name must be at most ${maxBaseLength} characters so per-file copies fit PostgreSQL identifiers.`);
  return url;
}

export function databaseUrl(base: URL, database: string, schema?: string): string {
  const url = new URL(base.href);
  url.pathname = `/${database}`;
  if (schema) url.searchParams.set('options', `-csearch_path=${schema}`);
  return url.href;
}

/** One short-lived administrative connection to the base test database. */
export async function withBase<T>(base: URL, body: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try { return await body(client); } finally { await client.end(); }
}

function quoted(name: string): string {
  if (!identifier.test(name)) throw new Error(`Unexpected database identifier: ${name}`);
  return `"${name}"`;
}

const suffix = () => randomBytes(3).toString('hex');

/** Copies `template`, or the pristine template0, which never accepts connections, so a copy cannot race a client. */
export async function createDatabase(client: pg.Client, name: string, template = 'template0'): Promise<void> {
  await client.query(`CREATE DATABASE ${quoted(name)} TEMPLATE ${quoted(template)}`);
  await client.query(`COMMENT ON DATABASE ${quoted(name)} IS '${cloneComment}'`);
}

/** Drops a database, terminating its remaining sessions; only for databases no test is using any more. */
export async function dropDatabase(client: pg.Client, name: string): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`);
}

/** Sessions still connected to `name`, described for a leak report. */
async function sessionsOn(client: pg.Client, name: string): Promise<string[]> {
  const { rows } = await client.query<{ application_name: string; state: string | null; query: string; seconds: number }>(
    `SELECT application_name, state, left(query, 80) AS query, floor(extract(epoch FROM clock_timestamp() - backend_start))::int AS seconds
       FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend' AND pid <> pg_backend_pid() ORDER BY backend_start`, [name]);
  return rows.map(row => `${row.state ?? 'unknown'} for ${row.seconds}s${row.application_name ? ` (${row.application_name})` : ''}${row.query ? `, last query: ${row.query}` : ''}`);
}

function leaked(open: string[]): Error {
  return new Error(`The test file left ${open.length || 'some'} connection(s) to its database open: ${open.join('; ') || 'already closing'}. `
    + 'Close every server (app.close()), pool (db.end()) and client the file opens in its afterAll.');
}

/**
 * Retires a file's database once its sessions are gone: renames it for the background
 * drop, which takes no checkpoint (see the module comment). Sessions that are still
 * closing (a pool's `end()` resolves before its sockets close) go within milliseconds;
 * this waits up to `closingMs` for them. PostgreSQL would wait too, but about ten seconds
 * before refusing, longer than a hook may take. A session open after that is a leak: a
 * pool, client or server the file never closed. The database is then left to the run's
 * teardown, which runs after the test workers exit (terminating the session here would
 * surface as an uncaught connection error in the test file), and this rejects with the
 * open sessions, so the file that leaked them fails. A database that no longer has this
 * name (already retired) is left alone.
 */
export async function retireWhenClosed(client: pg.Client, run: TemplateRun, name: string, closingMs = 5_000): Promise<void> {
  const deadline = Date.now() + closingMs;
  let open = await sessionsOn(client, name);
  while (open.length && Date.now() < deadline) {
    await delay(50);
    open = await sessionsOn(client, name);
  }
  if (open.length) throw leaked(open);
  try {
    await client.query(`ALTER DATABASE ${quoted(name)} RENAME TO ${quoted(run.retired + suffix())}`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '3D000') return;
    if (code === '55006') throw leaked(await sessionsOn(client, name));
    throw error;
  }
}

/**
 * Drops up to `batch` retired copies at once, each on its own connection: drops that run
 * together wait for the same checkpoint instead of one each. Returns how many it dropped.
 */
export async function dropRetired(client: pg.Client, base: URL, run: TemplateRun, batch = dropBatch): Promise<number> {
  const names = (await databasesStartingWith(client, run.retired)).slice(0, batch);
  await Promise.all(names.map(name => withBase(base, other => dropDatabase(other, name))));
  return names.length;
}

async function databasesStartingWith(client: pg.Client, prefix: string): Promise<string[]> {
  const { rows } = await client.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE left(datname, $2) = $1 AND shobj_description(oid, 'pg_database') = $3 ORDER BY datname`,
    [prefix, prefix.length, cloneComment]);
  return rows.map(row => row.datname);
}

/** Run identifiers start with the base-36 creation time, so stale leftovers can be recognised. */
export function newRun(base: URL, now = Date.now()): TemplateRun {
  const run = now.toString(36).padStart(9, '0') + randomBytes(2).toString('hex');
  const prefix = `${base.pathname.slice(1)}__${run}`;
  return { prefix, template: `${prefix}_tpl`, ready: `${prefix}_r`, retired: `${prefix}_x` };
}

/** Drops this harness's databases left behind by crashed runs older than `maxAgeMs`. */
export async function dropStale(client: pg.Client, base: URL, maxAgeMs: number, now = Date.now()): Promise<string[]> {
  const name = base.pathname.slice(1);
  const dropped: string[] = [];
  for (const datname of await databasesStartingWith(client, `${name}__`)) {
    const match = /^([a-z0-9]{9})[0-9a-f]{4}_[a-z0-9]+$/.exec(datname.slice(name.length + 2));
    const created = match ? parseInt(match[1]!, 36) : NaN;
    if (!Number.isFinite(created) || now - created < maxAgeMs) continue;
    await dropDatabase(client, datname);
    dropped.push(datname);
  }
  return dropped;
}

/**
 * Drops every database of one run, including copies of files that crashed, timed out or
 * leaked connections, `batch` at a time so that each group shares one checkpoint.
 */
export async function dropRun(base: URL, run: TemplateRun, batch = dropBatch): Promise<string[]> {
  const names = await withBase(base, client => databasesStartingWith(client, `${run.prefix}_`));
  for (let start = 0; start < names.length; start += batch)
    await Promise.all(names.slice(start, start + batch).map(name => withBase(base, client => dropDatabase(client, name))));
  return names;
}

/** Creates and migrates the run's template with the production `migrate()`. */
export async function prepareTemplate(base: URL, run: TemplateRun): Promise<string[]> {
  await withBase(base, client => createDatabase(client, run.template));
  const pool = new pg.Pool({ connectionString: databaseUrl(base, run.template), max: 1 });
  let applied: string[];
  try {
    await pool.query(`CREATE SCHEMA ${templateSchema}`);
    const migrator = new pg.Pool({ connectionString: databaseUrl(base, run.template, templateSchema), max: 1 });
    try { applied = await migrate(migrator, migrationsDirectory); } finally { await migrator.end(); }
  } finally { await pool.end(); }
  // A template with connections cannot be copied; forbid them so a stray client cannot break a copy.
  await withBase(base, client => client.query(`ALTER DATABASE ${quoted(run.template)} WITH ALLOW_CONNECTIONS false`));
  return applied;
}

/** Number of copies waiting to be claimed. */
export async function readyCount(client: pg.Client, run: TemplateRun): Promise<number> {
  return (await databasesStartingWith(client, run.ready)).length;
}

/**
 * Adds one ready copy. It is built under a name claimants ignore and published by an
 * atomic rename, so a claimant never sees a half-made copy.
 */
export async function addReadyCopy(client: pg.Client, run: TemplateRun): Promise<string> {
  const id = suffix(), building = `${run.prefix}_n${id}`, ready = `${run.ready}${id}`;
  await createDatabase(client, building, run.template);
  await client.query(`ALTER DATABASE ${quoted(building)} RENAME TO ${quoted(ready)}`);
  return ready;
}

/**
 * Takes a ready copy for one test file, or makes one if none is waiting. Renaming is
 * the claim: PostgreSQL lets exactly one session rename a database, so two files can
 * never receive the same copy.
 */
export async function claimCopy(client: pg.Client, run: TemplateRun): Promise<{ name: string; prepared: boolean }> {
  const name = `${run.prefix}_f${suffix()}`;
  for (const ready of await databasesStartingWith(client, run.ready)) {
    try {
      await client.query(`ALTER DATABASE ${quoted(ready)} RENAME TO ${quoted(name)}`);
      return { name, prepared: true };
    } catch (error) {
      // Another file claimed it first (it no longer exists under that name).
      if ((error as { code?: string }).code === '3D000') continue;
      throw error;
    }
  }
  await createDatabase(client, name, run.template);
  return { name, prepared: false };
}

/** Name for a database a file creates empty, to exercise `migrate()` from scratch. */
export function emptyName(run: TemplateRun): string {
  return `${run.prefix}_e${suffix()}`;
}
