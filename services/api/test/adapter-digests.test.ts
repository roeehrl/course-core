import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Adapter digests hash compiled function source text, so they are only meaningful
// from the built dist that production runs; vitest's transformed modules would hash
// differently. Compute them in a plain node process from dist (built by the
// orchestrated check before tests run).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const record = JSON.parse(readFileSync(path.join(root, 'adapter-digests.json'), 'utf8')) as Record<string, string>;
function built(): Record<string, string> {
  if (!existsSync(path.join(root, 'dist/adaptation-composition.js'))) throw new Error('services/api/dist is missing; run npm run build first');
  return JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/check-adapter-digests.mjs'), '--json'], { cwd: root, encoding: 'utf8' }));
}

describe('built-in adaptation adapter digests', () => {
  it('keeps the code-bank digest that approved registries pin (regressed in 0.1.33)', () => {
    const CODE_BANK = '05d8ba2439c6b2e26a06a1dfd4d366700f08a3b964eb1f1d24ea3fd73e9f7cc2';
    expect(record['authored-code-bank-v1']).toBe(CODE_BANK);
    expect(built()['authored-code-bank-v1']).toBe(CODE_BANK);
  });

  it('matches adapter-digests.json for every built-in adapter', () => {
    expect(built()).toEqual(record);
  });
});
