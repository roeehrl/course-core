import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isSupportedLocale, parseAcceptLanguage, resolveLocale, SUPPORTED_LOCALES, type LocaleSource, type SupportedLocale } from '@course-core/i18n';
import type { Actor } from './auth.js';
import { isMember, workspaceRole } from './course-access.js';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';

/**
 * UI locale selection (docs/i18n.md). The order is: the user's saved preference, the request's
 * Accept-Language, the workspace default (an owner setting), then English. Only supported
 * locales (SUPPORTED_LOCALES in @course-core/i18n) are stored or returned; pseudo-locales are a
 * client-side development aid and never reach the server.
 *
 * The API answers with machine codes and parameters, not prose. `requestLocale` exists for the
 * rare text the server itself renders, so it follows the same order as the clients.
 */
type Auth = { authenticate(request: FastifyRequest): Promise<Actor> };
const uuid = { type: 'string', format: 'uuid' };
const nullableTag = { anyOf: [{ type: 'string', minLength: 1, maxLength: 35 }, { type: 'null' }] };
const supported = (value: string | null | undefined): SupportedLocale | null => (isSupportedLocale(value) ? value : null);

/** The workspace default that applies to a user: the given workspace (membership required), else their first workspace that sets one. */
async function workspaceDefault(db: Database, actorId: string, workspaceId?: string): Promise<SupportedLocale | null> {
  if (workspaceId) {
    const row = (await db.query<{ default_locale: string | null }>(
      'SELECT w.default_locale FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.id=$1 AND m.user_id=$2', [workspaceId, actorId])).rows[0];
    if (!row) throw new ApiError(403, 'FORBIDDEN');
    return supported(row.default_locale);
  }
  const row = (await db.query<{ default_locale: string }>(
    `SELECT w.default_locale FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
     WHERE m.user_id=$1 AND w.default_locale IS NOT NULL ORDER BY w.created_at,w.id LIMIT 1`, [actorId])).rows[0];
  return supported(row?.default_locale);
}
async function userPreference(db: Database, actorId: string): Promise<SupportedLocale | null> {
  return supported((await db.query<{ locale: string | null }>('SELECT locale FROM app_users WHERE id=$1', [actorId])).rows[0]?.locale);
}
const requested = (request: FastifyRequest) => {
  const header = request.headers['accept-language'];
  return parseAcceptLanguage(Array.isArray(header) ? header.join(',') : header);
};

/** The UI locale for this request, for any server-rendered text. Without an actor only Accept-Language applies. */
export async function requestLocale(db: Database, request: FastifyRequest, actorId?: string, workspaceId?: string): Promise<{ locale: SupportedLocale; source: LocaleSource }> {
  const user = actorId ? await userPreference(db, actorId) : null;
  const workspace = actorId ? await workspaceDefault(db, actorId, workspaceId) : null;
  const resolved = resolveLocale({ user, requested: requested(request), workspace });
  return { locale: resolved.locale as SupportedLocale, source: resolved.source };
}

async function view(db: Database, request: FastifyRequest, actorId: string, workspaceId?: string) {
  const preference = await userPreference(db, actorId);
  const workspace = await workspaceDefault(db, actorId, workspaceId);
  const resolved = resolveLocale({ user: preference, requested: requested(request), workspace });
  return { preference, locale: resolved.locale as SupportedLocale, source: resolved.source, workspaceDefault: workspace, supported: [...SUPPORTED_LOCALES] };
}

export function registerLocaleRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  app.get('/api/me/locale', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { workspaceId: uuid } } },
  }, async request => {
    const actor = await auth.authenticate(request);
    return view(db, request, actor.id, (request.query as { workspaceId?: string }).workspaceId);
  });
  app.put('/api/me/locale', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['locale'], properties: { locale: nullableTag } } },
  }, async request => {
    const actor = await auth.authenticate(request);
    const { locale } = request.body as { locale: string | null };
    requireCondition(locale === null || isSupportedLocale(locale), 'UNSUPPORTED_LOCALE');
    await db.query('UPDATE app_users SET locale=$2 WHERE id=$1', [actor.id, locale]);
    return view(db, request, actor.id);
  });
  const params = { type: 'object', properties: { workspaceId: uuid }, required: ['workspaceId'] };
  app.get('/api/workspaces/:workspaceId/locale', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request);
    const { workspaceId } = request.params as { workspaceId: string };
    requireCondition(await isMember(db, actor, workspaceId), 'FORBIDDEN', 403);
    return { defaultLocale: await workspaceDefault(db, actor.id, workspaceId), supported: [...SUPPORTED_LOCALES] };
  });
  app.put('/api/workspaces/:workspaceId/locale', {
    schema: { params, body: { type: 'object', additionalProperties: false, required: ['defaultLocale'], properties: { defaultLocale: nullableTag } } },
  }, async request => {
    const actor = await auth.authenticate(request);
    const { workspaceId } = request.params as { workspaceId: string };
    const { defaultLocale } = request.body as { defaultLocale: string | null };
    return transaction(db, async client => {
      await workspaceRole(client, actor, workspaceId, ['owner']);
      requireCondition(defaultLocale === null || isSupportedLocale(defaultLocale), 'UNSUPPORTED_LOCALE');
      const previous = (await client.query<{ default_locale: string | null }>('SELECT default_locale FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0]!.default_locale;
      if (previous !== defaultLocale) {
        await client.query('UPDATE workspaces SET default_locale=$2 WHERE id=$1', [workspaceId, defaultLocale]);
        await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'workspace.locale_changed',
          payload: { defaultLocale, previous }, idempotencyKey: `workspace-locale:${workspaceId}:${randomUUID()}` });
      }
      return { defaultLocale: supported(defaultLocale), supported: [...SUPPORTED_LOCALES] };
    });
  });
}
