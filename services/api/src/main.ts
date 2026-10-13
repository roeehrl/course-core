import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createDatabase } from './database.js';
import { migrate } from './migrations.js';
import {composeAdaptation} from './adaptation-composition.js';
import { createServer } from './server.js';
import { composeProviders, unconfiguredProviders } from './provider-composition.js';
import { DockerSandbox, QUALIFIED_IMAGES } from '@course-core/sandbox';
import { codeEvaluator } from './code-evaluator.js';
import type { RuntimeExtension } from './publication.js';
import { svgRenderer } from './svg-renderer.js';
import {localCredentialVault} from './key-vault.js';
import {WorkspaceProviders} from './provider-setup.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'http://localhost:4310');
const host = process.env.API_HOST ?? '127.0.0.1';
if (origin.origin !== origin.toString().replace(/\/$/, '') || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be an origin without credentials or a path.');
const loopbackOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopbackOrigin && ['127.0.0.1', '::1'].includes(host))) {
  throw new Error('Remote deployments require HTTPS. Plain HTTP is allowed only for loopback development.');
}
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const db = createDatabase(connectionString);
await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
let providers = unconfiguredProviders();
if (process.env.PROVIDER_CONFIG_FILE) {
  let configuration: unknown;
  try {
    const text = await readFile(process.env.PROVIDER_CONFIG_FILE, 'utf8');
    if (text.length > 100000) throw new Error();
    configuration = JSON.parse(text);
  } catch { throw new Error('Provider configuration could not be read as bounded JSON.'); }
  providers = composeProviders(configuration, name => process.env[name]);
}
const workspaceIds = (process.env.SUPERVISOR_WORKSPACE_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const installedExtensions: RuntimeExtension[] = [await svgRenderer()];
if (process.env.CODE_FIXTURE_FILES) {
  let files: unknown;
  try { files = JSON.parse(process.env.CODE_FIXTURE_FILES); } catch { throw new Error('CODE_FIXTURE_FILES must be a JSON array of trusted server file paths.'); }
  if (!Array.isArray(files) || files.length > 20 || !files.every(file => typeof file === 'string' && file.length < 4096)) throw new Error('Invalid code fixture file list.');
  const image = process.env.COURSE_SANDBOX_IMAGE ?? QUALIFIED_IMAGES[process.arch as keyof typeof QUALIFIED_IMAGES];
  if (!image) throw new Error('An explicitly pinned sandbox image is required on this platform.');
  const sandbox = new DockerSandbox({ image, storageDirectory: process.env.SANDBOX_STORAGE_DIR ?? fileURLToPath(new URL('../.local/sandboxes', import.meta.url)) });
  for (const file of files) installedExtensions.push(await codeEvaluator(await readFile(file), sandbox));
  if (new Set(installedExtensions.map(extension => extension.id)).size !== installedExtensions.length) throw new Error('Duplicate installed extension ID.');
}
const app = await createServer(db, { origin: origin.origin, secureCookies: origin.protocol === 'https:',
  adaptation:composeAdaptation(JSON.parse(process.env.ADAPTATION_ADAPTERS??'[]'),installedExtensions),
  ...(process.env.CORE_INSTANCE_ID ? { instanceId: process.env.CORE_INSTANCE_ID } : {}),
  ...(process.env.LEARNER_WEB_DIR ? { learnerDirectory: process.env.LEARNER_WEB_DIR } : {}),
  ...(process.env.ADMIN_WEB_DIR ? { adminDirectory: process.env.ADMIN_WEB_DIR } : {}),
  providers,
  ...(process.env.PROVIDER_VAULT_DIRECTORY?{workspaceProviders:new WorkspaceProviders(db,await localCredentialVault(process.env.PROVIDER_VAULT_DIRECTORY),{},providers)}:{}),
  installedExtensions,
  ...(process.env.SUPERVISOR_HOST_TOKEN ? { supervisor: { serviceToken: process.env.SUPERVISOR_HOST_TOKEN, workspaceIds } } : {}),
});
await app.listen({ port, host });
process.stdout.write(`Course API listening on ${host}:${port}\n`);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close(); await db.end();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
