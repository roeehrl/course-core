import type { Assessment } from '@course-core/sdk';
import { publicQuestion } from './learning.js';

/** The question of a stored item, or null when the stored body is not a readable item. */
function question(assessment: unknown) {
  if (!assessment || typeof assessment !== 'object') return null;
  try { return publicQuestion(assessment as Assessment); } catch { return null; }
}

/** A stored teaching artifact (adaptation_artifacts.body) as it goes into a personal data export.
 *
 * An allowlist, not a denylist: each kind names exactly the fields the learner was shown. A
 * generated item variant contributes its question only (publicQuestion), never its grading key,
 * hidden fixtures, numeric recipe, generator or digest. A field an artifact gains later stays out
 * until it is named here. An erased artifact ({}) is listed as erased. */
export function learnerTeachingArtifact(artifactId: string, body: unknown) {
  const a = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof a.kind !== 'string') return { artifactId, erased: true };
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  const base = { artifactId, kind: a.kind, objectiveIds: strings(a.objectiveIds), sourceRefs: strings(a.sourceRefs) };
  switch (a.kind) {
    case 'explanation':
    case 'practice':
      return { ...base, markdown: typeof a.markdown === 'string' ? a.markdown : null };
    case 'episode':
      return { ...base, title: typeof a.title === 'string' ? a.title : null,
        blocks: (Array.isArray(a.blocks) ? a.blocks : []).map((b: { id?: unknown; markdown?: unknown }) => ({ id: b?.id ?? null, markdown: b?.markdown ?? null })) };
    case 'assessment_variant':
      return { ...base, question: question(a.assessment) };
    // Media and visuals are delivered to the learner whole, as lesson content.
    case 'media':
      return { ...base, media: structuredClone(a.media ?? null) };
    case 'visual':
      return { ...base, visual: structuredClone(a.visual ?? null) };
    case 'profile_suggestion':
      return { ...base, fieldId: a.fieldId ?? null, proposedValue: a.proposedValue ?? null, rationale: a.rationale ?? null };
    default:
      return base;
  }
}
