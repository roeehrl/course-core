import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const MODULES = Object.freeze({
  policy: { directory: 'packages/policy', typecheck: 'check', build: 'build' },
  providers: { directory: 'packages/providers', typecheck: 'check', build: 'build' },
  adaptation: { directory: 'packages/adaptation', typecheck: 'check', build: 'build' },
  research: { directory: 'packages/research', typecheck: 'typecheck', build: 'build' },
  'example-courses': { directory: 'examples/courses', typecheck: 'validate', build: 'validate' },
  sandbox: { directory: 'packages/sandbox', typecheck: 'typecheck', build: 'build', docker: 'test:docker' },
  visuals: { directory: 'packages/visuals', typecheck: 'typecheck', build: 'build', publishable: true, browser: 'test:browser' },
  api: { directory: 'services/api', typecheck: 'typecheck', build: 'build', browser: 'test:browser', practical: 'test:practical' },
  supervisor: { directory: 'services/supervisor', typecheck: 'typecheck', build: 'build', integration: 'test:temporal' },
  learner: { directory: 'apps/learner', typecheck: 'typecheck', build: 'export:web', web: true },
  admin: { directory: 'apps/admin', typecheck: 'typecheck', build: 'build', web: true },
});
export function ensure(condition, message) { if (!condition) throw new Error(message); }
export function requireNode26() { ensure(process.versions.node.split('.')[0] === '26', 'Use Node 26 for root orchestration and CI.'); }
export async function readJson(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
export async function requireFile(filename, label = filename) {
  try { ensure((await lstat(filename)).isFile(), `${label} must be a regular file`); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Required integration file is missing: ${label}`); throw error; }
}
export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
export function localModuleTarget(packageName, value, directory, root = ROOT) {
  if (typeof packageName !== 'string' || !packageName.startsWith('@course-core/')) return undefined;
  const name = packageName.slice('@course-core/'.length);
  if (!Object.hasOwn(MODULES, name) || typeof value !== 'string') return undefined;
  const relative = value.replace(/^file:/, '');
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || /^[A-Za-z]:/.test(relative)) return undefined;
  return path.resolve(directory, relative) === path.resolve(root, MODULES[name].directory) ? name : undefined;
}
export function targets(selection) {
  if (selection === 'all') return Object.keys(MODULES);
  if (selection === 'web') return ['learner', 'admin'];
  ensure(Object.hasOwn(MODULES, selection), `Select all, web, or one of: ${Object.keys(MODULES).join(', ')}.`);
  return [selection];
}
export async function readModule(name, root = ROOT) {
  ensure(Object.hasOwn(MODULES, name), 'Unknown module');
  const config = MODULES[name];
  const directory = path.join(root, config.directory);
  try {
    ensure(await realpath(directory) === path.join(await realpath(root), config.directory), `${config.directory}: module directory must not redirect through a symlink`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await requireFile(path.join(directory, 'package.json'), `${config.directory}/package.json`);
  await requireFile(path.join(directory, 'package-lock.json'), `${config.directory}/package-lock.json`);
  const manifest = await readJson(path.join(directory, 'package.json'));
  ensure(manifest.name === `@course-core/${name}` && manifest.license === 'Apache-2.0' && (config.publishable || manifest.private === true), `${config.directory}: unexpected standalone package identity/license`);
  ensure(!manifest.workspaces, `${config.directory}: root orchestration expects standalone installs`);
  const required = [config.typecheck, config.build, 'test', ...(config.web ? ['test:web'] : []), ...(config.browser ? [config.browser] : []), ...(config.integration ? [config.integration] : []), ...(config.docker ? [config.docker] : []), ...(config.practical ? [config.practical] : []), ...(name === 'learner' ? ['check:expo'] : [])];
  for (const script of required) ensure(typeof manifest.scripts?.[script] === 'string' && manifest.scripts[script].trim(), `${config.directory}: required npm script ${script} is missing`);
  return { ...config, directory, manifest };
}
export function sdkReleaseUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const match = /^\/roeehrl\/course-sdk\/releases\/download\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/course-core-sdk-([^/]+)\.tgz$/.exec(url.pathname);
  return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash && !!match && match[1] === match[2];
}
export function requireReleasedSdk(manifest) {
  ensure(sdkReleaseUrl(manifest.dependencies?.['@course-core/sdk']),
    'API integration requires @course-core/sdk from an explicit versioned public SDK release .tgz URL, with matching package-lock.json. The module owner must add it after the release exists.');
}
export function testDatabaseUrl(environment = process.env) {
  ensure(!environment.DATABASE_URL, 'Unset application DATABASE_URL before API checks; only TEST_DATABASE_URL is accepted.');
  ensure(environment.TEST_DATABASE_URL, 'TEST_DATABASE_URL must point to a disposable local Postgres 17 database.');
  let url;
  try { url = new URL(environment.TEST_DATABASE_URL); } catch { throw new Error('TEST_DATABASE_URL is not a valid database URL (value redacted).'); }
  ensure(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'TEST_DATABASE_URL must use PostgreSQL on a loopback host, never a remote application database.');
  ensure(/^\/(?:course_core_ci|course_core_test(?:_[a-z0-9_]+)?)$/.test(url.pathname) && !url.search && !url.hash,
    'Use a disposable database named course_core_ci or course_core_test[_suffix], without connection overrides.');
  return url;
}
export function assertLockRoot(manifest, lock, label) {
  ensure(lock.lockfileVersion === 3 && lock.packages?.[''], `${label}: npm lockfileVersion 3 is required`);
  ensure(lock.name === manifest.name && lock.version === manifest.version && lock.packages[''].version === manifest.version, `${label}: stale lockfile identity`);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(lock.packages[''][field] ?? {}, manifest[field] ?? {}, `${label}: stale locked ${field}`);
  }
}
