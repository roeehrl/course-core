import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

// Runs checkVisual for the main thread's visual-check pool (svg-renderer.ts). Each message
// is the exact JSON text whose SHA-256 the main thread records when the check passes.
//
// Before loading the check, and again after, the worker verifies that the visuals package it
// resolves is the expected directory and that every dist file and package.json still have the
// digests the main thread computed at startup. On any difference it exits without answering,
// which stops the pool; the main thread's own check, loaded at startup, then decides.
const { check, dist, files, manifest } = workerData as { check: string; dist: string; files: Record<string, string>; manifest: string };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function verify(): Promise<boolean> {
  const loaded = path.dirname(fileURLToPath(import.meta.resolve('@course-core/visuals/headless')));
  if (await realpath(loaded) !== await realpath(dist)) return false;
  if (sha256(await readFile(path.join(dist, '..', 'package.json'))) !== manifest) return false;
  const found: Record<string, string> = {};
  async function collect(relative: string): Promise<boolean> {
    for (const entry of await readdir(path.join(dist, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!await collect(name)) return false; }
      else if (!entry.isFile()) return false;
      else found[name] = sha256(await readFile(path.join(dist, name)));
    }
    return true;
  }
  if (!(await lstat(dist)).isDirectory() || !await collect('')) return false;
  const expected = Object.entries(files);
  return expected.length === Object.keys(found).length && expected.every(([name, digest]) => found[name] === digest);
}

if (!await verify().catch(() => false)) process.exit(1);
const { checkVisual } = await import(check);
if (!await verify().catch(() => false)) process.exit(1);
// Answers the passed scene's required render features, or false.
parentPort!.on('message', (json: string) => {
  let answer: false | string[] = false;
  try { answer = [...checkVisual(JSON.parse(json))]; } catch { answer = false; }
  parentPort!.postMessage(answer);
});
