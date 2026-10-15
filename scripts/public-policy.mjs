import path from 'node:path';
import { DEPENDENCY_FIELDS, MODULES, ensure, localModuleTarget, sdkReleaseUrl, assertLockRoot } from './modules.mjs';

export function auditRepositoryReferences(label, text) {
  const normalized = text.replace(/\\\//g, '/').replace(/(?:%[0-9a-f]{2})+/gi, (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  });
  const allowed = new Set(['course-sdk', 'course-core']);
  const references = /(?:^|[^A-Za-z0-9_./:@-])(?:(?:https?|git|ssh|git\+https?|git\+ssh):\/\/(?:[^/\s@]+@)?|git@)?(github\.com|www\.github\.com|raw\.githubusercontent\.com|api\.github\.com|codeload\.github\.com)(?::\d+)?[/:]([^\s"'`<>()\[\]{}?#]+)/gi;
  for (const match of normalized.matchAll(references)) {
    const host = match[1].toLowerCase();
    const parts = new URL(`https://${host}/${match[2]}`).pathname.slice(1).split('/');
    if (host === 'api.github.com' && parts.shift()?.toLowerCase() !== 'repos') continue;
    if (parts[0]?.toLowerCase() !== 'roeehrl' || !parts[1]) continue;
    ensure(allowed.has(parts[1].toLowerCase().replace(/\.git$/, '')), `${label}: owner repository is outside the public allowlist (value redacted)`);
  }
}

export function auditFilename(filename) {
  ensure(!filename.split('/').some((part) => part === '.gitmodules' || /^\.env(?:\.|$)/.test(part) && part !== '.env.example'), `${filename}: private configuration cannot be published`);
  ensure(!/\.(?:pem|key|p12|pfx|keystore|sqlite3?|db|dump|pgdump|mobileprovision|tgz|zip)$/i.test(filename), `${filename}: private material or unreviewable archive/database file is forbidden`);
}
export function auditText(label, text) {
  auditRepositoryReferences(label, text);
  const patterns = [
    ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{30,})\b/],
    ['npm token', /\bnpm_[A-Za-z0-9]{36,}\b/],
    ['cloud credential', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['service credential', /\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{35})\b/],
    ['literal credential', /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_+./=-]{16,}["']/i],
    ['host path', /(?:\/Users\/[^/\s"']+\/|\/home\/[^/\s"']+\/|[A-Z]:[\\/]Users[\\/])/i],
  ];
  for (const [kind, expression] of patterns) ensure(!expression.test(text), `${label}: possible ${kind} (value redacted)`);
  for (const match of text.matchAll(/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s"'`<>]+/gi)) {
    let url;
    try { url = new URL(match[0]); } catch { throw new Error(`${label}: malformed credential URL (value redacted)`); }
    // A literal user/password pair on an IANA example domain is a rejection
    // fixture, not a usable credential. Do not exempt entire tests or directories.
    const example = url.username === 'user' && url.password === 'password' && /^(?:example\.(?:com|org|net)|(?:[a-z0-9-]+\.)*(?:example|invalid|test))$/.test(url.hostname);
    const negativeTest = /(?:^|\/)(?:test|tests)\//.test(label) && url.username === 'user' && url.password === 'key';
    ensure(example || negativeTest,
      `${label}: possible URL credential (value redacted)`);
  }
  // Database examples may use only the documented disposable loopback credentials.
  for (const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi)) {
    let url;
    try { url = new URL(match[0]); } catch { throw new Error(`${label}: malformed database URL (value redacted)`); }
    if (!url.password || /^\$\{[A-Z_]+\}$/.test(url.password)) continue;
    ensure(['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname) && url.username === 'course_ci' &&
      url.password === 'course_ci_test_only' && /^\/course_core_(?:ci|test)$/.test(url.pathname), `${label}: non-demo database credential (value redacted)`);
  }
}

export function auditNpmrc(label, text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const match = /^\s*([a-z-]+)\s*=\s*(.*?)\s*$/.exec(line);
    ensure(match, `${label}: npm credentials/scoped configuration is forbidden`);
    const [, key, value] = match;
    ensure(['workspaces', 'audit', 'fund', 'cache', 'registry', 'ignore-scripts', 'engine-strict', 'install-links'].includes(key), `${label}: unapproved npm configuration`);
    if (key === 'registry') ensure(value === 'https://registry.npmjs.org/', `${label}: only public npm is allowed`);
    if (key === 'ignore-scripts') ensure(value === 'true', `${label}: install hooks must remain disabled`);
    if (key === 'install-links') ensure(value === 'true' || value === 'false', `${label}: install-links must be a boolean`);
    if (key === 'cache') ensure(!path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), `${label}: cache must remain local`);
  }
}

/**
 * Local modules resolve as symlinks so a rebuilt prerequisite is visible to its
 * consumers without a reinstall. Only registry modules marked copiesLocal may
 * use npm's install-links=true copies (refreshed by `check` after rebuilds).
 * This governs install mode only; auditDependencies accepts both lock forms.
 */
export function auditLocalInstallMode(name, lock, npmrc = '', registry = MODULES) {
  const label = registry[name]?.directory ?? name;
  ensure(Object.hasOwn(registry, name), `${label}: unknown module`);
  if (registry[name].copiesLocal) return;
  for (const line of npmrc.split(/\r?\n/)) {
    const match = /^\s*install-links\s*=\s*(.*?)\s*$/.exec(line);
    ensure(!match || match[1] === 'false', `${label}: local modules must be linked (install-links=false), not copied`);
  }
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    ensure(!(location.startsWith('node_modules/') && !entry.link && entry.resolved?.startsWith('file:')),
      `${label}: ${location} is a copied local module; reinstall with install-links=false so it is a link`);
  }
}

export function auditDependencies(manifest, lock, directory, root, label) {
  assertLockRoot(manifest, lock, label);
  ensure(!manifest.workspaces && !manifest.bundledDependencies && !manifest.bundleDependencies && !manifest.overrides, `${label}: unexpected workspace/bundle/override dependency policy`);
  const sdkUrls = new Set();
  const inspect = (dependencies, declaringDirectory = directory) => {
    for (const [name, spec] of Object.entries(dependencies ?? {})) {
      ensure(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) && typeof spec === 'string', `${label}: invalid dependency declaration`);
      if (name === '@course-core/sdk') {
        ensure(sdkReleaseUrl(spec), `${label}: SDK must use an explicit public release asset URL`);
        sdkUrls.add(spec);
      } else if (spec.startsWith('file:')) ensure(localModuleTarget(name, spec, declaringDirectory, root), `${label}: local dependency name and path must match a registered module`);
      else ensure(/^[v~^<>=*\d]/.test(spec) && /^[v~^<>=*0-9A-Za-z.|+\s-]+$/.test(spec), `${label}: dependency must be a public registry version/range`);
    }
  };
  for (const field of DEPENDENCY_FIELDS) inspect(manifest[field]);
  // Local entries declare their own relative paths, not paths relative to the
  // consumer. Collect released SDK URLs before checking hoisted remote entries.
  const localEntries = new Set();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    const installed = location.startsWith('node_modules/');
    if (installed) ensure(!location.includes('\\') && location.split('/').every((part) => part && part !== '.' && part !== '..'), `${label}: unsafe lockfile package path`);
    if (installed && !entry.link && !entry.resolved?.startsWith('file:')) continue;
    const packageName = installed ? /(?:^|\/)node_modules\/(@course-core\/[^/]+)$/.exec(location)?.[1] : entry.name;
    const module = localModuleTarget(packageName, installed ? entry.resolved : location, directory, root);
    ensure(module, `${label}: unexpected local lockfile package/link`);
    localEntries.add(location);
    for (const field of DEPENDENCY_FIELDS) inspect(entry[field], path.join(root, MODULES[module].directory));
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || localEntries.has(location)) continue;
    let url;
    try { url = new URL(entry.resolved); } catch { throw new Error(`${label}: unresolved or invalid dependency URL`); }
    const npm = url.origin === 'https://registry.npmjs.org' && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('.tgz');
    const sdk = sdkReleaseUrl(entry.resolved) && sdkUrls.has(entry.resolved);
    const isSdk = /(?:^|\/)node_modules\/@course-core\/sdk$/.test(location);
    ensure(isSdk ? sdk : npm, `${label}: unapproved dependency tarball source`);
    ensure(/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? ''), `${label}: every remote dependency needs SHA-512 integrity`);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) inspect(entry[field], path.join(directory, location));
  }
}
