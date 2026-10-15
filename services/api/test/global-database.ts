import { setTimeout as delay } from 'node:timers/promises';
import type { TestProject } from 'vitest/node';
import { addReadyCopy, baseDatabaseUrl, dropRun, dropStale, newRun, prepareTemplate, readyCount, withBase, type TemplateRun } from './database-template.js';

declare module 'vitest' {
  export interface ProvidedContext { courseTestDatabase: TemplateRun | null }
}

const staleAfterMs = 6 * 60 * 60 * 1000;
const maxReady = 4;

/** Migrates one template database per run and keeps a few copies ready; see database-template.ts. */
export default async function setup(project: TestProject) {
  if (!process.env.TEST_DATABASE_URL) {
    // Pure unit tests still run; every database test fails in its own setup with the explicit requirement.
    project.provide('courseTestDatabase', null);
    return;
  }
  const base = baseDatabaseUrl();
  await withBase(base, client => dropStale(client, base, staleAfterMs));
  const run = newRun(base);
  try { await prepareTemplate(base, run); } catch (error) {
    await withBase(base, client => dropRun(client, run)).catch(() => undefined);
    throw error;
  }
  project.provide('courseTestDatabase', run);
  // One copy at a time, on one connection: steady background work instead of bursts on a shared server.
  const target = Math.max(1, Math.min(maxReady, Number(project.config.maxWorkers) || maxReady));
  let stopped = false;
  const filler = withBase(base, async client => {
    while (!stopped) {
      if (await readyCount(client, run) < target) await addReadyCopy(client, run);
      else await delay(100);
    }
  }).catch((error: unknown) => {
    // Files fall back to making their own copy, which reports any real failure in that file.
    if (!stopped) console.warn(`Ready test database copies stopped: ${(error as Error).message}`);
  });
  return async () => {
    stopped = true;
    await filler;
    await withBase(base, client => dropRun(client, run));
  };
}
