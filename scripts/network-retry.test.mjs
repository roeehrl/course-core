import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_RETRY, classifyCommandFailure, retryTransientCommand } from './network-retry.mjs';

test('only network-class command failures are retried', () => {
  for (const [output, reason] of [
    ['read tcp 10.1.0.4:443: read: connection reset by peer', 'connection reset'],
    ['error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout', 'timeout'],
    ['dial tcp: lookup api.github.com on 127.0.0.53:53: no such host', 'DNS failure'],
    ['HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/releases)', 'HTTP 5xx'],
    ['received unexpected HTTP status: 503 Service Unavailable', 'HTTP 5xx'],
    ['error pulling image configuration: unexpected EOF', 'connection reset'],
    ['error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', 'connection failure'],
  ]) assert.deepEqual(classifyCommandFailure(output), { retry: true, reason }, output);
  for (const output of [
    'HTTP 401: Bad credentials (https://api.github.com/...)',
    'To get started with GitHub CLI, please run:  gh auth login',
    'Error response from daemon: manifest unknown',
    'toomanyrequests: You have reached your pull rate limit.',
    'pull access denied for python, repository does not exist',
    'HTTP 404: Not Found', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock', '', undefined,
    // A definitive cause wins even next to a network-looking line.
    'HTTP 403: rate limited\nread: connection reset by peer',
  ]) assert.equal(classifyCommandFailure(output).retry, false, String(output));
});

test('retries are bounded, rethrow the original error, and never log raw output', async () => {
  const failure = output => Object.assign(new Error('docker pull failed'), { output });
  const waits = [], logs = [];
  let runs = 0;
  const result = await retryTransientCommand(async n => { runs++; if (n < 3) throw failure('secret-looking-detail connection reset by peer'); return 'ok'; },
    { label: 'docker pull', wait: async ms => { waits.push(ms); }, log: message => logs.push(message) });
  assert.equal(result, 'ok'); assert.equal(runs, 3);
  assert.deepEqual(waits, [...COMMAND_RETRY.delays]);
  assert.ok(logs.every(message => !message.includes('secret-looking-detail')));
  assert.match(logs[0], /^docker pull: transient connection reset; retrying in 10 s \(attempt 2 of 3\)$/);
  runs = 0;
  const original = failure('HTTP 502');
  await assert.rejects(retryTransientCommand(async () => { runs++; throw original; }, { label: 'x', wait: async () => {}, log: () => {} }), error => error === original);
  assert.equal(runs, COMMAND_RETRY.attempts);
  runs = 0;
  // execFile-style errors carry stderr/stdout instead of output.
  await assert.rejects(retryTransientCommand(async () => { runs++; throw Object.assign(new Error('gh'), { stderr: 'HTTP 404: Not Found' }); }, { label: 'x', wait: async () => {}, log: () => {} }), /gh/);
  assert.equal(runs, 1);
});
