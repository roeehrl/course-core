import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';
import type { authService, Actor } from './auth.js';
import { catalogOfRelease, resolveRole, roleCan } from './course-access.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { digestJson } from './repository.js';

/**
 * Staff-authored concept mappings between two course releases (design §4: "cross-course skill
 * transfer requires an explicit concept mapping, not a matching word"). A mapping links objectives
 * of the two releases as equivalent, overlapping, or one a prerequisite of the other.
 *
 * - Only a person who is owner or admin of BOTH courses may create, revise or retire a mapping.
 *   Course grants never confer those roles, so course-scoped staff cannot. Reading needs
 *   course.read on both courses.
 * - Every save is a new immutable version (concept_mapping_versions) naming the author, the role
 *   they held in each workspace, the action and the links: the audit trail.
 * - Nothing is inferred: there is no model, agent or automatic path that writes a mapping. A
 *   suggested mapping from an SDK course package would still need a person to save it here.
 * - A mapping is course structure only. It never moves evidence: learner sharing between two
 *   enrollments needs the learner's own opt-in (cross-course.ts), and gates read only the course's
 *   own assessments.
 */
export const RELATIONS = ['equivalent', 'prerequisite_of', 'overlaps'] as const;
export type Relation = (typeof RELATIONS)[number];
export const MAX_LINKS = 200;
const uuid = z.uuid();
const objectiveId = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/);
const end = z.strictObject({ releaseId: uuid, objectiveId });
const linkSchema = z.strictObject({ relation: z.enum(RELATIONS), from: end, to: end });
export type MappingLink = z.infer<typeof linkSchema>;
const key = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const note = z.string().trim().max(500).optional();
const saveSchema = z.strictObject({
  releaseIds: z.tuple([uuid, uuid]),
  expectedRevision: z.number().int().min(0).max(2147483646),
  idempotencyKey: key,
  links: z.array(linkSchema).max(MAX_LINKS),
  note,
});
const retireSchema = z.strictObject({ expectedRevision: z.number().int().positive().max(2147483646), idempotencyKey: key, note });
const pairQuery = z.strictObject({ first: uuid, second: uuid });

interface ReleaseRow { id: string; workspace_id: string; course_key: string; version: string; status: string; title: string; server_bundle: CourseManifest }
interface MappingRow { id: string; a_workspace_id: string; a_release_id: string; b_workspace_id: string; b_release_id: string; revision: number; state: 'active' | 'retired'; updated_at: Date }

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}
/** The two releases in stored order (a < b). */
export const canonicalPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

async function release(client: PoolClient | Database, id: string): Promise<ReleaseRow | undefined> {
  return (await client.query<ReleaseRow>(`SELECT id,workspace_id,course_key,version,status,learner_bundle->>'title' AS title,server_bundle
    FROM course_releases WHERE id=$1`, [id])).rows[0];
}
/** The actor's governing role on a release's course. A release in a workspace where the actor
 * holds no role does not exist for them (404); one they can see but not act on is 403. */
async function roleOn(client: PoolClient | Database, actor: Pick<Actor, 'id'>, row: ReleaseRow | undefined) {
  requireCondition(row, 'RELEASE_NOT_FOUND', 404);
  const role = await resolveRole(client as PoolClient, actor, row.workspace_id, await catalogOfRelease(client as PoolClient, row));
  requireCondition(role && role !== 'learner', 'RELEASE_NOT_FOUND', 404);
  return role;
}
/** Both releases, with the actor's role on each; `write` requires owner or admin on both. */
async function authorizePair(client: PoolClient | Database, actor: Pick<Actor, 'id'>, ids: [string, string], write: boolean) {
  requireCondition(ids[0] !== ids[1], 'CONCEPT_MAPPING_SAME_RELEASE');
  const [aId, bId] = canonicalPair(ids[0], ids[1]);
  const a = await release(client, aId), b = await release(client, bId);
  const aRole = await roleOn(client, actor, a), bRole = await roleOn(client, actor, b);
  if (write) requireCondition(['owner', 'admin'].includes(aRole) && ['owner', 'admin'].includes(bRole), 'FORBIDDEN', 403);
  else requireCondition(roleCan(aRole, 'course.read') && roleCan(bRole, 'course.read'), 'FORBIDDEN', 403);
  // Two versions of one course are not a cross-course pair.
  requireCondition(!(a!.workspace_id === b!.workspace_id && a!.course_key === b!.course_key), 'CONCEPT_MAPPING_SAME_COURSE', 409);
  return { a: a!, b: b!, aRole, bRole };
}
const objectiveIds = (row: ReleaseRow) => new Set((row.server_bundle.objectives ?? []).map(o => o.id));

/** Validates links against the two releases and returns them in a stable stored form: symmetric
 * relations always run from the stored "a" release; one link per objective pair. */
export function normalizeLinks(links: MappingLink[], a: ReleaseRow, b: ReleaseRow): MappingLink[] {
  const ids = { [a.id]: objectiveIds(a), [b.id]: objectiveIds(b) };
  const seen = new Set<string>();
  const out = links.map(link => {
    requireCondition(link.from.releaseId !== link.to.releaseId && [a.id, b.id].includes(link.from.releaseId) && [a.id, b.id].includes(link.to.releaseId),
      'CONCEPT_MAPPING_LINK_SCOPE', 422);
    requireCondition(ids[link.from.releaseId]!.has(link.from.objectiveId) && ids[link.to.releaseId]!.has(link.to.objectiveId), 'OBJECTIVE_OUT_OF_SCOPE', 422);
    const flipped = link.relation !== 'prerequisite_of' && link.from.releaseId !== a.id;
    const normalized: MappingLink = flipped ? { relation: link.relation, from: link.to, to: link.from } : link;
    const aObjective = normalized.from.releaseId === a.id ? normalized.from.objectiveId : normalized.to.objectiveId;
    const bObjective = normalized.from.releaseId === a.id ? normalized.to.objectiveId : normalized.from.objectiveId;
    const pair = `${aObjective}\u0000${bObjective}`;
    requireCondition(!seen.has(pair), 'CONCEPT_MAPPING_DUPLICATE_LINK', 422);
    seen.add(pair);
    return { relation: normalized.relation, from: { releaseId: normalized.from.releaseId, objectiveId: normalized.from.objectiveId },
      to: { releaseId: normalized.to.releaseId, objectiveId: normalized.to.objectiveId } };
  });
  return out.sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1);
}

/** The mapping in force between two releases (active, with a saved version), or null. Read by the
 * learner-level coordinator and the learner's consent view. */
export async function activeMapping(client: PoolClient, releaseX: string, releaseY: string) {
  const [a, b] = canonicalPair(releaseX, releaseY);
  const row = (await client.query<MappingRow & { links: MappingLink[]; links_digest: string }>(
    `SELECT m.*,v.links,v.links_digest FROM concept_mappings m JOIN concept_mapping_versions v ON v.mapping_id=m.id AND v.revision=m.revision
      WHERE m.a_release_id=$1 AND m.b_release_id=$2 AND m.state='active' AND m.revision>0`, [a, b])).rows[0];
  return row ?? null;
}

/** Wakes the coordinators of learners who opted in for a pair on these releases: the mapping they
 * plan from changed. Identifiers only; the coordinator asks the host what changed. */
async function wakeMappedLearners(client: PoolClient, a: string, b: string) {
  await client.query(`INSERT INTO cross_course_wakeups(id,user_id,reason)
    SELECT gen_random_uuid(),u.user_id,'evidence_changed' FROM (SELECT DISTINCT c.user_id FROM cross_course_consents c
      JOIN enrollments ea ON ea.id=c.a_enrollment_id JOIN enrollments eb ON eb.id=c.b_enrollment_id
     WHERE c.state='granted' AND ((ea.course_release_id=$1 AND eb.course_release_id=$2) OR (ea.course_release_id=$2 AND eb.course_release_id=$1)) LIMIT 1000) u
    ON CONFLICT (user_id) WHERE delivered_at IS NULL AND abandoned_at IS NULL AND lease_token IS NULL DO NOTHING`, [a, b]);
}

async function view(client: PoolClient | Database, mapping: MappingRow, a: ReleaseRow, b: ReleaseRow) {
  const versions = (await client.query<{ revision: number; action: string; links: MappingLink[]; links_digest: string; authored_by: string; author_name: string;
    a_role: string; b_role: string; note: string; created_at: Date }>(
    `SELECT v.revision,v.action,v.links,v.links_digest,v.authored_by,u.display_name AS author_name,v.a_role,v.b_role,v.note,v.created_at
       FROM concept_mapping_versions v JOIN app_users u ON u.id=v.authored_by WHERE v.mapping_id=$1 ORDER BY v.revision DESC LIMIT 50`, [mapping.id])).rows;
  const current = versions.find(v => v.revision === mapping.revision);
  const course = (row: ReleaseRow) => ({ releaseId: row.id, workspaceId: row.workspace_id, courseKey: row.course_key, version: row.version, title: row.title });
  return {
    id: mapping.id, revision: mapping.revision, state: mapping.state, updatedAt: mapping.updated_at.toISOString(),
    courses: { a: course(a), b: course(b) },
    links: current?.links ?? [], linksDigest: current?.links_digest ?? null,
    authoredBy: 'staff' as const, inferred: false as const,
    history: versions.map(v => ({ revision: v.revision, action: v.action, linkCount: v.links.length, linksDigest: v.links_digest,
      author: { id: v.authored_by, displayName: v.author_name }, roles: { a: v.a_role, b: v.b_role }, note: v.note, createdAt: v.created_at.toISOString() })),
  };
}

async function save(client: PoolClient, actor: Actor, raw: unknown) {
  const input = parse(saveSchema, raw);
  const { a, b, aRole, bRole } = await authorizePair(client, actor, input.releaseIds, true);
  requireCondition(['published', 'archived'].includes(a.status) && ['published', 'archived'].includes(b.status), 'RELEASE_NOT_PUBLISHED', 409);
  const links = normalizeLinks(input.links, a, b);
  const requestDigest = digestJson({ op: 'save', releaseIds: [a.id, b.id], links, note: input.note ?? '' });
  // One row per pair, created at most once; the row lock orders every save and retirement.
  await client.query(`INSERT INTO concept_mappings(id,a_workspace_id,a_release_id,b_workspace_id,b_release_id,created_by) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT (a_release_id,b_release_id) DO NOTHING`, [randomUUID(), a.workspace_id, a.id, b.workspace_id, b.id, actor.id]);
  const mapping = (await client.query<MappingRow>('SELECT * FROM concept_mappings WHERE a_release_id=$1 AND b_release_id=$2 FOR UPDATE', [a.id, b.id])).rows[0]!;
  const prior = (await client.query<{ request_digest: string }>('SELECT request_digest FROM concept_mapping_versions WHERE mapping_id=$1 AND idempotency_key=$2',
    [mapping.id, input.idempotencyKey])).rows[0];
  if (prior) {
    requireCondition(prior.request_digest === requestDigest, 'IDEMPOTENCY_CONFLICT', 409);
    return { ...(await view(client, mapping, a, b)), replayed: true };
  }
  requireCondition(input.expectedRevision === mapping.revision, 'CONCEPT_MAPPING_STALE', 409);
  const revision = mapping.revision + 1;
  const action = mapping.revision === 0 ? 'created' : mapping.state === 'retired' ? 'restored' : 'revised';
  await client.query(`INSERT INTO concept_mapping_versions(mapping_id,revision,action,links,links_digest,author_kind,authored_by,a_role,b_role,note,idempotency_key,request_digest)
    VALUES($1,$2,$3,$4,$5,'staff',$6,$7,$8,$9,$10,$11)`,
  [mapping.id, revision, action, JSON.stringify(links), digestJson(links), actor.id, aRole, bRole, input.note ?? '', input.idempotencyKey, requestDigest]);
  const updated = (await client.query<MappingRow>(`UPDATE concept_mappings SET revision=$2,state='active',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
    [mapping.id, revision])).rows[0]!;
  await wakeMappedLearners(client, a.id, b.id);
  return { ...(await view(client, updated, a, b)), replayed: false };
}

async function retire(client: PoolClient, actor: Actor, mappingId: string, raw: unknown) {
  const input = parse(retireSchema, raw);
  const head = (await client.query<MappingRow>('SELECT * FROM concept_mappings WHERE id=$1', [mappingId])).rows[0];
  requireCondition(head, 'CONCEPT_MAPPING_NOT_FOUND', 404);
  const { a, b, aRole, bRole } = await authorizePair(client, actor, [head.a_release_id, head.b_release_id], true);
  const mapping = (await client.query<MappingRow>('SELECT * FROM concept_mappings WHERE id=$1 FOR UPDATE', [mappingId])).rows[0]!;
  const requestDigest = digestJson({ op: 'retire', mappingId, note: input.note ?? '' });
  const prior = (await client.query<{ request_digest: string }>('SELECT request_digest FROM concept_mapping_versions WHERE mapping_id=$1 AND idempotency_key=$2',
    [mapping.id, input.idempotencyKey])).rows[0];
  if (prior) {
    requireCondition(prior.request_digest === requestDigest, 'IDEMPOTENCY_CONFLICT', 409);
    return { ...(await view(client, mapping, a, b)), replayed: true };
  }
  requireCondition(input.expectedRevision === mapping.revision, 'CONCEPT_MAPPING_STALE', 409);
  requireCondition(mapping.state === 'active', 'CONCEPT_MAPPING_RETIRED', 409);
  const links = (await client.query<{ links: MappingLink[] }>('SELECT links FROM concept_mapping_versions WHERE mapping_id=$1 AND revision=$2', [mapping.id, mapping.revision])).rows[0]!.links;
  const revision = mapping.revision + 1;
  await client.query(`INSERT INTO concept_mapping_versions(mapping_id,revision,action,links,links_digest,author_kind,authored_by,a_role,b_role,note,idempotency_key,request_digest)
    VALUES($1,$2,'retired',$3,$4,'staff',$5,$6,$7,$8,$9,$10)`,
  [mapping.id, revision, JSON.stringify(links), digestJson(links), actor.id, aRole, bRole, input.note ?? '', input.idempotencyKey, requestDigest]);
  const updated = (await client.query<MappingRow>(`UPDATE concept_mappings SET revision=$2,state='retired',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
    [mapping.id, revision])).rows[0]!;
  // Pending suggestions planned from a retired mapping are withdrawn; decided ones stay the learner's record.
  await client.query(`DELETE FROM cross_course_suggestions WHERE mapping_id=$1 AND state='pending'`, [mapping.id]);
  await wakeMappedLearners(client, a.id, b.id);
  return { ...(await view(client, updated, a, b)), replayed: false };
}

/** Courses (with their published releases and objectives) the actor may map: those where they are
 * owner or admin. Only these can be picked in the two-course editor. */
async function candidates(db: Database, actor: Actor) {
  const rows = (await db.query<{ catalog_id: string; workspace_id: string; workspace_title: string; course_key: string; course_title: string; role: string;
    release_id: string; version: string; status: string; title: string; objectives: { id: string; description: string }[]; created_at: Date }>(
    `SELECT c.id AS catalog_id,c.workspace_id,w.title AS workspace_title,c.course_key,c.title AS course_title,m.role,
            r.id AS release_id,r.version,r.status,r.learner_bundle->>'title' AS title,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o->>'id','description',o->>'description')) FROM jsonb_array_elements(r.server_bundle->'objectives') o),'[]') AS objectives,
            r.created_at
       FROM memberships m JOIN admin_course_catalog c ON c.workspace_id=m.workspace_id JOIN workspaces w ON w.id=c.workspace_id
       JOIN course_releases r ON r.workspace_id=c.workspace_id AND r.course_key=c.course_key AND r.status IN ('published','archived')
      WHERE m.user_id=$1 AND m.role IN ('owner','admin')
      ORDER BY w.title,c.title,r.created_at DESC,r.id LIMIT 500`, [actor.id])).rows;
  const courses = new Map<string, { catalogId: string; workspaceId: string; workspaceTitle: string; courseKey: string; title: string; role: string;
    releases: { releaseId: string; version: string; status: string; title: string; objectives: { id: string; description: string }[] }[] }>();
  for (const row of rows) {
    const course = courses.get(row.catalog_id) ?? { catalogId: row.catalog_id, workspaceId: row.workspace_id, workspaceTitle: row.workspace_title,
      courseKey: row.course_key, title: row.course_title, role: row.role, releases: [] };
    course.releases.push({ releaseId: row.release_id, version: row.version, status: row.status, title: row.title, objectives: row.objectives });
    courses.set(row.catalog_id, course);
  }
  return { courses: [...courses.values()], relations: RELATIONS, maxLinks: MAX_LINKS };
}

export function registerConceptMappingRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const params = { type: 'object', additionalProperties: false, required: ['mappingId'], properties: { mappingId: { type: 'string', format: 'uuid' } } };
  app.get('/api/admin/concept-mappings/candidates', async request => candidates(db, await auth.authenticate(request)));
  app.get('/api/admin/concept-mappings', async request => {
    const actor = await auth.authenticate(request);
    const query = parse(pairQuery, request.query);
    const { a, b } = await authorizePair(db, actor, [query.first, query.second], false);
    const mapping = (await db.query<MappingRow>('SELECT * FROM concept_mappings WHERE a_release_id=$1 AND b_release_id=$2 AND revision>0', [a.id, b.id])).rows[0];
    const course = (row: ReleaseRow) => ({ releaseId: row.id, workspaceId: row.workspace_id, courseKey: row.course_key, version: row.version, title: row.title,
      objectives: (row.server_bundle.objectives ?? []).map(o => ({ id: o.id, description: o.description })) });
    return { courses: { a: course(a), b: course(b) }, mapping: mapping ? await view(db, mapping, a, b) : null };
  });
  app.post('/api/admin/concept-mappings', async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, client => save(client, actor, request.body));
  });
  app.post('/api/admin/concept-mappings/:mappingId/retire', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { mappingId } = request.params as { mappingId: string };
    return transaction(db, client => retire(client, actor, mappingId, request.body));
  });
}
