/**
 * Course version direction (requirement K13). A course's versions are semantic versions, and in a
 * workspace a course moves forward:
 *
 * - Publication refuses a release whose version is not a semantic version (PUBLISH_VERSION_INVALID).
 *   The SDK already refuses one at compile time; this guards rows written any other way.
 * - Publication refuses a version lower than one already published (or published, then archived)
 *   for the same course in the workspace, unless the request explicitly confirms the older version
 *   (PUBLISH_VERSION_OLDER_THAN_PUBLISHED, 409). Equal versions cannot exist: (workspace, course,
 *   version) is unique, and the installer refuses the same version with different content.
 * - Installing a course package older than the newest installed version needs the same explicit
 *   confirmation (OLDER_VERSION_CONFIRMATION_REQUIRED, see course-package-routes.ts).
 *
 * Going back to a release that was already published is a rollback (select it again with the
 * reviewed rollback impact, admin-routes.ts `activate`), not a new publication.
 */
import type { PoolClient } from 'pg';
import { ApiError } from './errors.js';
import { compareSemver, isSemver } from './course-package.js';

/** The newest semantic version among `versions`; non-semver legacy values are ignored. */
export function newestVersion(versions: readonly string[]): string | null {
  return versions.filter(isSemver).sort((a, b) => compareSemver(b, a))[0] ?? null;
}

/** Checks the version of a release about to be published. Returns the newer published version
 * the publication goes back from, or null when it moves forward. */
export async function assertPublishVersion(client: PoolClient, release: { id: string; workspace_id: string; course_key: string; version: string },
  confirmOlderVersion: boolean): Promise<string | null> {
  if (!isSemver(release.version)) throw new ApiError(409, 'PUBLISH_VERSION_INVALID', 'PUBLISH_VERSION_INVALID', { version: String(release.version).slice(0, 128) });
  const published = (await client.query<{ version: string }>(
    "SELECT version FROM course_releases WHERE workspace_id=$1 AND course_key=$2 AND id<>$3 AND status IN ('published','archived')",
    [release.workspace_id, release.course_key, release.id])).rows.map(row => row.version);
  const newest = newestVersion(published);
  if (!newest || compareSemver(release.version, newest) > 0) return null;
  if (!confirmOlderVersion) throw new ApiError(409, 'PUBLISH_VERSION_OLDER_THAN_PUBLISHED', 'PUBLISH_VERSION_OLDER_THAN_PUBLISHED', { version: release.version, newestPublished: newest });
  return newest;
}
