import { type Json, type ModelConfig, type VideoJobProvider } from '../src/index.js';
import { GoogleProvider, type GoogleModelConfig, type GoogleVideoJob } from '../src/google-index.js';

export const config: GoogleModelConfig = { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1000000 };
export const opaqueConfig: Json = config;
export const model: ModelConfig = { id: 'text', providerId: 'google-account', remoteModel: 'admin-selected-model',
  providerConfig: config, capabilities: ['tutoring'], tools: [], enabled: true,
  limits: { maxInputCharacters: 1000, maxOutputTokens: 100 } };
export function portableGooglePort(provider: GoogleProvider): VideoJobProvider { return provider; }
export function nativeOperation(job: GoogleVideoJob): string { return job.providerState.operationName; }
