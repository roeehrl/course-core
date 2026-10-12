import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Node resolves imported file URLs through filesystem aliases; argv may retain one. */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}
