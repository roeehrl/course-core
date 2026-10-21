import type { CourseManifest } from '@course-core/sdk';

/**
 * Source freshness (Q09): when each source a course cites was last reviewed by its author, and
 * where the course uses it. A source older than the review window is due for a fresh look; one
 * within a month of the window is coming due. Dates come from the author's `reviewedAt`; Core does
 * not fetch the sources, so this says when a person last checked them, not whether they changed.
 */
export const REVIEW_WINDOWS = [90, 180, 365, 730] as const;
export type SourceStatus = 'current' | 'due_soon' | 'overdue' | 'undated';
const DAY = 86_400_000, SOON = 30;

export function sourceFreshness(course: CourseManifest, now: Date, windowDays: number) {
  const blocks = course.chapters.flatMap((c) => c.episodes.flatMap((e) => e.blocks.map((b) => ({ episodeId: e.id, block: b }))));
  const sources = (course.sources ?? []).map((source) => {
    const reviewed = Date.parse(source.reviewedAt);
    const ageDays = Number.isFinite(reviewed) ? Math.max(0, Math.floor((now.getTime() - reviewed) / DAY)) : null;
    const status: SourceStatus = ageDays === null ? 'undated' : ageDays > windowDays ? 'overdue' : ageDays > windowDays - SOON ? 'due_soon' : 'current';
    const citing = blocks.filter(({ block }) => block.type === 'text' && block.sourceRefs?.includes(source.id));
    let host = '';
    try { host = new URL(source.url).host; } catch { /* shown without a host */ }
    return {
      id: source.id, title: source.title, url: source.url, host, reviewedAt: Number.isFinite(reviewed) ? new Date(reviewed).toISOString().slice(0, 10) : null,
      ageDays, status, citedBy: { blocks: citing.length, episodeIds: [...new Set(citing.map((c) => c.episodeId))].slice(0, 50) },
    };
  });
  // Most urgent first: undated, then overdue (oldest first), then due soon, then current.
  const rank: Record<SourceStatus, number> = { undated: 0, overdue: 1, due_soon: 2, current: 3 };
  sources.sort((a, b) => rank[a.status] - rank[b.status] || (b.ageDays ?? 0) - (a.ageDays ?? 0) || a.id.localeCompare(b.id));
  const count = (status: SourceStatus) => sources.filter((s) => s.status === status).length;
  return { windowDays, checkedAt: now.toISOString(), summary: { total: sources.length, current: count('current'), dueSoon: count('due_soon'), overdue: count('overdue'), undated: count('undated') }, sources };
}
