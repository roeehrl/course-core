import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { readConfig } from './config.js';
import { HttpHostBridge } from './bridge.js';
import { HttpProviderGateway, UnconfiguredProvider } from './providers.js';
import { dispatchOnce } from './outbox.js';
import { temporalActivities } from './temporal/activities.js';
import { temporalStarter } from './temporal/client.js';

export async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const mode = args[0];
  if (args.length !== 1 || !['check-config', 'worker', 'dispatch-once'].includes(mode ?? '')) {
    process.stderr.write('Usage: supervisor <check-config|worker|dispatch-once>\n'); return 2;
  }
  const result = readConfig(env);
  if (result.status !== 'ready') { process.stdout.write(`${JSON.stringify(result)}\n`); return 2; }
  const c = result.config;
  if (mode === 'check-config') {
    process.stdout.write(`${JSON.stringify({ status: 'configured', provider: c.provider ? 'configured_unverified' : 'configuration_missing', connectivity: 'not_checked' })}\n`);
    return 0;
  }
  // SDK log metadata can include errors/payloads. Emit only a fixed operational code and level.
  Runtime.install({ logger: new DefaultLogger('WARN', entry => {
    process.stderr.write(`${JSON.stringify({ code: 'temporal_runtime', level: entry.level })}\n`);
  }) });
  const bridge = new HttpHostBridge(c.host.url, c.host.token);
  const provider = c.provider ? new HttpProviderGateway(c.provider.url, c.provider.token) : new UnconfiguredProvider();
  const connectionOptions = { address: c.temporal.address, tls: c.temporal.tls,
    ...(c.temporal.apiKey ? { apiKey: c.temporal.apiKey } : {}) };
  if (mode === 'dispatch-once') {
    const connection = await Connection.connect(connectionOptions);
    try {
      const client = new Client({ connection, namespace: c.temporal.namespace });
      const summary = await dispatchOnce(bridge, temporalStarter(client, c.temporal.taskQueue));
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      if (summary.failed || summary.quarantined || summary.leaseLost) return 1;
    } finally { await connection.close(); }
    return 0;
  }
  const connection = await NativeConnection.connect(connectionOptions);
  try {
    const worker = await Worker.create({ connection, namespace: c.temporal.namespace, taskQueue: c.temporal.taskQueue,
      workflowsPath: fileURLToPath(new URL('./temporal/workflows.js', import.meta.url)),
      activities: temporalActivities(bridge, provider), maxConcurrentActivityTaskExecutions: c.concurrency,
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
