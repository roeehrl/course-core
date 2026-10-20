import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MODULES, ROOT } from './modules.mjs';
import { EXCEPTIONS_FILE, MAX_EXCEPTION_DAYS, applyNpmAuditExceptions, applyOsvExceptions, loadModuleExceptions, lockedPackage, parseExceptions } from './audit-exceptions.mjs';

const BRACES = 'GHSA-vfj7-8cjw-p6xm', FORGE = 'GHSA-86w9-cpqp-85rv', OTHER = 'GHSA-2222-3333-4444';
const NOW = new Date('2026-11-01T12:00:00Z');
const entry = (overrides = {}) => ({
  id: BRACES, aliases: ['CVE-2026-93687'], package: 'braces', versions: ['3.0.3'], introducedBy: ['micromatch'],
  severity: 'high', scope: 'build-tooling',
  reason: 'Synthetic: only reached by the bundler file watcher with repository-owned globs.',
  upstream: 'Synthetic: no patched release exists for this test advisory at all.',
  added: '2026-10-20', reviewBy: '2027-01-18', ...overrides,
});
const doc = (...entries) => ({ version: 1, exceptions: entries });
const lock = (extra = {}) => ({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { expo: '1.0.0' } },
    'node_modules/expo': { version: '1.0.0', dependencies: { 'metro-file-map': '^1.0.0' } },
    'node_modules/metro-file-map': { version: '1.0.0', dependencies: { micromatch: '^4.0.4' } },
    'node_modules/micromatch': { version: '4.0.8', dependencies: { braces: '^3.0.3' } },
    'node_modules/braces': { version: '3.0.3' },
    'node_modules/node-forge': { version: '1.4.0' },
    ...extra,
  },
});
const advisory = (id, name, severity = 'high') => ({ source: 1, name, dependency: name, title: 'synthetic', url: `https://github.com/advisories/${id}`, severity, range: '<=9.9.9' });
const npmReport = (extra = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    braces: { name: 'braces', severity: 'high', via: [advisory(BRACES, 'braces')] },
    micromatch: { name: 'micromatch', severity: 'high', via: ['braces'] },
    'metro-file-map': { name: 'metro-file-map', severity: 'high', via: ['micromatch'] },
    // npm audit reports cycles between dependents, as with metro and metro-config.
    metro: { name: 'metro', severity: 'high', via: ['metro-config', 'metro-file-map'] },
    'metro-config': { name: 'metro-config', severity: 'high', via: ['metro'] },
    ...extra,
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 5, critical: 0, total: 5 } },
});

test('the checked-in exception files are valid, narrow and expiring', async () => {
  for (const module of Object.values(MODULES)) {
    const exceptions = await loadModuleExceptions(module.directory);
    for (const exception of exceptions) {
      assert.equal(exception.scope, 'build-tooling');
      assert.ok(exception.versions.length >= 1 && exception.introducedBy.length >= 1);
      const lockfile = JSON.parse(await readFile(path.join(ROOT, module.directory, 'package-lock.json'), 'utf8'));
      const locked = lockedPackage(lockfile, exception.package);
      assert.deepEqual(locked.versions.filter(v => !exception.versions.includes(v)), [], `${exception.id} lists every locked version`);
      assert.deepEqual(locked.dependents.filter(d => !exception.introducedBy.includes(d)), [], `${exception.id} lists every dependent`);
      assert.ok(!exception.introducedBy.includes('<root>'), 'a direct dependency is never excepted');
    }
  }
  const learner = await loadModuleExceptions(MODULES.learner.directory);
  assert.deepEqual(learner.map(e => `${e.package} ${e.id}`).sort(), ['braces GHSA-vfj7-8cjw-p6xm', 'node-forge GHSA-86w9-cpqp-85rv', 'uuid GHSA-w5hq-g745-h8pq']);
});

test('exception documents reject blanket, open-ended or unexplained entries', () => {
  assert.equal(parseExceptions(doc(entry())).length, 1);
  assert.deepEqual(parseExceptions(doc()), []);
  const rejects = [
    [doc(entry({ package: '*' })), /one npm package name/],
    [doc(entry({ id: 'GHSA-*' })), /one GHSA advisory id/],
    [doc(entry({ id: 'CVE-2026-93687' })), /one GHSA advisory id/],
    [doc(entry({ versions: ['^3.0.3'] })), /versions has an invalid item/],
    [doc(entry({ versions: [] })), /versions must be a non-empty array/],
    [doc(entry({ introducedBy: [] })), /introducedBy must be a non-empty array/],
    [doc(entry({ scope: 'runtime' })), /shipped runtime code cannot be excepted/],
    [doc(entry({ reason: 'not reachable' })), /reason must explain/],
    [doc(entry({ upstream: '' })), /upstream must explain/],
    [doc(entry({ reviewBy: '2027-06-01' })), new RegExp(`within ${MAX_EXCEPTION_DAYS} days`)],
    [doc(entry({ reviewBy: '2026-10-19' })), /must be after added/],
    [doc(entry({ reviewBy: '2027-02-30' })), /not a real date/],
    [doc((({ reviewBy, ...rest }) => rest)(entry())), /must have exactly/],
    [doc({ ...entry(), allSeverities: true }), /must have exactly/],
    [doc(entry(), entry()), /duplicates/],
    [{ version: 1, exceptions: [], ignoreAll: true }, /expected exactly/],
    [{ version: 2, exceptions: [] }, /expected exactly/],
    [[], /must be a JSON object/],
  ];
  for (const [value, message] of rejects) assert.throws(() => parseExceptions(value), message);
});

test('npm audit: an excepted root advisory clears the findings that only inherit it, including cycles', () => {
  const result = applyNpmAuditExceptions(npmReport(), parseExceptions(doc(entry())), lock(), { now: NOW });
  assert.deepEqual(result.report.vulnerabilities, {});
  assert.deepEqual(result.report.metadata.vulnerabilities, { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 });
  assert.deepEqual(result.excepted, ['braces', 'metro', 'metro-config', 'metro-file-map', 'micromatch']);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unused, []);
});

test('npm audit: other advisories in the same chain still fail', () => {
  const report = npmReport({ micromatch: { name: 'micromatch', severity: 'high', via: ['braces', advisory(OTHER, 'micromatch')] } });
  const result = applyNpmAuditExceptions(report, parseExceptions(doc(entry())), lock(), { now: NOW });
  assert.deepEqual(Object.keys(result.report.vulnerabilities).sort(), ['metro', 'metro-config', 'metro-file-map', 'micromatch']);
  assert.equal(result.report.metadata.vulnerabilities.high, 4);
  assert.deepEqual(result.excepted, ['braces']);
  // The same advisory id on a different package is not covered.
  const moved = { braces: { name: 'braces', severity: 'high', via: [advisory(BRACES, 'fill-range')] } };
  const other = applyNpmAuditExceptions({ vulnerabilities: moved, metadata: {} }, parseExceptions(doc(entry())), lock(), { now: NOW });
  assert.deepEqual(Object.keys(other.report.vulnerabilities), ['braces']);
  assert.deepEqual(other.unused, [`${BRACES} (braces)`]);
});

test('npm audit: unrelated findings are untouched and a finding via an unknown name fails', () => {
  const report = npmReport({ 'node-forge': { name: 'node-forge', severity: 'critical', via: [advisory(FORGE, 'node-forge', 'critical')] }, orphan: { name: 'orphan', severity: 'low', via: ['missing'] } });
  const result = applyNpmAuditExceptions(report, parseExceptions(doc(entry())), lock(), { now: NOW });
  assert.deepEqual(Object.keys(result.report.vulnerabilities).sort(), ['node-forge', 'orphan']);
  assert.equal(result.report.metadata.vulnerabilities.critical, 1);
  assert.equal(result.report.metadata.vulnerabilities.total, 2);
});

test('npm audit: expiry, version drift and new dependents void an exception', () => {
  const exceptions = parseExceptions(doc(entry()));
  const expired = applyNpmAuditExceptions(npmReport(), exceptions, lock(), { now: new Date('2027-01-19T00:00:01Z') });
  assert.equal(Object.keys(expired.report.vulnerabilities).length, 5);
  assert.match(expired.problems[0], /expired on 2027-01-18/);
  assert.deepEqual(expired.unused, [`${BRACES} (braces)`]);
  // Still valid on the review date itself.
  assert.deepEqual(applyNpmAuditExceptions(npmReport(), exceptions, lock(), { now: new Date('2027-01-18T23:59:59Z') }).report.vulnerabilities, {});

  const drift = applyNpmAuditExceptions(npmReport(), exceptions, lock({ 'node_modules/foo/node_modules/braces': { version: '3.0.2' } }), { now: NOW });
  assert.match(drift.problems[0], /locked braces 3.0.2 is not listed/);
  assert.equal(Object.keys(drift.report.vulnerabilities).length, 5);

  const runtime = applyNpmAuditExceptions(npmReport(), exceptions, lock({ 'node_modules/web-thing': { version: '1.0.0', dependencies: { braces: '^3.0.0' } } }), { now: NOW });
  assert.match(runtime.problems[0], /now also required by web-thing/);
  assert.equal(Object.keys(runtime.report.vulnerabilities).length, 5);
});

test('npm audit: an exception without a matching finding is reported unused', () => {
  const result = applyNpmAuditExceptions({ vulnerabilities: {}, metadata: {} }, parseExceptions(doc(entry())), lock(), { now: NOW });
  assert.deepEqual(result.unused, [`${BRACES} (braces)`]);
  assert.throws(() => applyNpmAuditExceptions({ error: { code: 'ENOLOCK' } }, [], lock()), /usable JSON report/);
});

test('osv-scanner: exceptions match by id or alias for the exact npm package version only', () => {
  const osv = packages => ({ results: [{ source: { path: 'package-lock.json', type: 'lockfile' }, packages }] });
  const found = (name, version, vulnerabilities, ecosystem = 'npm') => ({ package: { name, version, ecosystem }, vulnerabilities, groups: [] });
  const exceptions = parseExceptions(doc(entry()));
  const ok = applyOsvExceptions(osv([found('braces', '3.0.3', [{ id: BRACES, aliases: [] }])]), exceptions, lock(), { now: NOW });
  assert.deepEqual(ok.remaining, []);
  assert.deepEqual(ok.excepted, [`braces@3.0.3 ${BRACES}`]);
  const alias = applyOsvExceptions(osv([found('braces', '3.0.3', [{ id: 'OSV-2026-1', aliases: ['CVE-2026-93687'] }])]), exceptions, lock(), { now: NOW });
  assert.deepEqual(alias.remaining, []);
  const mixed = applyOsvExceptions(osv([
    found('braces', '3.0.3', [{ id: BRACES }, { id: OTHER }]),
    found('braces', '3.0.2', [{ id: BRACES }]),
    found('braces', '3.0.3', [{ id: BRACES }], 'PyPI'),
  ]), exceptions, lock(), { now: NOW });
  assert.deepEqual(mixed.remaining, [`braces@3.0.2 ${BRACES}`, `braces@3.0.3 ${OTHER}`, `braces@3.0.3 ${BRACES}`]);
  const none = applyOsvExceptions(osv([]), exceptions, lock(), { now: NOW });
  assert.deepEqual(none.unused, [`${BRACES} (braces)`]);
  assert.throws(() => applyOsvExceptions({}, exceptions, lock()), /JSON report with results/);
});

test('exception files are optional per module and named consistently', async () => {
  assert.equal(EXCEPTIONS_FILE, 'audit-exceptions.json');
  assert.deepEqual(await loadModuleExceptions(MODULES.policy.directory), []);
});
