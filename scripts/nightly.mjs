import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MODULES, ROOT, ensure, readJson, requireNode26 } from './modules.mjs';
import { applyNpmAuditExceptions, applyOsvExceptions, loadModuleExceptions } from './audit-exceptions.mjs';
import { isMain } from './is-main.mjs';

const exec = promisify(execFile);
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/** Every registered module's lock file, so a new module cannot escape the scans. */
export function moduleLockfiles(registry = MODULES) {
  return Object.values(registry).map(module => `${module.directory}/package-lock.json`).sort();
}

/** Reduces `npm audit --json` output to counts and the packages at or above `level`. */
export function evaluateNpmAudit(report, level = 'high') {
  ensure(SEVERITIES.includes(level), 'Unknown audit level');
  ensure(report && typeof report === 'object' && !Array.isArray(report), 'npm audit did not return a JSON report');
  ensure(!report.error, `npm audit failed: ${String(report.error?.code ?? report.error?.summary ?? 'error').slice(0, 120)}`);
  const counts = report.metadata?.vulnerabilities;
  ensure(counts && SEVERITIES.every(severity => Number.isSafeInteger(counts[severity]) && counts[severity] >= 0), 'npm audit report has no vulnerability counts');
  const threshold = SEVERITIES.indexOf(level);
  const blocking = Object.entries(report.vulnerabilities ?? {})
    .filter(([, finding]) => SEVERITIES.indexOf(finding?.severity) >= threshold)
    .map(([name, finding]) => `${name} (${finding.severity})`).sort();
  const total = SEVERITIES.slice(threshold).reduce((sum, severity) => sum + counts[severity], 0);
  ensure(total === 0 || blocking.length > 0, 'npm audit counts and findings disagree');
  return { counts: Object.fromEntries(SEVERITIES.map(severity => [severity, counts[severity]])), blocking };
}

/** Node test runner summaries (spec `ℹ` or TAP `#` lines). Every summary must
 * show tests that ran, and none failed, skipped, cancelled or left as todo. */
export function requireNoSkips(text) {
  const summaries = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === 'tests') { current = {}; summaries.push(current); }
    if (current) current[match[1]] = Number(match[2]);
  }
  ensure(summaries.length > 0, 'No test runner summary found; the suite did not run');
  for (const summary of summaries) {
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) ensure(Number.isSafeInteger(summary[key]), `Incomplete test summary (${key} missing)`);
    ensure(summary.tests > 0 && summary.pass === summary.tests, `Only ${summary.pass} of ${summary.tests} tests passed`);
    ensure(summary.fail === 0 && summary.cancelled === 0, `${summary.fail} failed and ${summary.cancelled} cancelled tests`);
    ensure(summary.skipped === 0 && summary.todo === 0, `${summary.skipped} skipped and ${summary.todo} todo tests; nightly suites may not skip`);
  }
  return { summaries: summaries.length, tests: summaries.reduce((sum, s) => sum + s.tests, 0) };
}

/** Applies a module's reviewed, expiring exceptions (scripts/audit-exceptions.mjs).
 * An expired, mismatched or unused exception is itself a failure. */
export function exceptedNpmAudit(report, exceptions, lock, level = 'high', now = new Date()) {
  ensure(report && typeof report === 'object' && !Array.isArray(report), 'npm audit did not return a JSON report');
  ensure(!report.error, `npm audit failed: ${String(report.error?.code ?? report.error?.summary ?? 'error').slice(0, 120)}`);
  const applied = applyNpmAuditExceptions(report, exceptions, lock, { now });
  return { ...evaluateNpmAudit(applied.report, level), excepted: applied.excepted, problems: [...applied.problems, ...applied.unused.map(e => `unused exception ${e}`)] };
}
export function exceptedOsv(report, exceptions, lock, now = new Date()) {
  const applied = applyOsvExceptions(report, exceptions, lock, { now });
  return { blocking: applied.remaining, excepted: applied.excepted, problems: [...applied.problems, ...applied.unused.map(e => `unused exception ${e}`)] };
}

function summarize(scanner, results) {
  for (const r of results) {
    if (r.error) { console.log(`${scanner} ${r.lockfile}: ERROR ${r.error}`); continue; }
    console.log(`${scanner} ${r.lockfile}: ${r.blocking.length ? `FINDINGS ${r.blocking.join(', ')}` : 'no unexcepted findings'}${r.excepted.length ? `; excepted ${r.excepted.join(', ')}` : ''}`);
    for (const problem of r.problems) console.log(`${scanner} ${r.lockfile}: EXCEPTION ${problem}`);
  }
  const failed = results.filter(r => r.error || r.blocking.length || r.problems.length);
  ensure(failed.length === 0, `${scanner} failed for: ${failed.map(r => r.lockfile).join(', ')}`);
  return { state: 'passed', scanner, lockfiles: results.length };
}

async function auditAll(root = ROOT, level = 'high') {
  const results = [];
  for (const lockfile of moduleLockfiles()) {
    const directory = path.dirname(lockfile), cwd = path.join(root, directory);
    let stdout;
    // npm audit exits nonzero when it finds anything; the JSON report decides.
    try { ({ stdout } = await exec('npm', ['audit', '--package-lock-only', '--json', '--workspaces=false'], { cwd, maxBuffer: 64 * 1024 * 1024 })); }
    catch (error) { stdout = error.stdout; }
    try {
      let report;
      try { report = JSON.parse(stdout); } catch { report = undefined; }
      results.push({ lockfile, ...exceptedNpmAudit(report, await loadModuleExceptions(directory, root), await readJson(path.join(root, lockfile)), level) });
    } catch (error) { results.push({ lockfile, error: error.message }); }
  }
  return summarize(`npm audit (${level})`, results);
}

/** Runs osv-scanner once per module lock (JSON output) and applies that module's exceptions. */
async function osvAll(scanner, root = ROOT) {
  const results = [];
  for (const lockfile of moduleLockfiles()) {
    const directory = path.dirname(lockfile);
    let stdout, code = 0;
    try { ({ stdout } = await exec(scanner, ['scan', 'source', '--format', 'json', `--lockfile=${lockfile}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 })); }
    catch (error) { stdout = error.stdout; code = error.code; }
    try {
      // osv-scanner exits 1 when it found vulnerabilities; anything else is a scanner failure.
      ensure(code === 0 || code === 1, `osv-scanner exited ${code}`);
      let report;
      try { report = JSON.parse(stdout); } catch { throw new Error('osv-scanner did not return JSON'); }
      results.push({ lockfile, ...exceptedOsv(report, await loadModuleExceptions(directory, root), await readJson(path.join(root, lockfile))) });
    } catch (error) { results.push({ lockfile, error: error.message }); }
  }
  return summarize('osv-scanner', results);
}

export async function nightlyMain(args = process.argv.slice(2)) {
  requireNode26();
  const [action, value, ...rest] = args;
  if (action === 'lockfiles' && value === undefined) { for (const file of moduleLockfiles()) console.log(`--lockfile=${file}`); return; }
  if (action === 'audit' && rest.length === 0) return auditAll(ROOT, value ?? 'high');
  if (action === 'osv' && value && rest.length === 0) return osvAll(path.resolve(value));
  if (action === 'no-skips' && value && rest.length === 0) return requireNoSkips(await readFile(value, 'utf8'));
  throw new Error('Use: lockfiles | audit [level] | osv <osv-scanner> | no-skips <log>');
}
if (isMain(import.meta.url)) nightlyMain().then(result => { if (result) console.log(JSON.stringify(result)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
