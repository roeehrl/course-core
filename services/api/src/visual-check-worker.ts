import { parentPort, workerData } from 'node:worker_threads';

// Runs checkVisual for the main thread's visual-check pool (svg-renderer.ts). Each message
// is the exact JSON text whose SHA-256 the main thread records when the check passes.
const { checkVisual } = await import((workerData as { check: string }).check);
parentPort!.on('message', (json: string) => {
  let ok = false;
  try { checkVisual(JSON.parse(json)); ok = true; } catch { ok = false; }
  parentPort!.postMessage(ok);
});
