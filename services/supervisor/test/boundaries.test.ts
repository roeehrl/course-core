import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpHostBridge, assertEndpoint, readJson } from '../src/bridge.js';
import { HttpProviderGateway } from '../src/providers.js';
import { readConfig } from '../src/config.js';
import { outcomeSchema, rpcRequestSchema } from '../src/contracts.js';
import { temporalActivities } from '../src/temporal/activities.js';
import { TestHost, TestProvider } from './fixtures.js';

function baseEnv(): NodeJS.ProcessEnv {
  return { SUPERVISOR_TEMPORAL_ADDRESS: '127.0.0.1:17233', SUPERVISOR_TEMPORAL_NAMESPACE: 'test',
    SUPERVISOR_TEMPORAL_TASK_QUEUE: 'test-queue', SUPERVISOR_HOST_URL: 'http://127.0.0.1:18080/', SUPERVISOR_HOST_TOKEN: 'test-only' };
}
test('config is explicit and never reports configured providers as working', () => {
  const missing = readConfig({}); assert.equal(missing.status, 'configuration_missing');
  const result = readConfig(baseEnv()); assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.config.provider, null);
  assert.equal(readConfig({ ...baseEnv(), SUPERVISOR_PROVIDER_URL: 'https://example.invalid' }).status, 'configuration_missing');
  assert.equal(readConfig({ ...baseEnv(), SUPERVISOR_TEMPORAL_ADDRESS: 'remote.invalid:7233' }).status, 'configuration_missing');
  assert.equal(readConfig({ ...baseEnv(), SUPERVISOR_TEMPORAL_API_KEY: 'private' }).status, 'configuration_missing');
  assert.equal(readConfig({ ...baseEnv(), SUPERVISOR_ACTIVITY_CONCURRENCY: 'Infinity' }).status, 'configuration_missing');
});
test('HTTP boundaries reject credentials in URLs, redirects, remote cleartext and oversized bodies', async () => {
  for (const url of ['https://user:password@example.invalid/', 'http://example.invalid/', 'https://example.invalid/?secret=x'])
    assert.throws(() => assertEndpoint(url));
  await assert.rejects(readJson(new Response('x'.repeat(262_145))), /invalid_response/);
});
test('real loopback HTTP host bridge matches schema and passes no raw learner payload', async () => {
  const h = new TestHost(); const requests: unknown[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/supervisor/bridge');
    assert.equal(req.headers.authorization, 'Bearer test-only');
    const parts: Buffer[] = [];
    req.on('data', part => parts.push(part));
    req.on('end', async () => {
      const body = rpcRequestSchema.parse(JSON.parse(Buffer.concat(parts).toString())); requests.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body.method === 'load' ? h.snapshot : { accepted: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new HttpHostBridge(`http://127.0.0.1:${address.port}/`, 'test-only');
  try { assert.deepEqual(await bridge.load(h.ref), h.snapshot); assert.equal(requests.length, 1); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('unknown HTTP provider outcome never infers safe retry from status or response text', async () => {
  const h = new TestHost();
  const request = { schemaVersion: 1 as const, operationId: `${h.ref.jobId}/plan`, job: h.snapshot.specification.key,
    role: 'supervisor' as const, checkpoint: h.snapshot.specification.checkpoints[0]!, fence: h.snapshot.specification.fence };
  for (const makeResponse of [() => new Response('private', { status: 429 }), () => new Response('private', { status: 500 }),
    () => new Response(JSON.stringify({ status: 'succeeded', chainOfThought: 'private' })), () => new Response('bad json')]) {
    let calls = 0;
    const gateway = new HttpProviderGateway('https://example.invalid', 'test-only', async (_url, options) => {
      calls++; assert.equal(options!.redirect, 'error'); return makeResponse();
    });
    const outcome = await gateway.invoke(request, new AbortController().signal);
    assert.deepEqual(outcome, { status: 'uncertain' }); assert.equal(calls, 1);
  }
  assert.equal(outcomeSchema.safeParse({ status: 'not_started', retryable: true, retryAfter: Infinity }).success, false);
});
test('Temporal adapter sanitizes arbitrary thrown errors before recording failure history', async () => {
  const h = new TestHost(); h.load = async () => { throw new Error('learner-private bearer-secret'); };
  await assert.rejects(temporalActivities(h, new TestProvider()).loadJob(h.ref), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'supervisor_activity_unavailable');
    assert.doesNotMatch(JSON.stringify(error), /learner-private|bearer-secret/); return true;
  });
});
test('capability lookup carries only the authorized job workspace and preserves legacy callers',async()=>{
 const host=new TestHost(),urls:string[]=[];
 const gateway=new HttpProviderGateway('https://example.invalid','test-only',async(input)=>{urls.push(String(input));return new Response(JSON.stringify(Object.fromEntries(['supervisor','companion','research','media'].map(role=>[role,{status:'ready'}]))));});
 assert.deepEqual(await gateway.availability('supervisor',new AbortController().signal,host.ref),{status:'ready'});
 assert.equal(new URL(urls[0]!).searchParams.get('workspaceId'),host.ref.workspaceId);assert(!urls[0]!.includes(host.ref.enrollmentId));assert(!urls[0]!.includes(host.ref.jobId));
 await gateway.availability('companion',new AbortController().signal);assert.equal(new URL(urls[1]!).search,'');
});
