import type { CatalogCourse, Enrollment } from "../client/policyClient";

/** One course on the learner's home: the enrollment they continue, the versions of it they also
 * have, and a newer published version when there is one. A course appears once, never as both
 * "your course" and "available". */
export interface LibraryCourse {
  key: string;
  /** The enrollment the card continues: the most recent one the learner can still open. */
  enrollment: Enrollment;
  /** The learner's other enrollments in this course (other versions), most recent first. */
  others: Enrollment[];
  /** The course's current published version, when it is newer than the enrollment's. */
  newer?: CatalogCourse;
}
export interface Library {
  yours: LibraryCourse[];
  /** Published courses the learner has not started (or whose only enrollment they erased). */
  available: CatalogCourse[];
}

/** Older API responses and fixtures name no course; a release then stands for its own course. */
const enrollmentKey = (enrollment: Enrollment) => enrollment.course_key ?? `release:${enrollment.releaseId}`;
const catalogKey = (course: CatalogCourse) => course.course_key ?? `release:${course.id}`;

/** Compares dotted versions ("0.1.10" > "0.1.9"); a part that is not a number compares as text. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/), right = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? "0", y = right[i] ?? "0";
    const nx = Number(x), ny = Number(y);
    const diff = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** Groups enrollments (most recent first, as the API lists them) and the published catalog by course. */
export function library(enrollments: readonly Enrollment[], catalog: readonly CatalogCourse[]): Library {
  const groups = new Map<string, Enrollment[]>();
  for (const enrollment of enrollments) {
    const key = enrollmentKey(enrollment);
    groups.set(key, [...(groups.get(key) ?? []), enrollment]);
  }
  const yours: LibraryCourse[] = [];
  for (const [key, rows] of groups) {
    const enrollment = rows.find((row) => row.status !== "erased") ?? rows[0]!;
    const current = catalog.find((course) => catalogKey(course) === key);
    const newer =
      current && enrollment.status !== "erased" && !rows.some((row) => row.releaseId === current.id && row.status !== "erased") &&
      compareVersions(current.version, enrollment.version) > 0
        ? current
        : undefined;
    yours.push({ key, enrollment, others: rows.filter((row) => row !== enrollment), ...(newer ? { newer } : {}) });
  }
  const started = new Set(yours.filter((course) => course.enrollment.status !== "erased").map((course) => course.key));
  return { yours, available: catalog.filter((course) => !started.has(catalogKey(course))) };
}
