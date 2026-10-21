// One retry policy for every locked `npm ci` (the root orchestrator and the Docker self-host
// build). Two layers:
//  1. npm's own per-request retries (fetch-retries and backoff, also set in every module
//     .npmrc). These retry a request that fails before its response arrives.
//  2. A whole-command retry here, for failures npm does not retry itself, such as a
//     connection reset while a tarball body is being read ("npm error syscall read").
// Only network-class failures are retried. A lockfile, integrity, usage or 4xx failure is a
// definitive answer and fails at once. Partial node_modules are removed before each retry.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

/** npm's per-request retry settings. Every module .npmrc must carry these exact values
 * (scripts/npm-retry.test.mjs); install paths also pass them as environment settings. */
export const NPM_FETCH_RETRY_CONFIG = Object.freeze({
  'fetch-retries': '5',
  'fetch-retry-mintimeout': '10000',
  'fetch-retry-maxtimeout': '60000',
});
export function npmFetchRetryEnv() {
  return Object.fromEntries(Object.entries(NPM_FETCH_RETRY_CONFIG)
    .map(([key, value]) => [`NPM_CONFIG_${key.toUpperCase().replaceAll('-', '_')}`, value]));
}

/** Whole-command attempts for `npm ci`, and the waits between them (milliseconds). */
export const NPM_CI_RETRY = Object.freeze({ attempts: 3, delays: Object.freeze([20_000, 60_000]) });

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN']);
const SERVER_ERROR = /^E5\d\d$/;
// Anything here on an npm error line means the install can never succeed by retrying.
const DEFINITIVE = /\b(?:EINTEGRITY|EUSAGE|ELOCKVERIFY|ENOLOCK|EJSONPARSE|ETARGET|ENOVERSIONS|EBADENGINE|E4\d\d)\b|integrity checksum failed|package-lock\.json|npm-shrinkwrap\.json|lockfile|in sync/i;
const ERROR_LINE = /^npm (?:error|ERR!) ?(.*)$/;

/** Classifies a failed npm run from its combined output: { retry, reason }. Retries only
 * when every reported error code is network-class (ECONNRESET, ETIMEDOUT, ESOCKETTIMEDOUT,
 * EAI_AGAIN) or an HTTP 5xx, and no error line points at the lockfile or integrity. */
export function classifyNpmFailure(output) {
  const errorLines = String(output ?? '').split(/\r?\n/).map(line => ERROR_LINE.exec(line.trim())?.[1]).filter(line => line !== undefined);
  const codes = [...new Set(errorLines.map(line => /^code (\S+)/.exec(line)?.[1]).filter(Boolean))];
  if (!codes.length) return { retry: false, reason: 'no npm error code was reported' };
  const definitive = errorLines.find(line => DEFINITIVE.test(line));
  if (definitive) return { retry: false, reason: `definitive npm failure (${codes.join(', ')}): ${definitive}` };
  const other = codes.filter(code => !NETWORK_CODES.has(code) && !SERVER_ERROR.test(code));
  if (other.length) return { retry: false, reason: `npm failed with ${other.join(', ')}` };
  return { retry: true, reason: `transient network failure (${codes.join(', ')})` };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function removeNodeModules(directory) {
  return rm(path.join(directory, 'node_modules'), { recursive: true, force: true, maxRetries: 3 });
}

/** Runs one `npm ci` attempt at a time through runAttempt(attempt), which resolves to
 * { ok, output }. Retries network-class failures with the NPM_CI_RETRY policy, removing
 * the partial node_modules first. Resolves to the number of attempts used. `action` names
 * the npm command in messages when another registry-reading command (such as
 * `npm install --package-lock-only`) uses the same policy. */
export async function npmCiWithRetry(directory, runAttempt, {
  label = directory, action = 'npm ci', attempts = NPM_CI_RETRY.attempts, delays = NPM_CI_RETRY.delays,
  wait = sleep, clean = removeNodeModules, log = message => console.error(message),
} = {}) {
  for (let attempt = 1; ; attempt++) {
    const { ok, output } = await runAttempt(attempt);
    if (ok) return attempt;
    const verdict = classifyNpmFailure(output);
    if (!verdict.retry) throw new Error(`${label}: ${action} failed: ${verdict.reason}${attempt > 1 ? ` (attempt ${attempt} of ${attempts})` : ''}`);
    if (attempt >= attempts) throw new Error(`${label}: ${action} failed after ${attempts} attempts: ${verdict.reason}`);
    const delay = delays[Math.min(attempt - 1, delays.length - 1)];
    log(`${label}: ${action} hit a ${verdict.reason}; removing partial node_modules and retrying in ${Math.round(delay / 1000)} s (attempt ${attempt + 1} of ${attempts})`);
    await clean(directory);
    await wait(delay);
  }
}

/** Spawns a command, streaming its output to this process while keeping the last
 * `limit` characters for classification. Resolves to { ok, status, signal, output }. */
export function spawnAndCapture(command, args, options, { limit = 64 * 1024, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] });
    onChild?.(child);
    let output = '';
    for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => { target.write(chunk); output = (output + chunk).slice(-limit); });
    }
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ ok: status === 0, status, signal, output }));
  });
}
