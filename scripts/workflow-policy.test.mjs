import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { APT_ARCHIVE_CACHE } from './browser-cache.mjs';

const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(await Promise.all((await readdir(directory)).filter(name => /\.ya?ml$/.test(name)).sort()
  .map(async name => [name, await readFile(new URL(name, directory), 'utf8')])));
/** Top-level job blocks: two-space-indented keys under `jobs:`. */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7), result = {};
  let name;
  for (const line of body.split('\n')) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) { name = match[1]; result[name] = ''; } else if (name) result[name] += `${line}\n`;
  }
  return result;
}
const header = text => text.slice(0, text.indexOf('\njobs:\n'));
/** A job body's steps, each from its `- ` line to the next. */
const steps = body => body.includes('\n    steps:\n') ? body.slice(body.indexOf('\n    steps:\n') + 1).split(/\n(?= {6}- )/).slice(1) : [];
const jobMinutes = body => Number(/^ {4}timeout-minutes: (\d+)$/m.exec(body)?.[1]);
/** A step's budget: a number, or the browser install's hit-dependent `restored && N || M` (its larger value). */
const HIT_BUDGET = /^ {8}timeout-minutes: \$\{\{ steps\.browser-cache-restore\.outputs\.cache-hit != '' && (\d+) \|\| (\d+) \}\}$/m;
const stepMinutes = step => { const hit = HIT_BUDGET.exec(step); return hit ? Math.max(Number(hit[1]), Number(hit[2])) : Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]); };

test('every action is an official actions/* action pinned to a full commit SHA', () => {
  assert.ok(Object.keys(workflows).length >= 3);
  for (const [name, text] of Object.entries(workflows)) {
    for (const [, ref] of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
      if (ref.startsWith('./.github/workflows/')) continue;
      // An official action's own sub-action (actions/cache/restore) is pinned the same way.
      assert.match(ref, /^actions\/[a-z0-9-]+(?:\/[a-z0-9-]+)?@[a-f0-9]{40}$/, `${name}: ${ref}`);
    }
  }
});

test('caches hold only Playwright browsers and Ubuntu packages checked against the signed apt index', () => {
  const browserPaths = ['~/.cache/ms-playwright', "${{ matrix.app == 'visuals' && 'packages/visuals/node_modules/.cache/ms-playwright' || '~/.cache/ms-playwright' }}"];
  const cachePaths = step => /\n {8}with:\n(?: {10}.*\n)*? {10}path: \|\n((?: {12}.*\n)+)/.exec(`${step}\n`)?.[1].trim().split(/\n\s*/);
  let cachedJobs = 0;
  for (const [name, text] of Object.entries(workflows)) {
    // No combined actions/cache step: its implicit post-job save would run after the tests.
    assert.doesNotMatch(text, /uses: actions\/cache@/, name);
    // Dependency installs stay locked and fresh: setup-node never restores an npm cache.
    for (const step of Object.values(jobs(text)).flatMap(steps).filter(step => step.includes('uses: actions/setup-node@')))
      assert.match(step, /^ {10}package-manager-cache: false$/m, name);
    for (const [job, body] of Object.entries(jobs(text))) {
      const list = steps(body), index = pattern => list.findIndex(step => pattern.test(step));
      const restores = list.filter(step => step.includes('uses: actions/cache/restore@')), saves = list.filter(step => step.includes('uses: actions/cache/save@'));
      const installsPackages = index(/--with-deps|apt-get install/) >= 0;
      if (name === 'ci.yml' && /--with-deps/.test(body)) assert.equal(restores.length, 1, `${job}: browser installs use the cache`);
      if (!restores.length && !saves.length) continue;
      cachedJobs++;
      assert.ok(name === 'ci.yml', `${name} ${job}: release and nightly jobs do not use caches`);
      assert.equal(restores.length, 1, job);
      assert.equal(saves.length, 1, job);
      const [restore, save] = [restores[0], saves[0]];
      const paths = cachePaths(restore);
      assert.deepEqual(cachePaths(save), paths, `${job}: restore and save the same paths`);
      assert.equal(paths.length, 2, job);
      assert.ok(browserPaths.includes(paths[0]), `${job}: ${paths[0]}`);
      assert.equal(paths[1], APT_ARCHIVE_CACHE, job);
      for (const step of [restore, save]) assert.match(step, /^ {10}key: \$\{\{ steps\.browser-cache\.outputs\.key \}\}$/m, job);
      assert.match(restore, /^ {10}restore-keys: \$\{\{ steps\.browser-cache\.outputs\.restore-keys \}\}$/m, job);
      assert.match(restore, /^ {10}SEGMENT_DOWNLOAD_TIMEOUT_MINS: '\d'$/m, `${job}: a slow cache download falls back to a miss`);
      assert.match(save, /^ {8}if: steps\.browser-cache-restore\.outputs\.cache-hit != 'true'$/m, job);
      assert.ok(installsPackages, job);
      // Restored packages reach apt only through apt-restore's checksum check, before any install;
      // apt-collect runs after every install, and the save after both.
      const keyAt = index(/node scripts\/browser-cache\.mjs key /), restoreAt = list.indexOf(restore), saveAt = list.indexOf(save);
      const checkAt = index(/browser-cache\.mjs apt-restore/), collectAt = index(/browser-cache\.mjs apt-collect/);
      assert.ok(keyAt >= 0 && keyAt < restoreAt, `${job}: the key is computed before the restore`);
      assert.match(list[keyAt], /^ {8}id: browser-cache$/m, job);
      assert.match(restore, /^ {8}id: browser-cache-restore$/m, job);
      assert.ok(restoreAt < checkAt && checkAt <= index(/--with-deps|apt-get install/), `${job}: apt-restore runs before apt installs anything`);
      const lastInstall = list.findLastIndex(step => /--with-deps|apt-get install/.test(step));
      const firstInstallIn = step => step.search(/--with-deps|apt-get install/), lastInstallIn = step => Math.max(step.lastIndexOf('--with-deps'), step.lastIndexOf('apt-get install'));
      if (firstInstallIn(list[checkAt]) >= 0) assert.ok(list[checkAt].indexOf('apt-restore') < firstInstallIn(list[checkAt]), `${job}: apt-restore precedes the install in its step`);
      assert.ok(lastInstall <= collectAt && collectAt < saveAt, `${job}: apt-collect follows every install and precedes the save`);
      assert.ok(list[collectAt].lastIndexOf('apt-collect') > lastInstallIn(list[collectAt]), `${job}: apt-collect follows the install in its step`);
    }
  }
  assert.ok(cachedJobs >= 4, 'every browser job caches its downloads');
});

test('OIDC and attestation write access exist only on the release candidate job', () => {
  for (const [name, text] of Object.entries(workflows)) {
    assert.doesNotMatch(text, /pull_request_target|continue-on-error|secrets\./, name);
    assert.match(header(text), /\npermissions:\n {2}contents: read\n/, `${name}: read-only default token`);
    assert.doesNotMatch(header(text), /: write/, `${name}: no workflow-wide write permission`);
    for (const [job, body] of Object.entries(jobs(text))) {
      const writes = [...body.matchAll(/^\s+([a-z-]+): write\s*$/gm)].map(m => m[1]).sort();
      if (name === 'release.yml' && job === 'candidates') assert.deepEqual(writes, ['attestations', 'id-token']);
      else assert.deepEqual(writes, [], `${name} ${job}`);
    }
  }
  const candidates = jobs(workflows['release.yml']).candidates;
  assert.ok(candidates.indexOf('actions/attest-build-provenance@') > candidates.indexOf('release-artifacts.mjs verify'), 'attest only bytes that verify passed');
  assert.ok(candidates.indexOf('actions/attest-build-provenance@') < candidates.indexOf('actions/upload-artifact@'));
  assert.match(candidates, /subject-path: \$\{\{ runner\.temp \}\}\/course-core-candidates\/\*/);
});

test('nightly runs only on schedule or dispatch and covers each required area', () => {
  const nightly = workflows['nightly.yml'];
  assert.ok(nightly, 'nightly.yml exists');
  const on = header(nightly).slice(header(nightly).indexOf('\non:\n'));
  assert.match(on, /\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(on, /pull_request|push:/);
  assert.match(header(nightly), /\ndefaults:\n {2}run:\n(?: {4}#.*\n)* {4}shell: bash\n/, 'explicit bash gives -o pipefail for tee pipelines');
  for (const required of ['nightly.mjs audit high', 'nightly.mjs osv "$scanner"', 'sha256sum -c -', 'test:backup-drill', 'BACKUP_TEST_DATABASE_URL', "BACKUP_REQUIRE_AGE: '1'",
    'test:temporal', 'test:supervised', 'test:load', 'test:long-session', 'nightly.mjs no-skips']) assert.ok(nightly.includes(required), required);
  // Every tee'd test log is checked for skips.
  for (const [, log] of nightly.matchAll(/\| tee (?:-a )?"\$RUNNER_TEMP\/([a-z-]+\.log)"/g)) assert.ok(nightly.includes(`no-skips "$RUNNER_TEMP/${log}"`), log);
  assert.doesNotMatch(workflows['ci.yml'], /schedule:/);
});

test('nightly runs the OS/Node matrix and the scripted agent evals', () => {
  const nightly = jobs(workflows['nightly.yml']);
  const platforms = nightly.platforms;
  assert.ok(platforms, 'platforms job');
  assert.match(platforms, /^ {4}runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(platforms, /^ {8}os: \[ubuntu-24\.04, ubuntu-24\.04-arm, macos-15\]$/m, 'Linux x64, Linux arm64 and the macOS host');
  // The oldest Node the root engines range admits, and the newest Node 26.
  const engines = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node;
  const minimum = /^>=(\d+) <(\d+)$/.exec(engines);
  assert.ok(minimum, engines);
  assert.match(platforms, new RegExp(`^ {8}node: \\['${minimum[1]}\\.0\\.0', '${minimum[1]}'\\]$`, 'm'));
  assert.match(platforms, /node-version: \$\{\{ matrix\.node \}\}/);
  for (const command of ['npm run test:infra', 'npm run test:lifecycle', 'orchestrate.mjs check "$module"']) assert.ok(platforms.includes(command), command);
  const evals = nightly['agent-evals'];
  assert.ok(evals, 'agent-evals job');
  assert.ok(evals.includes('npm run eval:agents -- --report agent-eval-report.json'), 'reference model must pass');
  assert.ok(evals.includes('npm run eval:agents -- --model known-bad --expect-fail'), 'known-bad model must fail');
  assert.ok(evals.includes('npm run eval:agents -- --model over-triggering --expect-fail'), 'over-triggering model must fail');
  assert.doesNotMatch(evals, /COURSE_AGENT_EVALS_LIVE|--live\b|--judge\b|secrets/);
});

test('release and pull-request CI keep their job sets; the release job rehearses compatibility and rollback', () => {
  // The required checks and the release evidence count these jobs; adding one is a deliberate change.
  assert.deepEqual(Object.keys(jobs(workflows['release.yml'])), ['identity', 'full-ci', 'candidates']);
  assert.deepEqual(Object.keys(jobs(workflows['ci.yml'])), ['audit', 'packages', 'sandbox', 'api-core', 'api-engines', 'api-connected', 'api', 'web']);
  const candidates = jobs(workflows['release.yml']).candidates;
  assert.match(candidates, /image: postgres:17/);
  const order = ['release-compat.mjs check --candidate "$TESTED_COMMIT"', 'node --test scripts/tests/release-rehearsal.test.mjs', 'nightly.mjs no-skips "$RUNNER_TEMP/rehearsal.log"',
    'release-compat.mjs rehearse --candidate "$TESTED_COMMIT"', 'release-artifacts.mjs prepare'];
  for (const command of order) assert.ok(candidates.includes(command), command);
  for (let i = 1; i < order.length; i++) assert.ok(candidates.indexOf(order[i - 1]) < candidates.indexOf(order[i]), `${order[i - 1]} before ${order[i]}`);
  // Pipelines into tee need bash's pipefail.
  for (const step of candidates.split('\n      - ').filter(step => step.includes('| tee'))) assert.match(step, /\n {8}shell: bash\n/);
});

test('every job has a timeout, and the required API check gates every API job', () => {
  for (const [name, text] of Object.entries(workflows))
    for (const [job, body] of Object.entries(jobs(text)))
      if (!/^ {4}uses: /m.test(body)) assert.match(body, /^ {4}timeout-minutes: \d+$/m, `${name} ${job}`);
  const ci = jobs(workflows['ci.yml']);
  const apiJobs = Object.keys(ci).filter(job => job.startsWith('api-')).sort();
  assert.deepEqual(apiJobs, ['api-connected', 'api-core', 'api-engines']);
  const gate = ci.api;
  assert.match(gate, /^ {4}name: API and connected learner \/ Postgres 17$/m, 'required check name is bound by branch protection and release evidence');
  // always(): the gate must fail, never be skipped, when an API job fails or is cancelled.
  assert.match(gate, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  assert.match(gate, /^ {4}needs: \[audit, api-core, api-engines, api-connected\]$/m);
  for (const job of ['audit', ...apiJobs]) assert.ok(gate.includes(`\${{ needs.${job}.result }}`), job);
  assert.match(gate, /\[ "\$\{!job\}" = success \] \|\| status=1/);
  // Only the two slow suites may be skipped, only on pull requests and pushes to main; a release runs them.
  for (const job of ['api-engines', 'api-connected'])
    assert.match(ci[job], /^ {4}if: \$\{\{ github\.event_name != 'pull_request' && github\.event_name != 'push' \}\}$/m, job);
  assert.doesNotMatch(ci['api-core'], /^ {4}if:/m);
  assert.match(gate, /FAST: \$\{\{ github\.event_name == 'pull_request' \|\| github\.event_name == 'push' \}\}/);
  for (const job of apiJobs) {
    assert.match(ci[job], /^ {4}needs: audit$/m, job);
    assert.match(ci[job], /image: postgres:17/, job);
    assert.match(ci[job], /node scripts\/orchestrate\.mjs install api/, job);
  }
  // Each suite the required check used to run serially still runs in exactly one API job.
  for (const command of ['npm run test:backup-drill', 'npm run check:api:practical', 'npm run check:api\n', 'playwright.engines.config.ts --forbid-only',
    'run test:connected -- --forbid-only', 'npm run test:connected:webkit -- --forbid-only', 'npm --prefix apps/admin run test:real', 'run proof:local', 'run proof:clean-room', 'npm run test:supervised',
    // R02: migrations are rehearsed against the previous release on every change, not only at release.
    'release-compat.mjs rehearse --candidate "$GITHUB_SHA"'])
    assert.equal(apiJobs.filter(job => ci[job].includes(command)).length, 1, command);
});

test('browser jobs budget setup and tests in separate steps under a job limit', () => {
  // A step budget can only stop a step early; one at or above the job's limit means nothing.
  for (const [name, text] of Object.entries(workflows))
    for (const [job, body] of Object.entries(jobs(text)))
      for (const step of steps(body)) if (/^ {8}timeout-minutes:/m.test(step)) assert.ok(stepMinutes(step) < jobMinutes(body), `${name} ${job}: ${step.split('\n')[0]}`);
  const ci = jobs(workflows['ci.yml']);
  const setup = /orchestrate\.mjs install |sandbox:pull|--with-deps|apt-get install|uses: actions\/cache\//;
  const suite = /--forbid-only|npm run check:api\n|orchestrate\.mjs check "\$TARGET"/;
  for (const job of ['api-core', 'api-engines', 'api-connected', 'web']) {
    const list = steps(ci[job]);
    assert.ok(list.some(step => /--with-deps/.test(step)), job);
    for (const step of list.filter(step => setup.test(step) || suite.test(step))) {
      // Downloads never share a budget with a test suite, so a slow mirror cannot use up a suite's time.
      assert.ok(!(setup.test(step) && suite.test(step)), `${job}: setup and tests in one step: ${step.split('\n')[0]}`);
      assert.ok(stepMinutes(step) > 0, `${job}: ${step.split('\n')[0]} needs its own timeout-minutes`);
    }
    // Installing from a restored entry gets a tight budget; only a full miss, which downloads every package, gets more.
    for (const step of list.filter(step => /--with-deps/.test(step))) {
      const [, restored, miss] = HIT_BUDGET.exec(step) ?? [];
      assert.ok(Number(restored) > 0 && Number(restored) < Number(miss), `${job}: ${step.split('\n')[0]} budget depends on the cache restore`);
    }
  }
});

/** A workflow's top-level concurrency block, or undefined without one. */
function concurrency(text) {
  const block = /\nconcurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)\n/.exec(header(text));
  return block && { group: block[1], cancel: block[2] };
}
const PR_ONLY_CANCEL = "${{ github.event_name == 'pull_request' }}";
const PER_RUN_GROUP = "${{ github.event_name == 'pull_request' && format('public-ci-pr-{0}', github.ref) || format('public-ci-run-{0}', github.run_id) }}";
/** Why a ci.yml concurrency block could cancel, or replace while pending, a main or release run ('' when it cannot). */
function mainRunRisk(block) {
  if (!block) return 'no concurrency block';
  if (block.cancel !== PR_ONLY_CANCEL) return 'only pull request runs may cancel in progress';
  // GitHub keeps one pending run per group and cancels it when a newer one queues, whatever cancel-in-progress says.
  if (block.group !== PER_RUN_GROUP) return 'every run outside a pull request needs a group of its own';
  return '';
}

test('main and release CI runs are never cancelled; only a superseded pull request run is', () => {
  // The release tags only a "Version" commit whose own main run passed, so no later merge may cancel or replace that run.
  const ci = workflows['ci.yml'];
  assert.match(header(ci), /\non:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n {2}workflow_call:\n/);
  assert.equal(mainRunRisk(concurrency(ci)), '');
  // The checker rejects the configuration that cancelled the 0.1.60 main run, and a shared group whose pending run a later merge replaces.
  assert.match(mainRunRisk({ group: 'public-ci-${{ github.ref }}', cancel: 'true' }), /only pull request runs/);
  assert.match(mainRunRisk({ group: 'public-ci-${{ github.ref }}', cancel: PR_ONLY_CANCEL }), /group of its own/);
  assert.match(mainRunRisk({ group: PER_RUN_GROUP, cancel: 'true' }), /only pull request runs/);
  assert.match(mainRunRisk(undefined), /no concurrency block/);
  // The release workflow (which calls ci.yml) never cancels a candidate run.
  assert.equal(concurrency(workflows['release.yml'])?.cancel, 'false');
  // A job-level concurrency block would bypass the workflow-level rule.
  for (const name of ['ci.yml', 'release.yml'])
    for (const [job, body] of Object.entries(jobs(workflows[name]))) assert.doesNotMatch(body, /^ {4}concurrency:/m, `${name} ${job}`);
  // Any other workflow a push or another workflow can start must not cancel in progress either.
  for (const [name, text] of Object.entries(workflows)) {
    const on = header(text).slice(header(text).indexOf('\non:\n'));
    if (name !== 'ci.yml' && /\n {2}(?:push|workflow_call):/.test(on)) assert.notEqual(concurrency(text)?.cancel, 'true', name);
  }
});

test('PR and release CI fail on test-level skips: every test command is skip-checked', () => {
  const ci = workflows['ci.yml'];
  assert.match(header(ci), /\nenv:\n(?: {2}#.*\n)* {2}COURSE_FORBID_TEST_SKIPS: '1'\n/, 'orchestrate.mjs checks module suites for skips');
  // The release workflow runs this same workflow, so release CI inherits the rule.
  assert.match(jobs(workflows['release.yml'])['full-ci'], /uses: \.\/\.github\/workflows\/ci\.yml/);
  const commands = ci.split('\n').map(line => line.replace(/^\s*(?:- )?(?:run: )?/, '').trim())
    .filter(line => /(?:npm (?:--prefix \S+ )?run (?:test:\S+|check:sandbox:docker)|cli\.js test )/.test(line));
  assert.ok(commands.length >= 8, 'test commands found');
  // Qualification flows are scripts, not test runners; they fail on any unmet step themselves.
  const scripts = ['npm run test:supervised'];
  for (const command of commands)
    if (!scripts.includes(command)) assert.match(command, /^node (?:\.\.\/\.\.\/)?scripts\/test-skips\.mjs -- /, command);
});

test('the required Docker job brings up the documented self-host stack', () => {
  const sandbox = jobs(workflows['ci.yml']).sandbox;
  assert.match(sandbox, /^ {4}name: Sandbox \/ real Docker Linux$/m, 'required check name is bound by branch protection and release evidence');
  assert.ok(sandbox.indexOf('npm run test:self-host') > sandbox.indexOf('npm run check:sandbox:docker'), 'runs after the sandbox Docker suites');
  assert.equal(Object.values(jobs(workflows['ci.yml'])).filter(body => body.includes('npm run test:self-host')).length, 1);
});
