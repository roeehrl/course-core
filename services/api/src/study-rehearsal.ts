import { createHash, randomUUID } from 'node:crypto';
import type { Assessment, CourseManifest } from '@course-core/sdk';
import { compileCourse } from '@course-core/sdk/compiler';
import type { Database } from './database.js';
import { issueLoginCode } from './auth.js';
import { gradeDeterministic } from './learning.js';
import { definitionSchema, INSTRUMENT_SETS, type InstrumentSet } from './study.js';

/**
 * A scripted end-to-end run of a course's study definition (W01) through the real HTTP API and
 * PostgreSQL, before any real learner sees it. It installs the course in a fresh workspace,
 * creates the study from the course's own definition file, opens recruiting, and sends scripted
 * participants through consent, arm assignment, every instrument set (the delayed set through
 * the course's retention schedule, by moving a test clock), an optional withdrawal and, when the
 * study asks for them, usability timings. Then it checks what an analyst relies on:
 * - the definition is accepted, and its warnings are listed;
 * - assignments are balanced and recompute from the seed (no mismatch);
 * - each arm changes behaviour (no companion in an arm without it);
 * - the export has one row per included participant, each scripted outcome appears as
 *   scripted, withdrawn participants are absent and small arms are suppressed;
 * - the export carries no names, emails or account ids.
 * Scripted answers come from the course's keys: only items Core grades itself are answered;
 * others are skipped and listed. An instrument placed later in the course is reached the way a
 * learner reaches it: each earlier required lesson is read, its checkpoint answered from the keys
 * and completed. Where that is impossible (a code task, a written answer, an activity), the
 * rehearsal stops that participant there and reports the lesson and the server's reason. Synthetic participants show that the machinery works. They say
 * nothing about learning: that needs real, consenting learners.
 */

export interface StudyFile { definition: unknown }
export interface RehearsalOptions {
  /** The API under test (createServer); only `inject` is used. */
  app: { inject(request: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<InjectResponse> };
  db: Database;
  clock: { advance(ms: number): void };
  origin: string;
  /** The course's source manifest, as the import route takes it. */
  course: CourseManifest;
  study: StudyFile;
  participants: number;
  /** Seeds the scripted behaviour, so a rehearsal can be repeated exactly. */
  seed?: string;
  /** Chance a scripted participant answers an item correctly, per instrument set. */
  correct?: Partial<Record<InstrumentSet, number>>;
  /** Participants who withdraw after answering (default 1 when there are more than 3 per arm). */
  withdraw?: number;
  /** Receives the CSV export (synthetic participants only), for a closer look. */
  onExport?: (csv: string) => void;
}
interface InjectResponse { statusCode: number; body: string; json(): any; cookies: { name: string; value: string }[]; headers: Record<string, unknown> }
interface Session { id: string; cookie: string; csrf: string }
export interface RehearsalCheck { name: string; ok: boolean; detail: string }
export interface RehearsalReport {
  course: { id: string; version: string };
  study: { warnings: string[]; arms: { id: string; behaviour: string; consented: number }[]; usabilityMeasures: boolean };
  participants: { scripted: number; withdrew: number };
  answered: Record<InstrumentSet, { scripted: number; reached: number; skipped: string[] }>;
  /** Lessons where scripted progress stopped, with the server's reason (counts of participants). */
  blocked: { episodeId: string; reason: string; participants: number }[];
  export: { included: number | null; rows: number; suppressedArms: string[]; columns: number; digest: string };
  checks: RehearsalCheck[];
  ok: boolean;
}

/** Deterministic pseudo-random numbers in [0, 1) from a seed and a label. */
const chance = (seed: string, label: string) => createHash('sha256').update(seed + '\0' + label).digest().readUInt32BE(0) / 2 ** 32;

/** A scripted answer that the item's own grader scores as intended, or null when Core does not
 * grade this item type itself. */
export function scriptedAnswer(item: Assessment, correct: boolean): unknown {
  let answer: unknown;
  if (item.type === 'choice') answer = correct ? item.grading.correctOptionId : item.options.find((o) => o.id !== item.grading.correctOptionId)?.id;
  else if (item.type === 'numeric' || item.type === 'prediction') {
    const { expected, absoluteTolerance, relativeTolerance = 0, unit } = item.grading;
    const value = correct ? expected : expected + 1 + 10 * Math.max(absoluteTolerance, relativeTolerance * Math.abs(expected)) + Math.abs(expected);
    answer = unit ? { value, unit } : value;
  } else if (item.type === 'trace')
    answer = Object.fromEntries(item.grading.expected.map((k) => [k.stepId, correct ? k.answer : k.answer + ' (scripted wrong)']));
  else return null;
  // Never trust the construction: the answer must grade as scripted.
  return answer !== undefined && gradeDeterministic(item, answer).passed === correct ? answer : null;
}

export async function rehearseStudy(options: RehearsalOptions): Promise<RehearsalReport> {
  const { app, db, origin } = options, seed = options.seed ?? 'study-rehearsal';
  const checks: RehearsalCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const definition = definitionSchema.parse(options.study.definition);
  const workspace = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'rehearsal-' + workspace.slice(0, 8), 'Study rehearsal']);
  async function person(role: string): Promise<Session> {
    const id = randomUUID();
    await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `rehearsal:${id}`, `Scripted ${role}`]);
    await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
    const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { id, cookie: r.cookies.map((c) => c.name + '=' + c.value).join('; '), csrf: r.json().csrfToken };
  }
  const call = (who: Session, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { origin, cookie: who.cookie, 'x-csrf-token': who.csrf }, ...(payload === undefined ? {} : { payload }) });
  const ok = async (p: Promise<InjectResponse>, what: string) => {
    const r = await p;
    if (r.statusCode !== 200) throw new Error(`${what}: HTTP ${r.statusCode} ${r.body.slice(0, 300)}`);
    return r.json();
  };

  // ---- course and study, as an owner would set them up
  const owner = await person('owner');
  const release = (await ok(call(owner, 'POST', `/api/workspaces/${workspace}/releases`, options.course), 'import the course')).id as string;
  await ok(call(owner, 'POST', `/api/releases/${release}/publish`), 'publish the course');
  const compiled = compileCourse(options.course).server;
  const courseId = ((await ok(call(owner, 'GET', '/api/admin/session'), 'admin session')).courses as { id: string }[])[0]!.id;
  const created = await call(owner, 'POST', `/api/admin/courses/${courseId}/studies`, { releaseId: release, ...definition });
  if (created.statusCode !== 200) {
    check('definition accepted', false, `HTTP ${created.statusCode} ${created.body.slice(0, 300)}`);
    throw Object.assign(new Error('The study definition was refused; see checks.'), { checks });
  }
  const warnings = created.json().warnings as string[];
  check('definition accepted', true, warnings.length ? `${warnings.length} warning(s)` : 'no warnings');
  const opened = await call(owner, 'POST', `/api/admin/studies/${created.json().study.id}/open`, { expectedRevision: created.json().study.revision });
  check('recruiting opened', opened.statusCode === 200, opened.statusCode === 200 ? 'recruiting' : opened.body.slice(0, 300));
  if (opened.statusCode !== 200) throw Object.assign(new Error('The study could not open; see checks.'), { checks });
  const studyId = created.json().study.id as string;

  // ---- where each instrument item can be answered
  const items = new Map(compiled.assessments.map((a) => [a.id, a]));
  const episodes = compiled.chapters.flatMap((c) => c.episodes);
  const episodeOf = (itemId: string) => episodes.find((e) => e.blocks.some((b) => b.type === 'assessment' && b.assessmentId === itemId))
    ?? episodes.find((e) => { const gate = compiled.gates.find((g) => g.id === e.gateId); return !!gate && 'assessmentIds' in gate && Array.isArray(gate.assessmentIds) && gate.assessmentIds.includes(itemId); });
  const answered = Object.fromEntries(INSTRUMENT_SETS.map((set) => [set, { scripted: 0, reached: 0, skipped: [] as string[] }])) as RehearsalReport['answered'];
  const expected = new Map<string, Record<string, string>>(); // participant code -> item -> outcome
  const rates = { pre: 0.35, post: 0.7, transfer: 0.55, delayed: 0.6, ...options.correct };

  interface Participant extends Session { enrollment: string; code: string; arm: string; behaviour: string }
  const revision = async (p: Participant) => (await ok(call(p, 'GET', `/api/enrollments/${p.enrollment}`), 'read enrollment')).revision as number;
  const send = async (p: Participant, action: string, body: Record<string, unknown>) =>
    call(p, 'POST', `/api/enrollments/${p.enrollment}/${action}`, { expectedRevision: await revision(p), idempotencyKey: 'rehearsal-' + randomUUID(), ...body });
  async function answer(p: Participant, set: InstrumentSet, itemId: string, challenge: { challengeId: string }) {
    const item = items.get(itemId)!, correct = chance(seed, `${p.code}:${itemId}`) < rates[set], value = scriptedAnswer(item, correct);
    const response = await send(p, 'answers', value === null ? { challengeId: challenge.challengeId, abstain: true } : { challengeId: challenge.challengeId, answer: value });
    if (response.statusCode !== 200) throw new Error(`answer ${itemId}: HTTP ${response.statusCode} ${response.body.slice(0, 200)}`);
    (expected.get(p.code) ?? expected.set(p.code, {}).get(p.code)!)[itemId] = value === null ? 'abstained' : correct ? 'correct' : 'incorrect';
    answered[set].reached++;
  }

  // ---- progress: read, answer the checkpoint from the keys, complete; until `target` is open
  const blocked = new Map<string, { episodeId: string; reason: string; participants: Set<string> }>();
  const stop = (p: Participant, episodeId: string, reason: string) => {
    const key = episodeId + ':' + reason, row = blocked.get(key) ?? { episodeId, reason, participants: new Set<string>() };
    row.participants.add(p.code);
    blocked.set(key, row);
    return false;
  };
  const codeOf = (r: InjectResponse) => { try { return String(r.json().error ?? r.statusCode); } catch { return String(r.statusCode); } };
  async function reach(p: Participant, target: string): Promise<boolean> {
    for (let step = 0; step <= episodes.length; step++) {
      const snapshot = await ok(call(p, 'GET', `/api/enrollments/${p.enrollment}`), 'read enrollment');
      const lessons = snapshot.lessons as { id: string; status: string; completedBlockIds: string[] }[];
      if (lessons.find((l) => l.id === target)?.status !== 'locked') return true;
      const next = snapshot.nextEpisodeId as string | null;
      if (!next) return stop(p, target, 'NO_NEXT_LESSON');
      const episode = episodes.find((e) => e.id === next)!, done = lessons.find((l) => l.id === next)?.completedBlockIds ?? [];
      for (const block of episode.blocks.filter((b) => b.type !== 'assessment' && b.type !== 'activity' && !done.includes(b.id))) {
        const read = await send(p, 'read', { episodeId: next, blockId: block.id });
        if (read.statusCode !== 200) return stop(p, next, codeOf(read));
      }
      let decisionId: string | undefined;
      if (episode.gateId) {
        for (let tries = 0; tries < 20; tries++) {
          const decision = (await ok(call(p, 'GET', `/api/enrollments/${p.enrollment}/gates/${encodeURIComponent(episode.gateId)}/decision`), 'gate decision')).decision;
          decisionId = decision.decisionId;
          if (decision.status === 'ready') break;
          const issued = await send(p, 'challenges', { episodeId: next, mode: 'independent' });
          if (issued.statusCode !== 200) return stop(p, next, codeOf(issued));
          const itemId = (issued.json().question?.id ?? issued.json().assessmentId) as string, item = items.get(itemId), value = item ? scriptedAnswer(item, true) : null;
          if (value === null) return stop(p, next, `NOT_SCRIPTABLE:${item?.type ?? 'unknown'}`);
          const answered = await send(p, 'answers', { challengeId: issued.json().challengeId, answer: value });
          if (answered.statusCode !== 200) return stop(p, next, codeOf(answered));
        }
      }
      const completed = await send(p, 'complete', { episodeId: next, ...(decisionId ? { gateDecisionId: decisionId } : {}) });
      if (completed.statusCode !== 200) return stop(p, next, codeOf(completed));
    }
    return stop(p, target, 'TOO_MANY_LESSONS');
  }

  // ---- participants: enroll, consent, answer pre, post and transfer
  const participants: Participant[] = [];
  for (let i = 0; i < options.participants; i++) {
    const who = await person('learner');
    const enrollment = (await ok(call(who, 'POST', '/api/enrollments', { releaseId: release }), 'enroll')).id as string;
    const view = await ok(call(who, 'GET', `/api/enrollments/${enrollment}/study`), 'read the study');
    const p = { ...who, enrollment, code: '', arm: '', behaviour: '' } as Participant;
    const joined = await ok(send(p, 'study/consent', { studyId: view.study.id, consentDigest: view.study.consentDigest }), 'consent');
    p.code = joined.participation.participantCode;
    p.behaviour = joined.participation.version.behaviour;
    p.arm = (await db.query<{ arm_id: string }>('SELECT arm_id FROM study_participants WHERE study_id=$1 AND enrollment_id=$2', [studyId, enrollment])).rows[0]!.arm_id;
    participants.push(p);
  }
  for (const set of ['pre', 'post', 'transfer'] as const)
    for (const itemId of definition.instruments[set]) {
      const episode = episodeOf(itemId), item = items.get(itemId);
      if (!episode || !item) { answered[set].skipped.push(itemId); continue; }
      if (scriptedAnswer(item, true) === null && item.allowAbstain === false) { answered[set].skipped.push(itemId); continue; }
      for (const p of participants) {
        answered[set].scripted++;
        if (!(await reach(p, episode.id))) continue;
        const issued = await send(p, 'challenges', { episodeId: episode.id, assessmentId: itemId, mode: 'independent' });
        if (issued.statusCode !== 200) { if (p === participants[0]) answered[set].skipped.push(`${itemId} (${issued.json().error ?? issued.statusCode})`); continue; }
        await answer(p, set, itemId, issued.json());
      }
    }

  // ---- delayed: demonstrate the objectives through their gate items, then let the retention
  // schedule come due on the test clock and take the offered checks.
  const delayedObjectives = [...new Set(definition.instruments.delayed.flatMap((id) => items.get(id)?.objectiveIds ?? []))];
  if (definition.instruments.delayed.length) {
    for (const p of participants)
      for (const episode of episodes.filter((e) => e.objectiveIds.some((o) => delayedObjectives.includes(o)))) {
        if (!(await reach(p, episode.id))) break;
        const gate = compiled.gates.find((g) => g.id === episode.gateId);
        const gateItems = gate && 'assessmentIds' in gate && Array.isArray(gate.assessmentIds) ? gate.assessmentIds : [];
        for (const itemId of gateItems) {
          const item = items.get(itemId), value = item ? scriptedAnswer(item, true) : null;
          if (value === null) continue;
          const issued = await send(p, 'challenges', { episodeId: episode.id, assessmentId: itemId, mode: 'independent' });
          if (issued.statusCode === 200) await send(p, 'answers', { challengeId: issued.json().challengeId, answer: value });
        }
      }
    const wanted = new Set(definition.instruments.delayed);
    for (let day = 0; day < 45; day++) {
      options.clock.advance(86_400_000);
      for (const p of participants) {
        const due = (await ok(call(p, 'GET', `/api/enrollments/${p.enrollment}/retention`), 'retention')).items as { objectiveId: string; due: boolean }[];
        for (const row of due.filter((r) => r.due && delayedObjectives.includes(r.objectiveId))) {
          const issued = await send(p, 'retention/check', { objectiveId: row.objectiveId });
          if (issued.statusCode !== 200) continue;
          const itemId = (issued.json().question?.id ?? issued.json().question?.assessmentId) as string;
          if (!wanted.has(itemId) || expected.get(p.code)?.[itemId]) {
            // A retention item outside the study, or one already answered: answer it to keep the schedule moving.
            const item = items.get(itemId), value = item ? scriptedAnswer(item, true) : null;
            await send(p, 'answers', value === null ? { challengeId: issued.json().challengeId, abstain: true } : { challengeId: issued.json().challengeId, answer: value });
            continue;
          }
          answered.delayed.scripted++;
          await answer(p, 'delayed', itemId, issued.json());
        }
      }
      if (participants.every((p) => definition.instruments.delayed.every((id) => expected.get(p.code)?.[id]))) break;
    }
    for (const id of definition.instruments.delayed)
      if (!participants.some((p) => expected.get(p.code)?.[id])) answered.delayed.skipped.push(`${id} (not offered within 45 days)`);
  }

  // ---- arm behaviour: no companion where the arm does not offer it
  for (const behaviour of [...new Set(participants.map((p) => p.behaviour))]) {
    const p = participants.find((x) => x.behaviour === behaviour)!;
    const episode = episodes[0]!;
    const asked = await send(p, 'companion', { episodeId: episode.id, content: 'Scripted question for the rehearsal.' });
    const refusedByArm = asked.statusCode === 409 && asked.json().error === 'STUDY_ARM_NO_COMPANION';
    check(`arm ${behaviour}: companion ${behaviour === 'fixed' ? 'refused' : 'not refused by the arm'}`, behaviour === 'fixed' ? refusedByArm : !refusedByArm,
      `HTTP ${asked.statusCode}${asked.statusCode !== 200 ? ' ' + (asked.json().error ?? '') : ''}`);
  }

  // ---- usability timings, when the study asked for them
  if (definition.usabilityMeasures)
    for (const p of participants) {
      const trials = [
        { kind: 'next_action', place: 'course_page', deviceClass: 'desktop', outcome: 'reached', elapsedMs: 2000 + Math.round(chance(seed, p.code + ':ux') * 8000), wrongTurns: chance(seed, p.code + ':wt') < 0.2 ? 1 : 0, contextKept: null },
        { kind: 'detour_return', place: 'lesson', deviceClass: 'desktop', outcome: 'reached', elapsedMs: 15000, wrongTurns: 0, contextKept: true },
      ];
      const r = await call(p, 'POST', `/api/enrollments/${p.enrollment}/study/usability`, { batchId: randomUUID(), trials });
      if (r.statusCode !== 200) check('usability timings accepted', false, `HTTP ${r.statusCode} ${r.body.slice(0, 200)}`);
    }

  // ---- withdrawal: the last participants leave and must vanish from the export
  const perArm = Math.floor(participants.length / definition.arms.length);
  const leaving = participants.slice(participants.length - (options.withdraw ?? (perArm > 3 ? 1 : 0)));
  for (const p of leaving) await ok(send(p, 'study/withdraw', { studyId }), 'withdraw');

  // ---- what the analyst gets
  const allocation = await ok(call(owner, 'GET', `/api/admin/studies/${studyId}/allocation-check`), 'allocation check');
  check('assignments recompute from the seed', allocation.mismatches === 0 && allocation.checked === participants.length,
    `${allocation.checked} checked, ${allocation.mismatches} mismatch(es)`);
  const counts = new Map<string, number>();
  for (const p of participants) counts.set(p.arm, (counts.get(p.arm) ?? 0) + 1);
  const sizes = definition.arms.map((a) => counts.get(a.id) ?? 0);
  check('arms balanced', Math.max(...sizes) - Math.min(...sizes) <= 1, definition.arms.map((a, i) => `${a.id}=${sizes[i]}`).join(', '));
  const jsonResponse = await call(owner, 'GET', `/api/admin/studies/${studyId}/export?format=json`);
  const csvResponse = await call(owner, 'GET', `/api/admin/studies/${studyId}/export?format=csv`);
  const document = jsonResponse.json(), csv = csvResponse.body;
  options.onExport?.(csv);
  const stayed = participants.filter((p) => !leaving.includes(p));
  const included = new Map<string, number>();
  for (const p of stayed) included.set(p.arm, (included.get(p.arm) ?? 0) + 1);
  const suppressed = definition.arms.filter((a) => (included.get(a.id) ?? 0) < definition.minCellSize).map((a) => a.id);
  const visible = stayed.filter((p) => !suppressed.includes(p.arm));
  check('one export row per included participant', document.participants.length === visible.length,
    `${document.participants.length} row(s), ${visible.length} expected; suppressed arms: ${suppressed.join(', ') || 'none'}`);
  check('withdrawn participants absent', leaving.every((p) => !document.participants.some((r: { participant: string }) => r.participant === p.code)), `${leaving.length} withdrew`);
  check('small arms suppressed', document.arms.every((a: { id: string; suppressed: boolean }) => a.suppressed === suppressed.includes(a.id)), suppressed.join(', ') || 'none below the minimum');
  let mismatched = 0, compared = 0;
  for (const row of document.participants as { participant: string; sets: Record<string, { outcomes: Record<string, string> }> }[])
    for (const set of INSTRUMENT_SETS)
      for (const [itemId, outcome] of Object.entries(row.sets[set]!.outcomes)) {
        const scripted = expected.get(row.participant)?.[itemId] ?? 'not_attempted';
        compared++;
        if (scripted !== outcome) mismatched++;
      }
  for (const set of INSTRUMENT_SETS)
    if (definition.instruments[set].length)
      check(`${set} items reached by scripted participants`, answered[set].reached > 0 && answered[set].skipped.length === 0,
        `${answered[set].reached} answer(s); not reached: ${answered[set].skipped.join(', ') || 'none'}`);
  check('every scripted outcome appears as scripted', mismatched === 0, `${compared} outcome(s) compared, ${mismatched} different`);
  const leaks = [...participants.flatMap((p) => [p.id, p.enrollment]), 'rehearsal:', 'Scripted '].filter((s) => jsonResponse.body.includes(s) || csv.includes(s));
  check('export holds no names or account ids', leaks.length === 0, leaks.length ? `${leaks.length} identifier(s) found` : 'none found');
  if (definition.usabilityMeasures)
    check('usability columns present', csv.split('\r\n')[0]!.includes('ux_next_first_try') && visible.every((p) => {
      const row = document.participants.find((r: { participant: string }) => r.participant === p.code);
      return row?.usability?.nextTrials === 1 && row.usability.detours === 1;
    }), 'one timed next step and one detour per participant');

  return {
    course: { id: compiled.id, version: compiled.version },
    study: { warnings, usabilityMeasures: definition.usabilityMeasures,
      arms: definition.arms.map((a) => ({ id: a.id, behaviour: a.behaviour, consented: counts.get(a.id) ?? 0 })) },
    participants: { scripted: participants.length, withdrew: leaving.length },
    answered,
    blocked: [...blocked.values()].map((b) => ({ episodeId: b.episodeId, reason: b.reason, participants: b.participants.size })),
    export: { included: document.included, rows: document.participants.length, suppressedArms: suppressed, columns: csv.split('\r\n')[0]!.split(',').length,
      digest: String(csvResponse.headers['x-export-digest'] ?? '') },
    checks,
    ok: checks.every((c) => c.ok),
  };
}
