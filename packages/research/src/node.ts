import { createInspectionEngine, createReviewEngine, inspectionDigest, sourceReviewInput, verifyInspection, type ResearchOptions } from './internal/engine.js';
import type { AuthorizeResearch, SourceInspection } from './contracts.js';

export type { ResearchOptions } from './internal/engine.js';
/** Deterministic integrity checks for persisted inspections; no network or DI. */
export { sourceReviewInput, inspectionDigest, verifyInspection };
export { ResearchError } from './errors.js';
export function createSourceInspector<Credential>(authorize: AuthorizeResearch<Credential>, options: ResearchOptions = {}) {
  return createInspectionEngine(authorize, options);
}
export function createSourceReviewer<Credential>(authorize: AuthorizeResearch<Credential>, loadInspection: (id: string) => Promise<SourceInspection | undefined>) {
  return createReviewEngine(authorize, loadInspection);
}
export { createYouTubeSearch, youtubeSearchParameters, parseIsoDuration, YouTubeSearchError, YOUTUBE_DATA_API } from './youtube-search.js';
export type { YouTubeSearchQuery, YouTubeSearchHit, YouTubeSearchResult, YouTubeSearchOptions, YouTubeSearchErrorCode } from './youtube-search.js';
