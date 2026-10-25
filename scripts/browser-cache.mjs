// CI browser setup cache. Playwright's `install --with-deps` downloads the browsers from its CDN
// and about 120 MB of Ubuntu packages from the runner's apt mirror on every run. A slow mirror once
// spent 20 minutes on those packages and the job hit its limit before the suite finished. The
// workflow keeps both downloads in one actions/cache entry per job:
//
//   key <label> <module>...  names the entry: runner image, architecture, the job's label and the
//                            Playwright version the modules lock. Older entries for the same label
//                            restore by prefix; Playwright removes browser revisions it no longer uses.
//   apt-restore              copies the cached .deb files into apt's own root-owned archive and
//                            deletes every copy whose SHA-256 differs from the signed apt index
//                            (apt itself only compares the size of a file already in its archive).
//   apt-collect              replaces the cached .deb files with the installed versions in apt's
//                            archive, so the entry never accumulates superseded packages.
//
// The apt commands run only on GitHub-hosted Linux runners; they use passwordless sudo there.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isMain } from './is-main.mjs';
import { MODULES, ROOT, ensure, readJson } from './modules.mjs';

const exec = promisify(execFile);

/** The workflow's actions/cache path for the packages; scripts/workflow-policy.test.mjs keeps them equal. */
export const APT_ARCHIVE_CACHE = '~/.cache/course-ci/apt-archives';
export const APT_ARCHIVES = '/var/cache/apt/archives';
export const APT_KEEP_CONFIG = '/etc/apt/apt.conf.d/90course-ci-keep-archives';
const KEY_VERSION = 'v1';

const resolveHome = (value) => value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;

/** { key, restoreKeys } for one job's entry. The newest entry with the same Playwright version wins, then any for the label. */
export function cacheKey({ label, versions, imageOS, imageVersion, arch }) {
  ensure(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label ?? ''), 'Browser cache label must be lowercase words joined by hyphens');
  ensure(/^[a-z]+[0-9]+$/.test(imageOS ?? '') && /^[0-9]+(?:\.[0-9]+)+$/.test(imageVersion ?? '') && /^(?:X64|ARM64)$/.test(arch ?? ''),
    'Browser cache keys need the GitHub-hosted runner image (ImageOS, ImageVersion) and architecture (RUNNER_ARCH)');
  ensure(Array.isArray(versions) && versions.length > 0 && versions.every((version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)),
    'Browser cache keys need the exact locked Playwright version');
  const prefix = `browsers-${KEY_VERSION}-${imageOS}-${arch}-${label}-`;
  const playwright = `${prefix}pw${[...new Set(versions)].sort().join('+')}-`;
  return { key: `${playwright}${imageVersion}`, restoreKeys: [playwright, prefix] };
}

/** The exact playwright-core versions the modules' lockfiles install. */
export async function playwrightVersions(names, root = ROOT) {
  ensure(names.length > 0, 'Name at least one module whose Playwright browsers the job installs');
  const versions = [];
  for (const name of names) {
    ensure(Object.hasOwn(MODULES, name) && (MODULES[name].web || MODULES[name].browser), `${name} is not a registered browser module`);
    const lock = await readJson(path.join(root, MODULES[name].directory, 'package-lock.json'));
    const version = lock.packages?.['node_modules/playwright-core']?.version;
    ensure(typeof version === 'string', `${MODULES[name].directory}: the lockfile does not install playwright-core`);
    versions.push(version);
  }
  return [...new Set(versions)].sort();
}

/** GitHub step outputs; a multi-line value uses a delimiter that cannot occur in it. */
export function githubOutput(values, delimiter = `course_ci_${randomBytes(8).toString('hex')}`) {
  return Object.entries(values).map(([name, value]) => {
    if (!Array.isArray(value)) { ensure(!/[\r\n]/.test(value), `${name} must be a single line`); return `${name}=${value}\n`; }
    ensure(value.every((line) => !/[\r\n]/.test(line) && line !== delimiter), `${name} lines must be single lines`);
    return `${name}<<${delimiter}\n${value.join('\n')}\n${delimiter}\n`;
  }).join('');
}

// apt names an archive <package>_<version>_<architecture>.deb, with `_`, `:` (and `.` in the
// architecture) percent-encoded. Package names never contain `_`, so a valid name has three fields.
const decode = (field) => field.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
/** { package, version, architecture } for an apt archive file name, or null when it is not one. */
export function parseArchiveName(name) {
  const match = /^([a-z0-9][a-z0-9+.-]*)_([^_/\\]+)_([a-z0-9%-]+)\.deb$/.exec(name);
  if (!match) return null;
  const [pkg, version, architecture] = [match[1], decode(match[2]), decode(match[3])];
  if (!/^(?:\d+:)?[0-9][A-Za-z0-9.+~:-]*$/.test(version) || !/^[a-z0-9-]+$/.test(architecture)) return null;
  return { package: pkg, version, architecture };
}
const identity = ({ package: pkg, architecture, version }) => `${pkg}\0${architecture}\0${version}`;
/** apt-cache's selector for exactly this archive's package version. */
export const aptSelector = (archive) => `${archive.package}:${archive.architecture}=${archive.version}`;

/** Map of package identity to the SHA-256 values the signed index lists for it (`apt-cache show` output). */
export function parseAptRecords(text) {
  const records = new Map();
  for (const block of String(text).split(/\n\s*\n/)) {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (match) fields[match[1]] = match[2].trim();
    }
    if (!fields.Package || !fields.Version || !fields.Architecture || !/^[a-f0-9]{64}$/.test(fields.SHA256 ?? '')) continue;
    const key = identity({ package: fields.Package, architecture: fields.Architecture, version: fields.Version });
    if (!records.has(key)) records.set(key, new Set());
    records.get(key).add(fields.SHA256);
  }
  return records;
}

export async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/** Splits archive files in `directory` into those whose SHA-256 the signed index lists and the rest, with reasons. */
export async function verifyArchives(directory, names, records, hash = sha256) {
  const accepted = [], rejected = [];
  for (const name of names) {
    const archive = parseArchiveName(name);
    if (!archive) { rejected.push({ name, reason: 'not an apt archive name' }); continue; }
    const expected = records.get(identity(archive));
    if (!expected) { rejected.push({ name, reason: 'not in the signed package index' }); continue; }
    if (!expected.has(await hash(path.join(directory, name)))) { rejected.push({ name, reason: 'SHA-256 differs from the signed package index' }); continue; }
    accepted.push(name);
  }
  return { accepted, rejected };
}

/** The archive files whose exact package version dpkg reports as installed (`ii`). */
export function installedArchives(names, dpkgQuery) {
  const installed = new Set();
  for (const line of String(dpkgQuery).split('\n')) {
    const [status, pkg, architecture, version] = line.split('\t');
    if (status?.trim() === 'ii' && pkg && architecture && version) installed.add(identity({ package: pkg, architecture, version }));
  }
  return names.filter((name) => { const archive = parseArchiveName(name); return archive !== null && installed.has(identity(archive)); });
}

const debs = async (directory) => {
  try { return (await readdir(directory)).filter((name) => name.endsWith('.deb')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const chunks = (values, size = 200) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
const megabytes = async (directory, names) => {
  let bytes = 0;
  for (const name of names) bytes += (await stat(path.join(directory, name))).size;
  return (bytes / 1e6).toFixed(1);
};
function requireHostedLinux(environment = process.env) {
  ensure(process.platform === 'linux' && environment.GITHUB_ACTIONS === 'true' && /^ubuntu/.test(environment.ImageOS ?? ''),
    'The browser package cache changes the system apt archive; it runs only on GitHub-hosted Ubuntu runners');
}
async function sudo(args) { await exec('sudo', args, { maxBuffer: 64 * 1024 * 1024 }); }

async function aptRestore(cache) {
  requireHostedLinux();
  // apt-get (unlike apt) keeps what it downloads by default; say so, since apt-collect depends on it.
  const temporary = await mkdtemp(path.join(tmpdir(), 'course-ci-apt-'));
  try {
    await writeFile(path.join(temporary, 'keep'), 'APT::Keep-Downloaded-Packages "true";\n');
    await sudo(['install', '-m', '0644', '-o', 'root', '-g', 'root', path.join(temporary, 'keep'), APT_KEEP_CONFIG]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const names = (await debs(cache)).filter((name) => parseArchiveName(name) !== null);
  if (names.length === 0) { console.log('Browser package cache: no cached packages; apt downloads them this run.'); return; }
  await sudo(['apt-get', 'update', '-qq', '-o', 'Acquire::Retries=5']);
  // Verify the root-owned copies apt will read, not the originals, so nothing changes between check and use.
  for (const part of chunks(names)) await sudo(['install', '-m', '0644', '-o', 'root', '-g', 'root', '-t', APT_ARCHIVES, ...part.map((name) => path.join(cache, name))]);
  let index = '';
  for (const part of chunks(names.map((name) => aptSelector(parseArchiveName(name))))) {
    // apt-cache exits 100 only when it finds none of the selectors; the found records are still on stdout.
    try { index += `${(await exec('apt-cache', ['show', ...part], { maxBuffer: 64 * 1024 * 1024 })).stdout}\n\n`; }
    catch (error) { if (typeof error.stdout !== 'string') throw error; index += `${error.stdout}\n\n`; }
  }
  const { accepted, rejected } = await verifyArchives(APT_ARCHIVES, names, parseAptRecords(index));
  for (const part of chunks(rejected.map(({ name }) => path.join(APT_ARCHIVES, name)))) await sudo(['rm', '-f', '--', ...part]);
  console.log(`Browser package cache: ${accepted.length} cached packages (${await megabytes(APT_ARCHIVES, accepted)} MB) match the signed apt index; ${rejected.length} discarded.`);
  for (const { name, reason } of rejected.slice(0, 20)) console.log(`  discarded ${name}: ${reason}`);
}

async function aptCollect(cache) {
  requireHostedLinux();
  const { stdout } = await exec('dpkg-query', ['-W', '-f', '${db:Status-Abbrev}\t${Package}\t${Architecture}\t${Version}\n'], { maxBuffer: 64 * 1024 * 1024 });
  const available = await debs(APT_ARCHIVES);
  const kept = installedArchives(available, stdout);
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  for (const name of kept) await copyFile(path.join(APT_ARCHIVES, name), path.join(cache, name));
  console.log(`Browser package cache: kept ${kept.length} installed packages (${await megabytes(cache, kept)} MB) for later runs; left out ${available.length - kept.length}.`);
  // Not fatal: the run itself is fine, but every later run would download the packages again.
  if (kept.length === 0) console.log('::warning title=Browser package cache::apt kept no installed package archives; later runs download them again.');
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'key') {
    const [label, ...modules] = rest;
    const { key, restoreKeys } = cacheKey({ label, versions: await playwrightVersions(modules), imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, arch: process.env.RUNNER_ARCH });
    console.log(`Browser cache key: ${key}\nFalls back to the newest entry starting with: ${restoreKeys.join(', ')}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, githubOutput({ key, 'restore-keys': restoreKeys }));
  } else if (command === 'apt-restore' && rest.length === 0) await aptRestore(resolveHome(APT_ARCHIVE_CACHE));
  else if (command === 'apt-collect' && rest.length === 0) await aptCollect(resolveHome(APT_ARCHIVE_CACHE));
  else throw new Error('Usage: node scripts/browser-cache.mjs key <label> <module>... | apt-restore | apt-collect');
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
