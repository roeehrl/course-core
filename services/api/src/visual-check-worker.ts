import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

// Runs checkVisual for the main thread's visual-check pool (svg-renderer.ts). Each message
// is the exact JSON text whose SHA-256 the main thread records when the check passes.
//
// Before answering anything, the worker checks that the visuals package it loaded is the
// expected directory and that every file there still has the digest the main thread computed
// at startup (its package identity). On any difference it exits without answering, which
// stops the pool; the main thread's own check, loaded at startup, then decides.
const { check, dist, files } = workerData as { check: string; dist: string; files: Record<string, string> };
const { checkVisual } = await import(check);

async function verify(): Promise<boolean> {
  const loaded = path.dirname(fileURLToPath(import.meta.resolve('@course-core/visuals/headless')));
  if (await realpath(loaded) !== await realpath(dist)) return false;
  const found: Record<string, string> = {};
  async function collect(relative: string): Promise<boolean> {
    for (const entry of await readdir(path.join(dist, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!await collect(name)) return false; }
      else if (!entry.isFile()) return false;
      else found[name] = createHash('sha256').update(await readFile(path.join(dist, name))).digest('hex');
    }
    return true;
  }
  if (!(await lstat(dist)).isDirectory() || !await collect('')) return false;
  const expected = Object.entries(files), actual = Object.entries(found);
  return expected.length === actual.length && expected.every(([name, digest]) => found[name] === digest);
}

if (!await verify().catch(() => false)) process.exit(1);
parentPort!.on('message', (json: string) => {
  let ok = false;
  try { checkVisual(JSON.parse(json)); ok = true; } catch { ok = false; }
  parentPort!.postMessage(ok);
});
