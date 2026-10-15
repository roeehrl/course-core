import { isMain } from './is-main.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditPublic } from './audit-public.mjs';
import { checkTestDatabase } from './check-test-database.mjs';
import { resolveModuleGraph } from './dependency-graph.mjs';
import { MODULES, ROOT, ensure, readJson, requireFile, requireNode26, requireReleasedSdk, targets, testDatabaseUrl } from './modules.mjs';

export async function lockPath(root) {
  const key = createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 24);
  return path.join(tmpdir(), `course-core-orchestrator-${key}.lock`);
}
export async function withCheckoutLock(root, body) {
  const filename = await lockPath(root);
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another root command owns this checkout. Wait for it to finish; after a crashed run use node scripts/orchestrate.mjs unlock.');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.close();
    return await body();
  } finally { await handle.close().catch(() => {}); await rm(filename, { force: true }); }
}
async function unlock() {
  const filename = await lockPath(ROOT);
  let owner;
  try { owner = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { console.log('No root command lock exists.'); return; } throw error; }
  ensure(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'Invalid lock owner; inspect the lock manually.');
  try { process.kill(owner.pid, 0); throw new Error('The root command lock owner is still running; do not remove its lock.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await rm(filename);
  console.log('Removed a lock whose owner process no longer exists.');
}

let activeChild;
let interrupted = false;
function stop(signal) {
  interrupted = true;
  if (!activeChild) return;
  try { process.kill(process.platform === 'win32' ? activeChild.pid : -activeChild.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function run(command, args, cwd, env) {
  ensure(!interrupted, 'Root command interrupted');
  console.log(`[${path.relative(ROOT, cwd) || 'root'}] ${path.basename(command)} ${args.join(' ')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    activeChild = child;
    child.once('error', (error) => { activeChild = undefined; reject(error); });
    child.once('close', (code, signal) => {
      activeChild = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(`${path.relative(ROOT, cwd)}: ${path.basename(command)} ${args.join(' ')} failed (${signal ?? code}); no later steps were run`));
    });
  });
}
async function testFiles(directory) {
  const result = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) result.push(filename);
    }
  }
  for (const folder of ['test', 'tests', 'browser']) {
    try { await walk(path.join(directory, folder)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
/** Browser-host port settings for child commands. Children always run with CI=true,
 * so the caller's own CI status picks the port mode (services/api/browser/ports.ts):
 * fixed 4317/4318 in CI, free loopback ports locally so parallel checkouts do not
 * collide. Explicit COURSE_BROWSER_* settings are forwarded unchanged. */
export function browserPortEnv(callerEnv) {
  const env = { COURSE_BROWSER_PORTS: callerEnv.CI === 'true' ? 'fixed' : 'free' };
  for (const key of ['COURSE_BROWSER_PORTS', 'COURSE_BROWSER_PORT', 'COURSE_BROWSER_PASSKEY_PORT'])
    if (callerEnv[key] !== undefined && callerEnv[key] !== '') env[key] = callerEnv[key];
  return env;
}
export async function preflight(name, module) {
  const files = await testFiles(module.directory);
  ensure(files.length, `${MODULES[name].directory}: required tests are missing; integration is unfinished`);
  if (name === 'api') {
    requireReleasedSdk(module.manifest);
    await requireFile(path.join(module.directory, 'browser/start.ts'), 'API disposable browser host');
    await requireFile(path.join(module.directory, 'browser/learner.spec.ts'), 'API connected learner browser suite');
    const bodies = await Promise.all(files.map((filename) => readFile(filename, 'utf8')));
    ensure(bodies.some((text) => text.includes('TEST_DATABASE_URL')), 'API tests must consume TEST_DATABASE_URL; a mock-only test suite is insufficient.');
  }
  if (name === 'supervisor') await requireFile(path.join(module.directory, 'test/temporal.integration.ts'), 'supervisor Temporal integration suite');
  if (module.docker) await requireFile(path.join(module.directory, 'test/docker.test.mjs'), 'sandbox real-Docker qualification suite');
  if (module.practical) await requireFile(path.join(module.directory, 'qualification/practical-flow.ts'), 'API real-Postgres/real-Docker practical qualification');
  if (module.web || module.browser) {
    await requireFile(path.join(module.directory, 'playwright.config.ts'), `${MODULES[name].directory}/playwright.config.ts`);
    const browserFiles = files.filter((filename) => /[/\\](?:web|e2e|browser)[/\\]/.test(filename));
    ensure(browserFiles.length, `${MODULES[name].directory}: browser tests under browser/ or test(s)/web, e2e, or browser are required`);
    const bodies = (await Promise.all(browserFiles.map((filename) => readFile(filename, 'utf8')))).join('\n');
    ensure(!module.web || bodies.includes('@axe-core/playwright') && /\.analyze\s*\(/.test(bodies) && bodies.includes('.violations'),
      `${MODULES[name].directory}: browser tests must run and assert axe accessibility results`);
  }
}
async function verifyExports(module) {
  const visit = async (value) => {
    if (typeof value === 'string') {
      ensure(value.startsWith('./dist/') && !value.split('/').includes('..'), 'Package export must refer to its own built dist file');
      await requireFile(path.join(module.directory, value), 'advertised built package export');
    } else for (const child of Object.values(value ?? {})) await visit(child);
  };
  if (module.manifest.exports) await visit(module.manifest.exports);
}

async function execute(action, selection, withDependencies) {
  const selected = targets(selection);
  ensure(!withDependencies || action === 'browsers', '--with-deps is only valid for browser installation');
  ensure(['install', 'check', 'browsers'].includes(action), 'Use install, check, browsers, or unlock.');
  if (action === 'browsers') ensure(selected.every((name) => MODULES[name].web || MODULES[name].browser), 'Browser installation accepts api, learner, admin, visuals, or web.');
  await withCheckoutLock(ROOT, async () => {
    // The connected browser consumes learner and admin exports. They are additional
    // preparation roots, not fabricated API package dependencies/cycles.
    const graph = await resolveModuleGraph(selected, {
      extraRoots: selected.includes('api') && action !== 'browsers' ? ['learner', 'admin'] : [],
    });
    await auditPublic(ROOT, graph.order);
    const { modules, order } = graph;
    const selectedSet = new Set(selected);
    for (const name of order) {
      const module = modules.get(name);
      if (name === 'api') requireReleasedSdk(module.manifest);
      if (action === 'check' && selectedSet.has(name)) await preflight(name, module);
    }
    if (action === 'check' && selected.includes('api')) testDatabaseUrl();
    const scratch = await mkdtemp(path.join(tmpdir(), 'course-core-npm-'));
    try {
      const consumerHome = path.join(scratch, 'npm-config');
      await mkdir(consumerHome);
      await writeFile(path.join(consumerHome, 'user.npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nworkspaces=false\n');
      await writeFile(path.join(consumerHome, 'global.npmrc'), '');
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'USERPROFILE', 'PLAYWRIGHT_BROWSERS_PATH'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
      Object.assign(env, {
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`,
        CI: 'true', EXPO_NO_TELEMETRY: '1', NPM_CONFIG_USERCONFIG: path.join(consumerHome, 'user.npmrc'),
        NPM_CONFIG_GLOBALCONFIG: path.join(consumerHome, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(consumerHome, 'cache'),
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_WORKSPACES: 'false', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
        ...browserPortEnv(process.env),
      });
      const npm = (module, args, extraEnv = {}) => run('npm', ['--workspaces=false', ...args], module.directory, { ...env, ...extraEnv });
      if (action === 'browsers') {
        for (const name of selected) {
          const module = modules.get(name);
          const cli = path.join(module.directory, 'node_modules/@playwright/test/cli.js');
          await requireFile(cli, `${MODULES[name].directory}: installed Playwright CLI`);
          const browser = 'chromium'; // Matching Playwright pin; local direct checks can still use installed Chrome.
          const browserEnv = name === 'visuals'
            ? { ...env, PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(module.directory, 'node_modules/.cache/ms-playwright') }
            : env;
          await run(process.execPath, [cli, 'install', ...(withDependencies ? ['--with-deps'] : []), browser], module.directory, browserEnv);
        }
      } else {
        console.log(`Preparation order: ${order.join(' -> ')}`);
        for (const name of order) {
          const module = modules.get(name);
          const lock = await readJson(path.join(module.directory, 'package-lock.json'));
          const copiedLocal = Object.values(lock.packages).some((entry) => !entry.link && entry.resolved?.startsWith('file:'));
          // install-links=true takes a copy of local dist. Refresh that consumer
          // after its prerequisites are rebuilt, rather than test an old copy.
          if (action === 'install' || copiedLocal) await npm(module, ['ci', '--ignore-scripts']);
          await npm(module, ['run', module.build]);
          await verifyExports(module);
          // Public-contract typechecks may import this module's freshly built dist.
          if (action === 'check' && selectedSet.has(name)) await npm(module, ['run', module.typecheck]);
          // Approved adaptation registries pin built-in adapter digests, which hash the
          // compiled dist source. Check them against the record from this fresh build.
          if (action === 'check' && selectedSet.has(name) && name === 'api') await npm(module, ['run', 'check:adapter-digests']);
        }
      }
      // Finish all prerequisite builds before starting any selected test/server.
      // Dependency-only modules are built, not implicitly given their own test run.
      if (action === 'check') {
        for (const name of order.filter((value) => selectedSet.has(value))) {
          const module = modules.get(name);
          if (name === 'api') {
            await requireFile(path.join(modules.get('learner').directory, 'dist/index.html'), 'connected learner production export');
            await requireFile(path.join(modules.get('admin').directory, 'dist/index.html'), 'connected admin production export');
            await checkTestDatabase();
            await npm(module, ['test'], { TEST_DATABASE_URL: testDatabaseUrl().href });
          } else await npm(module, ['test']);
          if (module.integration) await npm(module, ['run', module.integration]);
          if (name === 'learner') await npm(module, ['run', 'check:expo']);
          if (module.web) {
            await requireFile(path.join(module.directory, 'dist/index.html'), `${MODULES[name].directory}: built web entry point`);
            // Keep export/build and its browser suite under the same checkout lock.
            // The app owns its preview server and ports; do not launch another server.
            await npm(module, ['run', 'test:web', '--', '--forbid-only']);
          } else if (module.browser) {
            await npm(module, ['run', module.browser, '--', '--forbid-only'],
              name === 'api' ? { TEST_DATABASE_URL: testDatabaseUrl().href } : {});
          }
        }
      }
      console.log(`Root ${action} passed for ${selected.join(', ')}. Demo/test verification only; no deployment or live-provider acceptance implied.`);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}
export async function main(args = process.argv.slice(2)) {
  requireNode26();
  ensure(args.length >= 1 && args.length <= 3, 'Usage: node scripts/orchestrate.mjs <install|check|browsers> <target> [--with-deps], or unlock');
  if (args[0] === 'unlock') { ensure(args.length === 1, 'unlock takes no arguments'); return unlock(); }
  ensure(args.length >= 2 && (!args[2] || args[2] === '--with-deps'), 'Unexpected orchestration arguments');
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await execute(args[0], args[1], args[2] === '--with-deps'); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (isMain(import.meta.url)) {
  main().catch((error) => { console.error(`Root command failed: ${error.message}`); process.exitCode = 1; });
}
