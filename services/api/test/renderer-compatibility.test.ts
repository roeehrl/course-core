import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { fromVisualExperience, VisualRuntime } from '@course-core/visuals/headless';
import { declarationMatchesInstalled } from '../src/extension-identity.js';
import { resolveInteractiveContext } from '../src/interactive-context.js';
import { assertCourseRunnable, type RuntimeExtension } from '../src/publication.js';
import type { EnrollmentContext } from '../src/repository.js';
import { acceptedPriorBuilds, installedVisualsIdentity, RECORDED_SVG_RELEASES, REVIEWED_PRIOR_SVG_BUILDS, svgRenderer, VisualCheckPool, visualsRendererIdentity } from '../src/svg-renderer.js';
import { UnidentifiableBuildError, visualsPackageIdentity } from '../src/visuals-identity.js';
import { fixture } from './fixture.js';
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

// The build shipped identically with Core v0.1.3 through v0.1.25. Pinned releases declare it.
const PRIOR = { version: '0.1.0', integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24' };
// Core v0.1.32 shipped changed bytes under 0.1.0. That build is not a released identity.
const MISLABELED = { version: '0.1.0', integrity: 'sha256-b330d598fc6201d04e9700e138f1cc6d4c17db4beab45d1ed7abbd5858c4692b' };
const FORGED = `sha256-${'f'.repeat(64)}`;
const tamper = (integrity: string) => integrity.slice(0, -1) + (integrity.endsWith('0') ? '1' : '0');
const SDK = '@course-core/sdk';

interface ReleasedRecord { versions: Record<string, { integrity: string; headless: string; identity?: string; typeOnlyDependencies?: string[]; files?: Record<string, string>; headlessFiles: Record<string, string> }> }
const record: ReleasedRecord = JSON.parse(await readFile(fileURLToPath(new URL('../../../packages/visuals/released-digests.json', import.meta.url)), 'utf8'));
// 0.1.1 as released: the fingerprint published courses declare, and its package identity.
const CURRENT = { version: '0.1.1', integrity: 'sha256-d64441db68463ba2c62d36d04fc9c60a3378b4a2f783d5f156238b6aa6e2dcd6' };
const IDENTITY = { version: '0.1.1', integrity: record.versions['0.1.1']!.identity! };
const installedDist = () => path.dirname(fileURLToPath(import.meta.resolve('@course-core/visuals/headless')));
const installedManifest = () => readFile(path.join(installedDist(), '..', 'package.json'), 'utf8');

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
    { label: '0.1.0 paired with the 0.1.1 package identity', version: PRIOR.version, integrity: IDENTITY.integrity },
    { label: 'tampered package identity', version: IDENTITY.version, integrity: tamper(IDENTITY.integrity) },
  ];
}

describe('released visuals identities', () => {
  it('the installed renderer is the recorded 0.1.1 release and advertises its recorded fingerprint', () => {
    expect({ version: renderer.version, integrity: renderer.integrity }).toEqual(CURRENT);
    expect(record.versions[renderer.version]?.integrity).toBe(renderer.integrity);
  });
  it('the API computes the same package identity as the visuals digest script, and it is the recorded one', async () => {
    const released = record.versions['0.1.1']!;
    const installed = await visualsPackageIdentity(installedDist(), await installedManifest(), released.typeOnlyDependencies);
    expect(installed).toEqual({ identity: released.identity, files: released.files, headlessFiles: released.headlessFiles });
    expect(RECORDED_SVG_RELEASES.map(build => ({ ...build, typeOnlyDependencies: [...build.typeOnlyDependencies] }))).toEqual(
      Object.entries(record.versions).filter(([, entry]) => entry.identity).map(([version, entry]) => ({ version, integrity: entry.integrity, identity: entry.identity, typeOnlyDependencies: entry.typeOnlyDependencies })));
    expect(Object.isFrozen(RECORDED_SVG_RELEASES) && RECORDED_SVG_RELEASES.every(build => Object.isFrozen(build) && Object.isFrozen(build.typeOnlyDependencies))).toBe(true);
  });
  it('the reviewed 0.1.0 prior build is served by the recorded 0.1.1 release, whose headless runtime is byte-identical', () => {
    expect(REVIEWED_PRIOR_SVG_BUILDS.map(({ version, integrity }) => ({ version, integrity }))).toEqual([PRIOR]);
    for (const build of REVIEWED_PRIOR_SVG_BUILDS) {
      expect(record.versions[build.version]).toMatchObject({ integrity: build.integrity, headless: build.headless });
      for (const server of build.servedBy) {
        const release = Object.values(record.versions).find(entry => entry.identity === server)!;
        expect(release.headlessFiles).toEqual(record.versions[build.version]!.headlessFiles);
      }
    }
  });
  it('the adapter exposes exactly the reviewed 0.1.0 declaration and the 0.1.1 package identity, and the list cannot be extended at runtime', () => {
    expect(renderer.acceptedPriorBuilds).toEqual([PRIOR, IDENTITY]);
    expect(Object.isFrozen(renderer.acceptedPriorBuilds)).toBe(true);
    expect(() => (renderer.acceptedPriorBuilds as BuildList).push({ version: '9.9.9', integrity: FORGED })).toThrow();
    expect(() => { (renderer.acceptedPriorBuilds![0] as { integrity: string }).integrity = FORGED; }).toThrow();
  });
  it('a reviewed entry applies only to a recorded release it names, and never to the installed build itself', () => {
    const release = RECORDED_SVG_RELEASES[0]!, installed = { version: '0.1.1', integrity: CURRENT.integrity, release };
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, installed)).toEqual([PRIOR]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { version: '0.1.1', integrity: FORGED })).toEqual([]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...installed, release: { ...release, identity: tamper(release.identity) } })).toEqual([]);
    expect(acceptedPriorBuilds([{ ...REVIEWED_PRIOR_SVG_BUILDS[0]!, servedBy: [tamper(release.identity)] }], installed)).toEqual([]);
    expect(acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...installed, version: '0.1.0' })).toEqual([]);
  });
});
type BuildList = { version: string; integrity: string }[];

describe('the shared declaration-vs-installed identity check', () => {
  it('accepts only the installed build, its package identity or an exact reviewed prior build', () => {
    expect(declarationMatchesInstalled(CURRENT, renderer)).toBe(true);
    expect(declarationMatchesInstalled(IDENTITY, renderer)).toBe(true);
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
  it('legacy 0.1.1 and package-identity declarations both publish and resolve interactive context', () => {
    for (const declared of [CURRENT, IDENTITY]) {
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

/** Every declaration a published course may carry today, plus the new package identity. */
const DECLARED = [PRIOR, CURRENT, IDENTITY];
const SCRATCH = fileURLToPath(new URL('../node_modules/.cache/renderer-identity-test/', import.meta.url));
afterAll(() => rm(SCRATCH, { recursive: true, force: true }));
let copies = 0;
type Change = (pkg: string, dist: string, manifest: Record<string, any>) => Promise<unknown> | unknown;
/** A copy of the installed visuals package (dist + manifest) with one change applied, under this package's ignored node_modules so Node can import it. */
async function copyPackage(change: Change, text?: (json: string) => string) {
  const pkg = path.join(SCRATCH, `p${copies++}`), dist = path.join(pkg, 'dist');
  await mkdir(pkg, { recursive: true });
  await cp(installedDist(), dist, { recursive: true });
  const manifest = JSON.parse(await installedManifest());
  await change(pkg, dist, manifest);
  const json = JSON.stringify(manifest, null, 2);
  await writeFile(path.join(pkg, 'package.json'), text ? text(json) : json);
  return { pkg, dist, manifestText: text ? text(json) : json };
}
async function variant(change: Change, text?: (json: string) => string) {
  const copy = await copyPackage(change, text);
  return { ...renderer, ...await visualsRendererIdentity(copy.dist, copy.manifestText), ...copy };
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
const refuses = async (change: Change, text?: (json: string) => string) => {
  const copy = await copyPackage(change, text);
  await expect(visualsRendererIdentity(copy.dist, copy.manifestText)).rejects.toBeInstanceOf(UnidentifiableBuildError);
};
const append = (file: string, body: string): Change => (_pkg, dist) => appendFile(path.join(dist, file), body);

describe('renderer identity covers what can run', () => {
  it('moving the type-only SDK pin changes nothing a course can observe (the 0.5.0 move)', async () => {
    for (const pin of ['https://github.com/roeehrl/course-sdk/releases/download/v0.2.0/course-core-sdk-0.2.0.tgz', 'https://github.com/roeehrl/course-sdk/releases/download/v9.9.9/course-core-sdk-9.9.9.tgz']) {
      const pinned = await variant((_p, _d, manifest) => { manifest.dependencies[SDK] = pin; });
      expect({ version: pinned.version, integrity: pinned.integrity }).toEqual(CURRENT);
      expect(pinned.acceptedPriorBuilds).toEqual(renderer.acceptedPriorBuilds);
      for (const declared of DECLARED) expect(accepts(pinned, declared)).toBe(true);
      for (const declaration of refused()) expect(accepts(pinned, declaration), declaration.label).toBe(false);
    }
  });
  it('any other change makes an unrecorded build that serves only its own strict identity', async () => {
    const changes: [string, Change][] = [
      ['headless file', append('runtime.js', '\n')],
      ['client file', append('react.js', '\n')],
      ['declaration file', append('headless.d.ts', '\n')],
      ['added file', (_p, dist) => writeFile(path.join(dist, 'extra.js'), '')],
      ['zod pin', (_p, _d, m) => { m.dependencies.zod = '3.25.75'; }],
      ['react peer range', (_p, _d, m) => { m.peerDependencies.react = '^19.0.0'; }],
      ['export map target', (_p, _d, m) => { m.exports['./headless'].import = './dist/index.js'; }],
      ['module type', (_p, _d, m) => { m.type = 'commonjs'; }],
      ['version', (_p, _d, m) => { m.version = '0.1.2'; }],
    ];
    for (const [label, change] of changes) {
      const changed = await variant(change);
      expect(changed.installed.release, label).toBeUndefined();
      expect(changed.integrity, label).toBe((await visualsPackageIdentity(changed.dist, changed.manifestText)).identity);
      expect(changed.acceptedPriorBuilds, label).toEqual([]);
      for (const declared of DECLARED) expect(accepts(changed, declared), label).toBe(false);
    }
  });
  it('the same bytes under a bumped version are not 0.1.1 (why a version bump alone could not carry the pin change)', async () => {
    const bumped = await variant((_p, _d, m) => { m.version = '0.1.2'; });
    expect(accepts(bumped, CURRENT)).toBe(false);
    expect(accepts(bumped, PRIOR)).toBe(false);
  });
});

// Regressions for the independent review of #69: each built two builds that run different
// code under one identity. Each must now be refused or get two identities.
describe('review findings: the same identity can no longer name different code', () => {
  it('H1: a mixed-quote or escaped specifier is refused', async () => {
    await refuses(async (pkg, dist) => {
      await appendFile(path.join(dist, 'headless.js'), `\nimport "./schema.js'/../../outside.js";\n`);
      await writeFile(path.join(pkg, 'outside.js'), 'globalThis.__poc = "EVIL";\n');
    });
    await refuses(append('headless.js', '\nimport "./\\x2e\\x2e/o.js";\n'));
    await refuses(append('headless.js', '\nimport "../outside.js";\n'));
  });
  it('H2: builtins and loaders the lint lists are refused (it is a lint over reviewed bytes, not a proof)', async () => {
    for (const body of [
      'const __m = process.getBuiltinModule("module");',
      'import { Module as __M, register as __r } from "node:module";',
      'export const e = (0, eval)("1");',
      'export const f = Function("return 1");',
      'export const f = (() => 1).constructor;',
      'export const u = import\n.meta;',
      'export const w = WebAssembly;',
      'export const g = globalThis;',
      'export const x = () => import("zod");',
    ]) await refuses(append('headless.js', `\n${body}\n`));
    for (const body of ['export const s = () => document.createElement("script");', 'export const w = () => navigator.serviceWorker;', 'export const k = (w) => w.addModule("x.js");'])
      await refuses(append('react.js', `\n${body}\n`));
  });
  it('H3: every file under dist is hashed and every entry must be a hashed dist file', async () => {
    const mjs = (tag: string) => variant(async (_p, dist, m) => {
      m.exports['./headless'].import = './dist/headless.mjs';
      await writeFile(path.join(dist, 'headless.mjs'), `export const RENDERER_ID = ${JSON.stringify(tag)};\n`);
    });
    expect((await mjs('benign')).integrity).not.toBe((await mjs('EVIL')).integrity);
    await refuses((_p, _d, m) => { m.exports['./headless'].import = './outside.js'; });
    await refuses((_p, _d, m) => { m.exports['./headless'] = { node: './dist/missing.js', default: './dist/headless.js' }; });
    await refuses((_p, dist) => writeFile(path.join(dist, 'x.cjs'), ''));
    await refuses((_p, dist) => writeFile(path.join(dist, 'addon.node'), ''));
    await refuses((_p, dist) => symlink(path.join(dist, 'headless.js'), path.join(dist, 'link.js')));
  });
  it('H4: export condition order is part of the identity, and duplicate manifest keys are refused', async () => {
    const order = (first: 'node' | 'default') => variant((_p, _d, m) => {
      m.exports['./headless'] = first === 'node' ? { node: './dist/index.js', default: './dist/headless.js' } : { default: './dist/headless.js', node: './dist/index.js' };
    });
    expect((await order('node')).integrity).not.toBe((await order('default')).integrity);
    await refuses(() => undefined, json => json.replace('"type": "module"', '"type": "commonjs", "type": "module"'));
  });
  it('H5: a check worker refuses to answer when the package on disk is not the identity computed at startup', async () => {
    const { visualContextFixture: make } = await import('../../../apps/learner/tests/visualContext.fixture.js');
    const json = JSON.stringify(make());
    const { installed } = await visualsRendererIdentity(installedDist(), await installedManifest());
    expect(await new VisualCheckPool(1, { dist: installedDist(), files: installed.files }).run(json)).toBe(true);
    // The disk no longer matches the startup identity (one file's digest differs).
    const changed = { ...installed.files, 'runtime.js': tamper(installed.files['runtime.js']!) };
    const stale = new VisualCheckPool(1, { dist: installedDist(), files: changed });
    expect(await stale.run(json)).toBe(false);
    expect(await stale.run(json)).toBe(false);
    // A copy of the package is not what the worker loaded.
    const copy = await copyPackage(() => undefined);
    expect(await new VisualCheckPool(1, { dist: copy.dist, files: installed.files }).run(json)).toBe(false);
  });
  it('L1: a build the identity refuses is never served, so nothing falls back to the legacy fingerprint', async () => {
    const copy = await copyPackage(append('headless.js', '\nexport const x = () => import("zod");\n'));
    await expect(installedVisualsIdentity(RECORDED_SVG_RELEASES, copy.dist, copy.manifestText)).rejects.toBeInstanceOf(UnidentifiableBuildError);
    await expect(import(pathToFileURL(path.join(copy.dist, 'headless.js')).href)).resolves.toBeDefined();
  });
  it('a type-only dependency named or imported by dist code loses the relaxation', async () => {
    const named = await variant(append('headless.js', '\nexport const n = "@course-core/sdk";\n'));
    expect(named.installed.release).toBeUndefined();
    const imported = await variant(append('headless.js', '\nimport "@course-core/sdk";\n'));
    expect(imported.installed.release).toBeUndefined();
    for (const declared of DECLARED) expect(accepts(imported, declared)).toBe(false);
  });
});
