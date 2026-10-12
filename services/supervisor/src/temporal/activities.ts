import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { createActivities, type Activities } from '../activities.js';
import type { HostBridge } from '../bridge.js';
import type { ProviderGateway } from '../providers.js';

export function temporalActivities(bridge: HostBridge, provider: ProviderGateway): Activities {
  const plain = createActivities(bridge, provider, () => ({
    signal: Context.current().cancellationSignal,
    heartbeat: () => Context.current().heartbeat(),
  }));
  // Raw exception messages may contain URLs, bearer tokens, provider text or learner data.
  const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await fn(...args); }
    catch { throw ApplicationFailure.create({ message: 'supervisor_activity_unavailable', type: 'SupervisorActivityFailure' }); }
  };
  const execute: Activities['executeCheckpoint'] = async (...args) => {
    const context = Context.current();
    const beat = () => { try { context.heartbeat(); } catch { /* signal propagates cancellation */ } };
    const timer = setInterval(beat, 1_000);
    timer.unref();
    try { beat(); return await plain.executeCheckpoint(...args); }
    finally { clearInterval(timer); }
  };
  return { loadJob: wrap(plain.loadJob), executeCheckpoint: wrap(execute),
    verifyJob: wrap(plain.verifyJob), applyJob: wrap(plain.applyJob), haltJob: wrap(plain.haltJob) };
}
