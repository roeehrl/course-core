import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fromVisualExperience, RENDERER_ID, VisualRuntime } from '@course-core/visuals/headless';
import type { RuntimeExtension } from './publication.js';

/** Fingerprint the installed implementation rather than trusting a course-supplied name. */
export async function svgRenderer(): Promise<RuntimeExtension> {
  const entry = fileURLToPath(import.meta.resolve('@course-core/visuals/headless'));
  const directory = path.dirname(entry), packageRoot = path.dirname(directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
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
  return { id: RENDERER_ID, version: manifest.version, integrity: `sha256-${hash.digest('hex')}`, capabilities: ['visual.render'], platforms: ['web'],
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
