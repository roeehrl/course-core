import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT, ensure, requireNode26 } from './modules.mjs';
import { isMain } from './is-main.mjs';

const exec = promisify(execFile);
const ID = /^[A-Z][0-9]{2}$/;
const REFERENCE = /^(core|sdk):([A-Za-z0-9_./@-]+)(?:::(.{3,200}))?$/;
/** Files that can hold tests: test directories, *.test/spec files, qualification gates. */
const TEST_PATH = /(?:^|\/)(?:test|tests|browser|qualification)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.integration\.ts$/;
export const SDK_REPOSITORY = 'https://github.com/roeehrl/course-sdk.git';

/** Requirement IDs defined in a requirement list: an ID that starts a line or follows a
 * sentence, then a description. Headings only cross-reference other documents. */
export function requirementIds(markdown) {
  const ids = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/(?:^|\. )([A-Z][0-9]{2}) (?=\S)/g)) ids.add(match[1]);
  }
  return [...ids].sort();
}

function parseReference(reference) {
  const match = REFERENCE.exec(reference);
  ensure(match, `Invalid test reference ${JSON.stringify(reference)}; use core:<path> or sdk:<path>, optionally ::<test title>`);
  const [, repository, file, title] = match;
  ensure(file.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe test path in ${reference}`);
  ensure(TEST_PATH.test(file), `${reference} is not a test file`);
  return { repository, file, title };
}

/** Structure only: known IDs, sorted unique lists and well-formed references. Unknown IDs fail. */
export function validateMap(map) {
  ensure(map && map.schemaVersion === 1, 'requirements-map.json must have schemaVersion 1');
  ensure(Array.isArray(map.ids) && map.ids.length > 0 && map.ids.every(id => ID.test(id)), 'ids must be a non-empty list of requirement IDs');
  ensure(map.ids.every((id, i) => i === 0 || map.ids[i - 1] < id), 'ids must be sorted and unique');
  const excluded = map.excludedPrefixes ?? {};
  ensure(Object.entries(excluded).every(([prefix, reason]) => /^[A-Z]$/.test(prefix) && typeof reason === 'string' && reason.length >= 10), 'Each excluded prefix needs a stated reason');
  ensure(!map.ids.some(id => Object.hasOwn(excluded, id[0])), 'An excluded prefix is also listed in ids');
  ensure(typeof map.repositories?.sdk?.commit === 'string' && /^[a-f0-9]{40}$/.test(map.repositories.sdk.commit), 'repositories.sdk.commit must pin a full SDK commit');
  const known = new Set(map.ids), references = [];
  ensure(map.requirements && typeof map.requirements === 'object' && !Array.isArray(map.requirements), 'requirements must map IDs to test references');
  for (const [id, list] of Object.entries(map.requirements)) {
    ensure(known.has(id), Object.hasOwn(excluded, id[0]) ? `${id} belongs to an excluded group` : `Unknown requirement ID ${id}`);
    ensure(Array.isArray(list) && list.length > 0, `${id} must list at least one test reference`);
    ensure(list.every((r, i) => i === 0 || list[i - 1] < r), `${id} references must be sorted and unique`);
    for (const reference of list) references.push({ id, reference, ...parseReference(reference) });
  }
  return references;
}

/** Each reference must name a tracked file in its repository and, with a title, contain that title. */
export async function danglingReferences(references, sources) {
  const dangling = [];
  for (const ref of references) {
    const source = sources[ref.repository];
    if (!source.files.has(ref.file)) { dangling.push(`${ref.id}: ${ref.reference} (no such tracked file)`); continue; }
    if (ref.title && !(await source.read(ref.file)).includes(ref.title)) dangling.push(`${ref.id}: ${ref.reference} (title not found)`);
  }
  return dangling;
}

export function coverage(map) {
  const uncovered = map.ids.filter(id => !map.requirements[id]);
  return { total: map.ids.length, covered: map.ids.length - uncovered.length, uncovered };
}

async function gitSource(directory, revision) {
  const { stdout } = await exec('git', ['-C', directory, 'ls-tree', '-r', '-z', '--name-only', revision], { maxBuffer: 64 * 1024 * 1024 });
  return { files: new Set(stdout.split('\0').filter(Boolean)),
    read: async file => (await exec('git', ['-C', directory, 'show', `${revision}:${file}`], { maxBuffer: 64 * 1024 * 1024 })).stdout };
}

/** The pinned public SDK commit, from a local clone that has it or by a shallow anonymous fetch. */
async function sdkSource(commit, localClone, scratch) {
  if (localClone) return gitSource(localClone, commit);
  await exec('git', ['init', '-q', scratch]);
  await exec('git', ['-C', scratch, 'fetch', '-q', '--depth', '1', '--no-tags', SDK_REPOSITORY, commit], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return gitSource(scratch, commit);
}

export async function requirementsMain(args = process.argv.slice(2), root = ROOT) {
  requireNode26();
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(['--sdk-git', '--requirements'].includes(args[i]) && args[i + 1] && !Object.hasOwn(options, args[i]), 'Use: [--sdk-git <clone>] [--requirements <list.md>]');
    options[args[i]] = path.resolve(args[i + 1]);
  }
  const map = JSON.parse(await readFile(path.join(root, 'requirements-map.json'), 'utf8'));
  const references = validateMap(map);
  if (options['--requirements']) {
    const excluded = map.excludedPrefixes ?? {};
    const listed = requirementIds(await readFile(options['--requirements'], 'utf8')).filter(id => !Object.hasOwn(excluded, id[0]));
    ensure(JSON.stringify(listed) === JSON.stringify(map.ids), `ids differ from the requirement list: missing ${listed.filter(id => !map.ids.includes(id)).join(', ') || 'none'}; extra ${map.ids.filter(id => !listed.includes(id)).join(', ') || 'none'}`);
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'requirements-map-'));
  try {
    const sources = { core: await gitSource(root, 'HEAD'), sdk: await sdkSource(map.repositories.sdk.commit, options['--sdk-git'], scratch) };
    const dangling = await danglingReferences(references, sources);
    ensure(dangling.length === 0, `Dangling test references:\n  ${dangling.join('\n  ')}`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  const report = coverage(map);
  console.log(`Requirement map: ${report.covered}/${report.total} IDs have at least one test reference (${references.length} references).`);
  if (report.uncovered.length) console.log(`Uncovered (reported, not failing): ${report.uncovered.join(' ')}`);
  return { ...report, references: references.length };
}
if (isMain(import.meta.url)) requirementsMain().catch(error => { console.error(`Requirement map check failed: ${error.message}`); process.exitCode = 1; });
