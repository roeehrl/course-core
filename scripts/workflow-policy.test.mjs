import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('every action is an official actions/* action pinned to a full commit SHA', () => {
  assert.ok(Object.keys(workflows).length >= 3);
  for (const [name, text] of Object.entries(workflows)) {
    for (const [, ref] of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
      if (ref.startsWith('./.github/workflows/')) continue;
      assert.match(ref, /^actions\/[a-z0-9-]+@[a-f0-9]{40}$/, `${name}: ${ref}`);
    }
  }
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
  for (const job of apiJobs) {
    assert.match(ci[job], /^ {4}needs: audit$/m, job);
    assert.match(ci[job], /image: postgres:17/, job);
    assert.match(ci[job], /node scripts\/orchestrate\.mjs install api/, job);
  }
  // Each suite the required check used to run serially still runs in exactly one API job.
  for (const command of ['npm run test:backup-drill', 'npm run check:api:practical', 'npm run check:api\n', 'playwright.engines.config.ts --forbid-only',
    'run test:connected -- --forbid-only', 'npm run test:connected:webkit -- --forbid-only', 'npm --prefix apps/admin run test:real', 'run proof:local', 'npm run test:supervised'])
    assert.equal(apiJobs.filter(job => ci[job].includes(command)).length, 1, command);
});
