import { z } from 'zod';
import { id, positive, transportSettingsSchema, videoJobSchema, type ModelConfig, type VideoOutput } from './contracts.js';
import { ensure } from './errors.js';
import { parse } from './validation.js';

/** Values the Interactions API `ImageResponseFormat` accepts (openapi, 2026-10). */
export const INTERACTION_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:8', '8:1', '1:4', '4:1'] as const;
export const INTERACTION_IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const;
const remoteModel = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const googleCommonConfig = {
  apiVersion: z.enum(['v1', 'v1beta']),
  maxResponseBytes: positive.max(32 * 1024 * 1024),
};
export const googleModelConfigSchema = z.discriminatedUnion('transport', [
  z.strictObject({ ...googleCommonConfig, transport: z.literal('generate_content') }),
  z.strictObject({ ...googleCommonConfig, transport: z.literal('video_lro'), video: z.strictObject({
    durationSeconds: z.array(positive).min(1).max(32), aspectRatios: z.array(z.string().regex(/^\d{1,2}:\d{1,2}$/)).min(1),
    resolutions: z.array(id).min(1), downloadHosts: z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/)).min(1),
  }) }),
  /** Image generation through the Interactions API (the current Gemini image models; Imagen is shut down). */
  z.strictObject({ ...googleCommonConfig, transport: z.literal('image_interaction'), image: z.strictObject({
    aspectRatios: z.array(z.enum(INTERACTION_ASPECT_RATIOS)).min(1),
    imageSizes: z.array(z.enum(INTERACTION_IMAGE_SIZES)).min(1),
    mimeTypes: z.array(z.literal('image/jpeg')).min(1).max(1),
    maxImageBytes: positive.max(16 * 1024 * 1024),
  }) }),
]);
export const googleVideoStateSchema = z.strictObject({
  adapter: z.literal('google_video_lro'), remoteModel,
  apiVersion: z.enum(['v1', 'v1beta']), operationName: z.string().min(1).max(512),
});
export const googleVideoJobSchema = videoJobSchema.extend({ providerState: googleVideoStateSchema });
export const googleTransportSettingsSchema = transportSettingsSchema;
export type GoogleModelConfig = z.infer<typeof googleModelConfigSchema>;
export type GoogleVideoJob = z.infer<typeof googleVideoJobSchema>;
export type GoogleVideoOutput = VideoOutput<GoogleVideoJob>;
export type GoogleTransportSettings = z.infer<typeof googleTransportSettingsSchema>;
export type GoogleResolvedModel = Omit<ModelConfig, 'providerConfig'> & { providerConfig: GoogleModelConfig };

/** Native protocol validation belongs here, never in the portable registry. */
export function requireGoogleModel(model: ModelConfig): GoogleResolvedModel {
  parse(remoteModel, model.remoteModel, 'INVALID_CONFIG');
  const config = parse(googleModelConfigSchema, model.providerConfig, 'INVALID_CONFIG');
  ensure(model.tools.every(tool => tool === 'web_search') && model.capabilities.includes('research') === model.tools.includes('web_search'), 'INVALID_CONFIG');
  ensure(config.transport === 'video_lro'
    ? model.capabilities.length === 1 && model.capabilities[0] === 'video' && config.video && model.tools.length === 0
    : config.transport === 'image_interaction'
      ? model.capabilities.length === 1 && model.capabilities[0] === 'image' && model.tools.length === 0 && model.limits.maxOutputTokens !== undefined
      : !model.capabilities.includes('video') && model.limits.maxOutputTokens !== undefined, 'INVALID_CONFIG');
  return { ...model, providerConfig: config };
}
