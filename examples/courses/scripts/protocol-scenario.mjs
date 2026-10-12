import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadPacks, episodes, validatePack, correctAnswer, wrongAnswer, assertNoGrading, assertNoBank } from './lib.mjs';

/** Uses the real HTTP protocol. Session material is supplied by the caller and never logged. */
export function apiClient({ baseUrl, origin = new URL(baseUrl).origin, cookie = '', csrf = '', fetcher = fetch }) {
  const base = new URL(baseUrl);
  assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash);
  assert(base.pathname === '/', 'Use an API origin, without a path');
  return async (method, pathname, body) => {
    const response = await fetcher(new URL(pathname, base), {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { origin, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Non-JSON HTTP response for ${method} ${pathname}`); }
    return { status: response.status, data };
  };
}
function status(response, code = 200) {
  assert.equal(response.status, code, `Unexpected HTTP status; error=${response.data?.error ?? 'none'}`);
  return response.data;
}
function sessionOptions(baseUrl, origin, session) { return { baseUrl, origin, cookie: session.cookie, csrf: session.csrf }; }
export async function runProtocolScenario({ baseUrl, origin, workspaceId, owner, learner, otherLearner, packs }) {
  assert(workspaceId && owner.cookie && owner.csrf && learner.cookie && learner.csrf);
  const staff = apiClient(sessionOptions(baseUrl, origin, owner));
  const student = apiClient(sessionOptions(baseUrl, origin, learner));
  const anonymous = apiClient({ baseUrl, origin });
  const outsider = otherLearner ? apiClient(sessionOptions(baseUrl, origin, otherLearner)) : null;
  status(await anonymous('GET', '/api/enrollments'), 401);
  const reports = [];
  for (const course of packs ?? await loadPacks()) {
    const validated = validatePack(course);
    let catalog = status(await staff('GET', `/api/workspaces/${workspaceId}/courses`));
    let release = catalog.find(row => row.course_key === course.id && row.version === course.version);
    if (release) {
      assert.equal(release.digest, validated.digest, 'An existing release has different content at this version');
    } else {
      const imported = status(await staff('POST', `/api/workspaces/${workspaceId}/releases`, course));
      assert.equal(imported.digest, validated.digest); release = { id: imported.id, status: 'draft' };
      const before = status(await student('GET', `/api/workspaces/${workspaceId}/courses`));
      assert(!before.some(row => row.id === release.id), 'Learner can see an unpublished release');
    }
    status(await staff('POST', `/api/releases/${release.id}/publish`));
    catalog = status(await student('GET', `/api/workspaces/${workspaceId}/courses`));
    assert(catalog.some(row => row.id === release.id)); assertNoGrading(catalog);
    status(await student('POST', `/api/workspaces/${workspaceId}/releases`, course), 403);
    const enrollment = status(await student('POST', '/api/enrollments', { releaseId: release.id }));
    const duplicate = status(await student('POST', '/api/enrollments', { releaseId: release.id }));
    assert.equal(duplicate.id, enrollment.id);
    const path = `/api/enrollments/${enrollment.id}`;
    const snapshot = async () => status(await student('GET', path));
    const first = await snapshot(); assertNoBank(first, course);
    assert(!first.complete && first.lessons.every(row => row.status !== 'completed'), 'Use a fresh learner account for this proof');
    status(await anonymous('GET', path), 401);
    if (outsider) status(await outsider('GET', path), 404);
    const command = async (action, body, want = 200) => {
      const fresh = await snapshot();
      return status(await student('POST', `${path}/${action}`, { expectedRevision: fresh.revision, idempotencyKey: randomUUID(), ...body }), want);
    };
    const issuedIds = new Set(); const known = new Map(course.assessments.map(item => [item.id, item]));
    async function issue(episodeId, assessmentId) {
      const result = await command('challenges', { episodeId, mode: 'independent', ...(assessmentId ? { assessmentId } : {}) });
      assertNoGrading(result.question);
      const item = known.get(result.question.id); assert(item, 'Unknown issued item');
      assert.equal(result.question.prompt, item.prompt);
      assert(!Object.hasOwn(result.question, 'familyId'));
      if (!assessmentId) assert(!issuedIds.has(item.id), 'Automatic challenge repeated an exposed item');
      issuedIds.add(item.id);
      // Refreshing an active attempt may expose its question, but never the full bank or a grading key.
      const resumed = await snapshot(); assertNoGrading(resumed);
      assert(resumed.activeChallenges.some(c => c.challengeId === result.challengeId));
      for (const hidden of course.assessments.filter(a => !issuedIds.has(a.id))) {
        assert(!JSON.stringify(resumed).includes(hidden.prompt), 'Refresh exposed an unissued prompt');
      }
      return { ...result, item };
    }
    async function answer(challenge, value, expectedPass, expectedIndependent) {
      const result = await command('answers', { challengeId: challenge.challengeId, answer: value });
      assert.equal(result.result.passed, expectedPass); assert.equal(result.result.independent, expectedIndependent);
      return result;
    }
    let wrong = 0, correctedRepeats = 0, assisted = 0, independentPasses = 0;
    for (const [index, episode] of episodes(course).entries()) {
      const blocked = await command('complete', { episodeId: episode.id }, 409);
      assert.equal(blocked.error, 'EVIDENCE_REQUIRED');
      const next = episodes(course)[index + 1];
      if (next) {
        const denied = await command('read', { episodeId: next.id, blockId: next.blocks.find(b => b.type === 'text').id }, 409);
        assert.equal(denied.error, 'PREREQUISITE_NOT_READY');
      }
      for (const block of episode.blocks.filter(b => b.type === 'text')) await command('read', { episodeId: episode.id, blockId: block.id });
      const challenge = await issue(episode.id); assert(challenge.independentEligible);
      await answer(challenge, wrongAnswer(challenge.item), false, true); wrong++;
      const repeat = await issue(episode.id, challenge.item.id); assert(!repeat.independentEligible);
      await answer(repeat, correctAnswer(repeat.item), true, false); correctedRepeats++;
      assert.equal((await command('complete', { episodeId: episode.id }, 409)).error, 'EVIDENCE_REQUIRED');
      if (index === 0) {
        const helped = await issue(episode.id);
        const help = await command('solution', { challengeId: helped.challengeId });
        assert.equal(help.independentEligible, false); assert.equal(typeof help.explanation, 'string');
        await answer(helped, correctAnswer(helped.item), true, false); assisted++;
      }
      const earned = new Set();
      for (let guard = 0; guard < 8; guard++) {
        const fresh = await issue(episode.id); assert(fresh.independentEligible);
        await answer(fresh, correctAnswer(fresh.item), true, true);
        independentPasses++; earned.add(fresh.item.familyId);
        if (earned.size >= 2) break;
        assert.equal((await command('complete', { episodeId: episode.id }, 409)).error, 'EVIDENCE_REQUIRED');
      }
      assert.equal(earned.size, 2);
      const completed = await command('complete', { episodeId: episode.id });
      assert.equal(completed.lessons.find(row => row.id === episode.id).status, 'completed');
      const reloaded = await snapshot(); assertNoBank(reloaded, course);
      assert.equal(reloaded.lessons.find(row => row.id === episode.id).status, 'completed');
    }
    const final = await snapshot(); assert.equal(final.complete, true);
    assert.equal(final.nextEpisodeId, null);
    reports.push({ courseId: course.id, episodesCompleted: episodes(course).length, wrongFirstAnswers: wrong,
      correctedRepeatsNotIndependent: correctedRepeats, helpedAnswersNotIndependent: assisted, independentPasses,
      noAnswerBankLeak: true, resumeVerified: true, complete: true });
  }
  return { transport: 'actual-http', courses: reports, anonymousAccessDenied: true, crossLearnerAccessDenied: !!outsider,
    noProviderRequestsIssued: true };
}
function envSession(prefix) {
  const cookie = process.env[`${prefix}_COOKIE`], csrf = process.env[`${prefix}_CSRF`];
  assert(cookie && csrf, `Provide ${prefix}_COOKIE and ${prefix}_CSRF from a disposable test session`);
  return { cookie, csrf };
}
async function main() {
  const baseUrl = process.env.EXAMPLE_COURSES_BASE_URL, workspaceId = process.env.EXAMPLE_COURSES_WORKSPACE_ID;
  assert(baseUrl && workspaceId, 'Provide EXAMPLE_COURSES_BASE_URL and EXAMPLE_COURSES_WORKSPACE_ID for a test host');
  const report = await runProtocolScenario({ baseUrl, origin: process.env.EXAMPLE_COURSES_ORIGIN,
    workspaceId, owner: envSession('EXAMPLE_COURSES_OWNER'), learner: envSession('EXAMPLE_COURSES_LEARNER') });
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
