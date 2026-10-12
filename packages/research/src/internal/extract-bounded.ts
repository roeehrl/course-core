import { Worker } from 'node:worker_threads';
import { ResearchError } from '../errors.js';
import { abortReason } from './network.js';
import type { extractReadable } from './extract.js';

/** Parsing also shares the total deadline; malicious HTML cannot block the
 * application's event loop or defeat that deadline with synchronous parsing. */
export function extractBounded(body: Uint8Array, mediaType: string, signal: AbortSignal): Promise<ReturnType<typeof extractReadable>> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
      workerData: { body, mediaType }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error?: ResearchError, result?: ReturnType<typeof extractReadable>) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort); void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', message => finish(message.error ? new ResearchError(message.error) : undefined, message.result));
    worker.once('error', () => finish(new ResearchError('HTML_LIMIT')));
    worker.once('exit', () => { if (!settled) finish(new ResearchError('HTML_LIMIT')); });
  });
}
