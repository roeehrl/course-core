import { ModelRegistry, ProviderRouter, type ProviderAdapter, type RegistryConfig,
  type TutoringProvider, type VideoJobProvider, type VideoJob } from '../src/index.js';

const configuration: RegistryConfig = { revision: 'v1', models: [{
  id: 'vendor/model @stable', providerId: 'other-vendor', remoteModel: 'organization/deployment@1',
  providerConfig: { dialect: 17, endpointReference: { queue: 'teaching' } }, enabled: true,
  capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 10000, maxOutputTokens: 100 },
}] };
const registry = new ModelRegistry(configuration);
const otherAdapter: ProviderAdapter = {
  providerId: 'other-vendor',
  validateModel(model) { if (!model.remoteModel.startsWith('organization/')) throw new Error('Invalid native model'); },
  ports: { tutoring: { async tutor(request) {
    return { output: { text: 'Typed fake reply' }, usage: {
      accounting: request.accounting, providerId: 'other-vendor', modelId: request.modelId,
      operation: 'tutor', attempts: [], inputCharacters: 0, requestedMaxOutputTokens: request.maxOutputTokens,
      requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
    } };
  } } },
};
registry.registerAdapter(otherAdapter);
export const corePort: TutoringProvider & VideoJobProvider = new ProviderRouter(registry);
export const portableJob: VideoJob = { kind: 'video', providerId: 'other-vendor', modelId: 'vendor/model @stable',
  registryRevision: 'v1', providerState: { arbitraryTicket: [1, 'queue-a'] },
  accounting: { accountingKey: 'job' }, requestedDurationSeconds: 9 };
// Native fields are deliberately not part of the portable job contract.
// @ts-expect-error Native operation names are inside an adapter's opaque state.
portableJob.operationName;
// @ts-expect-error Core capability ports do not promise Google's cancellation behavior.
corePort.videoCancellation;
