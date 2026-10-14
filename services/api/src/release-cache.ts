import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { digestJson, type Release } from "./repository.js";

/** Published and archived releases are immutable in the database (trigger
 * admin_release_immutable), so their bundles are read, digest-verified and
 * parsed once per process instead of on every request. Cached rows are deeply
 * frozen: a caller that mutates a shared course fails loudly instead of
 * corrupting other learners' views. Drafts are always read fresh. */
const cache = new Map<string, Release>();
const verified = new WeakSet<object>();
/** True when these exact bundle objects were digest-verified at cache fill. */
export const verifiedRelease = (release: Release) => verified.has(release.server_bundle);
/** True when `course` is a cached release's digest-verified, deeply frozen server bundle. */
export const verifiedBundle = (course: object) => verified.has(course);
const LIMIT = 64;
const immutable = (status: string) => status === "published" || status === "archived";

export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** The release row with verified bundles, or undefined when absent or outside the given workspace. */
export async function readRelease(client: PoolClient | Database, id: string, workspaceId?: string): Promise<Release | undefined> {
  const head = (
    await client.query<{ digest: string; status: string; workspace_id: string }>("SELECT digest,status,workspace_id FROM course_releases WHERE id=$1", [id])
  ).rows[0];
  if (!head || (workspaceId !== undefined && head.workspace_id !== workspaceId)) return undefined;
  const cached = cache.get(id);
  if (cached && cached.digest === head.digest && immutable(head.status)) return { ...cached, status: head.status };
  const row = (await client.query<Release>("SELECT * FROM course_releases WHERE id=$1", [id])).rows[0];
  if (!row) return undefined;
  requireCondition(row.digest === digestJson(row.server_bundle), "BASE_COURSE_INTEGRITY", 409);
  if (immutable(row.status)) {
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(id, freeze({ ...row }));
    verified.add(row.server_bundle);
    return { ...cache.get(id)!, status: row.status };
  }
  return row;
}
