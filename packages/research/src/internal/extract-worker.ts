import { parentPort, workerData } from 'node:worker_threads';
import { extractReadable } from './extract.js';
import { ResearchError } from '../errors.js';
try { parentPort!.postMessage({ result: extractReadable(workerData.body as Uint8Array, workerData.mediaType as string) }); }
catch (error) { parentPort!.postMessage({ error: error instanceof ResearchError ? error.code : 'HTML_LIMIT' }); }
