import { compileCourse } from '@course-core/sdk/compiler';
import type { CourseManifest, ContentBlock, ActivityAssignmentDecision } from '@course-core/sdk';
import type { AdaptationState, RuntimeContext } from './contracts.js';
import { requireCondition as assert } from './contracts.js';
import { counters, deepFreeze, materializedViews, readState, snapshot, validateContext } from './validation.js';

/**
 * A derived delivery view, never a replacement immutable course or evidence record.
 *
 * Every call validates the runtime context and reads the stored state in full: the state
 * digest is recomputed and compared, and its enrollment, base course, bindings and policy
 * reservations are checked against the current context. Only then is the view looked up.
 * The view is a pure function of the validated base course and the verified state content,
 * so it is recorded under exactly those two SHA-256 digests (bounded LRU, process-local).
 * A tampered or resealed state either fails the digest check or has another digest and is
 * projected again. The returned view is deeply frozen, shares unchanged parts with the
 * frozen base course, and is the same object for every call with the same identity.
 */
export async function materializeAdaptation(contextInput: RuntimeContext, stateInput: AdaptationState) {
  const stateCopy = snapshot(stateInput); // Read both inputs synchronously, before any await.
  const context = await validateContext(contextInput), state = await readState(stateCopy, context, true);
  const key = `${context.evidence.baseCourseDigest}/${state.digest}`;
  const known = materializedViews.get(key);
  if (known !== undefined) { counters.projectionReuses++; return known as Materialized; }
  counters.projections++;
  const view = deepFreeze(project(context.course, state));
  materializedViews.set(key, view);
  return view;
}
export type Materialized = ReturnType<typeof project>;

/** Copies only what an adaptation changes; everything else is shared with the frozen base. */
function project(course: CourseManifest, state: AdaptationState) {
  const server: CourseManifest = { ...course, chapters: course.chapters.map(c => ({ ...c, episodes: [...c.episodes] })),
    assessments: [...course.assessments], visuals: [...course.visuals], media: [...course.media] };
  const owned = new Set<object>();
  const editable = (episodeId: string) => {
    for (const chapter of server.chapters) {
      const at = chapter.episodes.findIndex(e => e.id === episodeId);
      if (at < 0) continue;
      let episode = chapter.episodes[at]!;
      if (!owned.has(episode)) { episode = { ...episode, blocks: [...episode.blocks] }; chapter.episodes[at] = episode; owned.add(episode); }
      return episode;
    }
    return undefined;
  };
  const assignments: { operationId: string; episodeId: string; artifactDigest: string; decision: ActivityAssignmentDecision }[] = [];
  const variants: { assessmentId: string; canonicalAssessmentId: string; canonicalFamilyId: string; objectiveIds: string[]; artifactDigest: string }[] = [];
  const profileSuggestions: { fieldId: string; proposedValue: string | number | boolean | null; rationale: string; artifactDigest: string }[] = [];
  for (const applied of state.applications) {
    const admission = state.admissions.find(a => a.id === applied.admissionId)!;
    for (const operation of admission.proposal.operations) {
      const artifact = admission.proposal.artifacts.find(a => a.id === operation.artifactId)!;
      if (operation.type === 'suggest_profile_correction') {
        assert(artifact.kind === 'profile_suggestion', 'INVALID_STATE', 'Suggestion kind differs.');
        profileSuggestions.push({ fieldId: artifact.fieldId, proposedValue: artifact.proposedValue, rationale: artifact.rationale, artifactDigest: artifact.digest });
        continue;
      }
      const decision = admission.assignments.find(a => a.operationId === operation.id)!;
      if (operation.type === 'insert_episode') {
        assert(artifact.kind === 'episode', 'INVALID_STATE', 'Inserted episodes need an episode artifact.');
        const chapter = server.chapters.find(c => c.episodes.some(e => e.id === operation.afterEpisodeId));
        assert(chapter, 'INVALID_STATE', 'Inserted episode anchor is missing.');
        const at = chapter.episodes.findIndex(e => e.id === operation.afterEpisodeId) + 1;
        // A personal teaching episode: text only, no gate, never new grading.
        const inserted = { id: artifact.id, title: artifact.title, objectiveIds: [...artifact.objectiveIds],
          ...(decision.classification === 'optional' ? { requirement: 'optional' as const } : {}),
          blocks: artifact.blocks.map(b => ({ id: b.id, type: 'text' as const, markdown: b.markdown, sourceRefs: [...artifact.sourceRefs] })) };
        chapter.episodes.splice(at, 0, inserted); owned.add(inserted);
        assignments.push({ operationId: operation.id, episodeId: artifact.id, artifactDigest: artifact.digest, decision: structuredClone(decision) });
        continue;
      }
      const episode = editable(operation.episodeId)!;
      let block: ContentBlock;
      if (artifact.kind === 'explanation' || artifact.kind === 'practice') {
        block = { id: operation.type === 'replace_teaching' ? operation.blockId : operation.id,
          type: 'text', markdown: artifact.markdown, sourceRefs: [...artifact.sourceRefs] };
      } else if (artifact.kind === 'assessment_variant') {
        server.assessments.push(structuredClone(artifact.assessment));
        block = { id: operation.id, type: 'assessment', assessmentId: artifact.assessment.id };
        variants.push({ assessmentId: artifact.assessment.id, canonicalAssessmentId: artifact.canonicalAssessmentId,
          canonicalFamilyId: artifact.assessment.familyId, objectiveIds: [...artifact.objectiveIds], artifactDigest: artifact.digest });
      } else if (artifact.kind === 'visual') {
        server.visuals.push(structuredClone(artifact.visual)); block = { id: operation.id, type: 'visual', visualId: artifact.visual.id };
      } else {
        assert(artifact.kind === 'media', 'INVALID_STATE', 'Unsupported teaching kind.');
        server.media.push(structuredClone(artifact.media));
        block = { id: operation.id, type: 'media', mediaId: artifact.media.id, required: decision.classification === 'required' };
      }
      if (operation.type === 'replace_teaching') {
        const index = episode.blocks.findIndex(b => b.id === operation.blockId && b.type === 'text');
        assert(index >= 0, 'INVALID_STATE', 'Only an existing allowed text block can be replaced.');
        episode.blocks[index] = block;
      } else episode.blocks.push(block);
      assignments.push({ operationId: operation.id, episodeId: episode.id, artifactDigest: artifact.digest, decision: structuredClone(decision) });
    }
  }
  // Reuse the SDK learner allowlist; generated grading is held only in server data.
  const learner = compileCourse(server).learner;
  return { baseCourseDigest: state.baseCourseDigest, planRevision: state.plan.revision, planDigest: state.plan.digest,
    server, learner, assignments, variants, profileSuggestions };
}
