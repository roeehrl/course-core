import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MODULES, ROOT, ensure, requireNode26, testDatabaseUrl } from './modules.mjs';
import { isMain } from './is-main.mjs';

// Release compatibility matrix and migration/rollback rehearsal.
//
// `matrix` describes what a Core source tree supports: the SDK release it pins and
// which compiled course packages it installs, Node and PostgreSQL versions, and its
// migration set. `check` compares a candidate with the previous release. `rehearse`
// applies the previous release's migrations to a disposable PostgreSQL schema with
// synthetic data, backs it up, migrates forward to the candidate, then rolls back by
// restoring the backup and verifies the previous schema and data exactly.

const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const MIGRATION = /^\d{3}_[a-z0-9_]+\.sql$/;
const MIGRATIONS = 'services/api/migrations';
const SDK_URL = /\/course-sdk\/releases\/download\/v(\d+\.\d+\.\d+)\/course-core-sdk-\1\.tgz$/;

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version ?? '');
  ensure(match, `Not a semantic version: ${version}`);
  return match.slice(1, 4).map(Number);
}
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
/** Same rule as supportedSdkRange in services/api/src/course-package-routes.ts:
 * Core accepts packages from the SDK minor it pins (0.x minors are breaking). */
export function supportedSdkRange(version) {
  const [major, minor] = parseVersion(version);
  return { min: `${major}.${minor}.0`, maxExclusive: major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0` };
}
/** How the package preview treats a course package compiled by `packageSdk`:
 * supported, installable with a warning (same major), or refused. */
export function packageAcceptance(coreSdk, packageSdk) {
  const range = supportedSdkRange(coreSdk);
  if (compareVersions(packageSdk, range.min) >= 0 && compareVersions(packageSdk, range.maxExclusive) < 0) return 'supported';
  return parseVersion(packageSdk)[0] === parseVersion(coreSdk)[0] ? 'install_with_warning' : 'refused';
}
/** `>=26 <27` style ranges: lower bound major and optional exclusive upper major. */
export function nodeRange(range) {
  const lower = /(?:^|\s)>=\s*(\d+)/.exec(range ?? ''), upper = /(?:^|\s)<\s*(\d+)/.exec(range ?? '');
  ensure(lower, `Node engine range needs a >= lower bound: ${range}`);
  return { min: Number(lower[1]), ...(upper ? { maxExclusive: Number(upper[1]) } : {}) };
}

/** A source tree read either from a Git revision or from a directory. */
export function gitSource(root, revision) {
  const git = (args, options = {}) => exec('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  return {
    label: revision,
    read: async file => (await git(['show', `${revision}:${file}`])).stdout,
    list: async directory => (await git(['ls-tree', '--name-only', `${revision}:${directory}`])).stdout.split('\n').filter(Boolean),
  };
}
export function directorySource(root) {
  return { label: root, read: file => readFile(path.join(root, file), 'utf8'), list: directory => readdir(path.join(root, directory)) };
}

/** name → sha256 of the exact text the migration runner hashes. */
export async function migrationSet(source) {
  const names = (await source.list(MIGRATIONS)).filter(name => MIGRATION.test(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, sha(await source.read(`${MIGRATIONS}/${name}`))])));
}

/** The machine-checked compatibility matrix of one source tree. */
export async function compatibilityMatrix(source) {
  const json = async file => JSON.parse(await source.read(file));
  const root = await json('package.json'), node = nodeRange(root.engines?.node);
  const sdkPins = new Set(), moduleEngines = {};
  // An older release may predate a module; modules absent from its tree are skipped.
  for (const [name, module] of Object.entries(MODULES)) {
    if (!(await source.list(module.directory).catch(() => [])).includes('package.json')) continue;
    const manifest = await json(`${module.directory}/package.json`);
    const pin = manifest.dependencies?.['@course-core/sdk'];
    if (pin !== undefined) {
      const match = SDK_URL.exec(pin);
      ensure(match, `${module.directory} must pin a released SDK archive`);
      sdkPins.add(match[1]);
    }
    if (manifest.engines?.node) {
      const range = nodeRange(manifest.engines.node);
      ensure(range.min <= node.min && (range.maxExclusive === undefined || range.maxExclusive > node.min), `${name} does not run on the supported Node ${node.min}`);
      moduleEngines[name] = manifest.engines.node;
    }
  }
  ensure(sdkPins.size === 1, `Every module must pin the same SDK release (found ${[...sdkPins].join(', ') || 'none'})`);
  const [sdk] = sdkPins;
  const workflows = (await source.list('.github/workflows')).filter(name => /\.ya?ml$/.test(name)).sort();
  const postgres = new Set();
  for (const name of workflows) for (const [, major] of (await source.read(`.github/workflows/${name}`)).matchAll(/image: postgres:(\d+)/g)) postgres.add(Number(major));
  ensure(postgres.size === 1, `CI must test exactly one PostgreSQL major (found ${[...postgres].join(', ') || 'none'})`);
  const migrations = await migrationSet(source), names = Object.keys(migrations);
  ensure(names.length > 0, 'No migrations found');
  return {
    schemaVersion: 1,
    core: root.version,
    sdk: {
      release: sdk,
      coursePackages: { supported: supportedSdkRange(sdk), sameMajorOutsideRange: 'install_with_warning', otherMajor: 'refused' },
    },
    node: { engines: root.engines.node, testedMajor: node.min, modules: moduleEngines },
    postgres: { major: [...postgres][0] },
    migrations: { count: names.length, last: names.at(-1), sha256: sha(names.map(name => `${name} ${migrations[name]}\n`).join('')) },
  };
}

/** Candidate against the previous release. Returns findings; any finding fails the release. */
export function compareReleases(previous, candidate, previousMigrations, candidateMigrations) {
  const findings = [];
  if (compareVersions(candidate.core, previous.core) <= 0) findings.push(`Core ${candidate.core} is not newer than the previous release ${previous.core}`);
  if (packageAcceptance(candidate.sdk.release, previous.sdk.release) === 'refused')
    findings.push(`Course packages compiled with the previous SDK ${previous.sdk.release} would be refused by SDK ${candidate.sdk.release}`);
  if (compareVersions(candidate.sdk.release, previous.sdk.release) < 0) findings.push(`SDK pin moved backwards from ${previous.sdk.release} to ${candidate.sdk.release}`);
  if (candidate.postgres.major < previous.postgres.major) findings.push(`PostgreSQL ${candidate.postgres.major} is older than the previous release's ${previous.postgres.major}`);
  for (const [name, digest] of Object.entries(previousMigrations)) {
    if (!Object.hasOwn(candidateMigrations, name)) findings.push(`Migration ${name} was removed`);
    else if (candidateMigrations[name] !== digest) findings.push(`Migration ${name} was edited after release`);
  }
  const added = Object.keys(candidateMigrations).filter(name => !Object.hasOwn(previousMigrations, name)).sort();
  return {
    findings,
    previous: { core: previous.core, sdk: previous.sdk.release, postgres: previous.postgres.major, node: previous.node.engines },
    coursePackagesFromPreviousSdk: packageAcceptance(candidate.sdk.release, previous.sdk.release),
    addedMigrations: added,
  };
}

/**
 * The newest vX.Y.Z tag strictly older than `version` that was actually published. A tag whose
 * release workflow failed is never published or re-tagged (a dead tag), so the git tag list
 * alone is not the release history: only tags in `published` count.
 */
export function previousReleaseTag(tags, version, published) {
  ensure(published instanceof Set, 'The published releases are required to pick the previous release');
  const older = tags.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag) && published.has(tag) && compareVersions(tag.slice(1), version) < 0);
  ensure(older.length, `No published release older than ${version}`);
  return older.sort((a, b) => compareVersions(a.slice(1), b.slice(1))).at(-1);
}

/**
 * Tags of published GitHub releases (not drafts or pre-releases). COURSE_PUBLISHED_RELEASES
 * (tags separated by commas or whitespace) wins; otherwise the GitHub CLI lists the repository's
 * releases (GH_TOKEN, and GH_REPO outside a clone). Fails rather than guessing from git tags.
 */
export async function publishedReleaseTags(root, environment = process.env) {
  const listed = environment.COURSE_PUBLISHED_RELEASES;
  if (listed !== undefined) return new Set(listed.split(/[\s,]+/).filter(Boolean));
  let stdout;
  try {
    ({ stdout } = await exec('gh', ['release', 'list', '--limit', '1000', '--exclude-drafts', '--exclude-pre-releases', '--json', 'tagName', '--jq', '.[].tagName'],
      { cwd: root, env: environment, maxBuffer: 1 << 20 }));
  } catch {
    throw new Error('Cannot list the published releases. Set COURSE_PUBLISHED_RELEASES, sign in to the GitHub CLI, or pass --previous <tag>.');
  }
  return new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
}

async function resolveSources(root, options) {
  const candidate = options.candidate ? gitSource(root, options.candidate) : directorySource(root);
  const version = JSON.parse(await candidate.read('package.json')).version;
  const tag = options.previous ?? previousReleaseTag((await exec('git', ['-C', root, 'tag', '--list', 'v*'])).stdout.split('\n').filter(Boolean), version,
    options.published ?? await publishedReleaseTags(root));
  return { candidate, previous: gitSource(root, `refs/tags/${tag}`), tag };
}

export async function checkCompatibility(root, options = {}) {
  const { candidate, previous, tag } = await resolveSources(root, options);
  const [matrix, before] = await Promise.all([compatibilityMatrix(candidate), compatibilityMatrix(previous)]);
  const comparison = compareReleases(before, matrix, await migrationSet(previous), await migrationSet(candidate));
  ensure(comparison.findings.length === 0, `Release compatibility check failed against ${tag}:\n  ${comparison.findings.join('\n  ')}`);
  return { matrix, previousTag: tag, ...comparison };
}

// ---------------------------------------------------------------------------
// Migration and rollback rehearsal on a disposable PostgreSQL schema.

/** The synthetic data seeded after the previous release's migrations. Only columns
 * of the first migration are used, so it applies to every released schema. */
export const REHEARSAL_SEED = `
INSERT INTO app_users (id, subject, display_name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'rehearsal-owner', 'Rehearsal owner'),
  ('00000000-0000-4000-8000-000000000002', 'rehearsal-learner', 'Rehearsal learner');
INSERT INTO workspaces (id, slug, title) VALUES ('00000000-0000-4000-8000-000000000010', 'rehearsal', 'Rehearsal workspace');
INSERT INTO memberships (workspace_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'owner'),
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000002', 'learner');
INSERT INTO course_releases (id, workspace_id, course_key, version, digest, server_bundle, learner_bundle, status, created_by) VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000010', 'rehearsal-course', '1.0.0', repeat('a', 64), '{}', '{}', 'published', '00000000-0000-4000-8000-000000000001');
INSERT INTO enrollments (id, workspace_id, course_release_id, user_id, policy) VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000002', '{}');
`;
const SEEDED = { app_users: 2, workspaces: 1, memberships: 2, course_releases: 1, enrollments: 1 };

/** Previous tables and columns must survive the forward migration with their rows:
 * released migrations are additive (new tables, nullable or defaulted columns). */
export function forwardDifferences(before, after) {
  const problems = [];
  for (const [table, columns] of Object.entries(before.columns)) {
    if (!after.columns[table]) { problems.push(`table ${table} was dropped`); continue; }
    for (const column of columns) if (!after.columns[table].includes(column)) problems.push(`column ${table}.${column} was dropped`);
    if (table !== 'schema_migrations' && after.counts[table] !== before.counts[table]) problems.push(`table ${table} has ${after.counts[table]} rows, expected ${before.counts[table]}`);
  }
  return problems;
}
/** After rollback the schema and every row must equal the pre-upgrade snapshot. */
export function rollbackDifferences(before, after) {
  const problems = [];
  for (const table of new Set([...Object.keys(before.columns), ...Object.keys(after.columns)])) {
    if (JSON.stringify(before.columns[table]) !== JSON.stringify(after.columns[table])) problems.push(`table ${table} columns differ`);
    else if (before.digests[table] !== after.digests[table]) problems.push(`table ${table} rows differ`);
  }
  return problems;
}

function database(url, pgBin) {
  const target = new URL(url), password = decodeURIComponent(target.password);
  target.password = '';
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...(password ? { PGPASSWORD: password } : {}) };
  const bin = name => pgBin ? path.join(pgBin, name) : name;
  const run = async (name, args, schema) => {
    try {
      return (await exec(bin(name), args, { env: { ...env, ...(schema ? { PGOPTIONS: `-c search_path=${schema}` } : {}) }, maxBuffer: 64 * 1024 * 1024 })).stdout;
    } catch (error) {
      // Report the tool and the database message only; never the connection string.
      throw new Error(`${name} failed: ${(error.stderr ?? '').trim().split('\n').slice(-3).join(' ') || error.code}`);
    }
  };
  return {
    sql: (text, schema) => run('psql', [target.href, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', text], schema),
    file: (file, schema) => run('psql', [target.href, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', file], schema),
    dump: (schema, file) => run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--schema', schema, '--file', file, target.href]),
    restore: file => run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', target.href, file]),
  };
}

/** Applies a source's migrations the way services/api/src/migrations.ts does: in
 * name order, skipping recorded names and refusing a recorded name whose text changed. */
async function applyMigrations(db, schema, source, scratch) {
  await db.sql('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())', schema);
  const recorded = Object.fromEntries((await db.sql('SELECT name, digest FROM schema_migrations', schema)).trim().split('\n').filter(Boolean).map(line => line.split('\t')));
  const applied = [];
  for (const name of (await source.list(MIGRATIONS)).filter(name => MIGRATION.test(name)).sort()) {
    const text = await source.read(`${MIGRATIONS}/${name}`), digest = sha(text);
    if (recorded[name]) { ensure(recorded[name] === digest, `Applied migration changed: ${name}`); continue; }
    const file = path.join(scratch, `migration-${name}`);
    await writeFile(file, `${text}\n;INSERT INTO schema_migrations (name, digest) VALUES ('${name}', '${digest}');\n`, { mode: 0o600 });
    await db.file(file, schema).catch(error => { throw new Error(`Migration ${name} failed: ${error.message}`); });
    applied.push(name);
  }
  return applied;
}
async function snapshot(db, schema) {
  const rows = (await db.sql(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='${schema}' ORDER BY table_name, ordinal_position`)).trim().split('\n').filter(Boolean);
  const columns = {};
  for (const line of rows) { const [table, column] = line.split('\t'); (columns[table] ??= []).push(column); }
  for (const list of Object.values(columns)) list.sort();
  const counts = {}, digests = {};
  for (const table of Object.keys(columns)) {
    ensure(/^[a-z_][a-z0-9_]{0,62}$/.test(table), 'unexpected table name');
    // Rows as text in a stable order; applied_at differs between runs but not across a restore.
    const [count, digest] = (await db.sql(`SELECT count(*), coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), '') FROM "${schema}"."${table}" t`)).trim().split('\t');
    counts[table] = Number(count); digests[table] = digest;
  }
  return { columns, counts, digests };
}

/** Real rehearsal against a disposable database (TEST_DATABASE_URL). Uses only its own schema. */
export async function rehearse(root, options = {}) {
  const url = testDatabaseUrl(), { candidate, previous, tag } = await resolveSources(root, options);
  const db = database(url.href, options.pgBin), schema = `release_rehearsal_${randomBytes(6).toString('hex')}`;
  const scratch = await mkdtemp(path.join(tmpdir(), 'release-rehearsal-'));
  const steps = [];
  try {
    await db.sql(`CREATE SCHEMA ${schema}`);
    const previousApplied = await applyMigrations(db, schema, previous, scratch); steps.push('previous_migrated');
    await writeFile(path.join(scratch, 'seed.sql'), REHEARSAL_SEED, { mode: 0o600 });
    await db.file(path.join(scratch, 'seed.sql'), schema); steps.push('seeded');
    const before = await snapshot(db, schema);
    for (const [table, count] of Object.entries(SEEDED)) ensure(before.counts[table] === count, `Seed did not land in ${table}`);
    const backup = path.join(scratch, 'previous.dump');
    await db.dump(schema, backup); steps.push('backed_up');
    const forward = await applyMigrations(db, schema, candidate, scratch); steps.push('candidate_migrated');
    const upgraded = await snapshot(db, schema), forwardProblems = forwardDifferences(before, upgraded);
    ensure(forwardProblems.length === 0, `Forward migration lost data or schema:\n  ${forwardProblems.join('\n  ')}`);
    ensure(upgraded.counts.schema_migrations === Object.keys(await migrationSet(candidate)).length, 'Not every candidate migration is recorded');
    ensure((await applyMigrations(db, schema, candidate, scratch)).length === 0, 'Re-running candidate migrations was not a no-op'); steps.push('candidate_idempotent');
    // Roll back: the previous runtime restores the pre-upgrade backup.
    await db.sql(`DROP SCHEMA ${schema} CASCADE`);
    await db.restore(backup); steps.push('rolled_back');
    const restored = await snapshot(db, schema), rollbackProblems = rollbackDifferences(before, restored);
    ensure(rollbackProblems.length === 0, `Rollback did not restore the previous release exactly:\n  ${rollbackProblems.join('\n  ')}`);
    ensure((await applyMigrations(db, schema, previous, scratch)).length === 0, 'The restored database is not at the previous release'); steps.push('previous_verified');
    // After a rollback the same upgrade must still succeed.
    const again = await applyMigrations(db, schema, candidate, scratch);
    ensure(JSON.stringify(again) === JSON.stringify(forward), 'Upgrade after rollback applied a different migration set'); steps.push('upgraded_again');
    return { status: 'passed', previousTag: tag, candidate: candidate.label, previousMigrations: previousApplied.length, addedMigrations: forward,
      tables: Object.keys(upgraded.columns).length, seededRows: Object.values(SEEDED).reduce((a, b) => a + b, 0), steps };
  } finally {
    await db.sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function compatMain(args = process.argv.slice(2), root = ROOT) {
  requireNode26();
  const [action, ...rest] = args, options = {};
  ensure(['matrix', 'check', 'rehearse'].includes(action), 'Use: matrix | check | rehearse [--previous <tag>] [--candidate <git revision>] [--pg-bin <dir>]');
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--previous': 'previous', '--candidate': 'candidate', '--pg-bin': 'pgBin' }[rest[i]];
    ensure(key && rest[i + 1] && !Object.hasOwn(options, key), 'Invalid or duplicate argument');
    options[key] = rest[i + 1];
  }
  if (options.previous) ensure(/^v\d+\.\d+\.\d+$/.test(options.previous), 'Previous release must be a vX.Y.Z tag');
  if (options.candidate) ensure(/^[A-Za-z0-9_./-]{1,200}$/.test(options.candidate), 'Invalid candidate revision');
  if (action === 'matrix') return compatibilityMatrix(options.candidate ? gitSource(root, options.candidate) : directorySource(root));
  return action === 'check' ? checkCompatibility(root, options) : rehearse(root, options);
}
if (isMain(import.meta.url)) compatMain().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
