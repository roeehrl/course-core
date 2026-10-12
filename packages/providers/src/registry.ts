import { capabilitySchema, id, modelId as modelIdentifier, registrySchema, type Capability, type CapabilityPorts, type ModelConfig, type ProviderAdapter, type RegistryConfig } from './contracts.js';
import { ensure, ProviderError } from './errors.js';
import { parse } from './validation.js';

/** Configuration claims only. No model name heuristics, discovery or price claims. */
export class ModelRegistry {
  #revision: string;
  #models: ModelConfig[];
  #adapters = new Map<string, Partial<CapabilityPorts>>();
  constructor(input: RegistryConfig) {
    const config = parse(registrySchema, input, 'INVALID_CONFIG');
    ensure(new Set(config.models.map(m => m.id)).size === config.models.length, 'INVALID_CONFIG');
    for (const model of config.models) {
      ensure(new Set(model.capabilities).size === model.capabilities.length && new Set(model.tools).size === model.tools.length, 'INVALID_CONFIG');
    }
    this.#revision = config.revision; this.#models = config.models;
  }
  get revision(): string { return this.#revision; }
  list(): ModelConfig[] { return structuredClone(this.#models); }
  require(modelId: string, capability: Capability, providerId: string): ModelConfig {
    parse(modelIdentifier, modelId); parse(capabilitySchema, capability); parse(id, providerId);
    const model = this.#models.find(m => m.id === modelId);
    ensure(model, 'UNKNOWN_MODEL');
    ensure(model.enabled && model.providerId === providerId && model.capabilities.includes(capability), 'CAPABILITY_MISMATCH');
    return structuredClone(model);
  }
  registerAdapter(adapter: ProviderAdapter): void {
    const providerId = parse(id, adapter.providerId, 'INVALID_CONFIG');
    ensure(!this.#adapters.has(providerId) && typeof adapter.validateModel === 'function' && adapter.ports !== null && typeof adapter.ports === 'object', 'INVALID_CONFIG');
    const methodNames = { tutoring: ['tutor'], structured_assessment: ['assess'], research: ['research'], image: ['startImage'], video: ['startVideo', 'pollVideo'] } as const;
    const ports: Partial<CapabilityPorts> = {};
    for (const [key, port] of Object.entries(adapter.ports)) {
      const capability = parse(capabilitySchema, key, 'INVALID_CONFIG');
      ensure(port !== null && typeof port === 'object', 'INVALID_CONFIG');
      const methods: Record<string, unknown> = {};
      for (const method of methodNames[capability]) {
        const implementation = (port as unknown as Record<string, unknown>)[method];
        ensure(typeof implementation === 'function', 'INVALID_CONFIG'); methods[method] = implementation.bind(port);
      }
      if (capability === 'video' && 'cancelVideo' in port) {
        ensure(typeof port.cancelVideo === 'function', 'INVALID_CONFIG'); methods.cancelVideo = port.cancelVideo.bind(port);
      }
      Object.assign(ports, { [capability]: Object.freeze(methods) });
    }
    for (const model of this.#models.filter(m => m.providerId === providerId)) {
      ensure(model.capabilities.every(capability => ports[capability]), 'INVALID_CONFIG');
      try {
        const result: unknown = adapter.validateModel(structuredClone(model));
        // Registration cannot succeed while async validation is still pending.
        if (result instanceof Promise) void result.catch(() => {});
        ensure(result === undefined, 'INVALID_CONFIG');
      } catch { throw new ProviderError('INVALID_CONFIG'); }
    }
    this.#adapters.set(providerId, Object.freeze(ports));
  }
  port<C extends Capability>(modelId: string, capability: C, providerId?: string): CapabilityPorts[C] {
    parse(modelIdentifier, modelId); parse(capabilitySchema, capability);
    const model = this.#models.find(m => m.id === modelId);
    ensure(model, 'UNKNOWN_MODEL');
    this.require(modelId, capability, providerId ?? model.providerId);
    const adapter = this.#adapters.get(model.providerId);
    ensure(adapter, 'ADAPTER_UNAVAILABLE');
    const port = adapter[capability]; ensure(port, 'CAPABILITY_MISMATCH');
    return port;
  }
}
