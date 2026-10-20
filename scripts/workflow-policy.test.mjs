import assert from 'node:assert/strict';
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
  for (const required of ['nightly.mjs audit high', 'scan source "${lockfiles[@]}"', 'sha256sum -c -', 'test:backup-drill', 'BACKUP_TEST_DATABASE_URL',
    'test:temporal', 'test:supervised', 'test:load', 'test:long-session', 'nightly.mjs no-skips']) assert.ok(nightly.includes(required), required);
  // Every tee'd test log is checked for skips.
  for (const [, log] of nightly.matchAll(/\| tee (?:-a )?"\$RUNNER_TEMP\/([a-z-]+\.log)"/g)) assert.ok(nightly.includes(`no-skips "$RUNNER_TEMP/${log}"`), log);
  assert.doesNotMatch(workflows['ci.yml'], /schedule:/);
});
