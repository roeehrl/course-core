import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderAdapter, UsageReceipt } from '@course-core/providers';
import type { ResearchPolicy } from '@course-core/research';
import type { YouTubeSearchResult } from '@course-core/research/node';
import { createActivities, dispatchOnce, HttpHostBridge, HttpProviderGateway, type RunRef } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { tableNamesContaining } from './table-scan.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { searchCoursePassages, searchLearnerQuestions } from '../src/retrieval.js';
import { startTelemetry, telemetry } from '../src/telemetry.js';
import { supervisorSupportFixture } from './supervisor-support-fixture.js';
import { otlpReceiver } from './otlp-receiver.js';
import { syntheticResearchInspector } from './research-fixture.js';
import { findLeaks, markerForms, type Channel } from './egress-scanner.js';

// One end-to-end egress sweep (A02, S09). Private markers are planted through the real HTTP
// API and PostgreSQL: learner chat and learner-model text, a display name, private course
// content, a provider credential and session secrets. The system is then driven through a
// scripted supervisor run, staff research, the run inspector, the workspace audit and data
// exports, and every outbound or shared path is scanned for each marker in plain and encoded
// forms. Per-surface canary tests cover each path in depth; this sweep proves no path is
// missing from the list. Only the external model is a scripted, deterministic adapter.
const marker = (kind: string) => `egress${kind}${randomBytes(8).toString('hex')}`;
const LEARNER = marker('learner'), NAME = marker('name'), COURSE = marker('course'), CREDENTIAL = marker('credential');
const schema = `egress_${randomUUID().replaceAll('-', '')}`, workspace = randomUUID(), otherWorkspace = randomUUID(), serviceToken = randomUUID();
const origin = 'http://localhost:4398';
const repositoryRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const exec = promisify(execFile);

// Everything that leaves the process or is shown to someone other than the learner.
const logs: string[] = [], providerRequests: string[] = [], researchRequests: string[] = [], searchQueries: string[] = [];
const sessionSecrets: string[] = [];
const usage: UsageReceipt = { accounting: { accountingKey: 'synthetic' }, providerId: 'test', modelId: 'planner', operation: 'assess',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
const script = [
  { decision: 'tool', tool: 'list_support', argumentsJson: '{}', summary: '' },
  { decision: 'tool', tool: 'choose_support', argumentsJson: JSON.stringify({ profileId: 'ordering-support-profile', entryId: 'number-line-support' }), summary: '' },
  { decision: 'finish', tool: 'none', argumentsJson: '{}', summary: 'Use the reviewed number-line explanation.' },
];
const adapter: ProviderAdapter = { providerId: 'test', validateModel() {}, ports: { structured_assessment: { async assess(request) {
  providerRequests.push(JSON.stringify(request));
  const round = Number(request.accounting.accountingKey.split(':round-')[1]);
  return { usage: { ...usage, accounting: request.accounting }, output: script[round]! };
} } } };
const inspected: { policy: ResearchPolicy; sourceId: string }[] = [];
const inspector = syntheticResearchInspector({ record: inspected });

interface Session { id: string; cookie: string; csrf: string }
let db: Database, app: Awaited<ReturnType<typeof createServer>>, base: string, testDatabase: TestDatabase | undefined;
let receiver: Awaited<ReturnType<typeof otlpReceiver>>;
const restore: (() => void)[] = [];
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });

function captureProcessOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return (write as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof stream.write;
    restore.push(() => { stream.write = write; });
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => { logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); original(...args); };
    restore.push(() => { console[level] = original; });
  }
}
async function login(role: string, workspaceId = workspace, displayName = `${role} person`) {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `egress:${id}`, displayName]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  const session = { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken as string };
  sessionSecrets.push(session.csrf, ...r.cookies.map(c => c.value));
  return session;
}
/** Real loopback HTTP, so server spans and logs come from the network stack. */
async function http(who: Session | null, method: string, url: string, payload?: unknown) {
  const response = await fetch(base + url, { method, headers: { ...(who ? headers(who) : { origin }), ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return { status: response.status, text: await response.text() };
}
async function ok(who: Session | null, method: string, url: string, payload?: unknown) {
  const r = await http(who, method, url, payload);
  expect(r.status, `${method} ${url}: ${r.text}`).toBe(200);
  return r.text;
}
/** Every application table's rows, as text, that contain `value`. */
const tablesContaining = (value: string) => tableNamesContaining(db, value);

beforeAll(async () => {
  captureProcessOutput();
  receiver = await otlpReceiver();
  expect((await startTelemetry({ serviceName: 'course-core-api', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url } })).enabled).toBe(true);
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const fixture = supervisorSupportFixture();
  const providers = composeProviders({ registry: { revision: 'egress-sweep', models: [{ id: 'planner', providerId: 'test', remoteModel: 'planner', providerConfig: {}, enabled: true,
    capabilities: ['structured_assessment'], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
  adapters: [{ id: 'test', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
  roles: { supervisor: { modelId: 'planner', maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 } } }, () => CREDENTIAL, { test: () => adapter });
  const youtubeSearch = { async forWorkspace() { return { async search(query: unknown): Promise<YouTubeSearchResult> {
    searchQueries.push(JSON.stringify(query));
    const { queryText } = query as { queryText: string };
    return { hits: [], sent: { q: queryText, relevanceLanguage: null, maxResults: 5 } }; } }; } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: fixture.runtime, providers, researchInspector: inspector, youtubeSearch,
    supervisor: { serviceToken, workspaceIds: [workspace], jobPolicy: { allowance: { microUsd: 100000, tokens: 1200000 } } } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  for (const [id, slug] of [[workspace, 'egress'], [otherWorkspace, 'egress-other']]) await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [id, slug, 'Egress sweep']);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 30000);
afterAll(async () => {
  await telemetry().shutdown(); await receiver?.close();
  await app?.close(); await db?.end(); await testDatabase?.drop();
  for (const undo of restore.reverse()) undo();
});

describe('the egress scanner', () => {
  it('finds a marker in plain, JSON, URL, hex and base64 form at every alignment, and ignores near misses', () => {
    const value = marker('control');
    for (const pad of ['', 'a', 'ab', 'abc']) {
      const channels: Channel[] = [
        { name: 'plain', text: `log ${value} line` }, { name: 'json', text: JSON.stringify({ q: `"${value}"` }) },
        { name: 'url', text: `/search?q=${encodeURIComponent(`${value} x`)}` }, { name: 'hex', text: Buffer.from(pad + value).toString('hex') },
        { name: 'base64', text: Buffer.from(pad + value + 'tail').toString('base64') }, { name: 'base64url', text: Buffer.from(pad + value).toString('base64url') },
      ];
      expect(findLeaks(channels, [value]).map(l => l.channel)).toEqual(channels.map(c => c.name));
    }
    expect(findLeaks([{ name: 'near miss', text: value.slice(0, -1) + ' ' + value.slice(1) }], [value])).toEqual([]);
    expect(markerForms(value).length).toBeGreaterThanOrEqual(6);
  });
});

describe('end-to-end egress canary sweep', () => {
  it('keeps every planted marker out of logs, telemetry, inspector, audit, retrieval, research, staff exports and release source', async () => {
    // Private course content: shown to its own enrolled learners, nowhere else.
    const support = supervisorSupportFixture(), course = support.course;
    course.chapters[0]!.episodes[0]!.blocks.splice(1, 0, { id: 'min-private', type: 'text', markdown: `Private course note ${COURSE} about minimum values.` });
    course.research = { publicTopics: [{ id: 'minimum-research', objectiveIds: ['minimum'], queryText: 'Public explanation of finding the minimum of a list', allowedDomains: ['docs.python.org'] }] };
    const owner = await login('owner'), instructor = await login('instructor'), observer = await login('support_observer');
    await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
      effective_from,source_note,created_by) VALUES($1,$2,'planner',1,'active','USD',300000,2500000,clock_timestamp()-interval '1 minute','Synthetic egress price',$3)`,
    [randomUUID(), workspace, owner.id]);
    const releaseId = JSON.parse(await ok(owner, 'POST', `/api/workspaces/${workspace}/releases`, course)).id as string;
    await ok(owner, 'POST', `/api/releases/${releaseId}/publish`);
    await ok(owner, 'POST', `/api/admin/releases/${releaseId}/adaptation-registry`, { expectedRegistryRevision: 0, configuration: support.config });

    // The learner plants chat and learner-model text through the HTTP API.
    const learner = await login('learner', workspace, `Learner ${NAME}`);
    const enrollmentId = JSON.parse(await ok(learner, 'POST', '/api/enrollments', { releaseId })).id as string;
    const revision = async () => JSON.parse(await ok(learner, 'GET', `/api/enrollments/${enrollmentId}`)).revision as number;
    await ok(learner, 'POST', `/api/enrollments/${enrollmentId}/supervision`, { expectedRevision: await revision(), idempotencyKey: randomUUID(), adaptiveTeaching: true });
    await ok(learner, 'POST', `/api/enrollments/${enrollmentId}/learner-model/profile`, { expectedRevision: await revision(), idempotencyKey: randomUUID(),
      profile: { preferences: { explanationStyle: 'worked_example', goal: `Goal ${LEARNER}` }, priorKnowledge: [], thoughts: `Thoughts ${LEARNER}` } });
    await ok(learner, 'POST', `/api/enrollments/${enrollmentId}/companion`, { expectedRevision: await revision(), idempotencyKey: randomUUID(), episodeId: 'min',
      content: `Why does the minimum work ${LEARNER}` });
    // The learner sees their own course content, so its absence elsewhere is meaningful.
    expect(await ok(learner, 'GET', `/api/enrollments/${enrollmentId}`)).toContain(COURSE);

    // A scripted supervisor run over the real dispatcher, worker activities and HTTP bridge.
    await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId }, { microUsd: 1000000, tokens: 2000000 });
    await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId, actorId: learner.id, actorKind: 'learner',
      type: 'learning.review_requested', payload: { episodeId: 'min' }, idempotencyKey: randomUUID(), supervise: true }));
    const hostBridge = new HttpHostBridge(base, serviceToken), gateway = new HttpProviderGateway(base, serviceToken), refs: RunRef[] = [];
    await dispatchOnce(hostBridge, { start: async ref => { refs.push(ref); } });
    const activities = createActivities(hostBridge, gateway, () => ({ signal: new AbortController().signal, heartbeat() {} }));
    const applied: string[] = [];
    for (const ref of refs) {
      try {
        const spec = await activities.loadJob(ref);
        let stopped = false;
        for (const checkpoint of spec.checkpoints) if ((await activities.executeCheckpoint(ref, checkpoint.id)).effect === 'stop') { stopped = true; break; }
        if (!stopped && (await activities.verifyJob(ref)).effect === 'continue' && (await activities.applyJob(ref)).snapshot.state === 'applied') applied.push(spec.role);
      } catch { /* A role without a configured model (the companion here) ends without a provider call. */ }
    }
    expect(applied).toContain('supervisor');
    // Positive control: the learner opted in, so their text legitimately reached the model.
    expect(findLeaks([{ name: 'provider', text: providerRequests.join('\n') }], [LEARNER])).toHaveLength(1);
    const supervisorJob = (await db.query<{ id: string }>("SELECT id FROM supervisor_jobs WHERE enrollment_id=$1 AND role='supervisor'", [enrollmentId])).rows[0]!.id;

    // Staff work: research inspection and media search, run inspection, the audit and exports.
    const sourceId = JSON.parse(await ok(owner, 'POST', `/api/admin/releases/${releaseId}/research/sources`, { topicId: 'minimum-research', kind: 'web',
      url: 'https://docs.python.org/3/library/functions.html', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), idempotencyKey: `k-${randomUUID()}` })).sourceId;
    await ok(owner, 'POST', `/api/admin/research/sources/${sourceId}/inspect`, {});
    expect(inspected).toHaveLength(1);
    researchRequests.push(...inspected.map(entry => JSON.stringify(entry)));
    await ok(owner, 'POST', `/api/admin/releases/${releaseId}/research/topics/minimum-research/youtube-search`, {});
    expect(searchQueries).toHaveLength(1);
    const library = await ok(owner, 'GET', `/api/admin/releases/${releaseId}/research/library`);
    const catalog = JSON.parse(await ok(owner, 'GET', '/api/admin/session')).courses[0].id as string;
    const runView = await ok(instructor, 'GET', `/api/admin/courses/${catalog}/runs/${supervisorJob}?payload=true&reveal=1`);
    const audit = await ok(observer, 'GET', `/api/admin/workspaces/${workspace}/audit?limit=200`);
    const ownExport = await ok(learner, 'GET', `/api/enrollments/${enrollmentId}/export`);
    const staffExport = await ok(owner, 'GET', `/api/enrollments/${enrollmentId}/export`);
    // Positive control: the learner's own export carries their text.
    expect(ownExport).toContain(LEARNER);

    // Another workspace: its people and indexes never see this workspace's learner or course.
    const outsider = await login('owner', otherWorkspace), peer = await login('learner', otherWorkspace);
    const outsiderViews = [await http(outsider, 'GET', '/api/admin/session'), await http(outsider, 'GET', `/api/admin/courses/${catalog}/runs/${supervisorJob}`),
      await http(outsider, 'GET', `/api/enrollments/${enrollmentId}/export`), await http(peer, 'GET', '/api/enrollments'), await http(peer, 'GET', '/api/workspaces'),
      await http(null, 'GET', '/api/workspaces'), await http(null, 'GET', `/api/enrollments/${enrollmentId}/export`)].map(r => r.text).join('\n');
    const peerRelease = JSON.parse(await ok(outsider, 'POST', `/api/workspaces/${otherWorkspace}/releases`, supervisorSupportFixture().course)).id as string;
    const retrieval = await transaction(db, async client => JSON.stringify([
      await searchCoursePassages(client, { releaseId: peerRelease, workspaceId: otherWorkspace }, COURSE),
      await searchCoursePassages(client, { releaseId, workspaceId: otherWorkspace }, COURSE),
      // Course passages index authored content only, never learner text.
      await searchCoursePassages(client, { releaseId, workspaceId: workspace }, LEARNER),
      await searchLearnerQuestions(client, { enrollmentId: randomUUID(), workspaceId: workspace, courseDigest: 'x' }, LEARNER),
      await searchLearnerQuestions(client, { enrollmentId, workspaceId: otherWorkspace, courseDigest: 'x' }, LEARNER),
    ]));
    // Positive control: the learner's own question index does find their text.
    const ownSearch = await transaction(db, async client => {
      const digest = (await client.query<{ digest: string }>('SELECT digest FROM course_releases WHERE id=$1', [releaseId])).rows[0]!.digest;
      return JSON.stringify(await searchLearnerQuestions(client, { enrollmentId, workspaceId: workspace, courseDigest: digest }, LEARNER));
    });
    expect(ownSearch).toContain(LEARNER);

    // The capture hooks see the process's real output streams.
    console.warn('egress sweep capture check');
    expect(logs.join('\n')).toContain('egress sweep capture check');
    await telemetry().shutdown();
    const telemetryRaw = receiver.received.map(entry => `${entry.path}\n${JSON.stringify(entry.headers)}\n${entry.raw}`).join('\n');
    expect(receiver.received.length).toBeGreaterThan(0);
    expect(telemetryRaw.length).toBeGreaterThan(1000);

    // Release source: the bytes a release snapshot is built from (tracked files, plus untracked
    // files not ignored) never pick up runtime data written during the run.
    const listed = (await exec('git', ['-C', repositoryRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
    const sourceHits: string[] = [];
    for (const file of listed) {
      if (file.endsWith('egress-canary-sweep.integration.test.ts')) continue;
      const text = await readFile(path.join(repositoryRoot, file), 'utf8').catch(() => '');
      if ([LEARNER, NAME, COURSE, CREDENTIAL].some(value => text.includes(value))) sourceHits.push(file);
    }
    expect(sourceHits).toEqual([]);

    const everyone = [LEARNER, NAME, COURSE, CREDENTIAL, serviceToken, ...sessionSecrets];
    const channels: [Channel, string[]][] = [
      [{ name: 'process logs (stdout, stderr, console)', text: logs.join('\n') }, everyone],
      [{ name: 'OpenTelemetry export (traces, metrics, headers)', text: telemetryRaw }, everyone],
      // The model sees the opted-in learner's text, their display name (provider-context.ts keeps it
      // on purpose) and the course; never account IDs, credentials or sessions. The credential
      // reaches the adapter as an argument, not inside the request body.
      [{ name: 'provider request bodies', text: providerRequests.join('\n') }, [learner.id, CREDENTIAL, serviceToken, ...sessionSecrets]],
      [{ name: 'research fetcher requests', text: researchRequests.join('\n') }, everyone],
      [{ name: 'media search queries', text: searchQueries.join('\n') }, everyone],
      [{ name: 'research library (staff)', text: library }, [LEARNER, NAME, CREDENTIAL]],
      [{ name: 'run inspector default view', text: runView }, [LEARNER, NAME, CREDENTIAL, serviceToken]],
      [{ name: 'workspace audit', text: audit }, [LEARNER, NAME, COURSE, CREDENTIAL, serviceToken]],
      [{ name: 'staff copy of the export', text: staffExport }, [LEARNER, CREDENTIAL, serviceToken]],
      [{ name: 'learner own export', text: ownExport }, [CREDENTIAL, serviceToken, ...sessionSecrets]],
      [{ name: 'other workspace and anonymous views', text: outsiderViews }, everyone],
      [{ name: 'retrieval indexes outside the learner', text: retrieval }, everyone],
    ];
    const leaks = channels.flatMap(([channel, markers]) => findLeaks([channel], markers));
    expect(leaks).toEqual([]);
    expect(researchRequests.join('')).toContain('docs.python.org');

    // Stored state: the provider credential and session cookies are never persisted in clear;
    // the learner's text is (their own record), which proves the table scan works.
    expect(await tablesContaining(LEARNER)).toContain('companion_messages');
    expect(await tablesContaining(CREDENTIAL)).toEqual([]);
    for (const secret of sessionSecrets.filter(s => s.length >= 16)) expect(await tablesContaining(secret), 'session secret').toEqual([]);
  }, 90000);
});
