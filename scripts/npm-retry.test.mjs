import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MODULES, ROOT } from './modules.mjs';
import {
  NPM_CI_RETRY, NPM_FETCH_RETRY_CONFIG, classifyNpmFailure, npmCiWithRetry, npmFetchRetryEnv, removeNodeModules, spawnAndCapture,
} from './npm-retry.mjs';
import { npmrcValue, requireFetchRetries } from './public-policy.mjs';

// The Docker self-host build failure of release run 39666773033 (apps/learner).
const READ_RESET = `npm warn deprecated uuid@7.0.3: uuid@10 and below is no longer supported.
npm error code ECONNRESET
npm error syscall read
npm error errno -104
npm error network read ECONNRESET
npm error network This is a problem related to network connectivity.
npm error network In most cases you are behind a proxy or have bad network settings.
npm error network
npm error network If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'
npm error A complete log of this run can be found in: /src/apps/learner/.npm-cache/_logs/2026-10-21T20_11_01_542Z-debug-0.log
`;
const failure = (code, ...lines) => [`npm error code ${code}`, ...lines.map(line => `npm error ${line}`)].join('\n');

test('network-class npm failures are retried', () => {
  assert.deepEqual(classifyNpmFailure(READ_RESET), { retry: true, reason: 'transient network failure (ECONNRESET)' });
  for (const output of [
    failure('ETIMEDOUT', 'network request to https://registry.npmjs.org/react failed, reason: connect ETIMEDOUT'),
    failure('ESOCKETTIMEDOUT', 'network Socket timeout'),
    failure('EAI_AGAIN', 'request to https://registry.npmjs.org/react failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org'),
    failure('E500', '500 Internal Server Error - GET https://registry.npmjs.org/react'),
    failure('E502', '502 Bad Gateway - GET https://github.com/roeehrl/course-sdk/releases/download/v0.5.0/course-core-sdk-0.5.0.tgz'),
    failure('E503', '503 Service Unavailable - GET https://registry.npmjs.org/react'),
    failure('E504', '504 Gateway Timeout - GET https://registry.npmjs.org/react'),
    'npm ERR! code ECONNRESET\nnpm ERR! network aborted', // older npm prefix
    `npm warn old lockfile\nnpm warn old lockfile The package-lock.json file was created with an old version of npm\n${READ_RESET}`, // warnings are not errors
  ]) assert.equal(classifyNpmFailure(output).retry, true, output);
});

test('lockfile, integrity and other definitive npm failures are never retried', () => {
  for (const [output, pattern] of [
    [failure('EINTEGRITY', 'sha512-abc integrity checksum failed when using sha512: wanted sha512-abc but got sha512-def. (1234 bytes)'), /EINTEGRITY/],
    [failure('EUSAGE', '', '`npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'), /EUSAGE/],
    [failure('ENOLOCK', 'This command requires an existing lockfile.'), /ENOLOCK/],
    [failure('ELOCKVERIFY', 'Errors were found in your package-lock.json'), /ELOCKVERIFY/],
    [failure('EJSONPARSE', 'Unexpected token in JSON at position 10 while parsing package-lock.json'), /EJSONPARSE/],
    [failure('E404', '404 Not Found - GET https://registry.npmjs.org/@course-core%2fmissing'), /E404/],
    [failure('E403', '403 Forbidden - GET https://registry.npmjs.org/react'), /E403/],
    [failure('ETARGET', 'No matching version found for react@99.0.0.'), /ETARGET/],
    [failure('EBADENGINE', 'Unsupported engine'), /EBADENGINE/],
    [failure('ENOSPC', 'nospc ENOSPC: no space left on device'), /ENOSPC/],
    [failure('EACCES', 'syscall open'), /EACCES/],
    // A network code alongside a definitive one is still definitive.
    [`${READ_RESET}${failure('EINTEGRITY', 'integrity checksum failed')}`, /EINTEGRITY/],
    [`${READ_RESET}npm error Invalid: lock file's react@18.3.1 does not satisfy react@19.0.0\nnpm error package-lock.json is out of date`, /package-lock\.json/],
    [`${failure('E503', '503 Service Unavailable')}\nnpm error integrity checksum failed`, /integrity/],
  ]) {
    const verdict = classifyNpmFailure(output);
    assert.equal(verdict.retry, false, output);
    assert.match(verdict.reason, pattern, output);
  }
  // No npm error code (a crash, a signal, a missing npm) is not known to be transient.
  for (const output of ['', undefined, 'Killed', 'npm error network read ECONNRESET', 'ECONNRESET'])
    assert.deepEqual(classifyNpmFailure(output), { retry: false, reason: 'no npm error code was reported' }, String(output));
});

test('npm ci retries network failures with backoff, cleaning node_modules before each retry', async () => {
  const events = [];
  const outcomes = [{ ok: false, output: READ_RESET }, { ok: false, output: failure('E503', '503') }, { ok: true }];
  const attempts = await npmCiWithRetry('/m', async (attempt) => { events.push(`run ${attempt}`); return outcomes[attempt - 1]; }, {
    label: 'apps/learner', clean: async directory => events.push(`clean ${directory}`), wait: async ms => events.push(`wait ${ms}`), log: () => {},
  });
  assert.equal(attempts, 3);
  assert.deepEqual(events, ['run 1', 'clean /m', 'wait 20000', 'run 2', 'clean /m', 'wait 60000', 'run 3']);
  assert.deepEqual(NPM_CI_RETRY, { attempts: 3, delays: [20_000, 60_000] });
});

test('npm ci stops at once on a definitive failure and after the last network failure', async () => {
  const quiet = { clean: async () => assert.fail('must not clean'), wait: async () => assert.fail('must not wait'), log: () => {} };
  let runs = 0;
  await assert.rejects(npmCiWithRetry('/m', async () => { runs++; return { ok: false, output: failure('EINTEGRITY', 'integrity checksum failed') }; }, { label: 'apps/learner', ...quiet }),
    /^Error: apps\/learner: npm ci failed: definitive npm failure \(EINTEGRITY\)/);
  assert.equal(runs, 1);
  runs = 0;
  await assert.rejects(npmCiWithRetry('/m', async () => { runs++; return { ok: false, output: 'Killed' }; }, { label: 'm', ...quiet }), /no npm error code/);
  assert.equal(runs, 1);
  runs = 0;
  let cleans = 0;
  await assert.rejects(npmCiWithRetry('/m', async () => { runs++; return { ok: false, output: READ_RESET }; }, { label: 'm', clean: async () => { cleans++; }, wait: async () => {}, log: () => {} }),
    /^Error: m: npm ci failed after 3 attempts: transient network failure \(ECONNRESET\)/);
  assert.deepEqual({ runs, cleans }, { runs: 3, cleans: 2 });
  // A network failure followed by a definitive one stops there.
  runs = 0;
  const outcomes = [READ_RESET, failure('EUSAGE', 'package.json and package-lock.json are not in sync')];
  await assert.rejects(npmCiWithRetry('/m', async (attempt) => { runs++; return { ok: false, output: outcomes[attempt - 1] }; }, { label: 'm', clean: async () => {}, wait: async () => {}, log: () => {} }),
    /definitive npm failure \(EUSAGE\).*\(attempt 2 of 3\)/);
  assert.equal(runs, 2);
});

test('a real child that resets mid-install is retried after its partial node_modules is removed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'npm-retry-'));
  try {
    await writeFile(path.join(directory, 'package-lock.json'), '{}\n');
    // Fake npm: the first run leaves a partial node_modules and fails as in the release
    // run; the second run requires that node_modules was removed first.
    const fake = path.join(directory, 'fake-npm.mjs');
    await writeFile(fake, `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const marker = 'attempted';
if (existsSync('node_modules')) { console.error('partial node_modules survived'); process.exit(2); }
if (!existsSync(marker)) {
  writeFileSync(marker, '');
  mkdirSync('node_modules/react', { recursive: true });
  writeFileSync('node_modules/react/package.json', '{"name":"react"');
  process.stderr.write(${JSON.stringify(READ_RESET)});
  process.exit(1);
}
mkdirSync('node_modules/react', { recursive: true });
process.exit(0);
`);
    const waits = [];
    const attempts = await npmCiWithRetry(directory, () => spawnAndCapture(process.execPath, [fake], { cwd: directory }), { label: 'fixture', wait: async ms => { waits.push(ms); }, log: () => {} });
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [20_000]);
    await access(path.join(directory, 'node_modules/react'));
    assert.equal(await readFile(path.join(directory, 'package-lock.json'), 'utf8'), '{}\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('removing node_modules leaves the lockfile and is a no-op when absent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'npm-retry-'));
  try {
    await mkdir(path.join(directory, 'node_modules/.bin'), { recursive: true });
    await writeFile(path.join(directory, 'package-lock.json'), '{}\n');
    await removeNodeModules(directory);
    await assert.rejects(access(path.join(directory, 'node_modules')), { code: 'ENOENT' });
    await access(path.join(directory, 'package-lock.json'));
    await removeNodeModules(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the npm fetch retry settings match every module .npmrc and the audited bounds', async () => {
  const text = Object.entries(NPM_FETCH_RETRY_CONFIG).map(([key, value]) => `${key}=${value}\n`).join('');
  assert.doesNotThrow(() => requireFetchRetries('npm-retry.mjs', `ignore-scripts=true\n${text}`));
  for (const { directory } of Object.values(MODULES)) {
    const npmrc = await readFile(path.join(ROOT, directory, '.npmrc'), 'utf8');
    for (const [key, value] of Object.entries(NPM_FETCH_RETRY_CONFIG)) assert.equal(npmrcValue(npmrc, key), value, `${directory}/.npmrc ${key}`);
  }
  assert.deepEqual(npmFetchRetryEnv(), { NPM_CONFIG_FETCH_RETRIES: '5', NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '10000', NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '60000' });
});

test('the Docker self-host build installs only through the shared retry policy', async () => {
  const build = await readFile(path.join(ROOT, 'deploy/docker/build.mjs'), 'utf8');
  assert.match(build, /import \{[^}]*npmCiWithRetry[^}]*npmFetchRetryEnv[^}]*\} from '\.\.\/\.\.\/scripts\/npm-retry\.mjs'/);
  assert.match(build, /\.\.\.npmFetchRetryEnv\(\)/);
  assert.match(build, /await npmCiWithRetry\(directory, \(\) => spawnAndCapture\('npm', \['--workspaces=false', 'ci', '--ignore-scripts'\]/);
  assert.equal(build.match(/'ci'/g).length, 1, 'build.mjs runs npm ci only through npmCiWithRetry');
  const dockerfile = await readFile(path.join(ROOT, 'deploy/docker/Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /\bnpm (?:ci|install|i)\b/, 'the Dockerfile installs only through build.mjs');
  assert.match(dockerfile, /^ARG NODE_IMAGE=node:[0-9.]+-slim@sha256:[0-9a-f]{64}$/m, 'the base image stays pinned by digest');
  // The module .npmrc files (fetch retries, ignore-scripts) must reach the build context.
  const ignore = await readFile(path.join(ROOT, 'deploy/docker/Dockerfile.dockerignore'), 'utf8');
  assert.doesNotMatch(ignore, /npmrc/);
  const orchestrate = await readFile(path.join(ROOT, 'scripts/orchestrate.mjs'), 'utf8');
  assert.match(orchestrate, /npmCiWithRetry\(module\.directory/);
  assert.match(orchestrate, /\.\.\.npmFetchRetryEnv\(\)/);
});
