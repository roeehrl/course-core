import { createInspectionEngine, createReviewEngine, sourceReviewInput, type ResearchOptions } from './internal/engine.js';
import type { AuthorizeResearch, SourceInspection } from './contracts.js';

export type { ResearchOptions } from './internal/engine.js';
export { sourceReviewInput };
export { ResearchError } from './errors.js';
export function createSourceInspector<Credential>(authorize: AuthorizeResearch<Credential>, options: ResearchOptions = {}) {
  return createInspectionEngine(authorize, options);
}
export function createSourceReviewer<Credential>(authorize: AuthorizeResearch<Credential>, loadInspection: (id: string) => Promise<SourceInspection | undefined>) {
  return createReviewEngine(authorize, loadInspection);
}
