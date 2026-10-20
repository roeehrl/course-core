import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MODULES, ROOT, ensure, readJson, requireNode26 } from './modules.mjs';
import { isMain } from './is-main.mjs';

// Dependency advisory exceptions. A module may keep an `audit-exceptions.json`
// next to its package-lock.json. Each entry excuses exactly one advisory for
// one package at exact locked versions, reached only through named dependents,
// until a review date no more than MAX_EXCEPTION_DAYS after it was added.
// Anything else in a scan still fails. There is no wildcard, severity or
// package-wide ignore, and an exception that no longer matches a finding
// fails the scan so it gets removed.

const exec = promisify(execFile);
export const EXCEPTIONS_FILE = 'audit-exceptions.json';
export const MAX_EXCEPTION_DAYS = 120;
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const ENTRY_KEYS = ['id', 'aliases', 'package', 'versions', 'introducedBy', 'severity', 'scope', 'reason', 'upstream', 'added', 'reviewBy'];
const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;

function day(value, label) {
  ensure(typeof value === 'string' && DATE.test(value), `${label} must be a YYYY-MM-DD date`);
  const time = Date.parse(`${value}T00:00:00Z`);
  ensure(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, `${label} is not a real date`);
  return time;
}
const today = now => Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
const list = (value, label, pattern, { empty = false } = {}) => {
  ensure(Array.isArray(value) && (empty || value.length > 0), `${label} must be a${empty ? 'n' : ' non-empty'} array`);
  ensure(value.every(item => typeof item === 'string' && pattern.test(item)), `${label} has an invalid item`);
  ensure(new Set(value).size === value.length, `${label} has duplicates`);
  return value;
};

/** Validates an exceptions document. Structure is checked strictly; expiry is
 * reported separately so a scan can say which entry needs review. */
export function parseExceptions(document, label = EXCEPTIONS_FILE) {
  ensure(document && typeof document === 'object' && !Array.isArray(document), `${label}: must be a JSON object`);
  ensure(Object.keys(document).sort().join() === 'exceptions,version' && document.version === 1, `${label}: expected exactly {version: 1, exceptions: [...]}`);
  ensure(Array.isArray(document.exceptions), `${label}: exceptions must be an array`);
  const seen = new Set();
  return document.exceptions.map((entry, index) => {
    const where = `${label}: exceptions[${index}]`;
    ensure(entry && typeof entry === 'object' && !Array.isArray(entry), `${where} must be an object`);
    ensure(Object.keys(entry).sort().join() === [...ENTRY_KEYS].sort().join(), `${where} must have exactly: ${ENTRY_KEYS.join(', ')}`);
    ensure(typeof entry.id === 'string' && GHSA.test(entry.id), `${where}.id must be one GHSA advisory id`);
    list(entry.aliases, `${where}.aliases`, /^(?:GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})$/, { empty: true });
    ensure(typeof entry.package === 'string' && PACKAGE.test(entry.package), `${where}.package must be one npm package name`);
    list(entry.versions, `${where}.versions`, VERSION);
    list(entry.introducedBy, `${where}.introducedBy`, PACKAGE);
    ensure(SEVERITIES.includes(entry.severity), `${where}.severity is unknown`);
    ensure(entry.scope === 'build-tooling', `${where}.scope must be "build-tooling"; shipped runtime code cannot be excepted`);
    for (const key of ['reason', 'upstream']) ensure(typeof entry[key] === 'string' && entry[key].trim().length >= 40 && entry[key].length <= 1200, `${where}.${key} must explain the exception (40-1200 characters)`);
    const added = day(entry.added, `${where}.added`), reviewBy = day(entry.reviewBy, `${where}.reviewBy`);
    ensure(reviewBy > added && reviewBy - added <= MAX_EXCEPTION_DAYS * DAY, `${where}.reviewBy must be after added and within ${MAX_EXCEPTION_DAYS} days of it`);
    const key = `${entry.id}\0${entry.package}`;
    ensure(!seen.has(key), `${where} duplicates ${entry.id} for ${entry.package}`);
    seen.add(key);
    return Object.freeze({ ...entry, aliases: [...entry.aliases], versions: [...entry.versions], introducedBy: [...entry.introducedBy] });
  });
}

/** Locked versions of a package and the packages that declare it, from a v3 lock. */
export function lockedPackage(lock, name) {
  ensure(lock?.lockfileVersion === 3 && lock.packages && typeof lock.packages === 'object', 'Expected a lockfileVersion 3 package-lock.json');
  const versions = new Set(), dependents = new Set();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location.replace(/^.*node_modules\//, '') === name && location.includes('node_modules/')) versions.add(entry.version);
    const declared = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies, ...entry.devDependencies };
    if (Object.hasOwn(declared, name)) dependents.add(location === '' ? '<root>' : location.replace(/^.*node_modules\//, ''));
  }
  return { versions: [...versions].sort(), dependents: [...dependents].sort() };
}

/** Why an exception does or does not cover `packageName` with `ids` in this lock. */
function matches(exception, ids, packageName, lock, now) {
  if (exception.package !== packageName || !ids.some(id => id === exception.id || exception.aliases.includes(id))) return undefined;
  if (today(now) > day(exception.reviewBy, 'reviewBy')) return { exception, problem: `expired on ${exception.reviewBy}; review ${exception.id} again` };
  const locked = lockedPackage(lock, packageName);
  const versions = locked.versions.filter(version => !exception.versions.includes(version));
  if (versions.length) return { exception, problem: `locked ${packageName} ${versions.join(', ')} is not listed; review ${exception.id} again` };
  const dependents = locked.dependents.filter(name => !exception.introducedBy.includes(name));
  if (dependents.length) return { exception, problem: `${packageName} is now also required by ${dependents.join(', ')}; review ${exception.id} again` };
  return { exception };
}
function cover(exceptions, ids, packageName, lock, now) {
  const results = exceptions.map(exception => matches(exception, ids, packageName, lock, now)).filter(Boolean);
  return results.find(result => !result.problem) ?? results[0];
}

/** Applies exceptions to `npm audit --json` output. Returns an npm audit
 * shaped report without the excepted findings (and the findings that are only
 * vulnerable through them), with recomputed counts, plus what was used. */
export function applyNpmAuditExceptions(report, exceptions, lock, { now = new Date() } = {}) {
  ensure(report && typeof report === 'object' && !Array.isArray(report) && !report.error, 'npm audit did not return a usable JSON report');
  const findings = report.vulnerabilities ?? {};
  const used = new Map(), problems = [];
  const blocked = new Set();
  for (const [name, finding] of Object.entries(findings)) {
    ensure(Array.isArray(finding?.via) && SEVERITIES.includes(finding.severity), `npm audit finding ${name} is malformed`);
    for (const via of finding.via) {
      if (typeof via === 'string') { if (!Object.hasOwn(findings, via)) blocked.add(name); continue; }
      const id = /\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(String(via?.url ?? ''))?.[1];
      const result = id && cover(exceptions, [id], via.name, lock, now);
      if (result?.problem) problems.push(`${result.exception.id} (${result.exception.package}): ${result.problem}`);
      if (result && !result.problem) used.set(result.exception, (used.get(result.exception) ?? new Set()).add(name));
      else blocked.add(name);
    }
  }
  // A finding that is only vulnerable through other findings stays blocked if any of them is.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, finding] of Object.entries(findings)) {
      if (!blocked.has(name) && finding.via.some(via => typeof via === 'string' && blocked.has(via))) { blocked.add(name); changed = true; }
    }
  }
  const vulnerabilities = Object.fromEntries(Object.entries(findings).filter(([name]) => blocked.has(name)));
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, Object.values(vulnerabilities).filter(f => f.severity === severity).length]));
  counts.total = SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
  const excepted = Object.keys(findings).filter(name => !blocked.has(name)).sort();
  return {
    report: { ...report, vulnerabilities, metadata: { ...report.metadata, vulnerabilities: counts } },
    excepted, problems, unused: exceptions.filter(exception => !used.has(exception)).map(e => `${e.id} (${e.package})`),
  };
}

/** Applies exceptions to `osv-scanner scan source --format json` output. */
export function applyOsvExceptions(report, exceptions, lock, { now = new Date() } = {}) {
  ensure(report && Array.isArray(report.results), 'osv-scanner did not return a JSON report with results');
  const used = new Set(), problems = [], remaining = [], excepted = [];
  for (const result of report.results) for (const found of result.packages ?? []) {
    const name = found?.package?.name, version = found?.package?.version, ecosystem = found?.package?.ecosystem;
    for (const vulnerability of found.vulnerabilities ?? []) {
      const ids = [vulnerability.id, ...(vulnerability.aliases ?? [])].filter(id => typeof id === 'string');
      const match = ecosystem === 'npm' && cover(exceptions, ids, name, lock, now);
      const ok = match && !match.problem && match.exception.versions.includes(version);
      if (match?.problem) problems.push(`${match.exception.id} (${name}): ${match.problem}`);
      const line = `${name}@${version} ${vulnerability.id}`;
      if (ok) { used.add(match.exception); excepted.push(line); } else remaining.push(line);
    }
  }
  return { remaining: remaining.sort(), excepted: excepted.sort(), problems, unused: exceptions.filter(e => !used.has(e)).map(e => `${e.id} (${e.package})`) };
}

export async function loadModuleExceptions(directory, root = ROOT) {
  let text;
  try { text = await readFile(path.join(root, directory, EXCEPTIONS_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return parseExceptions(JSON.parse(text), `${directory}/${EXCEPTIONS_FILE}`);
}
function moduleDirectory(value) {
  const module = Object.values(MODULES).find(entry => entry.directory === value);
  ensure(module, `Unknown module directory: ${value}`);
  return module.directory;
}
function finish(label, { problems, unused }, blocking, excepted) {
  for (const line of excepted) console.log(`${label}: excepted ${line}`);
  for (const line of blocking) console.log(`${label}: FINDING ${line}`);
  for (const line of problems) console.log(`${label}: EXCEPTION ${line}`);
  for (const line of unused) console.log(`${label}: UNUSED EXCEPTION ${line}; remove it`);
  ensure(blocking.length === 0 && problems.length === 0 && unused.length === 0, `${label}: dependency scan failed`);
  return { state: 'passed', module: label, excepted: excepted.length };
}

async function npmAudit(directory, level, root = ROOT) {
  ensure(SEVERITIES.includes(level), 'Unknown audit level');
  const cwd = path.join(root, directory);
  let stdout;
  // npm audit exits nonzero when it finds anything; the JSON report decides.
  try { ({ stdout } = await exec('npm', ['audit', '--package-lock-only', '--json', '--workspaces=false'], { cwd, maxBuffer: 64 * 1024 * 1024 })); }
  catch (error) { stdout = error.stdout; }
  let report;
  try { report = JSON.parse(stdout); } catch { throw new Error(`${directory}: npm audit did not return JSON`); }
  const result = applyNpmAuditExceptions(report, await loadModuleExceptions(directory, root), await readJson(path.join(cwd, 'package-lock.json')));
  const threshold = SEVERITIES.indexOf(level);
  const blocking = Object.entries(result.report.vulnerabilities).filter(([, f]) => SEVERITIES.indexOf(f.severity) >= threshold).map(([name, f]) => `${name} (${f.severity})`).sort();
  return finish(directory, result, blocking, result.excepted.map(name => `${name} (${report.vulnerabilities[name].severity})`));
}

async function osvReport(directory, file, root = ROOT) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  const result = applyOsvExceptions(report, await loadModuleExceptions(directory, root), await readJson(path.join(root, directory, 'package-lock.json')));
  return finish(directory, result, result.remaining, result.excepted);
}

export async function auditExceptionsMain(args = process.argv.slice(2)) {
  requireNode26();
  const [action, directory, value, ...rest] = args;
  if (action === 'validate' && directory === undefined) {
    for (const module of Object.values(MODULES)) await loadModuleExceptions(module.directory);
    return { state: 'valid' };
  }
  if (action === 'npm' && directory && rest.length === 0) return npmAudit(moduleDirectory(directory), value ?? 'high');
  if (action === 'osv' && directory && value && rest.length === 0) return osvReport(moduleDirectory(directory), value);
  throw new Error('Use: validate | npm <module-directory> [level] | osv <module-directory> <osv-scanner.json>');
}
if (isMain(import.meta.url)) auditExceptionsMain().then(result => { if (result) console.log(JSON.stringify(result)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
