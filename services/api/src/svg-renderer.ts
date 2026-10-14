import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fromVisualExperience, RENDERER_ID, VisualRuntime } from '@course-core/visuals/headless';
import type { BuildIdentity } from './extension-identity.js';
import type { RuntimeExtension } from './publication.js';

/** A reviewed prior visuals build, bound to the exact server-side headless runtime it was reviewed against. */
export interface ReviewedPriorBuild extends BuildIdentity { readonly headless: string }

/**
 * Prior `course-core-svg-v1` builds still served for already published, pinned courses.
 *
 * 0.1.0 is the build shipped identically with Core v0.1.3 through v0.1.25. 0.1.1 changed
 * only the React client wrapper (dist/react.js); the server-side headless entry and every
 * module it imports, plus the dependency manifest, are byte-identical. Server-side
 * validation and interactive context therefore behave exactly as they did for 0.1.0.
 *
 * Each entry applies only while the installed headless digest equals its `headless`
 * value (see acceptedPriorBuilds), so a later runtime change disables it instead of
 * silently widening it. Values match packages/visuals/released-digests.json. Adding an
 * entry requires the same review. Never add a build whose headless runtime differs.
 */
export const REVIEWED_PRIOR_SVG_BUILDS: readonly ReviewedPriorBuild[] = Object.freeze([
  Object.freeze({
    version: '0.1.0',
    integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24',
    headless: 'sha256-c479f10e2def81707919764494e52a86cbe35ae8b4245af0faff1788d9cc94ea',
  }),
]);

/** Reviewed prior builds that apply to this exact installed build. */
export function acceptedPriorBuilds(reviewed: readonly ReviewedPriorBuild[], installed: BuildIdentity & { headless: string }): readonly BuildIdentity[] {
  return Object.freeze(reviewed
    .filter(build => build.headless === installed.headless && build.version !== installed.version && build.integrity !== installed.integrity)
    .map(({ version, integrity }) => Object.freeze({ version, integrity })));
}

export interface VisualsDigests { version: string; integrity: string; headless: string }

/** The svgRenderer fingerprint of a visuals dist directory, plus its headless-entry digest. */
export async function visualsDistDigests(directory: string, manifest: { version: string; dependencies?: unknown; peerDependencies?: unknown }): Promise<VisualsDigests> {
  const hash = createHash('sha256');
  const files: string[] = [];
  async function collect(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && /\.(?:js|css|json)$/.test(entry.name)) files.push(name);
    }
  }
  await collect('');
  for (const name of files.sort()) hash.update(name.replaceAll(path.sep, '/')).update('\0').update(await readFile(path.join(directory, name))).update('\0');
  hash.update(JSON.stringify({ version: manifest.version, dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies }));

  // headless.js and every dist module it reaches through relative imports.
  const closure = new Set<string>();
  async function follow(name: string) {
    if (closure.has(name)) return;
    closure.add(name);
    const text = await readFile(path.join(directory, name), 'utf8');
    for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*["'](\.\/[^"']+)["']/g))
      await follow(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]!)));
  }
  await follow('headless.js');
  const headless = createHash('sha256');
  for (const name of [...closure].sort()) headless.update(name).update('\0').update(await readFile(path.join(directory, name))).update('\0');
  headless.update(JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies }));
  return { version: manifest.version, integrity: `sha256-${hash.digest('hex')}`, headless: `sha256-${headless.digest('hex')}` };
}

/** Fingerprint the installed implementation rather than trusting a course-supplied name. */
export async function svgRenderer(): Promise<RuntimeExtension> {
  const entry = fileURLToPath(import.meta.resolve('@course-core/visuals/headless'));
  const directory = path.dirname(entry), packageRoot = path.dirname(directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const installed = await visualsDistDigests(directory, manifest);
  return { id: RENDERER_ID, version: installed.version, integrity: installed.integrity, capabilities: ['visual.render'], platforms: ['web'],
    acceptedPriorBuilds: acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, installed),
    validateVisual(visual) {
      const scene = fromVisualExperience(visual);
      for (const viewportWidth of [320, 960]) for (const reducedMotion of [false, true]) {
        const runtime = new VisualRuntime(scene, { viewportWidth, reducedMotion });
        for (const time of [0, scene.timeline.durationMs / 2, scene.timeline.durationMs]) runtime.seek(time);
      }
      // This validates rendering/data bounds, not the lesson's scientific claims.
      // Course-specific numerical/source verification remains a separate release gate.
    },
  };
}
