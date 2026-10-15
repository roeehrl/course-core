import { type Json, type ModelConfig, type StructuredAssessmentProvider, type TokenUsage, type TutoringProvider } from '../src/index.js';
import { AnthropicProvider, type AnthropicModelConfig } from '../src/anthropic-index.js';

export const config: AnthropicModelConfig = { transport: 'messages', apiVersion: '2023-06-01', maxResponseBytes: 1000000, effort: 'low', thinking: 'disabled' };
export const opaqueConfig: Json = { transport: 'messages', apiVersion: '2023-06-01', maxResponseBytes: 1000000, effort: 'low', thinking: 'disabled' };
export const model: ModelConfig = { id: 'companion', providerId: 'anthropic-account', remoteModel: 'claude-haiku-5-5',
  providerConfig: opaqueConfig, capabilities: ['tutoring'], tools: [], enabled: true,
  limits: { maxInputCharacters: 1000, maxOutputTokens: 100 } };
export function portableTutor(provider: AnthropicProvider): TutoringProvider { return provider; }
export function portableAssessment(provider: AnthropicProvider): StructuredAssessmentProvider { return provider; }
// Provider-specific counters are optional so existing adapters stay assignable.
export const googleShaped: TokenUsage = { input: 1, output: 1, total: 2, cachedInput: null, thoughts: null, toolInput: null };
