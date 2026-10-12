import { assertEndpoint } from './bridge.js';

export interface Config {
  temporal: { address: string; namespace: string; taskQueue: string; tls: boolean; apiKey?: string };
  host: { url: string; token: string };
  provider: { url: string; token: string } | null;
  concurrency: number;
}
export type ConfigResult = { status: 'ready'; config: Config } | { status: 'configuration_missing'; fields: string[] };
/** Does not probe services, start workers or print values. */
export function readConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const fields: string[] = [];
  const get = (name: string) => { const value = env[name]?.trim(); if (!value) fields.push(name); return value ?? ''; };
  const address = get('SUPERVISOR_TEMPORAL_ADDRESS');
  const namespace = get('SUPERVISOR_TEMPORAL_NAMESPACE');
  const taskQueue = get('SUPERVISOR_TEMPORAL_TASK_QUEUE');
  const hostUrl = get('SUPERVISOR_HOST_URL');
  const hostToken = get('SUPERVISOR_HOST_TOKEN');
  const tls = env.SUPERVISOR_TEMPORAL_TLS === 'true';
  if (env.SUPERVISOR_TEMPORAL_TLS && !['true', 'false'].includes(env.SUPERVISOR_TEMPORAL_TLS)) fields.push('SUPERVISOR_TEMPORAL_TLS');
  const local = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(address);
  if (address && (!/^(?:[a-zA-Z0-9.-]+|\[::1\]):[0-9]{1,5}$/.test(address)
    || Number(address.split(':').at(-1)) < 1 || Number(address.split(':').at(-1)) > 65535)) fields.push('SUPERVISOR_TEMPORAL_ADDRESS');
  if (address && !local && !tls) fields.push('SUPERVISOR_TEMPORAL_TLS');
  if (env.SUPERVISOR_TEMPORAL_API_KEY && !tls) fields.push('SUPERVISOR_TEMPORAL_TLS');
  for (const [name, value] of [['SUPERVISOR_TEMPORAL_NAMESPACE', namespace], ['SUPERVISOR_TEMPORAL_TASK_QUEUE', taskQueue]])
    if (value && !/^[a-zA-Z0-9_./-]{1,200}$/.test(value)) fields.push(name!);
  if (hostUrl) { try { assertEndpoint(hostUrl); } catch { fields.push('SUPERVISOR_HOST_URL'); } }
  let provider: Config['provider'] = null;
  if (env.SUPERVISOR_PROVIDER_URL || env.SUPERVISOR_PROVIDER_TOKEN) {
    const url = get('SUPERVISOR_PROVIDER_URL');
    const token = get('SUPERVISOR_PROVIDER_TOKEN');
    if (url) { try { assertEndpoint(url); } catch { fields.push('SUPERVISOR_PROVIDER_URL'); } }
    provider = { url, token };
  }
  const concurrency = Number(env.SUPERVISOR_ACTIVITY_CONCURRENCY ?? '4');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) fields.push('SUPERVISOR_ACTIVITY_CONCURRENCY');
  if (fields.length) return { status: 'configuration_missing', fields: [...new Set(fields)].sort() };
  return { status: 'ready', config: { temporal: { address, namespace, taskQueue, tls,
    ...(env.SUPERVISOR_TEMPORAL_API_KEY ? { apiKey: env.SUPERVISOR_TEMPORAL_API_KEY } : {}) },
    host: { url: hostUrl, token: hostToken }, provider, concurrency } };
}
