import { validateContract, type ToolDefinition } from '@course-core/sdk';
import type { Json } from '@course-core/providers';

/**
 * The supervisor's scoped tools as SDK `defineTool` contracts. Each is validated by the SDK at
 * load, and the tool loop offers exactly these ids. Implementations stay in supervisor-tools.ts,
 * inside the host's transaction and authority checks; a contract here grants nothing by itself.
 */
export const TOOL_FAMILIES = ['learner_read', 'teaching', 'research', 'learner_model', 'hypothesis', 'assessment', 'code_lab', 'visual_media', 'delegation'] as const;
export type ToolFamily = (typeof TOOL_FAMILIES)[number];
export interface HostTool { contract: ToolDefinition; family: ToolFamily }

const object = (properties: Record<string, Json> = {}, required: string[] = []): Record<string, Json> =>
  ({ type: 'object', additionalProperties: false, properties, required });
const id = { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,127}$' };
function tool(family: ToolFamily, value: Omit<ToolDefinition, 'version' | 'execution' | 'outputSchema' | 'timeoutMs' | 'maxOutputBytes' | 'idempotency' | 'inputSchema'>
  & Partial<Pick<ToolDefinition, 'inputSchema' | 'idempotency'>>): HostTool {
  const contract: ToolDefinition = { version: '1.0.0', execution: 'server', inputSchema: object(), outputSchema: { type: 'object' },
    // Every call is keyed by its operation and round, so a replayed round returns its first receipt.
    idempotency: 'idempotency_key', timeoutMs: 15_000, maxOutputBytes: 12_000, ...value };
  const checked = validateContract('tool', contract);
  if (!checked.valid) throw new Error(`invalid_tool_contract:${contract.id}`);
  return { contract: checked.value, family };
}

export const SUPERVISOR_TOOLS: readonly HostTool[] = [
  tool('learner_read', { id: 'get_history', description: 'Read a bounded page of this enrollment\'s companion history.',
    inputSchema: object({ beforeMessageId: { type: 'string', format: 'uuid' } }), capabilities: ['learner.history.read'], sideEffects: 'none' }),
  tool('learner_read', { id: 'get_profile', description: 'Read the learner profile and source-linked learner model.', capabilities: ['learner.profile.read'], sideEffects: 'none' }),
  tool('learner_read', { id: 'get_evidence', description: 'Read server-recorded understanding and recent attempt outcomes.', capabilities: ['learner.evidence.read'], sideEffects: 'none' }),
  tool('teaching', { id: 'list_sources', description: 'List the course release\'s cited sources.', capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('teaching', { id: 'search_sources', description: 'Full-text search of this course release\'s lesson text and cited source titles; ranked snippets with source references.',
    inputSchema: object({ query: { type: 'string', minLength: 1, maxLength: 200 } }, ['query']), capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('learner_read', { id: 'search_history', description: 'Full-text search of the learner\'s own earlier companion questions in this course version; excluded and erased questions are never returned.',
    inputSchema: object({ query: { type: 'string', minLength: 1, maxLength: 200 } }, ['query']), capabilities: ['learner.history.read'], sideEffects: 'none' }),
  tool('teaching', { id: 'list_support', description: 'List author-reviewed support for the current episode.', capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('teaching', { id: 'choose_support', description: 'Select one author-reviewed support entry for verification and delivery.',
    inputSchema: object({ profileId: id, entryId: id }, ['profileId', 'entryId']), capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('teaching', { id: 'list_generation_profiles', description: 'List course-approved generation profiles for new teaching.', capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('teaching', { id: 'create_teaching', description: 'Stage one bounded generated candidate under an approved profile: teaching text, a whole lesson, a simulation (scene data), a check question keyed by a scene model, or a code exercise with hidden tests.',
    inputSchema: { type: 'object' }, capabilities: ['teaching.generate', 'artifact.write'], sideEffects: 'artifact_write' }),
  tool('teaching', { id: 'check_teaching', description: 'Run the reference checks on a staged candidate by digest.',
    inputSchema: object({ artifactDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['artifactDigest']), capabilities: ['teaching.verify'], sideEffects: 'none' }),
  tool('research', { id: 'list_research_topics', description: 'List author-approved public research topics.', capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('research', { id: 'request_research', description: 'Stage a public research request for an approved topic, optionally with a declared task, objective and learner-free request fields. Only the approved public query reaches search.',
    inputSchema: object({ topicId: id, taskId: id, objectiveId: id, misconceptionHypothesis: { type: ['string', 'null'] }, knownPrerequisites: { type: 'array', items: id, maxItems: 20 },
      modality: { type: 'string', enum: ['article', 'video', 'interactive', 'worked_example', 'any'] },
      remainingLearningTime: { type: 'string', enum: ['under_15_min', '15_to_60_min', 'over_60_min'] },
      accessibilityNeeds: { type: 'array', maxItems: 7, items: { type: 'string', enum: ['captions', 'transcript', 'screen_reader', 'reduced_motion', 'keyboard_only', 'audio_description', 'plain_language'] } },
      requiredOrOptional: { type: 'string', enum: ['optional', 'required_replacement'] } }, ['topicId']), capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('research', { id: 'list_reviewed_resources', description: 'List staff-reviewed resources attached to the current lesson as MediaCandidates (objective fit, quoted claims, reviewed segment, duration, captions, rights, concerns).',
    capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('research', { id: 'choose_resource', description: 'Choose one reviewed resource for one objective of the current lesson; the host verifies it before it is suggested to the learner.',
    inputSchema: object({ attachmentId: { type: 'string', format: 'uuid' }, objectiveId: id }, ['attachmentId', 'objectiveId']), capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('learner_model', { id: 'get_model_sources', description: 'List learner events that a model suggestion may cite.', capabilities: ['learner.history.read'], sideEffects: 'none' }),
  tool('learner_model', { id: 'suggest_model', description: 'Propose one source-linked learner-model change for learner review.',
    inputSchema: { type: 'object' }, capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('hypothesis', { id: 'list_hypotheses', description: 'List this learner\'s teaching hypotheses.', inputSchema: { type: 'object' }, capabilities: ['learner.profile.read'], sideEffects: 'none' }),
  tool('hypothesis', { id: 'propose_hypothesis', description: 'Propose a revisable teaching hypothesis citing learner events.', inputSchema: { type: 'object' }, capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('hypothesis', { id: 'update_hypothesis', description: 'Revise or retire a teaching hypothesis.', inputSchema: { type: 'object' }, capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('hypothesis', { id: 'schedule_probe', description: 'Schedule a declared discriminating probe; it never grants mastery.', inputSchema: { type: 'object' }, capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('hypothesis', { id: 'read_probe_results', description: 'Read results of scheduled probes.', inputSchema: { type: 'object' }, capabilities: ['learner.evidence.read'], sideEffects: 'none' }),
  tool('assessment', { id: 'get_assessment_outline', description: 'Outline the current episode\'s assessment items (type, objectives, family, role, declared misconceptions); never answers or grading keys.',
    capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('assessment', { id: 'propose_practice_check', description: 'Offer the learner one new practice problem for an objective of this lesson: Core picks an item from a problem family they have not tried, never a gate, placement or retention item. Practice only; it never counts as evidence.',
    inputSchema: object({ objectiveId: id }, ['objectiveId']), capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('visual_media', { id: 'list_visuals', description: 'List the course\'s registered visuals and animations for this lesson\'s objectives: id, renderer, length, accessible description and reference checks. Never generated media.',
    capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('visual_media', { id: 'choose_visual', description: 'Suggest one registered visual for an objective of this lesson (a change of representation). The host checks it is a reviewed course visual with an accessible description before the learner sees it.',
    inputSchema: object({ visualId: id, objectiveId: id }, ['visualId', 'objectiveId']), capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('learner_model', { id: 'request_authority', description: 'Ask for a change the supervisor may not make itself: a new overall goal (the learner decides), required objectives, grading standards or a higher paid ceiling (staff decide). The job waits for that decision; nothing changes until it is approved.',
    inputSchema: object({ kind: { type: 'string', enum: ['goal_change', 'required_objectives', 'grading_standard', 'paid_ceiling'] }, reason: { type: 'string', minLength: 1, maxLength: 500 },
      proposedGoal: { type: 'string', minLength: 1, maxLength: 300 }, objectiveIds: { type: 'array', items: id, minItems: 1, maxItems: 10 },
      proposedLimitMicroUsd: { type: 'integer', minimum: 1, maximum: 1_000_000_000 } }, ['kind', 'reason']), capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('delegation', { id: 'compare_alternatives', description: 'Evaluator only: read the alternative drafts the builders of this job proposed, with their reference-check results.',
    capabilities: ['artifact.read'], sideEffects: 'none' }),
  tool('delegation', { id: 'choose_alternative', description: 'Evaluator only: commit to one builder\'s alternative. The plan then carries exactly that draft; the host verifies it as usual.',
    inputSchema: object({ checkpointId: { type: 'string', pattern: '^build-[a-c]$' } }, ['checkpointId']), capabilities: ['proposal.submit'], sideEffects: 'proposal_only' }),
  tool('code_lab', { id: 'get_code_results', description: 'Read recent sandbox results for this episode\'s code exercises: pass, status and case counts only; never hidden cases or source.',
    capabilities: ['learner.evidence.read'], sideEffects: 'none' }),
];
export const SUPERVISOR_TOOL_IDS = SUPERVISOR_TOOLS.map(t => t.contract.id) as [string, ...string[]];
if (new Set(SUPERVISOR_TOOL_IDS).size !== SUPERVISOR_TOOL_IDS.length) throw new Error('duplicate_tool_contract');
export function supervisorTool(id: string): HostTool | undefined { return SUPERVISOR_TOOLS.find(t => t.contract.id === id); }

/** Tools that write a proposal of new material; a planner or evaluator never builds. */
const BUILDS = new Set(['create_teaching', 'choose_support', 'choose_resource', 'choose_visual', 'propose_practice_check']);
/** Which tools each logical role (design §4) may use. A single-writer job (no logical role) has every
 * family but delegation; builders build and read; the evaluator compares, checks and commits. */
export function toolAllowedForRole(toolId: string, logicalRole: 'planner' | 'builder' | 'evaluator' | undefined) {
  const t = supervisorTool(toolId);
  if (!t) return false;
  if (logicalRole === 'evaluator') return t.family === 'delegation' || t.family === 'learner_read' || toolId === 'check_teaching' || toolId === 'get_assessment_outline';
  if (t.family === 'delegation') return false;
  if (logicalRole === 'planner') return !BUILDS.has(toolId) && toolId !== 'request_authority';
  if (logicalRole === 'builder') return ['teaching', 'visual_media', 'assessment', 'learner_read', 'code_lab'].includes(t.family);
  return true;
}
/** The tools a run is offered: the strategy's references, narrowed to the logical role and to the
 * families the workspace permits (Q08). The host enforces the same rule on every call. */
export function offeredTools(toolRefs: readonly string[], logicalRole: 'planner' | 'builder' | 'evaluator' | undefined, permittedFamilies: readonly string[]) {
  return toolRefs.filter(id => toolAllowedForRole(id, logicalRole) && permittedFamilies.includes(supervisorTool(id)!.family));
}
