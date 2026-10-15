import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { fromVisualExperience, VisualRuntime } from '@course-core/visuals/headless';
import { declarationMatchesInstalled } from '../src/extension-identity.js';
import { resolveInteractiveContext } from '../src/interactive-context.js';
import { assertCourseRunnable, type RuntimeExtension } from '../src/publication.js';
import type { EnrollmentContext } from '../src/repository.js';
import { acceptedPriorBuilds, installedVisualsIdentity, RECORDED_SVG_RELEASES, REVIEWED_PRIOR_SVG_BUILDS, svgRenderer, visualsDistDigests, visualsRendererIdentity } from '../src/svg-renderer.js';
import { fixture } from './fixture.js';
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

// The build shipped identically with Core v0.1.3 through v0.1.25. Pinned releases declare it.
const PRIOR = { version: '0.1.0', integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24' };
// Core v0.1.32 shipped changed bytes under 0.1.0. That build is not a released identity.
const MISLABELED = { version: '0.1.0', integrity: 'sha256-b330d598fc6201d04e9700e138f1cc6d4c17db4beab45d1ed7abbd5858c4692b' };
const FORGED = `sha256-${'f'.repeat(64)}`;
const tamper = (integrity: string) => integrity.slice(0, -1) + (integrity.endsWith('0') ? '1' : '0');

interface ReleasedRecord { versions: Record<string, { integrity: string; headless: string; executed: string; headlessExecuted: string; files: Record<string, string>; headlessFiles: Record<string, string>; runtime: unknown; headlessRuntime: unknown }> }
const record: ReleasedRecord = JSON.parse(await readFile(fileURLToPath(new URL('../../../packages/visuals/released-digests.json', import.meta.url)), 'utf8'));
// 0.1.1 as released: the fingerprint published courses declare, and its executed identity.
const CURRENT = { version: '0.1.1', integrity: 'sha256-d64441db68463ba2c62d36d04fc9c60a3378b4a2f783d5f156238b6aa6e2dcd6' };
const EXECUTED = { version: '0.1.1', integrity: record.versions['0.1.1']!.executed };
const PRIOR_EXECUTED = { version: '0.1.0', integrity: record.versions['0.1.0']!.executed };
const installedDist = () => path.dirname(fileURLToPath(import.meta.resolve('@course-core/visuals/headless')));

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
    { label: '0.1.0 paired with the installed executed identity', version: PRIOR.version, integrity: EXECUTED.integrity },
    { label: 'installed version paired with the 0.1.0 executed identity', version: renderer.version, integrity: PRIOR_EXECUTED.integrity },
    { label: 'tampered executed identity', version: EXECUTED.version, integrity: tamper(EXECUTED.integrity) },
  ];
}

describe('released visuals identities', () => {
  it('the installed renderer is the recorded release for its version, and 0.1.1 is a new version', () => {
    expect({ version: renderer.version, integrity: renderer.integrity }).toEqual(CURRENT);
    expect(record.versions[renderer.version]?.integrity).toBe(renderer.integrity);
    expect(renderer.integrity).not.toBe(PRIOR.integrity);
  });
  it('the API computes the same executed identity as the visuals digest script, and it is the recorded one', async () => {
    const dist = installedDist();
    const installed = await visualsDistDigests(dist, JSON.parse(await readFile(path.join(dist, '..', 'package.json'), 'utf8')));
    const released = record.versions[installed.version]!;
    expect(installed).toMatchObject({ executed: released.executed, headlessExecuted: released.headlessExecuted, files: released.files,
      headlessFiles: released.headlessFiles, runtime: released.runtime, headlessRuntime: released.headlessRuntime });
    expect(RECORDED_SVG_RELEASES.map(build => ({ ...build }))).toEqual(Object.entries(record.versions).map(([version, entry]) => ({ version, integrity: entry.integrity, executed: entry.executed })));
    expect(Object.isFrozen(RECORDED_SVG_RELEASES) && RECORDED_SVG_RELEASES.every(Object.isFrozen)).toBe(true);
  });
  it('every reviewed prior build is the recorded release with the same headless runtime as the installed build', async () => {
    expect(REVIEWED_PRIOR_SVG_BUILDS.map(({ version, integrity }) => ({ version, integrity }))).toEqual([PRIOR]);
    const dist = installedDist();
    const installed = await visualsDistDigests(dist, JSON.parse(await readFile(path.join(dist, '..', 'package.json'), 'utf8')));
    expect(installedVisualsIdentity(RECORDED_SVG_RELEASES, installed).integrity).toBe(renderer.integrity);
    for (const build of REVIEWED_PRIOR_SVG_BUILDS) {
      expect(record.versions[build.version]).toMatchObject({ integrity: build.integrity, headless: build.headless, headlessExecuted: build.headlessExecuted });
      // Server-side runtime and scene semantics are byte-identical (headless.js, every module it imports, and the pins of what they import).
      expect(installed.headlessExecuted).toBe(build.headlessExecuted);
      expect(record.versions[renderer.version]!.headlessFiles).toEqual(record.versions[build.version]!.headlessFiles);
    }
  });
  it('the adapter exposes exactly the reviewed 0.1.0 declaration and its own executed identity, and the list cannot be extended at runtime', () => {
    expect(renderer.acceptedPriorBuilds).toEqual([PRIOR, EXECUTED]);
    expect(Object.isFrozen(renderer.acceptedPriorBuilds)).toBe(true);
    expect(() => (renderer.acceptedPriorBuilds as BuildList).push({ version: '9.9.9', integrity: FORGED })).toThrow();
    expect(() => { (renderer.acceptedPriorBuilds![0] as { integrity: string }).integrity = FORGED; }).toThrow();
  });
  it('a reviewed entry is dropped when its headless runtime differs from the installed one or it names the installed build', () => {
    const installed = { version: '0.1.1', integrity: renderer.integrity, headlessExecuted: REVIEWED_PRIOR_SVG_BUILDS[0]!.headlessExecuted };
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, installed)).toEqual([PRIOR]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...installed, headlessExecuted: tamper(installed.headlessExecuted) })).toEqual([]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...installed, headlessExecuted: undefined })).toEqual([]);
    expect(acceptedPriorBuilds([{ ...REVIEWED_PRIOR_SVG_BUILDS[0]!, headlessExecuted: tamper(installed.headlessExecuted) }], installed)).toEqual([]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...installed, version: '0.1.0' })).toEqual([]);
    // The legacy headless digest alone no longer admits a prior build.
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { version: '0.1.1', integrity: renderer.integrity, headless: REVIEWED_PRIOR_SVG_BUILDS[0]!.headless } as never)).toEqual([]);
  });
});
type BuildList = { version: string; integrity: string }[];

describe('the shared declaration-vs-installed identity check', () => {
  it('accepts only the installed build, its executed identity or an exact reviewed prior build', () => {
    expect(declarationMatchesInstalled({ version: renderer.version, integrity: renderer.integrity }, renderer)).toBe(true);
    expect(declarationMatchesInstalled(CURRENT, renderer)).toBe(true);
    expect(declarationMatchesInstalled(EXECUTED, renderer)).toBe(true);
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
  it('legacy 0.1.1 and executed-identity declarations both publish and resolve interactive context', () => {
    for (const declared of [CURRENT, EXECUTED]) {
      expect(() => assertCourseRunnable(course(declared).source, [renderer])).not.toThrow();
      expect(interactive(declared, renderer)()).toMatchObject({ kind: 'visual', renderer: { id: 'course-core-svg-v1', version: CURRENT.version, integrity: CURRENT.integrity } });
    }
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

/** Every declaration a published course may carry today, plus the new executed identity. */
const DECLARED = [PRIOR, CURRENT, EXECUTED];
const scratch: string[] = [];
afterAll(() => Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true }))));
/** A copy of the installed visuals build (dist + manifest) with one change applied. */
async function variant(change: (dist: string, manifest: Record<string, any>) => Promise<unknown> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'svg-identity-')), dist = path.join(dir, 'dist');
  scratch.push(dir);
  await cp(installedDist(), dist, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(installedDist(), '..', 'package.json'), 'utf8'));
  await change(dist, manifest);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest));
  const identity = await visualsRendererIdentity(dist, manifest);
  return { ...renderer, ...identity, legacy: (await visualsDistDigests(dist, manifest)).integrity };
}
const accepts = (installed: RuntimeExtension, declared: { version: string; integrity: string }) => {
  const matches = declarationMatchesInstalled(declared, installed);
  let publishes = true, context = true;
  try { assertCourseRunnable(course(declared).source, [installed]); } catch { publishes = false; }
  try { interactive(declared, installed)(); } catch { context = false; }
  // Publication and interactive context always agree with the shared check.
  expect([publishes, context]).toEqual([matches, matches]);
  return matches;
};

describe('renderer identity follows what executes', () => {
  it('a dependency pin no dist file imports (the SDK, types only) changes nothing a course can observe', async () => {
    const pinned = await variant((_, manifest) => {
      manifest.dependencies['@course-core/sdk'] = 'https://github.com/roeehrl/course-sdk/releases/download/v0.5.0/course-core-sdk-0.5.0.tgz';
    });
    // The legacy fingerprint moves, which is what used to block the pin change...
    expect(pinned.legacy).not.toBe(CURRENT.integrity);
    // ...but the advertised identity and every accepted declaration are exactly the released ones.
    expect({ version: pinned.version, integrity: pinned.integrity }).toEqual(CURRENT);
    expect(pinned.acceptedPriorBuilds).toEqual(renderer.acceptedPriorBuilds);
    for (const declared of DECLARED) expect(accepts(pinned, declared)).toBe(true);
    for (const declaration of refused()) expect(accepts(pinned, declaration), declaration.label).toBe(false);
  });
  it('a tampered headless file is refused under every legacy and executed declaration', async () => {
    const tampered = await variant(dist => appendFile(path.join(dist, 'runtime.js'), '\n'));
    expect(tampered.integrity).not.toBe(CURRENT.integrity);
    // An unrecorded build advertises only its own executed identity.
    expect(tampered.integrity).not.toBe(tampered.legacy);
    for (const declared of DECLARED) expect(accepts(tampered, declared)).toBe(false);
    expect(tampered.acceptedPriorBuilds.map(build => build.integrity)).not.toContain(PRIOR.integrity);
  });
  it('a tampered client file refuses 0.1.1 but keeps the 0.1.0 prior build, whose server-side runtime is unchanged', async () => {
    const tampered = await variant(dist => appendFile(path.join(dist, 'react.js'), '\n'));
    expect(accepts(tampered, CURRENT)).toBe(false);
    expect(accepts(tampered, EXECUTED)).toBe(false);
    expect(accepts(tampered, PRIOR)).toBe(true);
  });
  it('a changed pin of a package the headless runtime imports refuses every released declaration', async () => {
    const zod = await variant((_, manifest) => { manifest.dependencies.zod = '3.25.75'; });
    for (const declared of DECLARED) expect(accepts(zod, declared)).toBe(false);
  });
  it('a changed export map (which file is the headless entry) refuses every released declaration', async () => {
    const moved = await variant((_, manifest) => { manifest.exports['./headless'].import = './dist/index.js'; });
    // The legacy fingerprint does not cover the export map, so it alone would still say 0.1.1.
    expect(moved.legacy).toBe(CURRENT.integrity);
    for (const declared of DECLARED) expect(accepts(moved, declared)).toBe(false);
  });
  it('a build whose module loading cannot be analysed has no executed identity and only its own legacy fingerprint', async () => {
    const dynamic = await variant(dist => appendFile(path.join(dist, 'runtime.js'), '\nexport const later = () => import("zod");\n'));
    expect(dynamic.integrity).toBe(dynamic.legacy);
    expect(dynamic.acceptedPriorBuilds).toEqual([]);
    for (const declared of DECLARED) expect(accepts(dynamic, declared)).toBe(false);
    const undeclared = await variant(dist => appendFile(path.join(dist, 'headless.js'), '\nimport "left-pad";\n'));
    expect(undeclared.acceptedPriorBuilds).toEqual([]);
    for (const declared of DECLARED) expect(accepts(undeclared, declared)).toBe(false);
  });
  it('the same bytes under a bumped version are not the 0.1.1 release (why a version bump alone could not carry the pin change)', async () => {
    const bumped = await variant((_, manifest) => { manifest.version = '0.1.2'; });
    expect(accepts(bumped, CURRENT)).toBe(false);
    expect(accepts(bumped, PRIOR)).toBe(true);
  });
});
