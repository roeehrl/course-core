import test from 'node:test';
import assert from 'node:assert/strict';
import { config, harness, json, videoRequest, completed, job, NAME, body, KEY, code } from './helpers.mjs';

test('video REST submits predictLongRunning once and polls the returned name without resubmission', async () => {
  const h = harness([{ name: NAME }, { name: NAME, done: false }, completed()]);
  const submitted = await h.client.startVideo(videoRequest());
  assert.equal(submitted.output.state, 'pending'); assert.equal(submitted.output.job.providerState.operationName, NAME);
  assert.equal(h.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/admin-selected-video-model:predictLongRunning');
  assert.deepEqual(body(h.calls[0]), { instances: [{ prompt: 'private-test-message' }], parameters: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' } });
  assert.equal(submitted.usage.requestedVideoSeconds, 4); assert.equal(submitted.usage.observedVideoCount, null);
  const result = await h.client.waitForVideo(submitted.output.job, { maxPolls: 2, pollIntervalMs: 1 });
  assert.equal(result.output.state, 'completed'); assert.equal(result.pollUsage.length, 2);
  assert.equal(result.usage.observedVideoCount, 1); assert.equal(result.usage.requestedVideoSeconds, null);
  assert.deepEqual(h.calls.map(c => c.init.method), ['POST', 'GET', 'GET']);
  assert.equal(h.calls[1].url, `https://generativelanguage.googleapis.com/v1beta/${NAME}`);
  assert.equal(h.calls[1].init.body, undefined);
});

test('immediate completed video operations retain their job and observed count', async () => {
  const result = await harness([completed()]).client.startVideo(videoRequest());
  assert.equal(result.output.state, 'completed'); assert.equal(result.usage.observedVideoCount, 1);
});

test('interrupted polling retains a resumable handle and never submits a replacement', async () => {
  const controller = new AbortController();
  const h = harness([{ name: NAME, done: false }, () => { controller.abort(KEY); return new Promise(() => {}); }, completed()]);
  await assert.rejects(h.client.waitForVideo(job(), { maxPolls: 3, pollIntervalMs: 1, signal: controller.signal }), error => {
    assert.equal(error.code, 'CANCELLED'); assert.deepEqual(error.job, job()); assert.equal(error.pollUsage.length, 1);
    assert.equal(JSON.stringify(error).includes(KEY), false); return true;
  });
  const resumed = await h.client.pollVideo(JSON.parse(JSON.stringify(job())));
  assert.equal(resumed.output.state, 'completed'); assert.equal(h.calls.every(c => c.init.method === 'GET'), true);
});

test('poll count and overall wait timeout are independent finite boundaries with recoverable handles', async () => {
  const count = harness([{ name: NAME }, { name: NAME }]);
  await assert.rejects(count.client.waitForVideo(job(), { maxPolls: 2, pollIntervalMs: 1 }), error => {
    assert.equal(error.code, 'POLL_LIMIT'); assert.equal(error.pollUsage.length, 2); assert.deepEqual(error.job, job()); return true;
  });
  const timed = harness([{ name: NAME }]);
  await assert.rejects(timed.client.waitForVideo(job(), { maxPolls: 100, pollIntervalMs: 1000, timeoutMs: 15 }), error => {
    assert.equal(error.code, 'TIMEOUT'); assert.deepEqual(error.job, job()); return true;
  });
  assert.equal(timed.calls.length, 1);
});

test('GET polling retries transient failures while POST uncertainty is never retried', async () => {
  const poll = harness([json({ error: KEY }, 503), new Error(KEY), completed()]);
  const result = await poll.client.pollVideo(job());
  assert.equal(result.output.state, 'completed'); assert.equal(result.usage.attempts.length, 3);
  assert.equal(poll.calls.every(c => c.init.method === 'GET'), true);
  const start = harness([json({ error: KEY }, 503)]);
  await assert.rejects(start.client.startVideo(videoRequest()), error => error.code === 'UPSTREAM_UNAVAILABLE' && error.submission === 'unknown');
  assert.equal(start.calls.length, 1);
});

test('cancellation is local only and cannot claim that remote work or billing stopped', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort();
  assert.equal(h.client.videoCancellation, 'local_abort_only');
  await assert.rejects(h.client.pollVideo(job(), { signal: controller.signal }), error => error.code === 'CANCELLED' && error.job.providerState.operationName === NAME);
  assert.equal(h.calls.length, 0); assert.equal(h.client.cancelVideo, undefined);
});

test('model, duration and media parameter capability mismatches fail before sending', async () => {
  for (const patch of [{ modelId: 'text' }, { durationSeconds: 99 }, { resolution: 'unsupported' }, { aspectRatio: '1:1' }]) {
    const h = harness(); await assert.rejects(h.client.startVideo(videoRequest(patch)), code('CAPABILITY_MISMATCH')); assert.equal(h.calls.length, 0);
  }
  const cfg = config(); cfg.models[1].remoteModel = 'replacement-model';
  await assert.rejects(harness([], { config: cfg }).client.pollVideo(job()), code('CAPABILITY_MISMATCH'));
});

test('operation handles reject cross-model identities, traversal, absolute URLs and query injection', async () => {
  for (const name of ['https://evil.invalid/operations/id', 'operations/../admin', 'operations/id?key=x', 'operations/id%2Fother', 'models/other/operations/id']) {
    const h = harness(); await assert.rejects(h.client.pollVideo(job({ providerState: { ...job().providerState, operationName: name } })), code('INVALID_RESPONSE')); assert.equal(h.calls.length, 0);
  }
  const h = harness([{ name: 'https://evil.invalid/collect-key' }]);
  await assert.rejects(h.client.startVideo(videoRequest()), code('INVALID_RESPONSE'));
  assert.equal(h.calls.length, 1);
});

test('remote terminal errors are sanitized and keep the submitted operation for reconciliation', async () => {
  const failure = { name: NAME, done: true, error: { code: 13, message: `${KEY} detailed upstream failure` } };
  for (const call of ['startVideo', 'pollVideo']) {
    const h = harness([failure]);
    await assert.rejects(h.client[call](call === 'startVideo' ? videoRequest() : job()), error => {
      assert.equal(error.code, 'OPERATION_FAILED'); assert.equal(error.job.providerState.operationName, NAME);
      assert.equal(error.message.includes(KEY), false); assert.equal(JSON.stringify(error).includes(KEY), false); return true;
    });
    assert.equal(h.calls.length, 1);
  }
});

test('malformed operation combinations and unapproved download origins cannot become completed media', async () => {
  const invalid = [
    { name: NAME, done: 'true' }, { name: NAME, done: true }, { name: NAME, done: false, error: { code: 13 } },
    completed({ error: { code: 13 } }), completed({ name: 'operations/different' }),
    { name: NAME, done: true, response: { generateVideoResponse: { generatedSamples: [] } } },
  ];
  for (const raw of invalid) await assert.rejects(harness([raw]).client.pollVideo(job()), code('INVALID_RESPONSE'));
  for (const uri of ['https://evil.invalid/video.mp4', 'http://storage.googleapis.com/video', 'https://user:key@storage.googleapis.com/video', 'file:///video.mp4']) {
    const raw = completed(); raw.response.generateVideoResponse.generatedSamples[0].video.uri = uri;
    await assert.rejects(harness([raw]).client.pollVideo(job()), code('INVALID_RESPONSE'));
  }
});

test('media references are returned without fetching assets or forwarding credentials to storage', async () => {
  const h = harness([completed()]); const result = await h.client.pollVideo(job());
  assert.equal(result.output.videos[0].uri, 'https://storage.googleapis.com/synthetic-output/clip.mp4');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url.startsWith('https://generativelanguage.googleapis.com/'), true);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});
