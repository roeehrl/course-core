import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';
import type { Database } from './database.js';
import { digestJson } from './repository.js';
import { gateItemIds } from './gates.js';
import { episodes } from './learning.js';

type Sql = Database | PoolClient;
export interface SafetyRelease { id: string; version: string; status: string; digest: string; server_bundle: CourseManifest; created_at: Date }

/** Entity kinds a release diff reports: every top-level manifest array of objects with an `id`,
 * plus chapter episodes flattened as `episodes`. Each entity is compared by its digest. */
function entities(course: CourseManifest) {
  const kinds = new Map<string, Map<string, string>>();
  for (const [kind, value] of Object.entries(course as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value) || !value.every(v => v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string')) continue;
    kinds.set(kind, new Map(value.map(v => [(v as { id: string }).id, digestJson(kind === 'chapters' ? { ...(v as object), episodes: ((v as { episodes?: { id: string }[] }).episodes ?? []).map(e => e.id) } : v)])));
  }
  kinds.set('episodes', new Map(episodes(course).map(e => [e.id, digestJson(e)])));
  for (const scalar of ['placement', 'policy'] as const) {
    const value = (course as unknown as Record<string, unknown>)[scalar];
    if (value !== undefined) kinds.set(scalar, new Map([[scalar, digestJson(value)]]));
  }
  return kinds;
}

/** What changed from `from` to `to`, by entity digest. */
export function releaseDiff(from: SafetyRelease, to: SafetyRelease) {
  const a = entities(from.server_bundle), b = entities(to.server_bundle);
  const kinds: Record<string, { added: string[]; removed: string[]; changed: string[]; unchanged: number }> = {};
  for (const kind of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const before = a.get(kind) ?? new Map<string, string>(), after = b.get(kind) ?? new Map<string, string>();
    const entry = { added: [...after.keys()].filter(k => !before.has(k)).sort(), removed: [...before.keys()].filter(k => !after.has(k)).sort(),
      changed: [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k)).sort(), unchanged: [...after.keys()].filter(k => before.get(k) === after.get(k)).length };
    if (entry.added.length || entry.removed.length || entry.changed.length || entry.unchanged) kinds[kind] = entry;
  }
  const changes = Object.values(kinds).reduce((n, k) => n + k.added.length + k.removed.length + k.changed.length, 0);
  return { from: { id: from.id, version: from.version, digest: from.digest }, to: { id: to.id, version: to.version, digest: to.digest }, identical: from.digest === to.digest, changes, kinds };
}

export async function defectiveItems(client: Sql, releaseId: string) {
  return (await client.query<{ assessment_id: string; reason: string; created_at: Date }>(
    'SELECT assessment_id,reason,created_at FROM release_defective_items WHERE release_id=$1 ORDER BY created_at', [releaseId])).rows;
}

/**
 * The impact of selecting an older release for new learners (a rollback). Existing learners stay
 * pinned to the release they started; nothing moves. The impact tells staff who is on each side,
 * which content differs, how much valid evidence the active release holds on items the target
 * changes or lacks, and which of the target's items are already marked defective. Confirming a
 * rollback requires the digest of exactly this impact.
 */
export async function rollbackImpact(client: Sql, from: SafetyRelease, to: SafetyRelease) {
  const diff = releaseDiff(from, to);
  const pinned = async (releaseId: string) => (await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM enrollments WHERE course_release_id=$1 AND status IN ('active','paused')", [releaseId])).rows[0]!.n;
  const differing = [...(diff.kinds.assessments?.changed ?? []), ...(diff.kinds.assessments?.removed ?? [])];
  const evidence = (await client.query<{ evidence: number; learners: number }>(
    `SELECT count(*)::int AS evidence,count(DISTINCT ev.enrollment_id)::int AS learners FROM evidence ev JOIN attempts a ON a.id=ev.attempt_id AND a.enrollment_id=ev.enrollment_id
       JOIN enrollments e ON e.id=ev.enrollment_id WHERE e.course_release_id=$1 AND ev.invalidated_at IS NULL AND a.assessment_id=ANY($2::text[])`, [from.id, differing])).rows[0]!;
  const impact = {
    from: diff.from, to: diff.to,
    learnersPinnedToActive: await pinned(from.id), learnersPinnedToTarget: await pinned(to.id),
    contentChanges: diff.changes,
    changedOrRemovedItems: differing.sort(),
    evidenceOnChangedItems: evidence.evidence, learnersWithEvidenceOnChangedItems: evidence.learners,
    targetDefectiveItems: (await defectiveItems(client, to.id)).map(d => d.assessment_id),
    existingLearnersMove: false as const,
  };
  return { impact, impactDigest: digestJson(impact) };
}

/** Items that can stand in for a defective one: not defective, covering all its objectives and,
 * when the item counts toward a gate, listed by that same gate. */
export function replacementItems(course: CourseManifest, assessmentId: string, defective: Set<string>) {
  const item = course.assessments.find(a => a.id === assessmentId);
  if (!item) return [];
  const gates = course.gates.filter(g => gateItemIds(g).includes(assessmentId));
  return course.assessments.filter(a => a.id !== assessmentId && !defective.has(a.id) && item.objectiveIds.every(o => a.objectiveIds.includes(o))
    && gates.every(g => gateItemIds(g).includes(a.id))).map(a => a.id).sort();
}

/** What marking one item defective on one release would do. */
export async function defectPreview(client: Sql, release: SafetyRelease, assessmentId: string) {
  const known = release.server_bundle.assessments.some(a => a.id === assessmentId);
  const defective = new Set((await defectiveItems(client, release.id)).map(d => d.assessment_id));
  const counts = (await client.query<{ evidence: number; enrollments: number; open_challenges: number }>(
    `SELECT (SELECT count(*)::int FROM evidence ev JOIN attempts a ON a.id=ev.attempt_id AND a.enrollment_id=ev.enrollment_id JOIN enrollments e ON e.id=ev.enrollment_id
              WHERE e.course_release_id=$1 AND a.assessment_id=$2 AND ev.invalidated_at IS NULL AND e.status<>'erased') AS evidence,
            (SELECT count(DISTINCT ev.enrollment_id)::int FROM evidence ev JOIN attempts a ON a.id=ev.attempt_id AND a.enrollment_id=ev.enrollment_id JOIN enrollments e ON e.id=ev.enrollment_id
              WHERE e.course_release_id=$1 AND a.assessment_id=$2 AND ev.invalidated_at IS NULL AND e.status<>'erased') AS enrollments,
            (SELECT count(*)::int FROM assessment_challenges c JOIN enrollments e ON e.id=c.enrollment_id
              WHERE e.course_release_id=$1 AND c.assessment_id=$2 AND c.attempt_id IS NULL AND c.expires_at>clock_timestamp()) AS open_challenges`,
    [release.id, assessmentId])).rows[0]!;
  const replacements = replacementItems(release.server_bundle, assessmentId, defective);
  const preview = { releaseId: release.id, releaseDigest: release.digest, assessmentId, known, alreadyDefective: defective.has(assessmentId),
    evidenceToInvalidate: counts.evidence, affectedEnrollments: counts.enrollments, openChallengesToClose: counts.open_challenges,
    replacement: { available: replacements.length > 0, itemIds: replacements } };
  return { preview, previewDigest: digestJson(preview) };
}
