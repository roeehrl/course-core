import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { readConfig, type Config } from './config.js';
import { HttpHostBridge } from './bridge.js';
import { HttpProviderGateway, UnconfiguredProvider } from './providers.js';
import { deliverCancellationsOnce, deliverControlsOnce, deliverCrossCourseOnce, dispatchOnce, reconcileOnce, waitForWork, type WakeCursor } from './outbox.js';
import { temporalActivities } from './temporal/activities.js';
import { connectWithRetry, TemporalUnavailableError } from './temporal/connect.js';
import { crossCourseSignaller, enrollmentStarter, temporalCancellationSignaller, temporalSignaller } from './temporal/client.js';
import { activityTraceInterceptor, workflowTraceInterceptor } from './temporal/tracing.js';
import { startTelemetry, telemetryConfiguration, TelemetryConfigurationError, type Telemetry } from './telemetry.js';

export async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const mode = args[0];
  if (args.length !== 1 || !['check-config', 'worker', 'dispatch-once', 'dispatch-loop'].includes(mode ?? '')) {
    process.stderr.write('Usage: supervisor <check-config|worker|dispatch-once|dispatch-loop>\n'); return 2;
  }
  const result = readConfig(env);
  if (result.status !== 'ready') { process.stdout.write(`${JSON.stringify(result)}\n`); return 2; }
  const c = result.config;
  // Optional OTLP export, enabled only by standard OTEL_* variables. Never prints their values.
  const serviceName = mode === 'worker' ? 'course-core-worker' : 'course-core-dispatcher';
  let telemetryStatus: 'configured_unverified' | 'off';
  try { telemetryStatus = telemetryConfiguration(env, serviceName).enabled ? 'configured_unverified' : 'off'; }
  catch (error) {
    if (!(error instanceof TelemetryConfigurationError)) throw error;
    process.stderr.write(`${JSON.stringify({ code: 'invalid_telemetry_configuration', field: error.field })}\n`); return 2;
  }
  if (mode === 'check-config') {
    process.stdout.write(`${JSON.stringify({ status: 'configured', provider: c.provider ? 'configured_unverified' : 'configuration_missing', telemetry: telemetryStatus, connectivity: 'not_checked' })}\n`);
    return 0;
  }
  const observability: Telemetry = await startTelemetry({ serviceName, env });
  try { return await run(mode as 'worker' | 'dispatch-once' | 'dispatch-loop', c, env); }
  finally { await observability.shutdown(); }
}
async function run(mode: 'worker' | 'dispatch-once' | 'dispatch-loop', c: Config, env: NodeJS.ProcessEnv): Promise<number> {
  // SDK log metadata can include errors/payloads. Emit only a fixed operational code and level.
  Runtime.install({ logger: new DefaultLogger('WARN', entry => {
    process.stderr.write(`${JSON.stringify({ code: 'temporal_runtime', level: entry.level })}\n`);
  }) });
  const bridge = new HttpHostBridge(c.host.url, c.host.token);
  const provider = c.provider ? new HttpProviderGateway(c.provider.url, c.provider.token) : new UnconfiguredProvider();
  const connectionOptions = { address: c.temporal.address, tls: c.temporal.tls,
    ...(c.temporal.apiKey ? { apiKey: c.temporal.apiKey } : {}) };
  // Temporal may still be starting (or restarting): retry the first connection until the deadline,
  // then exit with a clear code. A stop signal during the wait ends it promptly.
  const connect = async <T>(open: (remainingMs: number) => Promise<T>): Promise<T | null> => {
    const stop = new AbortController(), onStop = () => stop.abort();
    process.once('SIGINT', onStop); process.once('SIGTERM', onStop);
    try {
      return await connectWithRetry(open, { deadlineMs: c.temporal.connectDeadlineMs, signal: stop.signal,
        onRetry: (attempt, delayMs) => process.stderr.write(`${JSON.stringify({ code: 'temporal_connect_retry', attempt, delayMs })}\n`) });
    } catch (error) {
      if (!(error instanceof TemporalUnavailableError)) throw error;
      process.stderr.write(`${JSON.stringify(error.reason === 'stopped' ? { code: 'temporal_connect_stopped' }
        // The same one-line shape as the API's startup failures (services/api/src/startup.ts).
        : { startup: 'failed', step: 'temporal', code: 'temporal_unavailable', attempts: error.attempts, deadlineMs: c.temporal.connectDeadlineMs,
          hint: 'Temporal did not accept a connection at SUPERVISOR_TEMPORAL_ADDRESS before SUPERVISOR_TEMPORAL_CONNECT_DEADLINE_MS. Start Temporal (or wait for it) and check the address and TLS settings.' })}\n`);
      return null;
    } finally { process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop); }
  };
  if (mode === 'dispatch-once' || mode === 'dispatch-loop') {
    const intervalMs = Number(env.SUPERVISOR_DISPATCH_INTERVAL_MS ?? '2000');
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) {
      process.stderr.write('{"code":"invalid_dispatch_interval"}\n'); return 2;
    }
    // The client SDK otherwise waits up to 10 seconds per attempt; keep each one within the budget
    // (and short enough that a refused connection is retried rather than awaited).
    const connection = await connect(remainingMs => Connection.connect({ ...connectionOptions, connectTimeout: Math.max(Math.min(remainingMs, 5_000), 500) }));
    if (!connection) return 1;
    const stop = new AbortController();
    const onStop = () => stop.abort();
    if (mode === 'dispatch-loop') { process.once('SIGINT', onStop); process.once('SIGTERM', onStop); }
    try {
      // Workflow starts carry the dispatcher's trace context (a no-op while telemetry is off).
      const client = new Client({ connection, namespace: c.temporal.namespace, interceptors: { workflow: [workflowTraceInterceptor()] } });
      const wake: WakeCursor = { sequence: null };
      do {
        // Staff pause/stop/resume wake-ups. Their failure never blocks event dispatch.
        const controls = await deliverControlsOnce(bridge, temporalSignaller(client)).catch(() => null);
        if (!controls) process.stderr.write('{"code":"control_delivery_unavailable"}\n');
        else if (controls.claimed) process.stdout.write(`${JSON.stringify({ controls })}\n`);
        // Job cancellations from data erasure or a provider change. The host flag already stops each
        // job at its next step; the signal stops a call, retry wait or hold that is under way now.
        const cancellations = await deliverCancellationsOnce(bridge, temporalCancellationSignaller(client)).catch(() => null);
        if (!cancellations) process.stderr.write('{"code":"cancellation_delivery_unavailable"}\n');
        else if (cancellations.claimed) process.stdout.write(`${JSON.stringify({ cancellations })}\n`);
        // Learner coordinators: opened on an opt-in or new evidence, stopped on a revocation or erasure.
        const crossCourse = await deliverCrossCourseOnce(bridge, crossCourseSignaller(client, c.temporal.taskQueue)).catch(() => null);
        if (!crossCourse) process.stderr.write('{"code":"cross_course_delivery_unavailable"}\n');
        else if (crossCourse.claimed) process.stdout.write(`${JSON.stringify({ crossCourse })}\n`);
        // Uncertain calls settled from gateway receipts, and due follow-ups, restart in a new generation.
        const reconciled = await reconcileOnce(bridge, enrollmentStarter(client, c.temporal.taskQueue)).catch(() => null);
        if (!reconciled) process.stderr.write('{"code":"reconcile_unavailable"}\n');
        else if (reconciled.settled || reconciled.resumed || reconciled.failed) process.stdout.write(`${JSON.stringify({ reconciled })}\n`);
        try {
          const summary = await dispatchOnce(bridge, enrollmentStarter(client, c.temporal.taskQueue));
          if (mode === 'dispatch-once' || Object.values(summary).some(value => typeof value === 'number' && value > 0)) process.stdout.write(`${JSON.stringify(summary)}\n`);
          if (mode === 'dispatch-once' && (summary.failed || summary.quarantined || summary.leaseLost)) return 1;
        } catch {
          if (mode === 'dispatch-once') throw new Error('dispatch_failed');
          process.stderr.write('{"code":"dispatch_unavailable"}\n');
        }
        if (mode === 'dispatch-once' || stop.signal.aborted) break;
        // Wakes as soon as the host commits new work (a question, a cancellation); the interval is
        // the backstop poll for everything else (retries that come due, controls, reconciliation).
        await waitForWork(bridge, intervalMs, stop.signal, wake);
      } while (!stop.signal.aborted);
    } finally { process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop); await connection.close(); }
    return 0;
  }
  const connection = await connect(() => NativeConnection.connect(connectionOptions));
  if (!connection) return 1;
  try {
    const worker = await Worker.create({ connection, namespace: c.temporal.namespace, taskQueue: c.temporal.taskQueue,
      workflowsPath: fileURLToPath(new URL('./temporal/workflows.js', import.meta.url)),
      activities: temporalActivities(bridge, provider), maxConcurrentActivityTaskExecutions: c.concurrency,
      interceptors: { workflowModules: [fileURLToPath(new URL('./temporal/workflow-interceptors.js', import.meta.url))],
        activity: [() => ({ inbound: activityTraceInterceptor() })] },
      maxConcurrentWorkflowTaskExecutions: c.concurrency, shutdownGraceTime: '20 seconds',
    });
    await worker.run();
  } finally { await connection.close(); }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('{"code":"supervisor_process_failed"}\n'); process.exitCode = 1;
  });
}
