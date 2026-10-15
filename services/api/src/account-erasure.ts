import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { eraseWithin } from './data-lifecycle.js';
import { lockKeys, openSupervisorOperationKeys } from './erasure-spend.js';
import { recordSpendEvents } from './provider-costs.js';
import { afterCommitTransaction, onCommit } from './after-commit.js';

export const ACCOUNT_ERASURE_CONFIRMATION = 'ERASE MY ACCOUNT';
const TERMINAL = "('applied','cancelled','failed')";

/**
 * POST /api/account/erase {confirmation:'ERASE MY ACCOUNT', reason}: the learner
 * erases every enrollment they have and then their account. The same two steps
 * as one enrollment's erasure (data-lifecycle.ts): first supervision is
 * withdrawn and running jobs are asked to stop (409 ERASURE_WAITING_FOR_SUPERVISION
 * until they have); then, in one transaction, every enrollment is redacted and
 * finished paid work is settled, and the account loses its name, sign-in
 * identity, password, passkeys, sign-in codes, sessions and memberships. The
 * account id stays as an anonymous identifier so audit rows that name it remain
 * valid. Accounts holding a staff role are refused: an administrator must move
 * that role first, so no workspace loses its owner. Replays return the record.
 */
export function registerAccountErasureRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, cookies: { secure: boolean }) {
  const body = z.strictObject({ confirmation: z.string().max(100), reason: z.string().trim().min(10).max(1000) });
  app.post('/api/account/erase', { bodyLimit: 8192 }, async (request, reply) => {
    const actor = await auth.authenticate(request);
    const input = body.safeParse(request.body);
    requireCondition(input.success, 'INVALID_INPUT', 400);
    requireCondition(input.data!.confirmation === ACCOUNT_ERASURE_CONFIRMATION, 'ERASURE_CONFIRMATION_REQUIRED', 400);
    const pending = await transaction(db, async client => {
      await client.query('SELECT 1 FROM app_users WHERE id=$1 FOR UPDATE', [actor.id]);
      const staff = await client.query("SELECT 1 FROM memberships WHERE user_id=$1 AND role<>'learner' LIMIT 1", [actor.id]);
      requireCondition(!staff.rowCount, 'ACCOUNT_HAS_STAFF_ROLE', 409);
      const enrollments = (await client.query<{ id: string }>("SELECT id FROM enrollments WHERE user_id=$1 AND status<>'erased' ORDER BY id FOR UPDATE", [actor.id])).rows.map(row => row.id);
      await client.query('UPDATE supervisor_permissions SET adaptive_teaching=false,revision=revision+1 WHERE enrollment_id=ANY($1::uuid[]) AND adaptive_teaching', [enrollments]);
      const active = await client.query(`UPDATE supervisor_jobs SET cancellation_requested=true WHERE enrollment_id=ANY($1::uuid[]) AND state NOT IN ${TERMINAL} RETURNING id`, [enrollments]);
      return { enrollments, active: active.rowCount ?? 0 };
    });
    requireCondition(!pending.active, 'ERASURE_WAITING_FOR_SUPERVISION', 409);
    const result = await afterCommitTransaction(db, async client => {
      // Operation locks first (as the gateway takes them), then the account, then each enrollment.
      const keys = (await Promise.all(pending.enrollments.map(id => openSupervisorOperationKeys(client, id)))).flat();
      await lockKeys(client, keys);
      await client.query('SELECT 1 FROM app_users WHERE id=$1 FOR UPDATE', [actor.id]);
      const enrollments = (await client.query<{ id: string; workspace_id: string }>("SELECT id,workspace_id FROM enrollments WHERE user_id=$1 AND status<>'erased' ORDER BY id FOR UPDATE",
        [actor.id])).rows;
      // An enrollment started between the two steps is not erased half-way: start over.
      requireCondition(enrollments.every(row => pending.enrollments.includes(row.id)), 'ERASURE_WAITING_FOR_SUPERVISION', 409);
      const busy = await client.query(`SELECT 1 FROM supervisor_jobs WHERE enrollment_id=ANY($1::uuid[]) AND state NOT IN ${TERMINAL} LIMIT 1`, [enrollments.map(row => row.id)]);
      requireCondition(!busy.rowCount, 'ERASURE_WAITING_FOR_SUPERVISION', 409);
      const counts: Record<string, number> = {}, spend: Awaited<ReturnType<typeof eraseWithin>>["spend"] = [];
      for (const enrollment of enrollments) {
        const erased = await eraseWithin(client, enrollment);
        for (const [key, value] of Object.entries(erased.counts)) counts[key] = (counts[key] ?? 0) + value;
        spend.push(...erased.spend);
        await client.query("INSERT INTO data_erasures(id,enrollment_id,workspace_id,requested_by,actor_kind,reason,counts) VALUES($1,$2,$3,$4,'learner',$5,$6)",
          [randomUUID(), enrollment.id, enrollment.workspace_id, actor.id, input.data!.reason, JSON.stringify(erased.counts)]);
        await appendEvent(client, { workspaceId: enrollment.workspace_id, actorId: actor.id, actorKind: 'learner', type: 'data.erased',
          payload: { enrollmentId: enrollment.id, counts: erased.counts, scope: 'account' }, idempotencyKey: 'data-erasure:' + enrollment.id });
      }
      onCommit(client, () => recordSpendEvents(spend));
      // The account: no name, sign-in identity or way to sign in, and no workspace access.
      const account: Record<string, number> = {};
      const run = async (label: string, sql: string) => { account[label] = (await client.query(sql, [actor.id])).rowCount ?? 0; };
      await run('sessions', 'UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL');
      await run('signInCodes', 'DELETE FROM login_codes WHERE user_id=$1');
      await run('passkeyChallenges', 'DELETE FROM passkey_challenges WHERE user_id=$1');
      await run('passkeys', 'DELETE FROM passkey_credentials WHERE user_id=$1');
      await run('password', 'DELETE FROM password_credentials WHERE user_id=$1');
      await run('memberships', 'DELETE FROM memberships WHERE user_id=$1');
      await run('account', "UPDATE app_users SET display_name='Erased account',subject='erased:'||id::text,login_name=NULL WHERE id=$1");
      const all = { ...counts, ...Object.fromEntries(Object.entries(account).map(([key, value]) => [`account.${key}`, value])) };
      await client.query('INSERT INTO account_erasures(id,user_id,enrollment_ids,counts,reason) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.id, JSON.stringify(enrollments.map(row => row.id)), JSON.stringify(all), input.data!.reason]);
      return { status: 'erased' as const, enrollmentIds: enrollments.map(row => row.id), counts: all };
    });
    const options = { httpOnly: true, secure: cookies.secure, sameSite: 'strict' as const, path: '/' };
    reply.clearCookie('course_session', options).clearCookie('course_csrf', options);
    return result;
  });
}
