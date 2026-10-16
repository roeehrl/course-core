import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Adapter digests hash compiled function source text, so they are only meaningful
// from a tsc build like the dist that production runs; vitest's transformed modules
// would hash differently. The test compiles the current source into its own
// directory and computes them there in a plain node process, so it never depends on
// whether services/api/dist exists or is stale. The directory sits inside this
// package so the build resolves the same node_modules as dist would.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const record = JSON.parse(readFileSync(path.join(root, 'adapter-digests.json'), 'utf8')) as Record<string, string>;
let digests: Record<string, string> | undefined;
function built(): Record<string, string> {
  if (digests) return digests;
  const out = mkdtempSync(path.join(root, '.adapter-digests-build-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--outDir', out], { cwd: root, encoding: 'utf8' });
    digests = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/check-adapter-digests.mjs'), '--json', '--dist', out], { cwd: root, encoding: 'utf8' })) as Record<string, string>;
    return digests;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
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
