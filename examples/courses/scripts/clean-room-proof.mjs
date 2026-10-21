import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as reserveSocket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { apiClient } from './protocol-scenario.mjs';
import { ACTIVITY_ID, EVALUATOR_ID, buildLab } from '../src/clean-room-lab.mjs';

/**
 * Clean-room author proof on unchanged Core. The course comes from src/clean-room-lab.mjs, which
 * uses only the released SDK. This host harness starts the built production entry point
 * (services/api/dist/main.js, the same installed extensions as any deployment) on loopback with
 * a disposable PostgreSQL 17 schema, then drives everything over HTTP: the author reads the
 * host's advertised builds, imports and publishes; a learner runs the activity and the checker
 * grades it; an admin changes the course's admin setting and the next result shows it. Only
 * seeding accounts and the final audit-row check touch the database directly, as an operator would.
 */
const API = fileURLToPath(new URL('../../../services/api/', import.meta.url));
const { createDatabase } = await import(pathToFileURL(`${API}dist/database.js`).href);
const { issueLoginCode } = await import(pathToFileURL(`${API}dist/auth.js`).href);

async function freePort() {
  const server = reserveSocket();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function testDatabase(raw) {
  assert(raw, 'Provide an explicit disposable TEST_DATABASE_URL');
  const url = new URL(raw);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert(/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname));
  assert(!url.search && !url.hash && ['postgres:', 'postgresql:'].includes(url.protocol));
  return url;
}
const ok = (response, code = 200) => { assert.equal(response.status, code, `HTTP ${response.status}; error=${response.data?.error ?? 'none'}`); return response.data; };

/** Starts dist/main.js; resolves once it listens. Its output is kept in memory, never printed with secrets. */
async function startCore(env) {
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: API, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = chunk => { output = (output + chunk).slice(-20000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  for (let i = 0; i < 200 && !/Course API listening/.test(output); i++) {
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.match(output, /Course API listening/, `Core did not start (exit ${child.exitCode})`);
  return { child, output: () => output };
}

export async function cleanRoomProof() {
  assert(!process.env.DATABASE_URL, 'Do not run this disposable proof with DATABASE_URL set');
  const url = testDatabase(process.env.TEST_DATABASE_URL), schema = `clean_room_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(url.href);
  let db, core, schemaCreated = false;
  try {
    const version = Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    assert(version >= 170000 && version < 180000, 'PostgreSQL 17 is required for this proof');
    await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
    const scoped = new URL(url); scoped.searchParams.set('options', `-csearch_path=${schema}`);
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    // A minimal environment: no provider, supervisor, sandbox or telemetry configuration is inherited.
    core = await startCore({ PATH: process.env.PATH ?? '', DATABASE_URL: scoped.href, PUBLIC_ORIGIN: origin, API_HOST: '127.0.0.1', PORT: String(port), AUTH_LOGIN_CODES: 'enabled' });
    db = createDatabase(scoped.href);
    const workspaceId = randomUUID();
    await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `clean-room-${randomUUID()}`, 'Clean-room lab']);
    async function login(role) {
      const id = randomUUID();
      await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [id, `clean-room:${id}`, `Clean-room ${role}`]);
      await db.query('INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspaceId, id, role]);
      const response = await fetch(`${origin}/auth/redeem`, { method: 'POST', redirect: 'error', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: await issueLoginCode(db, id) }) });
      assert.equal(response.status, 200);
      const data = await response.json();
      return apiClient({ baseUrl: origin, origin, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: data.csrfToken });
    }
    const owner = await login('owner'), learner = await login('learner');

    // Authoring: the course declares the builds this host advertises; nothing else is shared.
    const extensions = ok(await owner('GET', '/api/runtime/extensions')).extensions;
    const refused = ok(await owner('POST', `/api/workspaces/${workspaceId}/releases`, buildLab(extensions, { version: '0.9.0', withoutKey: true })));
    const refusal = await owner('POST', `/api/releases/${refused.id}/publish`);
    assert.equal(refusal.status, 409);
    assert.equal(refusal.data.error, 'PUBLISH_EVALUATOR_CONFIGURATION_INVALID');
    assert.equal(refusal.data.details?.reason, 'key_item_missing');
    const release = ok(await owner('POST', `/api/workspaces/${workspaceId}/releases`, buildLab(extensions)));
    ok(await owner('POST', `/api/releases/${release.id}/publish`));

    // Learning: the activity runs on Core's declarative runtime; the key never reaches the learner.
    const enrollment = ok(await learner('POST', '/api/enrollments', { releaseId: release.id }));
    const view = ok(await learner('POST', `/api/enrollments/${enrollment.id}/activities`, { episodeId: 'thermometer', blockId: 'thermometer-lab', target: 'web_mobile' }));
    assert.equal(view.execution, 'declarative'); assert.equal(view.evaluated, true);
    const seen = JSON.stringify([view, ok(await learner('GET', `/api/enrollments/${enrollment.id}`))]);
    for (const secret of ['21.5', 'Thermometer lab reading', EVALUATOR_ID, 'show-mismatched-controls']) assert(!seen.includes(secret), `Learner payload exposes ${secret}`);
    const submit = values => learner('POST', `/api/enrollments/${enrollment.id}/activity-instances/${view.instanceId}/calls`,
      { capability: 'observation.emit', idempotencyKey: randomUUID(), payload: { observation: { kind: 'submitted', values } } });
    const wrong = { temperature: 23, freezing: 'above', 'eye-level': true };
    const first = ok(await submit(wrong));
    assert.deepEqual([first.evaluation.status, first.evaluation.explanation, first.satisfied], ['not_passed', undefined, false]);

    // Administration: the owner turns on the course's feedback setting for this enrollment.
    const catalog = ok(await owner('GET', '/api/admin/session')).courses.find(row => row.workspaceId === workspaceId);
    const sections = ok(await owner('GET', `/api/admin/courses/${catalog.id}/admin-sections`)).sections;
    assert.deepEqual(sections.map(row => row.id), [EVALUATOR_ID]);
    ok(await learner('GET', `/api/admin/courses/${catalog.id}/admin-sections/${EVALUATOR_ID}`), 403);
    ok(await learner('PUT', `/api/admin/courses/${catalog.id}/admin-sections/${EVALUATOR_ID}/values`,
      { scope: 'enrollment', scopeRef: enrollment.id, expectedRevision: 0, values: { 'show-mismatched-controls': true } }), 403);
    const saved = ok(await owner('PUT', `/api/admin/courses/${catalog.id}/admin-sections/${EVALUATOR_ID}/values`,
      { scope: 'enrollment', scopeRef: enrollment.id, expectedRevision: 0, values: { 'show-mismatched-controls': true } }));
    assert.equal(saved.section.settings[0].value, true);

    // The setting is consumed: the same wrong reading now names the value to recheck, and the verdict is unchanged.
    const second = ok(await submit(wrong));
    assert.deepEqual([second.evaluation.status, second.evaluation.explanation], ['not_passed', 'Reading in degrees Celsius']);
    const right = ok(await submit({ temperature: 21.5, freezing: 'above', 'eye-level': false }));
    assert.deepEqual([right.evaluation.status, right.evaluation.evaluator, right.satisfied], ['passed', `${EVALUATOR_ID}@1.0.0`, true]);
    const audited = Number((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE event_type='admin_section.settings_changed' AND workspace_id=$1", [workspaceId])).rows[0].n);
    assert.equal(audited, 1);
    const evidence = (await db.query('SELECT objective_id,result FROM activity_evidence WHERE enrollment_id=$1 ORDER BY created_at', [enrollment.id])).rows;
    assert.deepEqual(evidence.map(row => row.result.passed), [false, false, true]);
    return { course: 'thermometer-lab', host: 'services/api/dist/main.js', persistence: 'real-postgresql-17', publishRefusedWithoutKey: true,
      activity: 'declarative', evaluator: `${EVALUATOR_ID} via course-core-declarative-evaluator`, adminSettingConsumed: true, auditedChanges: audited, providerServicesStarted: false };
  } finally {
    try { if (core) { core.child.kill('SIGTERM'); if (core.child.exitCode === null) await Promise.race([once(core.child, 'exit'), delay(5000)]); if (core.child.exitCode === null) core.child.kill('SIGKILL'); } }
    finally {
      try { await db?.end(); }
      finally {
        try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally { await admin.end(); }
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 2, 'This proof takes no arguments');
  cleanRoomProof().then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
