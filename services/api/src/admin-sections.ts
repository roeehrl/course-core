import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { AdminSection, AdminSetting, CourseManifest } from "@course-core/sdk";
import type { authService, Actor } from "./auth.js";
import { transaction, type Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { catalogOfEnrollment, resolveRole, roleCan, type AdminPermission } from "./course-access.js";

/**
 * Course-declared admin sections (SDK `defineAdminSection`).
 *
 * A release declares sections in its server bundle; Core renders each one as a form built
 * from its settings schema and never loads course code into the administration app (a
 * declared `rendererRef` is reported, not executed). Every rule is enforced here, on the
 * server, whatever the client shows:
 * - a section is visible only to a role holding the read permissions it declares;
 * - a setting changes only for a role holding its mutation permission, with a value that
 *   matches its declared type, bounds, length or options, at its declared scope;
 * - writes are revisioned and each one is audited (`audit: 'all_mutations'`);
 * - no section reads learner data. A section declaring `scoped_with_consent` gets none,
 *   because there is no learner sharing control yet (learner-privacy.ts).
 *
 * SDK permissions map onto Core's permission matrix (course-access.ts). An SDK permission
 * with no Core counterpart would map to null, which no role holds.
 */
export const SDK_ADMIN_PERMISSIONS: Readonly<Record<AdminSection["requiredPermissions"][number], AdminPermission | null>> = {
  "course.read": "course.read",
  "course.settings.write": "course.write",
  "policy.read": "policy.read",
  "policy.write": "policy.write",
  "learners.read_evidence": "enrollment.read",
  "reviews.write": "evidence.review",
  "research.review": "release.review",
  "supervision.control": "supervision.control",
  "debug.read": "run.inspect",
  "debug.payload": "run.payload",
  "audit.read": "audit.read",
};

type Sql = Database | PoolClient;
type Auth = ReturnType<typeof authService>;
type Scope = AdminSetting["scope"];
type Value = boolean | number | string;
interface Catalog { id: string; workspace_id: string; course_key: string; active_release_id: string | null }
interface StoredRow { setting_values: Record<string, unknown>; revision: number; section_version: string; updated_at: Date }

const holds = (role: string | null, permission: AdminSection["requiredPermissions"][number]) => {
  const core = SDK_ADMIN_PERMISSIONS[permission];
  return core !== null && core !== undefined && roleCan(role, core);
};
/** The SDK's write permissions (its ADMIN_WRITE_PERMISSIONS, which it does not export). */
export const SDK_WRITE_PERMISSIONS: ReadonlySet<string> = new Set(["course.settings.write", "policy.write", "reviews.write", "supervision.control"]);
/**
 * Whether a role may open a section. `requiredPermissions` declares every permission the
 * section uses; the read permissions among them gate viewing, so for example an instructor
 * may read a section whose settings only an author may change. A section declaring only
 * write permissions is visible to a role holding at least one of them.
 */
export function maySeeSection(role: string | null, section: AdminSection) {
  const reads = section.requiredPermissions.filter((p) => !SDK_WRITE_PERMISSIONS.has(p));
  return reads.length ? reads.every((p) => holds(role, p)) : section.requiredPermissions.some((p) => holds(role, p));
}
/** Whether a role may change one setting: it must see the section and hold the setting's mutation permission. */
export const mayChangeSetting = (role: string | null, section: AdminSection, setting: AdminSetting) =>
  maySeeSection(role, section) && section.requiredPermissions.includes(setting.mutationPermission) && holds(role, setting.mutationPermission);

/** Whether `value` is valid for `setting` as declared. */
export function settingAccepts(setting: AdminSetting, value: unknown): value is Value {
  switch (setting.type) {
    case "boolean": return typeof value === "boolean";
    case "integer": return Number.isInteger(value) && (value as number) >= setting.minimum && (value as number) <= setting.maximum;
    case "number": return typeof value === "number" && Number.isFinite(value) && value >= setting.minimum && value <= setting.maximum;
    case "string": return typeof value === "string" && value.length <= setting.maxLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
    case "enum": return typeof value === "string" && setting.options.includes(value);
  }
}

/** Effective values of one section for one scope target: a stored value only while it is
 * still valid for the declaration in force, otherwise the declared default. */
export function effectiveValues(section: AdminSection, scope: Scope, stored: Record<string, unknown> | undefined) {
  return section.settings.filter((s) => s.scope === scope).map((setting) => {
    const has = stored !== undefined && Object.hasOwn(stored, setting.id), valid = has && settingAccepts(setting, stored[setting.id]);
    return { setting, value: (valid ? stored[setting.id] : setting.default) as Value, source: valid ? ("saved" as const) : ("default" as const), discarded: has && !valid };
  });
}

/**
 * The values a trusted extension reads for one enrollment: for each setting, the value at its
 * declared scope (the enrollment, its current chapter, or the course), falling back to the
 * default. Declarations come from the enrollment's own release.
 */
export async function adminSectionSettingsFor(client: Sql, enrollment: { id: string; workspace_id: string; course_release_id: string; current_episode_id: string | null }, sectionId: string) {
  const release = (await client.query<{ course_key: string; server_bundle: CourseManifest }>("SELECT course_key,server_bundle FROM course_releases WHERE id=$1 AND workspace_id=$2",
    [enrollment.course_release_id, enrollment.workspace_id])).rows[0];
  const section = release?.server_bundle.adminSections?.find((s) => s.id === sectionId);
  if (!release || !section) return null;
  // The chapter of the current episode; before the first episode starts, the first chapter.
  const chapters = release.server_bundle.chapters;
  const chapter = (chapters.find((c) => c.episodes.some((e) => e.id === enrollment.current_episode_id)) ?? chapters[0])?.id ?? null;
  const result: Record<string, Value> = {};
  for (const scope of ["course", "chapter", "enrollment"] as const) {
    const ref = scope === "course" ? "" : scope === "chapter" ? chapter : enrollment.id;
    const stored = ref === null ? undefined : (await storedValues(client, enrollment.workspace_id, release.course_key, section.id, scope, ref))?.setting_values;
    for (const row of effectiveValues(section, scope, stored)) result[row.setting.id] = row.value;
  }
  return result;
}

async function storedValues(client: Sql, workspaceId: string, courseKey: string, sectionId: string, scope: Scope, scopeRef: string, lock = false) {
  return (await client.query<StoredRow>(
    `SELECT setting_values,revision,section_version,updated_at FROM admin_section_values
      WHERE workspace_id=$1 AND course_key=$2 AND section_id=$3 AND scope=$4 AND scope_ref=$5 ${lock ? "FOR UPDATE" : ""}`,
    [workspaceId, courseKey, sectionId, scope, scopeRef])).rows[0];
}

const uuid = z.uuid();
const scopeQuery = z.strictObject({
  scope: z.enum(["course", "chapter", "enrollment"]).default("course"),
  scopeRef: z.string().max(200).default(""),
});
const writeSchema = z.strictObject({
  scope: z.enum(["course", "chapter", "enrollment"]),
  scopeRef: z.string().max(200),
  expectedRevision: z.number().int().min(0),
  values: z.record(z.string().min(1).max(200), z.union([z.boolean(), z.number(), z.string().max(100_000)])),
});
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, "INVALID_REQUEST");
  return parsed.data;
}
const params = (request: FastifyRequest) => request.params as Record<string, string>;

/** The course, the role governing it (course grants honoured) and its active release's sections. */
async function courseSections(client: Sql, actor: Actor, courseId: string, lock = false) {
  parse(uuid, courseId);
  const catalog = (await client.query<Catalog>(`SELECT id,workspace_id,course_key,active_release_id FROM admin_course_catalog WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [courseId])).rows[0];
  requireCondition(catalog, "COURSE_NOT_FOUND", 404);
  const role = await resolveRole(client, actor, catalog.workspace_id, catalog.id);
  requireCondition(roleCan(role, "course.read"), "FORBIDDEN", 403);
  const release = catalog.active_release_id
    ? (await client.query<{ id: string; version: string; server_bundle: CourseManifest }>("SELECT id,version,server_bundle FROM course_releases WHERE id=$1", [catalog.active_release_id])).rows[0]
    : undefined;
  return { catalog, role, release, sections: release?.server_bundle.adminSections ?? [] };
}

/** Checks that a scope target exists in this course; enrollment targets also need enrollment.read. */
async function checkTarget(client: Sql, catalog: Catalog, role: string | null, bundle: CourseManifest, scope: Scope, scopeRef: string) {
  if (scope === "course") { requireCondition(scopeRef === "", "ADMIN_SECTION_SCOPE_INVALID", 400); return; }
  if (scope === "chapter") { requireCondition(bundle.chapters.some((c) => c.id === scopeRef), "ADMIN_SECTION_SCOPE_INVALID", 400); return; }
  requireCondition(uuid.safeParse(scopeRef).success, "ADMIN_SECTION_SCOPE_INVALID", 400);
  requireCondition(roleCan(role, "enrollment.read"), "FORBIDDEN", 403);
  const enrollment = (await client.query<{ workspace_id: string; course_release_id: string }>("SELECT workspace_id,course_release_id FROM enrollments WHERE id=$1 AND workspace_id=$2",
    [scopeRef, catalog.workspace_id])).rows[0];
  requireCondition(enrollment && (await catalogOfEnrollment(client, enrollment)) === catalog.id, "ADMIN_SECTION_SCOPE_INVALID", 400);
}

function sectionView(section: AdminSection, role: string | null, scope: Scope, scopeRef: string, stored: StoredRow | undefined) {
  const scopes = (["course", "chapter", "enrollment"] as const).filter((s) => section.settings.some((setting) => setting.scope === s));
  return {
    id: section.id,
    version: section.version,
    title: section.title,
    description: section.description ?? null,
    learnerDataAccess: section.learnerDataAccess,
    // Core does not share learner data with sections (no consent control exists yet).
    learnerDataShared: false,
    renderer: { kind: "core_schema_form" as const, declaredRendererRef: section.rendererRef ?? null, declaredRendererLoaded: false },
    scopes,
    scope,
    scopeRef,
    revision: stored?.revision ?? 0,
    savedForVersion: stored?.section_version ?? null,
    updatedAt: stored?.updated_at.toISOString() ?? null,
    settings: effectiveValues(section, scope, stored?.setting_values).map(({ setting, value, source, discarded }) => ({
      ...setting,
      description: setting.description ?? null,
      value,
      source,
      discardedSavedValue: discarded,
      canEdit: mayChangeSetting(role, section, setting),
    })),
  };
}

export function registerAdminSectionRoutes(app: FastifyInstance, db: Database, auth: Auth, path = "/api/admin") {
  const base = `${path}/courses/:courseId/admin-sections`;
  /** Sections of the active release this role may open (navigation). */
  app.get(base, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { role, release, sections } = await courseSections(client, actor, params(request).courseId!);
      return {
        release: release ? { id: release.id, version: release.version } : null,
        sections: sections.filter((s) => maySeeSection(role, s)).map((s) => ({ id: s.id, version: s.version, title: s.title })),
        chapters: release ? release.server_bundle.chapters.map((c) => ({ id: c.id, title: c.title })) : [],
      };
    });
  });
  app.get(`${base}/:sectionId`, async (request) => {
    const actor = await auth.authenticate(request), query = parse(scopeQuery, request.query ?? {});
    return transaction(db, async (client) => {
      const { catalog, role, release, sections } = await courseSections(client, actor, params(request).courseId!);
      const section = sections.find((s) => s.id === params(request).sectionId);
      requireCondition(section, "ADMIN_SECTION_NOT_FOUND", 404);
      requireCondition(maySeeSection(role, section), "FORBIDDEN", 403);
      await checkTarget(client, catalog, role, release!.server_bundle, query.scope, query.scopeRef);
      const stored = await storedValues(client, catalog.workspace_id, catalog.course_key, section.id, query.scope, query.scopeRef);
      return { release: { id: release!.id, version: release!.version }, section: sectionView(section, role, query.scope, query.scopeRef, stored) };
    });
  });
  app.put(`${base}/:sectionId/values`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(writeSchema, request.body);
    return transaction(db, async (client) => {
      const { catalog, role, release, sections } = await courseSections(client, actor, params(request).courseId!, true);
      const section = sections.find((s) => s.id === params(request).sectionId);
      requireCondition(section, "ADMIN_SECTION_NOT_FOUND", 404);
      requireCondition(maySeeSection(role, section), "FORBIDDEN", 403);
      await checkTarget(client, catalog, role, release!.server_bundle, input.scope, input.scopeRef);
      const ids = Object.keys(input.values);
      requireCondition(ids.length > 0, "INVALID_REQUEST");
      const changed: { settingId: string; from: Value; to: Value }[] = [];
      const current = await storedValues(client, catalog.workspace_id, catalog.course_key, section.id, input.scope, input.scopeRef, true);
      requireCondition((current?.revision ?? 0) === input.expectedRevision, "STALE_REVISION", 409);
      const effective = new Map(effectiveValues(section, input.scope, current?.setting_values).map((row) => [row.setting.id, row]));
      for (const id of ids) {
        const setting = section.settings.find((s) => s.id === id);
        requireCondition(setting, "ADMIN_SETTING_UNKNOWN", 400);
        requireCondition(setting.scope === input.scope, "ADMIN_SETTING_SCOPE_MISMATCH", 400);
        requireCondition(mayChangeSetting(role, section, setting), "FORBIDDEN", 403);
        requireCondition(settingAccepts(setting, input.values[id]), "ADMIN_SETTING_INVALID", 400);
        const from = effective.get(id)!.value, to = input.values[id] as Value;
        if (from !== to || effective.get(id)!.source === "default") changed.push({ settingId: id, from, to });
      }
      // Keep only values still valid for this declaration, then apply the change.
      const next: Record<string, Value> = {};
      for (const row of effective.values()) if (row.source === "saved") next[row.setting.id] = row.value;
      for (const id of ids) next[id] = input.values[id] as Value;
      const revision = input.expectedRevision + 1;
      await client.query(
        `INSERT INTO admin_section_values(workspace_id,course_key,section_id,scope,scope_ref,setting_values,section_version,revision,updated_by,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
         ON CONFLICT (workspace_id,course_key,section_id,scope,scope_ref) DO UPDATE SET setting_values=EXCLUDED.setting_values,
           section_version=EXCLUDED.section_version,revision=EXCLUDED.revision,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
        [catalog.workspace_id, catalog.course_key, section.id, input.scope, input.scopeRef, JSON.stringify(next), section.version, revision, actor.id]);
      await appendEvent(client, {
        workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: "staff", type: "admin_section.settings_changed",
        ...(input.scope === "enrollment" ? { enrollmentId: input.scopeRef } : {}),
        payload: { catalogId: catalog.id, releaseId: release!.id, sectionId: section.id, sectionVersion: section.version, scope: input.scope, scopeRef: input.scopeRef, revision, changes: changed },
        idempotencyKey: `admin-section:${catalog.id}:${section.id}:${input.scope}:${input.scopeRef}:${revision}`,
      });
      const stored = await storedValues(client, catalog.workspace_id, catalog.course_key, section.id, input.scope, input.scopeRef);
      return { section: sectionView(section, role, input.scope, input.scopeRef, stored) };
    });
  });
}
