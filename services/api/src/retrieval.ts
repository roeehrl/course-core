import type { PoolClient } from 'pg';
import { USABLE_MESSAGE } from './context-capsule.js';

/**
 * Full-text retrieval over Postgres `tsvector` indexes (migration 062); no embeddings yet.
 *
 * - Course passages: every text block of a release and every cited source's title,
 *   `course_release_passages`, rebuilt from the release bundle by a trigger.
 * - The learner's own companion questions: `companion_messages.search` (learner turns only).
 *
 * The text-search configuration is 'simple' (lower-casing, no stemming, no stop words), because
 * Core is course- and language-agnostic. Queries are built here from letters and digits only,
 * each word a prefix match, any word matching; results are ranked with `ts_rank_cd`. Query text
 * never reaches SQL as syntax, so operators, quotes and wildcards in it are inert.
 *
 * Retrieval is read-only and bounded (at most 5 results, short snippets). Scope comes from the
 * caller's trusted server state (a resolved supervisor job), never from model output.
 */

export const SEARCH_LIMITS = { results: 5, queryWords: 8, wordCharacters: 40, queryCharacters: 200, snippetCharacters: 400 } as const;

/** A safe `to_tsquery('simple', …)` expression for `raw`, or null when it has no words. */
export function searchQuery(raw: string): string | null {
  const words = raw.normalize('NFKC').slice(0, SEARCH_LIMITS.queryCharacters).toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words.map(word => word.slice(0, SEARCH_LIMITS.wordCharacters)))].slice(0, SEARCH_LIMITS.queryWords);
  return unique.length ? unique.map(word => `${word}:*`).join(' | ') : null;
}

const HEADLINE = `'StartSel="",StopSel="",MaxWords=40,MinWords=12,MaxFragments=2,FragmentDelimiter=" … "'`;
const clip = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, SEARCH_LIMITS.snippetCharacters);

export interface PassageMatch { passageId: string; kind: 'text_block' | 'source'; chapterId: string | null; episodeId: string | null;
  title: string; snippet: string; sourceRefs: string[] }

/** Ranked passages of one release matching `query`. */
export async function searchCoursePassages(client: PoolClient, scope: { releaseId: string; workspaceId: string }, query: string,
  limit: number = SEARCH_LIMITS.results): Promise<PassageMatch[]> {
  const expression = searchQuery(query);
  if (!expression) return [];
  const rows = (await client.query<{ passage_id: string; kind: 'text_block' | 'source'; chapter_id: string | null; episode_id: string | null; title: string;
    snippet: string; source_refs: string[] }>(
    `SELECT p.passage_id,p.kind,p.chapter_id,p.episode_id,p.title,p.source_refs,
        ts_headline('simple',CASE WHEN p.body='' THEN p.title ELSE p.body END,q,${HEADLINE}) AS snippet
       FROM course_release_passages p,to_tsquery('simple',$3) q
      WHERE p.course_release_id=$1 AND p.workspace_id=$2 AND p.search @@ q
      ORDER BY ts_rank_cd(p.search,q) DESC,p.passage_id LIMIT $4`,
    [scope.releaseId, scope.workspaceId, expression, Math.min(Math.max(limit, 1), SEARCH_LIMITS.results)])).rows;
  return rows.map(row => ({ passageId: row.passage_id, kind: row.kind, chapterId: row.chapter_id, episodeId: row.episode_id,
    title: row.title.slice(0, 200), snippet: clip(row.snippet), sourceRefs: row.source_refs.slice(0, 10) }));
}

export interface QuestionMatch { messageId: string; eventId: string | null; episodeId: string | null; createdAt: string; snippet: string }

/**
 * The learner's own companion questions in one enrollment and course version that match
 * `query`. Never assistant turns, other enrollments, erased or deleted questions, or questions
 * the learner asked the companion not to use again: the shared USABLE_MESSAGE filter of context-capsule.ts.
 */
export async function searchLearnerQuestions(client: PoolClient, scope: { enrollmentId: string; workspaceId: string; courseDigest: string }, query: string,
  limit: number = SEARCH_LIMITS.results): Promise<QuestionMatch[]> {
  const expression = searchQuery(query);
  if (!expression) return [];
  const rows = (await client.query<{ id: string; event_id: string | null; episode_id: string | null; created_at: Date; snippet: string }>(
    `SELECT m.id,m.context->>'episodeId' AS episode_id,m.created_at,
        (SELECT e.id FROM learning_events e WHERE e.enrollment_id=m.enrollment_id AND e.event_type='companion.requested' AND e.payload->>'messageId'=m.id::text LIMIT 1) AS event_id,
        ts_headline('simple',left(m.content,4000),q,${HEADLINE}) AS snippet
       FROM companion_messages m JOIN enrollments n ON n.id=m.enrollment_id AND n.workspace_id=$2,to_tsquery('simple',$4) q
      WHERE m.enrollment_id=$1 AND m.role='learner' AND m.search @@ q AND m.context->>'courseDigest'=$3
        AND ${USABLE_MESSAGE}
      ORDER BY ts_rank_cd(m.search,q) DESC,m.created_at DESC,m.id LIMIT $5`,
    [scope.enrollmentId, scope.workspaceId, scope.courseDigest, expression, Math.min(Math.max(limit, 1), SEARCH_LIMITS.results)])).rows;
  return rows.map(row => ({ messageId: row.id, eventId: row.event_id, episodeId: row.episode_id, createdAt: row.created_at.toISOString(), snippet: clip(row.snippet) }));
}
