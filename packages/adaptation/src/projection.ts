import { compileCourse } from '@course-core/sdk/compiler';
import type { CourseManifest, ContentBlock, ActivityAssignmentDecision } from '@course-core/sdk';
import type { AdaptationState, RuntimeContext } from './contracts.js';
import { requireCondition as assert } from './contracts.js';
import { capture, readState, validateContext } from './validation.js';

/** A derived delivery view, never a replacement immutable course or evidence record. */
export async function materializeAdaptation(contextInput: RuntimeContext, stateInput: AdaptationState) {
  const captured = await capture({ context: contextInput, state: stateInput });
  const context = await validateContext(captured.context), state = await readState(captured.state, context);
  const server: CourseManifest = structuredClone(context.course);
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
      const episode = server.chapters.flatMap(c => c.episodes).find(e => e.id === operation.episodeId)!;
      const decision = admission.assignments.find(a => a.operationId === operation.id)!;
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
