import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createServer, registeredRoutes } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { adminPermissionMatrix, type AdminPermission } from "../src/course-access.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { credentialVault } from "../src/key-vault.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";
import { fillPath, installZodCapture, rejectingSchema, sampleSchema, sampleZod } from "./route-matrix-harness.js";
import { ALLOWED_REFUSALS, PROBE_INPUT, ROUTE_ACCESS, type Access } from "./route-access.js";

// Real HTTP and PostgreSQL 17: the access matrix for EVERY registered route. The route list
// comes from the server itself (registeredRoutes), so a new route without an entry in
// test/route-access.ts fails here. Each route is called anonymously, with the service token
// and as every role, and must deny exactly the actors its access class excludes.
const origin = "http://localhost:4396",
  schema = "route_matrix_" + randomUUID().replaceAll("-", ""),
  serviceToken = "route-matrix-service-token-" + randomUUID();
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined, staticRoot: string | undefined;
interface Session { userId: string; cookie: string; csrf: string }
const ids: Record<string, string> = {};

/** Every actor probed against every route. */
const WORKSPACE_ROLES = ["owner", "admin", "author", "instructor", "reviewer", "observer", "support_observer", "service"] as const;
const ACTORS = ["anonymous", "service_token", "outsider", "learner", "other_learner", ...WORKSPACE_ROLES,
  "scoped_instructor", "scoped_reviewer", "scoped_author", "scoped_expired", "scoped_none", "scoped_other"] as const;
type Actor = (typeof ACTORS)[number];
const sessions: Partial<Record<Actor, Session>> = {};
/** The grant role a course_scoped actor holds on the probed course (`catalog`); none for the rest. */
const SCOPED_ROLE: Partial<Record<Actor, string>> = { scoped_instructor: "instructor", scoped_reviewer: "reviewer", scoped_author: "author" };
const SIGNED_IN = ACTORS.filter((a) => a !== "anonymous" && a !== "service_token");
const MEMBERS = SIGNED_IN.filter((a) => a !== "outsider");

/** The actors an access class admits (the classes are described in route-access.ts). */
function allowedActors(access: Access): Set<Actor> {
  if (typeof access !== "string") return new Set(access.flatMap((part) => [...allowedActors(part)]));
  if (access === "public") return new Set(ACTORS);
  if (access === "signed-in") return new Set(SIGNED_IN);
  if (access === "member") return new Set(MEMBERS);
  if (access === "own-learner") return new Set(["learner"]);
  if (access === "service-token") return new Set(["service_token"]);
  if (access === "agent-grant") return new Set();
  const [kind, value] = access.split(":") as [string, string];
  if (kind === "perm") {
    if (!adminPermissionMatrix.owner!.includes(value as AdminPermission)) throw new Error(`Unknown permission in ${access}`);
    const permitted = (role: string | undefined) => !!role && (adminPermissionMatrix[role]?.includes(value as AdminPermission) ?? false);
    return new Set(ACTORS.filter((a) => permitted((WORKSPACE_ROLES as readonly string[]).includes(a) ? a : SCOPED_ROLE[a])));
  }
  if (kind === "roles") {
    const roles = value.split(",");
    if (!roles.every((role) => (WORKSPACE_ROLES as readonly string[]).includes(role))) throw new Error(`Unknown role in ${access}`);
    return new Set(roles as Actor[]);
  }
  throw new Error(`Unknown access class ${access}`);
}

async function person(workspace: string, role: string, name: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "matrix:" + id, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const headers = (actor: Actor): Record<string, string> =>
  actor === "anonymous" ? { origin } : actor === "service_token" ? { origin, authorization: "Bearer " + serviceToken } : { origin, cookie: sessions[actor]!.cookie, "x-csrf-token": sessions[actor]!.csrf };
async function ok(actor: Actor, method: "GET" | "POST", url: string, payload?: object) {
  const r = await app.inject({ method, url, headers: headers(actor), ...(payload ? { payload } : {}) });
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(200);
  return r.json();
}
async function publish(manifest: ReturnType<typeof fixture>) {
  const id = (await ok("owner", "POST", `/api/workspaces/${ids.workspaceId}/releases`, manifest)).id as string;
  await ok("owner", "POST", `/api/releases/${id}/publish`);
  return id;
}

installZodCapture();
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  // Static app directories register their own routes; give them one page each so those are listed too.
  staticRoot = await mkdtemp(path.join(tmpdir(), "route-matrix-"));
  for (const dir of ["learner", "admin"]) {
    await mkdir(path.join(staticRoot, dir));
    await writeFile(path.join(staticRoot, dir, "index.html"), "<!doctype html><title>x</title>");
  }
  const workspace = randomUUID(), otherWorkspace = randomUUID();
  ids.workspaceId = workspace;
  // Every optional route group is enabled: provider setup, the supervisor bridge and gateway, and both apps.
  // No metadata adapter is configured, so no request can reach a provider.
  app = await createServer(db, {
    loginCodes: true, origin, secureCookies: false,
    workspaceProviders: new WorkspaceProviders(db, credentialVault(randomBytes(32)), {}, undefined, {}),
    supervisor: { serviceToken, workspaceIds: [workspace] },
    // Nothing a probe sends may leave the machine: no package fetches and no source inspection.
    coursePackages: { remoteFetch: "off" },
    researchInspector: { inspect: async () => { throw new Error("The route matrix never inspects a source."); } },
    // A live event stream ends almost at once, so probing it as an allowed reader returns.
    eventStream: { pollMs: 10, heartbeatMs: 20, recheckMs: 30, lifetimeMs: 40 },
    learnerDirectory: path.join(staticRoot, "learner"), adminDirectory: path.join(staticRoot, "admin"),
  });
  for (const [id, slug] of [[workspace, "matrix"], [otherWorkspace, "matrix-other"]]) await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [id, slug + "-" + id, slug]);
  for (const role of WORKSPACE_ROLES) sessions[role] = await person(workspace, role, role);
  for (const [actor, role] of [["learner", "learner"], ["other_learner", "learner"]] as const) sessions[actor] = await person(workspace, role, actor);
  for (const actor of ["scoped_instructor", "scoped_reviewer", "scoped_author", "scoped_expired", "scoped_none", "scoped_other"] as const) sessions[actor] = await person(workspace, "course_scoped", actor);
  sessions.outsider = await person(otherWorkspace, "owner", "outsider");
  ids.releaseId = await publish(fixture());
  const other = fixture();
  other.id = "ordering-other";
  other.title = "Other course";
  ids.otherReleaseId = await publish(other);
  const courses = (await ok("owner", "GET", "/api/admin/session")).courses as { id: string; title: string }[];
  ids.courseId = ids.catalogId = courses.find((c) => c.title === "Ordering values")!.id;
  const otherCatalog = courses.find((c) => c.title === "Other course")!.id;
  ids.enrollmentId = (await ok("learner", "POST", "/api/enrollments", { releaseId: ids.releaseId })).id;
  await ok("other_learner", "POST", "/api/enrollments", { releaseId: ids.releaseId });
  const grant = (actor: Actor, catalogId: string, role: string) => ok("owner", "POST", `/api/admin/workspaces/${workspace}/course-grants`,
    { userId: sessions[actor]!.userId, catalogId, role, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reasonCode: "support_case", idempotencyKey: "g-" + randomUUID() });
  for (const actor of ["scoped_instructor", "scoped_reviewer", "scoped_author"] as const) await grant(actor, ids.catalogId, SCOPED_ROLE[actor]!);
  await grant("scoped_other", otherCatalog, "instructor");
  const expiring = await grant("scoped_expired", ids.catalogId, "instructor");
  await db.query("ALTER TABLE course_access_grants DISABLE TRIGGER course_access_grants_guard");
  await db.query("UPDATE course_access_grants SET created_at=created_at-interval '3 days',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [expiring.grantId]);
  await db.query("ALTER TABLE course_access_grants ENABLE TRIGGER course_access_grants_guard");
  // Known path values: the probed course, release and enrollment; fixed episode and gate names.
  Object.assign(ids, { gateId: "min-gate", episodeId: "min", sha256: "0".repeat(64), extensionId: "matrix-extension", version: "1.0.0", name: "matrix", sectionId: "matrix", providerId: "matrix" });
}, 120000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
  if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
});

const key = (method: string, url: string) => `${method} ${url}`;
/** Routes that end or erase the caller's own session, account or enrollment run last (sign-out the
 * very last), so earlier probes keep their sessions and records. */
const LAST = /\/auth\/logout$|\/erase$/;
const lastRank = (route: Route) => (route.url.endsWith("/auth/logout") ? 2 : LAST.test(route.url) ? 1 : 0);
/** A denial: unauthenticated, forbidden, hidden as not found, no such method, or throttled before the handler ran.
 * Anything else (a success, a conflict, a validation error after a valid probe) means the actor got through. */
const DENIED = new Set([401, 403, 404, 405, 429]);
/** A 404 that hides the probed enrollment itself is a denial for an actor who should reach it. */
const HIDDEN = new Set(["ENROLLMENT_NOT_FOUND"]);
const errorCode = (body: string) => { try { return String(JSON.parse(body).error ?? ""); } catch { return ""; } };

/** Current revisions, so a denial probe is never refused as stale before it reaches authorization. */
const revisions = { enrollment: 1, catalog: 1 };
async function refreshRevisions() {
  revisions.enrollment = (await db.query("SELECT revision FROM enrollments WHERE id=$1", [ids.enrollmentId])).rows[0].revision;
  revisions.catalog = (await db.query("SELECT revision FROM admin_course_catalog WHERE id=$1", [ids.catalogId])).rows[0].revision;
}
/** Administration commands take their revision and idempotency key as headers. */
const COMMAND_HEADERS = () => ({ "if-match": String(revisions.catalog), "idempotency-key": "matrix-" + randomUUID() });
type Route = { method: string; url: string; schema: Record<string, unknown> | undefined };
const send = (route: Route, actor: Actor, url: string, query: Record<string, unknown> | undefined, body: unknown) =>
  app.inject({ method: route.method as "GET", headers: { ...headers(actor), ...(route.url.startsWith("/api/") ? COMMAND_HEADERS() : {}) }, ...(body === undefined ? {} : { payload: body as object }),
    url: url + (query && Object.keys(query).length ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : "") });
/**
 * One request as `actor`. A denial probe sends input that passes validation, so the request
 * reaches the handler's authorization: first a sample of the route's JSON schema (Fastify would
 * otherwise reject it before the handler), then, while the handler's own zod validation still
 * refuses it, a sample of the refusing zod schema. An allowed probe sends an empty body: it must
 * not be denied, and it almost always stops at validation (a 400) without changing anything.
 */
async function probe(route: Route, actor: Actor, denialProbe: boolean) {
  const url = fillPath(route.url, ids, route.schema?.params), hasBody = route.method !== "GET" && route.method !== "DELETE";
  const extra = denialProbe ? PROBE_INPUT[key(route.method, route.url)]?.(ids) : undefined;
  if (denialProbe) await refreshRevisions();
  // Enrollment commands carry the enrollment's revision; a current one gets past the staleness check.
  const current = route.url.includes(":enrollmentId") ? { expectedRevision: revisions.enrollment } : {};
  const withExtra = <T,>(value: T, more?: object) => {
    if (!value || typeof value !== "object") return more ? ({ ...more } as T) : value;
    const merged = { ...(value as object), ...(more ?? {}) } as Record<string, unknown>;
    return ("expectedRevision" in merged && !(more && "expectedRevision" in more) ? { ...merged, ...current } : merged) as T;
  };
  let query = withExtra(sampleSchema(route.schema?.querystring) as Record<string, unknown> | undefined, extra?.query);
  let body = !hasBody ? undefined : denialProbe ? withExtra(sampleSchema(route.schema?.body) ?? {}, extra?.body) : {};
  for (let repair = 0; ; repair++) {
    const { result, schema: refusing, partial } = await rejectingSchema(hasBody ? body : query, () => send(route, actor, url, query, body));
    if (!denialProbe || result.statusCode !== 400 || !refusing || repair >= 4) return result;
    let valid = sampleZod(refusing) as Record<string, unknown> | undefined;
    if (valid === undefined) return result;
    // A schema that validated the sent fields plus values the handler added keeps only the sent fields.
    if (partial) valid = Object.fromEntries(Object.keys((hasBody ? body : query) as object).map((k) => [k, valid![k]]));
    if (hasBody) body = withExtra(valid, extra?.body);
    else query = withExtra(valid, extra?.query);
  }
}

describe("route × role matrix (every registered route)", () => {
  it("every registered route has exactly one access entry, and every entry names a registered route", () => {
    const registered = registeredRoutes(app).map((r) => key(r.method, r.url));
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.length).toBeGreaterThan(200);
    expect(registered.filter((r) => !Object.hasOwn(ROUTE_ACCESS, r)).sort(), "add these routes to test/route-access.ts").toEqual([]);
    expect(Object.keys(ROUTE_ACCESS).filter((r) => !registered.includes(r)).sort(), "remove these stale entries from test/route-access.ts").toEqual([]);
    // Every class is known; an unknown class, permission or role throws here.
    for (const access of Object.values(ROUTE_ACCESS)) allowedActors(access);
    // Only the declared public routes admit an anonymous caller.
    expect(Object.keys(ROUTE_ACCESS).filter((r) => allowedActors(ROUTE_ACCESS[r]!).has("anonymous")).every((r) => ROUTE_ACCESS[r] === "public")).toBe(true);
  });

  it("each route denies exactly the actors outside its access class", async () => {
    const routes = [...registeredRoutes(app)].sort((a, b) => lastRank(a) - lastRank(b));
    const mismatches: string[] = [];
    for (const route of routes) {
      const access = ROUTE_ACCESS[key(route.method, route.url)];
      if (access === undefined) continue;
      const allowed = allowedActors(access);
      // Destructive self-service routes are probed for denials only; their allowed callers are covered by their own suites.
      const probeAllowed = !LAST.test(route.url);
      for (const actor of ACTORS) {
        const isAllowed = allowed.has(actor);
        if (isAllowed && !probeAllowed) continue;
        const response = await probe(route, actor, !isAllowed), observed = response.statusCode, code = errorCode(response.body);
        const refused = observed === 401 || observed === 403 || (observed === 404 && HIDDEN.has(code));
        const ok = isAllowed ? !refused || (ALLOWED_REFUSALS[key(route.method, route.url)] ?? []).includes(code) : DENIED.has(observed);
        if (!ok) mismatches.push(`${key(route.method, route.url)} ${actor}: ${observed} ${code} (expected ${isAllowed ? "not denied" : "denied"})`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 600000);
});
