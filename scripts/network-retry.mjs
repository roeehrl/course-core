// Bounded retries for release-path commands that read from the network but are not npm
// (scripts/npm-retry.mjs covers npm): `gh release list` and `docker pull`. Only a failure
// whose output names a network-class cause is retried: a connection reset or unexpected EOF,
// a timeout, a DNS failure, or an HTTP 5xx. A 4xx (missing, unauthorized, rate-limited
// without a retry hint), a missing manifest or any other failure is a definitive answer
// and is rethrown at once. Raw command output is never logged; only the matched cause is.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const COMMAND_RETRY = Object.freeze({ attempts: 3, delays: Object.freeze([10_000, 30_000]) });

// Checked first: any of these means retrying cannot help.
const DEFINITIVE = /\bHTTP 4\d\d\b|\b4\d\d (?:Unauthorized|Forbidden|Not Found|Too Many Requests)\b|unauthorized|authentication required|denied|manifest unknown|not found|no matching manifest|toomanyrequests|gh auth login|invalid reference format/i;
const TRANSIENT = [
  ['connection reset', /connection reset|ECONNRESET|broken pipe|unexpected EOF/i],
  ['timeout', /i\/o timeout|TLS handshake timeout|Client\.Timeout exceeded|context deadline exceeded|ETIMEDOUT|request canceled while waiting for connection/i],
  ['connection failure', /error connecting to /i],
  ['DNS failure', /no such host|temporary failure in name resolution|EAI_AGAIN|server misbehaving/i],
  ['HTTP 5xx', /\bHTTP 5\d\d\b|\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b|received unexpected HTTP status: 5\d\d/i],
];

/** { retry, reason } for a failed command's combined output. */
export function classifyCommandFailure(output) {
  const text = String(output ?? '');
  if (DEFINITIVE.test(text)) return { retry: false, reason: 'definitive failure' };
  const match = TRANSIENT.find(([, pattern]) => pattern.test(text));
  return match ? { retry: true, reason: match[0] } : { retry: false, reason: 'not a network-class failure' };
}

/** Runs attempt(n) until it resolves. A rejection is retried only when the output it
 * carries (error.output, else error.stderr + error.stdout) is network-class and attempts
 * remain; otherwise the original error is rethrown unchanged. */
export async function retryTransientCommand(attempt, {
  label, attempts = COMMAND_RETRY.attempts, delays = COMMAND_RETRY.delays, wait = sleep, log = message => console.error(message),
} = {}) {
  for (let n = 1; ; n++) {
    try { return await attempt(n); }
    catch (error) {
      const verdict = classifyCommandFailure(error?.output ?? `${error?.stderr ?? ''}\n${error?.stdout ?? ''}`);
      if (!verdict.retry || n >= attempts) throw error;
      const delay = delays[Math.min(n - 1, delays.length - 1)];
      log(`${label}: transient ${verdict.reason}; retrying in ${Math.round(delay / 1000)} s (attempt ${n + 1} of ${attempts})`);
      await wait(delay);
    }
  }
}
