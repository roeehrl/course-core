import { ResearchError, requireResearch } from './errors.js';
import { validateAttribution, type SourceAttribution } from './contracts.js';

/**
 * The only input a YouTube search receives: an author-approved public query and,
 * optionally, a declared language. Any other field (a learner ID, profile, history,
 * misconception text, enrollment or URL) is rejected rather than ignored, so a caller
 * cannot accidentally widen what leaves the host.
 */
export interface YouTubeSearchQuery {
  queryText: string;
  /** BCP 47 language the author declared for the task, e.g. "en". */
  relevanceLanguage?: string;
  /** At most ten results; defaults to five. */
  maxResults?: number;
}
/** Metadata from the YouTube Data API. It is a lead, never reviewed content: no
 * claims and no segment are derived from a title or description. */
export interface YouTubeSearchHit {
  videoId: string;
  watchUrl: string;
  title: string;
  channelTitle: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  embeddable: boolean | null;
  captions: 'creator_captions' | 'unknown';
  attribution: SourceAttribution;
  inspectedEvidence: 'metadata_only';
  reviewStatus: 'unreviewed';
  trust: 'untrusted_provider_metadata';
}
export interface YouTubeSearchResult {
  hits: YouTubeSearchHit[];
  /** Exactly the parameters sent, without the key, for receipts and tests. */
  sent: { q: string; relevanceLanguage: string | null; maxResults: number };
}
export type YouTubeSearchErrorCode = 'SEARCH_UNAUTHORIZED' | 'SEARCH_QUOTA' | 'SEARCH_FAILED';
export interface YouTubeSearchOptions {
  /** Server-side key lookup (an admin-configured credential). Never logged or returned. */
  apiKey: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export const YOUTUBE_DATA_API = 'https://www.googleapis.com/youtube/v3';
const allowedKeys = new Set(['queryText', 'relevanceLanguage', 'maxResults']);
const control = /[\u0000-\u001f\u007f-\u009f]/;
const videoId = /^[A-Za-z0-9_-]{11}$/;
const language = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;

/** Validates and minimizes a query. Throws INVALID_INPUT for anything beyond the approved text. */
export function youtubeSearchParameters(input: unknown): YouTubeSearchResult['sent'] {
  requireResearch(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_INPUT');
  const value = input as Record<string, unknown>;
  requireResearch(Object.keys(value).every(key => allowedKeys.has(key)), 'INVALID_INPUT');
  requireResearch(typeof value.queryText === 'string' && !control.test(value.queryText), 'INVALID_INPUT');
  const q = value.queryText.trim().replace(/ +/g, ' ');
  requireResearch(q.length >= 1 && q.length <= 500, 'INVALID_INPUT');
  const lang = value.relevanceLanguage;
  requireResearch(lang === undefined || (typeof lang === 'string' && language.test(lang)), 'INVALID_INPUT');
  const max = value.maxResults ?? 5;
  requireResearch(Number.isSafeInteger(max) && (max as number) >= 1 && (max as number) <= 10, 'INVALID_INPUT');
  return { q, relevanceLanguage: (lang as string | undefined) ?? null, maxResults: max as number };
}

/** ISO 8601 durations as returned by videos.list, e.g. PT1H2M3S. */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,3})H)?(?:(\d{1,4})M)?(?:(\d{1,5})S)?)?$/.exec(value);
  if (!match || value === 'P' || value.endsWith('T')) return null;
  const [, d = '0', h = '0', m = '0', s = '0'] = match;
  const total = Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  return Number.isSafeInteger(total) ? total : null;
}

export class YouTubeSearchError extends ResearchError {
  constructor(readonly searchCode: YouTubeSearchErrorCode) {
    super('FETCH_FAILED');
    this.name = 'YouTubeSearchError';
    this.message = searchCode;
  }
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && !control.test(value) ? value.slice(0, max) : undefined;

/** A Data API search adapter. It sends only the minimized approved query and reads
 * metadata; it never fetches thumbnails, transcripts or pages. */
export function createYouTubeSearch(options: YouTubeSearchOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000, maxBytes = options.maxResponseBytes ?? 512 * 1024;
  async function call(path: 'search' | 'videos', params: URLSearchParams, key: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new ResearchError('CANCELLED');
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(`${YOUTUBE_DATA_API}/${path}?${params}`, {
        method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: combined,
        // The key travels in a header so it never appears in a URL, access log or receipt.
        headers: { 'x-goog-api-key': key, accept: 'application/json' },
      });
    } catch {
      if (signal?.aborted) throw new ResearchError('CANCELLED');
      if (timeout.aborted) throw new ResearchError('TIMEOUT');
      throw new YouTubeSearchError('SEARCH_FAILED');
    }
    if ([400, 401, 403].includes(response.status)) {
      const body = await bounded(response, maxBytes).catch(() => '');
      if (/quotaExceeded|rateLimitExceeded|dailyLimitExceeded/.test(body)) throw new YouTubeSearchError('SEARCH_QUOTA');
      if (response.status !== 400 || /keyInvalid|keyExpired|API_KEY_INVALID/.test(body)) throw new YouTubeSearchError('SEARCH_UNAUTHORIZED');
    }
    if (response.status === 429) throw new YouTubeSearchError('SEARCH_QUOTA');
    if (!response.ok) throw new YouTubeSearchError('SEARCH_FAILED');
    try {
      return JSON.parse(await bounded(response, maxBytes)) as unknown;
    } catch (error) {
      if (error instanceof ResearchError) throw error;
      throw new YouTubeSearchError('SEARCH_FAILED');
    }
  }
  return {
    async search(query: unknown, signal?: AbortSignal): Promise<YouTubeSearchResult> {
      const sent = youtubeSearchParameters(query);
      const key = await options.apiKey();
      if (typeof key !== 'string' || key.length < 10 || key.length > 512 || control.test(key)) throw new YouTubeSearchError('SEARCH_UNAUTHORIZED');
      const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(sent.maxResults), q: sent.q,
        safeSearch: 'strict', videoEmbeddable: 'true' });
      if (sent.relevanceLanguage) params.set('relevanceLanguage', sent.relevanceLanguage);
      const found = await call('search', params, key, signal) as { items?: unknown };
      const items = (Array.isArray(found?.items) ? found.items : []).slice(0, sent.maxResults).flatMap(raw => {
        const item = raw as { id?: { kind?: unknown; videoId?: unknown }; snippet?: Record<string, unknown> };
        const id = item?.id?.videoId, snippet = item?.snippet ?? {};
        if (item?.id?.kind !== 'youtube#video' || typeof id !== 'string' || !videoId.test(id)) return [];
        const title = text(snippet.title, 300), channelTitle = text(snippet.channelTitle, 300) ?? 'Unknown channel';
        if (!title) return [];
        const published = typeof snippet.publishedAt === 'string' && !Number.isNaN(Date.parse(snippet.publishedAt))
          ? new Date(snippet.publishedAt).toISOString() : null;
        return [{ id, title, channelTitle, published }];
      });
      const unique = items.filter((item, index) => items.findIndex(other => other.id === item.id) === index);
      const details = new Map<string, { durationSeconds: number | null; embeddable: boolean | null; captions: 'creator_captions' | 'unknown' }>();
      if (unique.length) {
        // Only the IDs the search returned; no query text is repeated.
        const listed = await call('videos', new URLSearchParams({ part: 'contentDetails,status', id: unique.map(i => i.id).join(','),
          maxResults: String(unique.length) }), key, signal) as { items?: unknown };
        for (const raw of Array.isArray(listed?.items) ? listed.items : []) {
          const v = raw as { id?: unknown; contentDetails?: { duration?: unknown; caption?: unknown }; status?: { embeddable?: unknown } };
          if (typeof v?.id !== 'string' || !unique.some(i => i.id === v.id)) continue;
          details.set(v.id, {
            durationSeconds: parseIsoDuration(v.contentDetails?.duration),
            embeddable: typeof v.status?.embeddable === 'boolean' ? v.status.embeddable : null,
            captions: v.contentDetails?.caption === 'true' ? 'creator_captions' : 'unknown',
          });
        }
      }
      return {
        sent,
        hits: unique.map((item, index): YouTubeSearchHit => {
          const detail = details.get(item.id);
          return {
            videoId: item.id, watchUrl: `https://www.youtube.com/watch?v=${item.id}`, title: item.title, channelTitle: item.channelTitle,
            publishedAt: item.published, durationSeconds: detail?.durationSeconds ?? null, embeddable: detail?.embeddable ?? null,
            captions: detail?.captions ?? 'unknown',
            attribution: validateAttribution({ trust: 'untrusted_provider_metadata', providerName: 'YouTube', authorName: item.channelTitle,
              searchRank: index + 1 }),
            inspectedEvidence: 'metadata_only', reviewStatus: 'unreviewed', trust: 'untrusted_provider_metadata',
          };
        }),
      };
    },
  };
}

async function bounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ResearchError('BYTES_LIMIT');
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new ResearchError('BYTES_LIMIT'); }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
