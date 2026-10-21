import { validateContract, type ToolDefinition } from '@course-core/sdk';
import type { Json } from '@course-core/providers';

/**
 * The supervisor's scoped tools as SDK `defineTool` contracts. Each is validated by the SDK at
 * load, and the tool loop offers exactly these ids. Implementations stay in supervisor-tools.ts,
 * inside the host's transaction and authority checks; a contract here grants nothing by itself.
 */
export const TOOL_FAMILIES = ['learner_read', 'teaching', 'research', 'learner_model', 'hypothesis', 'assessment', 'code_lab'] as const;
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
  tool('code_lab', { id: 'get_code_results', description: 'Read recent sandbox results for this episode\'s code exercises: pass, status and case counts only; never hidden cases or source.',
    capabilities: ['learner.evidence.read'], sideEffects: 'none' }),
];
export const SUPERVISOR_TOOL_IDS = SUPERVISOR_TOOLS.map(t => t.contract.id) as [string, ...string[]];
if (new Set(SUPERVISOR_TOOL_IDS).size !== SUPERVISOR_TOOL_IDS.length) throw new Error('duplicate_tool_contract');
export function supervisorTool(id: string): HostTool | undefined { return SUPERVISOR_TOOLS.find(t => t.contract.id === id); }
