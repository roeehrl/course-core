import { z } from 'zod';
import { positive, transportSettingsSchema, type ModelConfig } from './contracts.js';
import { ensure } from './errors.js';
import { parse } from './validation.js';

/** Messages API model identifiers such as `claude-haiku-5-5`; never a path or URL. */
const remoteModel = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
/** The basic, direct-call web search tool. Later versions add dynamic filtering through code
 * execution, which returns additional block types this adapter does not accept. */
export const anthropicWebSearchTools = ['web_search_20250305'] as const;
export const anthropicModelConfigSchema = z.strictObject({
  transport: z.literal('messages'),
  /** The `anthropic-version` request header. */
  apiVersion: z.literal('2023-06-01'),
  maxResponseBytes: positive.max(32 * 1024 * 1024),
  /** Sent as `output_config.effort` when set. Absent leaves the model's default. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Sent as `thinking.type` when set. Only declare a type the model accepts; some models
   * reject `disabled`. Absent leaves the model's default. */
  thinking: z.enum(['adaptive', 'disabled']).optional(),
  /** Server web search for the research capability. */
  webSearch: z.strictObject({
    toolType: z.enum(anthropicWebSearchTools),
    maxUses: z.number().int().min(1).max(20),
  }).optional(),
}).refine(c => !(c.thinking === 'disabled' && (c.effort === 'xhigh' || c.effort === 'max')),
  // Models that accept disabled thinking at all accept it only at effort `high` or below.
  { message: 'thinking_disabled_needs_effort_high_or_below' });
export const anthropicTransportSettingsSchema = transportSettingsSchema;
export type AnthropicModelConfig = z.infer<typeof anthropicModelConfigSchema>;
export type AnthropicResolvedModel = Omit<ModelConfig, 'providerConfig'> & { providerConfig: AnthropicModelConfig };

/** Native protocol validation belongs here, never in the portable registry. The Messages API
 * has no media generation, so image and video capabilities are refused. */
export function requireAnthropicModel(model: ModelConfig): AnthropicResolvedModel {
  parse(remoteModel, model.remoteModel, 'INVALID_CONFIG');
  const config = parse(anthropicModelConfigSchema, model.providerConfig, 'INVALID_CONFIG');
  ensure(model.capabilities.every(c => c === 'tutoring' || c === 'structured_assessment' || c === 'research'), 'INVALID_CONFIG');
  ensure(model.tools.every(tool => tool === 'web_search') && model.capabilities.includes('research') === model.tools.includes('web_search')
    && model.capabilities.includes('research') === (config.webSearch !== undefined), 'INVALID_CONFIG');
  ensure(model.limits.maxOutputTokens !== undefined, 'INVALID_CONFIG');
  return { ...model, providerConfig: config };
}
