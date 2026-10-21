import type { CourseManifest } from '@course-core/sdk';
import { describe, expect, it } from 'vitest';
import { assertCourseRunnable, type RuntimeExtension } from '../src/publication.js';
import { fixture } from './fixture.js';

// S12: Core publication itself refuses inaccessible visual renderers, whatever SDK built the bundle.
type Visual = CourseManifest['visuals'][number];
const INTEGRITY = `sha256-${'a'.repeat(64)}`;
const adapter: RuntimeExtension = { id: 'scenes', version: '1.0.0', integrity: INTEGRITY, platforms: ['web'], capabilities: ['visual.render'], validateVisual: () => {} };

function course(access: { keyboard?: unknown; textAlternative?: unknown } = {}, description = 'A bar chart of the values 4 and 9.', block = true) {
  const source = fixture();
  const visual: Visual = { id: 'bars', rendererId: 'scenes', platforms: ['web'], state: {}, scene: {}, layouts: { compact: {}, expanded: {} },
    timeline: { durationMs: 0, seekable: false, cues: [] }, accessibility: { description, reducedMotion: {} }, referenceChecks: [] };
  source.visuals.push(visual);
  if (block) source.chapters[0]!.episodes[0]!.blocks.push({ id: 'bars-block', type: 'visual', visualId: 'bars' });
  source.extensions.push({ id: 'scenes', version: '1.0.0', integrity: INTEGRITY, execution: 'declarative', entrypoint: 'scenes.js', platforms: ['web'], capabilities: ['visual.render'],
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'The scene has a text equivalent.', ...access } as CourseManifest['extensions'][number]['accessibility'] });
  return source;
}
const refusal = (run: () => void) => { try { run(); } catch (caught) { return caught; } return undefined; };

describe('publication refuses inaccessible visuals (S12)', () => {
  it('publishes an accessible visual block', () => {
    expect(() => assertCourseRunnable(course(), [adapter])).not.toThrow();
  });
  it('refuses a renderer that declares keyboard: false, with a stable code and reasons', () => {
    expect(refusal(() => assertCourseRunnable(course({ keyboard: false }), [adapter]))).toMatchObject({ statusCode: 409, code: 'PUBLISH_VISUAL_INACCESSIBLE',
      details: { visualId: 'bars', rendererId: 'scenes', reasons: ['keyboard'] } });
  });
  it('refuses a missing or non-boolean keyboard declaration (fails closed)', () => {
    for (const keyboard of [undefined, 'yes', 1])
      expect(refusal(() => assertCourseRunnable(course({ keyboard }), [adapter]))).toMatchObject({ code: 'PUBLISH_VISUAL_INACCESSIBLE', details: { reasons: ['keyboard'] } });
  });
  it('refuses a blank renderer text alternative and a blank visual description', () => {
    expect(refusal(() => assertCourseRunnable(course({ textAlternative: '  ' }), [adapter]))).toMatchObject({ code: 'PUBLISH_VISUAL_INACCESSIBLE',
      details: { reasons: ['renderer_text_alternative'] } });
    expect(refusal(() => assertCourseRunnable(course({}, '\n\t'), [adapter]))).toMatchObject({ code: 'PUBLISH_VISUAL_INACCESSIBLE',
      details: { visualId: 'bars', reasons: ['visual_description'] } });
    expect(refusal(() => assertCourseRunnable(course({ keyboard: false, textAlternative: '' }, ''), [adapter]))).toMatchObject({
      details: { reasons: ['keyboard', 'renderer_text_alternative', 'visual_description'] } });
  });
  it('refuses a visual renderer definition whose extension declares keyboard: false, even with no visual block', () => {
    const source = course({ keyboard: false }, 'A bar chart.', false);
    source.renderers = [{ id: 'svg', version: '1.0.0', surface: 'visual', extensionId: 'scenes', targets: ['web'], features: [] }];
    expect(refusal(() => assertCourseRunnable(source, [adapter]))).toMatchObject({ code: 'PUBLISH_VISUAL_INACCESSIBLE',
      details: { rendererDefinitionId: 'svg', rendererId: 'scenes', reasons: ['keyboard'] } });
    source.extensions[0]!.accessibility.keyboard = true;
    expect(() => assertCourseRunnable(source, [adapter])).not.toThrow();
  });
  it('an unused inaccessible extension that renders no visual does not block publication', () => {
    expect(() => assertCourseRunnable(course({ keyboard: false }, 'A bar chart.', false), [adapter])).not.toThrow();
  });
  it('a capability problem is still reported first when the renderer is not installed', () => {
    expect(refusal(() => assertCourseRunnable(course({ keyboard: false }), []))).toMatchObject({ code: 'PUBLISH_CAPABILITY_MISSING' });
  });
});
