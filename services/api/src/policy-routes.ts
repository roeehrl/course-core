import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { acceptExtension, disposeOffer, grantExtension, poolBalances, previewExtension, proposeExtension, resolveConstraints, type PolicyState, type Transition } from '@course-core/policy';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { authService, type Actor } from './auth.js';
import { enrollmentRole } from './course-access.js';
import { enrollmentCommand, loadEnrollment, type CommandInput } from './repository.js';
import { extensionRequest, loadPolicy } from './policy-adapter.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { closedQuestionAllowance, coverageView } from './closure.js';

const path = '/api/enrollments/:enrollmentId';
const params = { type: 'object', required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
const base = { expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 } };
const daysFields = { scopeId: { type: 'string', minLength: 1, maxLength: 200 }, days: { type: 'integer', minimum: 1, maximum: 366 },
  minutes: { type: 'integer', minimum: 1, maximum: 100000 }, episodes: { type: 'integer', minimum: 1, maximum: 1000 },
  poolIds: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } } };
/** Days move a deadline; planned minutes and episodes raise a work cap. At least one is required. */
const someAmount = { anyOf: [{ required: ['days'] }, { required: ['minutes'] }, { required: ['episodes'] }] };
function body(fields: Record<string, unknown>, required: string[]) { return { type: 'object', additionalProperties: false, properties: { ...base, ...fields }, required: ['expectedRevision', 'idempotencyKey', ...required] }; }
type Amounts = { scopeId: string; days?: number; minutes?: number; episodes?: number; poolIds?: string[] };
function extensionArguments(state: PolicyState, input: Amounts) {
  const { scopeId, days, minutes, episodes, poolIds } = input;
  return extensionRequest(state, scopeId, { ...(days ? { days } : {}), ...(minutes ? { minutes } : {}), ...(episodes ? { episodes } : {}), ...(poolIds ? { poolIds } : {}) });
}

async function saveTransition(client: PoolClient, enrollmentId: string, transition: Transition) {
  const result = await client.query(`UPDATE policy_states SET policy_revision=$2,ledger_revision=$3,snapshot=$4,updated_at=now()
    WHERE enrollment_id=$1 AND policy_revision=$5 AND ledger_revision=$6`, [enrollmentId, transition.state.policyRevision, transition.state.ledgerRevision,
    JSON.stringify(transition.state), transition.preconditions.policyRevision, transition.preconditions.ledgerRevision]);
  requireCondition(result.rowCount === 1, 'STALE_POLICY_REVISION', 409);
  await client.query('UPDATE enrollments SET policy_revision=$2 WHERE id=$1', [enrollmentId, transition.state.policyRevision]);
}

export function registerPolicyRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  app.get(`${path}/policy`, { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, false, true), state = await loadPolicy(client, enrollmentId);
      // A closed course's remaining read-only questions, so the companion can say so before they run out.
      // Learner-only: staff reading this enrollment's policy do not see its question usage.
      const closedQuestions = context.enrollment.user_id === actor.id ? await closedQuestionAllowance(client, enrollmentId, state) : undefined;
      return { revision: context.enrollment.revision, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision,
        ...(closedQuestions ? { closedQuestions } : {}),
        constraints: state.scopes.map(scope => resolveConstraints(state, scope.scopeId)), balances: poolBalances(state), offers: state.offers, grants: state.grants,
        // A stable core denominator with personal extras on their own counter (G08).
        coverage: coverageView(context.release.server_bundle, context, state),
        refunds: state.refunds.map(({ authorityReceipt: _a, ...refund }) => refund),
        exceptionalGrants: state.exceptionalGrants.map(({ authorityReceipt: _a, ...entry }) => entry) };
    });
  });
  app.post(`${path}/extensions/preview`, { schema: { params, body: { type: 'object', additionalProperties: false, properties: daysFields, required: ['scopeId'], ...someAmount } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as Amounts;
    return transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, false, true), state = await loadPolicy(client, enrollmentId);
      return { revision: context.enrollment.revision, policyRevision: state.policyRevision, ...previewExtension(state, extensionArguments(state, input)) };
    });
  });
  app.post(`${path}/extensions/propose`, { schema: { params, body: { ...body({ ...daysFields,
    rationaleEventIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
    episodeIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', maxLength: 200 } },
    planImpact: { type: 'string', minLength: 1, maxLength: 2000 }, alternatives: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 1000 } },
  }, ['scopeId', 'rationaleEventIds', 'episodeIds', 'planImpact', 'alternatives']), ...someAmount } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as CommandInput & Amounts & { rationaleEventIds: string[]; episodeIds: string[]; planImpact: string; alternatives: string[] };
    return enrollmentCommand(db, actor, enrollmentId, 'extension.propose', input, async (client, context) => {
      requireCondition(['owner', 'admin', 'instructor'].includes(await enrollmentRole(client, actor, context.enrollment) ?? ''), 'FORBIDDEN', 403);
      const events = await client.query('SELECT id FROM learning_events WHERE enrollment_id=$1 AND id=ANY($2::uuid[])', [enrollmentId, input.rationaleEventIds]);
      requireCondition(events.rowCount === input.rationaleEventIds.length, 'RATIONALE_OUT_OF_SCOPE', 403);
      requireCondition(input.episodeIds.every(id => context.release.server_bundle.chapters.some(ch => ch.episodes.some(ep => ep.id === id))), 'ACTIVITY_OUT_OF_SCOPE');
      const state = await loadPolicy(client, enrollmentId), now = new Date().toISOString(), offerId = randomUUID();
      const transition = proposeExtension(state, { ...extensionArguments(state, input), now, offerId, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
        idempotencyKey: input.idempotencyKey, rationaleEvidenceRefs: input.rationaleEventIds, proposedActivities: input.episodeIds, planImpact: input.planImpact, alternatives: input.alternatives,
        expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() });
      await saveTransition(client, enrollmentId, transition);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'staff', type: 'extension.proposed', payload: { offerId, termsDigest: transition.state.offers.at(-1)!.termsDigest }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { revision: context.enrollment.revision + 1, offer: transition.state.offers.at(-1), balances: poolBalances(transition.state) };
    }, true);
  });
  app.post(`${path}/extensions/accept`, { schema: { params, body: body({ offerId: { type: 'string', format: 'uuid' }, termsDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, explicitConsent: { const: true } }, ['offerId', 'termsDigest', 'explicitConsent']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as CommandInput & { offerId: string; termsDigest: string; explicitConsent: true };
    return enrollmentCommand(db, actor, enrollmentId, 'extension.accept', input, async (client, context) => {
      const state = await loadPolicy(client, enrollmentId), now = new Date().toISOString();
      const acceptance = { receiptId: randomUUID(), learnerId: actor.id, enrollmentId, offerId: input.offerId, termsDigest: input.termsDigest, explicit: true as const, acceptedAt: now };
      const offer = state.offers.find(row => row.terms.offerId === input.offerId);
      requireCondition(offer, 'UNKNOWN_OFFER', 404);
      const common = { now, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision, idempotencyKey: input.idempotencyKey, offerId: input.offerId, acceptance };
      const transition = offer.terms.requiredApprovals.length
        ? acceptExtension(state, common)
        : grantExtension(state, { ...common, grantId: randomUUID(), atomicLedgerTransactionId: randomUUID(), authorityReceipts: [] });
      await saveTransition(client, enrollmentId, transition);
      const grant = transition.state.grants.find(row => row.offerId === input.offerId);
      if (grant) await client.query(`INSERT INTO extension_grants (id,enrollment_id,offer_id,terms_digest,learner_id,consent_receipt,ledger_transaction_id,idempotency_key,grant_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [grant.grantId, enrollmentId, input.offerId, input.termsDigest, actor.id, JSON.stringify(acceptance), grant.atomicLedgerTransactionId, input.idempotencyKey, JSON.stringify(grant)]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: grant ? 'extension.granted' : 'extension.accepted', payload: { offerId: input.offerId, termsDigest: input.termsDigest, grantId: grant?.grantId ?? null }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { revision: context.enrollment.revision + 1, offer: transition.state.offers.find(row => row.terms.offerId === input.offerId), balances: poolBalances(transition.state) };
    });
  });
  app.post(`${path}/extensions/decline`, { schema: { params, body: body({ offerId: { type: 'string', format: 'uuid' } }, ['offerId']) } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as CommandInput & { offerId: string };
    return enrollmentCommand(db, actor, enrollmentId, 'extension.decline', input, async (client, context) => {
      const state = await loadPolicy(client, enrollmentId);
      const transition = disposeOffer(state, { now: new Date().toISOString(), expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision, idempotencyKey: input.idempotencyKey, offerId: input.offerId, state: 'declined', learnerId: actor.id });
      await saveTransition(client, enrollmentId, transition);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'extension.declined', payload: { offerId: input.offerId }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { revision: context.enrollment.revision + 1, balances: poolBalances(transition.state) };
    });
  });
}
