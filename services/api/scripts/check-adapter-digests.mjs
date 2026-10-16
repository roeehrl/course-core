// Verifies the built-in adaptation adapters' implementationDigest values against
// services/api/adapter-digests.json.
//
// Each digest hashes the compiled source text (Function.prototype.toString) of the
// adapter and of the functions it lists, so it must be computed from the BUILT dist
// that `node dist/main.js` runs. vitest/tsx transform source differently and would
// produce other digests. Run after `npm run build`:
//   node scripts/check-adapter-digests.mjs           # check (CI)
//   node scripts/check-adapter-digests.mjs --json    # print the built digests
//   node scripts/check-adapter-digests.mjs --json --dist <dir>  # from another build of this API
//   node scripts/check-adapter-digests.mjs --update  # rewrite the record (deliberate breaks only)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordFile = path.join(root, 'adapter-digests.json');

export async function builtAdapterDigests(dist = path.join(root, 'dist')) {
  const { composeAdaptation } = await import(pathToFileURL(path.join(dist, 'adaptation-composition.js')).href);
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  const runtime = composeAdaptation(Object.keys(record), []);
  return Object.fromEntries(runtime.adapters.map(adapter => [adapter.id, adapter.implementationDigest]));
}

async function main(args) {
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  // --dist <dir> reads another build of this API (the test builds a fresh one).
  const at = args.indexOf('--dist');
  const built = await builtAdapterDigests(at >= 0 ? path.resolve(args[at + 1]) : undefined);
  if (args.includes('--json')) { console.log(JSON.stringify(built, null, 2)); return; }
  if (args.includes('--update')) {
    await writeFile(recordFile, JSON.stringify(built, null, 2) + '\n');
    console.log(`Recorded built adapter digests in ${path.relative(process.cwd(), recordFile)}.`);
    return;
  }
  const changed = Object.keys(record).filter(id => built[id] !== record[id]);
  if (changed.length) {
    for (const id of changed) {
      console.error(`Adapter ${id}: built implementationDigest ${built[id]} differs from the recorded ${record[id]}.`);
    }
    console.error([
      'Approved registries pin this digest; a changed digest stops every approved adaptation profile for',
      'this adapter from resolving (ADAPTATION_ADAPTER_NOT_INSTALLED / installed_creator_digest_mismatch).',
      'The digest covers the compiled source text of the adapter and every function it lists, including',
      'comments and refactors that do not change behaviour. Restore the previous source text, or, if the',
      'behaviour change is deliberate, record it with `node scripts/check-adapter-digests.mjs --update`',
      'and document the break in the release notes (see RELEASES.md).',
    ].join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`Built adapter digests match adapter-digests.json (${Object.keys(record).length} adapters).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`Adapter digest check failed: ${error.message}`); process.exitCode = 1; });
}
