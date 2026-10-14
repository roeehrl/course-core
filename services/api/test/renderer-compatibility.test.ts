import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { fromVisualExperience, VisualRuntime } from '@course-core/visuals/headless';
import { declarationMatchesInstalled } from '../src/extension-identity.js';
import { resolveInteractiveContext } from '../src/interactive-context.js';
import { assertCourseRunnable, type RuntimeExtension } from '../src/publication.js';
import type { EnrollmentContext } from '../src/repository.js';
import { acceptedPriorBuilds, REVIEWED_PRIOR_SVG_BUILDS, svgRenderer, visualsDistDigests } from '../src/svg-renderer.js';
import { fixture } from './fixture.js';
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

// The build shipped identically with Core v0.1.3 through v0.1.25. Pinned releases declare it.
const PRIOR = { version: '0.1.0', integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24' };
// Core v0.1.32 shipped changed bytes under 0.1.0. That build is not a released identity.
const MISLABELED = { version: '0.1.0', integrity: 'sha256-b330d598fc6201d04e9700e138f1cc6d4c17db4beab45d1ed7abbd5858c4692b' };
const FORGED = `sha256-${'f'.repeat(64)}`;
const tamper = (integrity: string) => integrity.slice(0, -1) + (integrity.endsWith('0') ? '1' : '0');

interface ReleasedRecord { versions: Record<string, { integrity: string; headless: string; headlessFiles: Record<string, string> }> }
const record: ReleasedRecord = JSON.parse(await readFile(fileURLToPath(new URL('../../../packages/visuals/released-digests.json', import.meta.url)), 'utf8'));

let renderer: RuntimeExtension;
beforeAll(async () => { renderer = await svgRenderer(); });

function course({ version, integrity }: { version: string; integrity: string }) {
  const declared = { version, integrity }, visual = visualContextFixture(), source = fixture();
  source.visuals.push(visual);
  source.chapters[0]!.episodes[0]!.blocks.push({ id: 'diagram-one', type: 'visual', visualId: visual.id });
  source.extensions.push({ id: 'course-core-svg-v1', ...declared, execution: 'declarative', entrypoint: 'renderers/svg-v1.js', platforms: ['web'], capabilities: ['visual.render'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: visual.accessibility.description } });
  return { source, visual };
}
function interactive(declared: { version: string; integrity: string }, installed: RuntimeExtension) {
  const { source, visual } = course(declared), compiled = compileCourse(source);
  const enrollment: EnrollmentContext = {
    enrollment: { id: 'enrollment', workspace_id: 'workspace', user_id: 'learner', status: 'active', revision: 1, profile: {}, profile_revision: 1, policy_revision: 1, policy: source.policy, started_at: new Date(0), course_release_id: 'release' },
    release: { id: 'release', workspace_id: 'workspace', digest: compiled.digest, server_bundle: compiled.server, learner_bundle: compiled.learner, status: 'published' },
    progress: [], evidence: [],
  };
  const runtime = new VisualRuntime(fromVisualExperience(visual));
  return () => resolveInteractiveContext({ enrollment, scope: { episodeId: 'min', blockId: 'diagram-one' }, installedExtensions: [installed],
    input: { schemaVersion: 1, sceneVersion: 1, episodeId: 'min', blockId: 'diagram-one', visualId: visual.id, rendererId: visual.rendererId, sceneFingerprint: runtime.exportReplay().sceneFingerprint, state: runtime.getSnapshot().frame.state, timeMs: 500, layout: 'compact', reducedMotion: false } });
}
/** Every declaration the API must refuse, against the real installed renderer. */
function refused() {
  return [
    { label: 'unknown integrity', version: PRIOR.version, integrity: FORGED },
    { label: 'unknown integrity at the current version', version: renderer.version, integrity: FORGED },
    { label: '0.1.0 paired with the new integrity', version: PRIOR.version, integrity: renderer.integrity },
    { label: 'current version paired with the old integrity', version: renderer.version, integrity: PRIOR.integrity },
    { label: 'tampered prior integrity', version: PRIOR.version, integrity: tamper(PRIOR.integrity) },
    { label: 'prior integrity at an unknown version', version: '0.1.2', integrity: PRIOR.integrity },
    { label: 'mislabeled v0.1.32 build of 0.1.0', ...MISLABELED },
  ];
}

describe('released visuals identities', () => {
  it('the installed renderer is the recorded release for its version, and 0.1.1 is a new version', () => {
    expect(renderer.version).toBe('0.1.1');
    expect(record.versions[renderer.version]?.integrity).toBe(renderer.integrity);
    expect(renderer.integrity).not.toBe(PRIOR.integrity);
  });
  it('every reviewed prior build is the recorded release with the same headless runtime as the installed build', async () => {
    expect(REVIEWED_PRIOR_SVG_BUILDS.map(({ version, integrity }) => ({ version, integrity }))).toEqual([PRIOR]);
    const entry = fileURLToPath(import.meta.resolve('@course-core/visuals/headless')), dist = path.dirname(entry);
    const installed = await visualsDistDigests(dist, JSON.parse(await readFile(path.join(dist, '..', 'package.json'), 'utf8')));
    expect(installed.integrity).toBe(renderer.integrity);
    for (const build of REVIEWED_PRIOR_SVG_BUILDS) {
      expect(record.versions[build.version]).toMatchObject({ integrity: build.integrity, headless: build.headless });
      // Server-side runtime and scene semantics are byte-identical (headless.js and every module it imports).
      expect(installed.headless).toBe(build.headless);
      expect(record.versions[renderer.version]!.headlessFiles).toEqual(record.versions[build.version]!.headlessFiles);
    }
  });
  it('the adapter exposes exactly the reviewed 0.1.0 declaration, and the list cannot be extended at runtime', () => {
    expect(renderer.acceptedPriorBuilds).toEqual([PRIOR]);
    expect(Object.isFrozen(renderer.acceptedPriorBuilds)).toBe(true);
    expect(() => (renderer.acceptedPriorBuilds as BuildList).push({ version: '9.9.9', integrity: FORGED })).toThrow();
    expect(() => { (renderer.acceptedPriorBuilds![0] as { integrity: string }).integrity = FORGED; }).toThrow();
  });
  it('a reviewed entry is dropped when its headless runtime differs from the installed one or it names the installed build', () => {
    const installed = { version: '0.1.1', integrity: renderer.integrity, headless: REVIEWED_PRIOR_SVG_BUILDS[0]!.headless };
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, installed)).toEqual([PRIOR]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...installed, headless: tamper(installed.headless) })).toEqual([]);
    expect(acceptedPriorBuilds([{ ...REVIEWED_PRIOR_SVG_BUILDS[0]!, headless: tamper(installed.headless) }], installed)).toEqual([]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...installed, version: '0.1.0' })).toEqual([]);
  });
});
type BuildList = { version: string; integrity: string }[];

describe('the shared declaration-vs-installed identity check', () => {
  it('accepts only the installed build or an exact reviewed prior build', () => {
    expect(declarationMatchesInstalled({ version: renderer.version, integrity: renderer.integrity }, renderer)).toBe(true);
    expect(declarationMatchesInstalled(PRIOR, renderer)).toBe(true);
    for (const declaration of refused()) expect(declarationMatchesInstalled(declaration, renderer), declaration.label).toBe(false);
    expect(declarationMatchesInstalled(undefined, renderer)).toBe(false);
    expect(declarationMatchesInstalled(PRIOR, undefined)).toBe(false);
  });
  it('a tampered prior entry on the adapter does not admit the original declaration', () => {
    const tampered = { ...renderer, acceptedPriorBuilds: [{ version: PRIOR.version, integrity: tamper(PRIOR.integrity) }] };
    expect(declarationMatchesInstalled(PRIOR, tampered)).toBe(false);
    expect(declarationMatchesInstalled(PRIOR, { ...renderer, acceptedPriorBuilds: [{ version: '0.1.2', integrity: PRIOR.integrity }] })).toBe(false);
    expect(declarationMatchesInstalled(PRIOR, { ...renderer, acceptedPriorBuilds: undefined })).toBe(false);
  });
  it('adapters without reviewed prior builds keep exact matching', () => {
    const grader = { version: '1.0.0', integrity: `sha256-${'a'.repeat(64)}` };
    expect(declarationMatchesInstalled(grader, grader)).toBe(true);
    expect(declarationMatchesInstalled({ ...grader, integrity: FORGED }, grader)).toBe(false);
    expect(declarationMatchesInstalled({ ...grader, version: '1.0.1' }, grader)).toBe(false);
  });
});

describe('publication and interactive context route through the shared check', () => {
  it('a course declaring the old 0.1.0 build publishes and resolves interactive context on the new renderer', () => {
    expect(() => assertCourseRunnable(course(PRIOR).source, [renderer])).not.toThrow();
    expect(interactive(PRIOR, renderer)()).toMatchObject({ kind: 'visual', renderer: { id: 'course-core-svg-v1', version: renderer.version, integrity: renderer.integrity } });
    expect(() => assertCourseRunnable(course({ version: renderer.version, integrity: renderer.integrity }).source, [renderer])).not.toThrow();
  });
  it('every refused declaration is refused by both publication and interactive context', () => {
    for (const declaration of refused()) {
      expect(() => assertCourseRunnable(course(declaration).source, [renderer]), declaration.label).toThrowError(/PUBLISH_CAPABILITY_MISSING/);
      expect(interactive(declaration, renderer), declaration.label).toThrowError(/INTERACTIVE_RENDERER_UNAVAILABLE/);
    }
  });
  it('an installed renderer without the reviewed list refuses the old declaration', () => {
    const exactOnly = { ...renderer, acceptedPriorBuilds: [] };
    expect(() => assertCourseRunnable(course(PRIOR).source, [exactOnly])).toThrowError(/PUBLISH_CAPABILITY_MISSING/);
    expect(interactive(PRIOR, exactOnly)).toThrowError(/INTERACTIVE_RENDERER_UNAVAILABLE/);
  });
});
