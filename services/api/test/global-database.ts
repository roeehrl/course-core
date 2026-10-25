import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import type { TestProject } from 'vitest/node';
import { addReadyCopy, baseDatabaseUrl, dropRetired, dropRun, dropStale, newRun, prepareTemplate, readyCount, withBase, type TemplateRun } from './database-template.js';

declare module 'vitest' {
  export interface ProvidedContext { courseTestDatabase: TemplateRun | null }
}

const staleAfterMs = 6 * 60 * 60 * 1000;
const maxReady = 8;
/** Empty databases kept ready, for the few files that run migrate() from an empty schema. */
const readyEmpty = 2;
/** Copies made at once; more only compete for the same disk. */
const fillers = 2;

/**
 * Migrates one template database per run, keeps copies ready ahead of demand and drops
 * the copies files have retired, all in the background; see database-template.ts.
 */
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
    await dropRun(base, run).catch(() => undefined);
    throw error;
  }
  project.provide('courseTestDatabase', run);
  let stopped = false;
  // Steady background work instead of bursts on a shared server. If a loop stops, files make
  // their own copies, retired copies wait for the teardown, and nothing is lost.
  const background = (name: string, step: (client: pg.Client) => Promise<boolean>) => withBase(base, async client => {
    while (!stopped) if (!await step(client)) await delay(100);
  }).catch((error: unknown) => {
    if (!stopped) console.warn(`${name} stopped: ${(error as Error).message}`);
  });
  const target = Math.max(1, Math.min(maxReady, Number(project.config.maxWorkers) || maxReady));
  const loops = Array.from({ length: fillers }, () => background('Ready test database copies', async client => {
    if (await readyCount(client, run, { empty: true }) < readyEmpty) await addReadyCopy(client, run, { empty: true });
    else if (await readyCount(client, run) < target) await addReadyCopy(client, run);
    else return false;
    return true;
  }));
  // DROP DATABASE waits for a checkpoint of the whole server; no test file waits for one.
  loops.push(background('Dropping retired test database copies', async client => await dropRetired(client, base, run) > 0));
  return async () => {
    stopped = true;
    await Promise.all(loops);
    await dropRun(base, run);
  };
}
