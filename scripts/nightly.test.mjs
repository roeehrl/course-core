import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { MODULES } from './modules.mjs';
import { evaluateNpmAudit, moduleLockfiles, requireNoSkips } from './nightly.mjs';

const counts = (overrides = {}) => ({ info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...overrides });

test('nightly scans cover every registered module lock and nothing else', () => {
  assert.deepEqual(moduleLockfiles(), Object.values(MODULES).map(m => `${m.directory}/package-lock.json`).sort());
  assert.deepEqual(moduleLockfiles({ a: { directory: 'z/a' }, b: { directory: 'b' } }), ['b/package-lock.json', 'z/a/package-lock.json']);
  const out = execFileSync(process.execPath, ['scripts/nightly.mjs', 'lockfiles'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), moduleLockfiles().map(file => `--lockfile=${file}`));
});

test('npm audit evaluation blocks high and critical findings and refuses unusable reports', () => {
  assert.deepEqual(evaluateNpmAudit({ vulnerabilities: {}, metadata: { vulnerabilities: counts() } }).blocking, []);
  const report = { vulnerabilities: { braces: { severity: 'high' }, uuid: { severity: 'moderate' }, forge: { severity: 'critical' } },
    metadata: { vulnerabilities: counts({ moderate: 1, high: 1, critical: 1 }) } };
  assert.deepEqual(evaluateNpmAudit(report).blocking, ['braces (high)', 'forge (critical)']);
  assert.deepEqual(evaluateNpmAudit(report, 'critical').blocking, ['forge (critical)']);
  assert.deepEqual(evaluateNpmAudit(report, 'moderate').blocking.length, 3);
  assert.throws(() => evaluateNpmAudit(undefined), /did not return a JSON report/);
  assert.throws(() => evaluateNpmAudit({ error: { code: 'ENOTFOUND' } }), /npm audit failed: ENOTFOUND/);
  assert.throws(() => evaluateNpmAudit({ vulnerabilities: {} }), /no vulnerability counts/);
  assert.throws(() => evaluateNpmAudit({ vulnerabilities: {}, metadata: { vulnerabilities: counts({ high: 2 }) } }), /disagree/);
  assert.throws(() => evaluateNpmAudit(report, 'severe'), /Unknown audit level/);
});

test('nightly test logs must show suites that ran without skips, todos, cancellations or failures', () => {
  const spec = (o = {}) => Object.entries({ tests: 3, suites: 0, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...o }).map(([k, v]) => `ℹ ${k} ${v}`).join('\n');
  const tap = (o = {}) => Object.entries({ tests: 2, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...o }).map(([k, v]) => `# ${k} ${v}`).join('\n');
  assert.deepEqual(requireNoSkips(`noise\n${spec()}\n`), { summaries: 1, tests: 3 });
  assert.deepEqual(requireNoSkips(`${spec()}\nrepeat\n${tap()}`), { summaries: 2, tests: 5 });
  assert.throws(() => requireNoSkips('npm ERR! missing script'), /did not run/);
  assert.throws(() => requireNoSkips(spec({ skipped: 1, pass: 2 })), /Only 2 of 3/);
  assert.throws(() => requireNoSkips(spec({ tests: 4, skipped: 1 })), /Only 3 of 4/);
  assert.throws(() => requireNoSkips(spec({ todo: 1 })), /todo/);
  assert.throws(() => requireNoSkips(spec({ tests: 0, pass: 0 })), /Only 0 of 0/);
  assert.throws(() => requireNoSkips(`${spec()}\n${tap({ fail: 1, pass: 1 })}`), /Only 1 of 2/);
  assert.throws(() => requireNoSkips('ℹ tests 3\nℹ pass 3'), /Incomplete test summary/);
});
